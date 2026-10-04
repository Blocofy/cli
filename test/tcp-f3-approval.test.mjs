import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";

import { approvalOutcome, approvalWaitState, safeApprovalUrl, themeWorkRefusal } from "../lib/theme-work.mjs";
import { CliRefusal } from "../lib/media-uses.mjs";

// Review + human approval, CLI half: `theme work seal` (freeze for review, no approval), `theme work request-approval`
// (prints the approval URL - no token in it -, optional --open, optional read-only --wait), and the publish status in
// `theme work status`. The CLI never publishes a work and never decides an approval: the only routes it calls are the
// work read, seal, approvals (request) and publish-status (read).

const execFileP = promisify(execFile);
const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "blocofy.mjs");
const TOKEN = "bcf_testtoken1234567890abcd";
const API_KEY = "blcf_live_testkey1234567890abcdef";
const HANDLE = "wk_abcdefghijklmnopqrstuvwxyz";
const AP = "ap_bbbbbbbbbbbbbbbbbbbbbbbbbb";
const DIGEST = "c".repeat(64);

const work = (over = {}) => ({
  id: HANDLE, intent: "Başlık", state: "open", state_version: 1, theme: "t7k2p9", sandbox: false,
  base: { theme: "t9live", theme_key: "default", theme_version: "1.3.0" }, stale: false, stale_reasons: [],
  reserved_bytes: 1500, failure_reason: null, created_at: "", updated_at: "", ended_at: null, ...over,
});
const approval = (url, over = {}) => ({
  id: AP, state: "unused", expired: false, revoke_reason: null, digest: DIGEST, digest_short: DIGEST.slice(0, 12),
  expires_at: new Date(Date.now() + 15 * 60_000).toISOString(), approval_url: `${url}/approve/${AP}`, outcome: null, created_at: "", ...over,
});
const status = (url, phase, approvalOver = {}, extra = {}) => ({
  work: work({ state: phase === "published" ? "published" : "sealed" }), phase, phase_label: phase,
  package: { seal_revision: 1, digest: DIGEST, digest_short: DIGEST.slice(0, 12) },
  approval: approvalOver === null ? null : approval(url, approvalOver), ...extra,
});

function projectDir() {
  const dir = mkdtempSync(join(tmpdir(), "blocofy-tcp-f3-"));
  mkdirSync(join(dir, ".blocofy"), { recursive: true });
  writeFileSync(join(dir, ".blocofy", "project.json"), JSON.stringify({ schema_version: 1, site_id: 14, site_slug: "ksc", platform_origin: null }));
  return dir;
}

const json = (res, s, body) => {
  res.writeHead(s, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

/**
 * A platform with the v1 work routes. `answers.seal` / `answers.approvals` → `(url) => [status, body]`;
 * `answers.statuses` → `(url) => [body, body, …]` answered in order (the last one repeats).
 */
function platform(answers = {}) {
  const seen = { paths: [], seals: 0, approvals: 0, statuses: 0, auth: [] };
  let url = "";
  const server = createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    seen.paths.push(`${req.method} ${u.pathname}`);
    if (u.pathname.startsWith("/api/v1/")) seen.auth.push(req.headers.authorization);
    req.resume();
    req.on("end", () => {
      if (req.method === "GET" && u.pathname === "/api/v1/ping") return json(res, 200, { site: { id: 14, slug: "ksc", name: "Ksc" } });
      if (req.method === "GET" && u.pathname === "/api/dev/whoami") return json(res, 200, { site: { id: 14, slug: "ksc", name: "Ksc" }, liveThemeId: "t9live" });
      if (req.method === "GET" && u.pathname === `/api/v1/theme-work/${HANDLE}`) return json(res, 200, { work: work(answers.workOver ?? {}) });
      if (req.method === "POST" && u.pathname === `/api/v1/theme-work/${HANDLE}/seal`) {
        seen.seals++;
        if (answers.seal) {
          const [s, body] = answers.seal(url);
          if (body === null) return res.writeHead(s, { "content-type": "text/html" }).end("<html>404</html>");
          return json(res, s, body);
        }
        return json(res, 200, { status: "ready_for_review", phase_label: "İncelemeye hazır", already_sealed: false, work: work({ state: "sealed", state_version: 2 }), package: { seal_revision: 1, digest: DIGEST, digest_short: DIGEST.slice(0, 12) } });
      }
      if (req.method === "POST" && u.pathname === `/api/v1/theme-work/${HANDLE}/approvals`) {
        seen.approvals++;
        if (answers.approvals) return json(res, ...answers.approvals(url));
        return json(res, 200, { status: "approval_required", message: "x", approval: approval(url), work: work({ state: "sealed", state_version: 2 }), phase_label: "Onay bekleniyor" });
      }
      if (req.method === "GET" && u.pathname === `/api/v1/theme-work/${HANDLE}/publish-status`) {
        const list = answers.statuses ? answers.statuses(url) : [status(url, "awaiting_approval")];
        const body = list[Math.min(seen.statuses, list.length - 1)];
        seen.statuses++;
        return Array.isArray(body) ? json(res, ...body) : json(res, 200, body);
      }
      res.writeHead(404).end();
    });
  });
  return {
    server,
    seen,
    setUrl: (v) => {
      url = v;
    },
  };
}

async function withPlatform(answers, fn) {
  const { server, seen, setUrl } = platform(answers);
  server.listen(0);
  await once(server, "listening");
  const url = `http://localhost:${server.address().port}`;
  setUrl(url);
  try {
    return await fn(url, seen);
  } finally {
    server.close();
  }
}

const HOME = mkdtempSync(join(tmpdir(), "blocofy-tcp-f3-home-"));
// A browser opener stub: `open` (macOS) / `xdg-open` (Linux) append their argument to a file instead of opening.
const STUB_BIN = mkdtempSync(join(tmpdir(), "blocofy-tcp-f3-bin-"));
const OPENED = join(STUB_BIN, "opened.txt");
for (const name of ["open", "xdg-open"]) {
  writeFileSync(join(STUB_BIN, name), `#!/bin/sh\necho "$1" >> "${OPENED}"\n`);
  chmodSync(join(STUB_BIN, name), 0o755);
}
const env = (url) => {
  const e = { ...process.env, HOME, PATH: `${STUB_BIN}${delimiter}${process.env.PATH}` };
  for (const k of ["BLOCOFY_URL", "BLOCOFY_TOKEN", "BLOCOFY_API_URL", "BLOCOFY_API_KEY", "BLOCOFY_CONTEXT"]) delete e[k];
  return Object.assign(e, { BLOCOFY_URL: url, BLOCOFY_TOKEN: TOKEN, BLOCOFY_API_URL: url, BLOCOFY_API_KEY: API_KEY });
};
const runBin = (url, argv) =>
  execFileP("node", [BIN, ...argv], { env: env(url) }).then(
    (r) => ({ code: 0, ...r }),
    (e) => ({ code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" }),
  );
const lastLine = (stderr) => stderr.trimEnd().split("\n").at(-1);
const withDir = async (fn) => {
  const dir = projectDir();
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
/** No call ever reaches a publish / deploy / approve-decision route. */
const noPublish = (seen) => {
  const bad = seen.paths.filter((p) => /\/publish$|\/deploy$|\/approve$|\/revoke$|\/api\/dev\/publish|\/themes\//.test(p));
  assert.deepEqual(bad, []);
};
const readOpened = async () => {
  for (let i = 0; i < 40 && !existsSync(OPENED); i++) await new Promise((r) => setTimeout(r, 50));
  return existsSync(OPENED) ? readFileSync(OPENED, "utf8") : "";
};

// ── pure ───────────────────────────────────────────────────────────────────────────────────────────────────

test("safeApprovalUrl: only this platform's /approve/ap_… page, no query, fragment or credentials", () => {
  const api = "https://app.blocofy.com";
  assert.equal(safeApprovalUrl(`${api}/approve/${AP}`, api), `${api}/approve/${AP}`);
  assert.equal(safeApprovalUrl(`/approve/${AP}`, `${api}/`), `${api}/approve/${AP}`);
  for (const bad of [`https://evil.example/approve/${AP}`, `${api}/approve/${AP}?token=x`, `${api}/approve/${AP}#x`, `https://u:p@app.blocofy.com/approve/${AP}`,
    `${api}/approve/nope`, `${api}/other/${AP}`, "javascript:alert(1)", "", null]) {
    assert.equal(safeApprovalUrl(bad, api), null, String(bad));
  }
});

test("approvalWaitState: every end of a request, and pending otherwise", () => {
  const u = "https://app.blocofy.com";
  assert.equal(approvalWaitState(status(u, "awaiting_approval"), AP), "pending");
  assert.equal(approvalWaitState(status(u, "publishing"), AP), "pending");
  assert.equal(approvalWaitState(status(u, "published", { state: "consumed", outcome: { status: "published", theme: "t1" } }), AP), "published");
  assert.equal(approvalWaitState(status(u, "needs_update", { state: "revoked", revoke_reason: "stale" }), AP), "stale");
  assert.equal(approvalWaitState(status(u, "ready_for_review", { expired: true }), AP), "expired");
  assert.equal(approvalWaitState(status(u, "ready_for_review", { state: "revoked", revoke_reason: "declined" }), AP), "declined");
  assert.equal(approvalWaitState(status(u, "preparing", null), AP), "superseded");
  assert.equal(approvalWaitState(status(u, "preparing", { state: "revoked", revoke_reason: "superseded" }), AP), "superseded");
  assert.equal(approvalWaitState(status(u, "cancelled"), AP), "cancelled");
  assert.equal(approvalWaitState(status(u, "failed"), AP), "failed");
  assert.equal(approvalWaitState(status(u, "awaiting_approval", { id: "ap_cccccccccccccccccccccccccc" }), AP), "pending");
  for (const s of ["stale", "expired", "declined", "superseded", "cancelled", "failed", "timeout"]) {
    const o = approvalOutcome(s, { handle: HANDLE });
    assert.equal(o.ok, false, s);
    assert.match(o.lines[0], /yayınlanmadı|karar verilmedi|tamamlanamadı/, s);
  }
  assert.equal(approvalOutcome("published", { handle: HANDLE }).ok, true);
});

test("themeWorkRefusal knows the approval-side wire codes", () => {
  assert.match(themeWorkRefusal(new CliRefusal(409, { code: "conflict" }), { handle: HANDLE }).lines[0], /Onay isteği bu sırada değişti/);
  assert.match(themeWorkRefusal(new CliRefusal(409, { code: "work_not_publishable" }), { handle: HANDLE }).lines[1], /request-approval/);
  assert.match(themeWorkRefusal(new CliRefusal(403, { code: "forbidden_scope" }), { op: "wait" }).lines[0], /themes:read/);
});

test("work start quota_exceeded: theme_bytes frees space; the legacy draft count says remove a draft; never a plan upgrade", () => {
  const bytes = themeWorkRefusal(new CliRefusal(422, { code: "quota_exceeded", details: { resource: "theme_bytes", usedBytes: 1, allowanceBytes: 1 } }), { op: "start" });
  const text = bytes.lines.join("\n");
  assert.match(text, /tema alanı dolu/);
  assert.match(text, /destek/);
  assert.doesNotMatch(text + bytes.message, /plan|yükselt|upgrade/i);
  assert.match(text, /tema kütüphanesinden sil/);
  assert.doesNotMatch(text, /arşivle|bitir/i, "archiving or 'finishing' a work frees no theme bytes");
  const drafts = themeWorkRefusal(new CliRefusal(422, { code: "quota_exceeded", details: { resource: "theme_drafts", used: 5, limit: 5 } }), { op: "start" });
  assert.match(drafts.lines.join("\n"), /kullanmadığın bir taslak temayı sil/);
  assert.doesNotMatch(drafts.lines.join("\n") + drafts.message, /plan|yükselt|upgrade|faturalandırma/i);
});

// ── end to end (mock platform) ─────────────────────────────────────────────────────────────────────────────

test("seal: reads the work, seals it once, requests no approval, publishes nothing", () =>
  withDir((dir) =>
    withPlatform({}, async (url, seen) => {
      const r = await runBin(url, ["theme", "work", "seal", HANDLE, "--dir", dir]);
      assert.equal(r.code, 0, r.stdout + r.stderr);
      assert.match(r.stdout, new RegExp(`Çalışma incelemeye hazır: ${HANDLE}`));
      assert.match(r.stdout, /onay istenmedi/);
      assert.ok(r.stdout.includes(DIGEST.slice(0, 12)));
      assert.equal(seen.seals, 1);
      assert.equal(seen.approvals, 0);
      assert.ok(seen.auth.every((a) => a === `Bearer ${API_KEY}`));
      noPublish(seen);
    })));

test("seal on a platform without the endpoint (HTML 404) says so and points to request-approval; exit 2", () =>
  withDir((dir) =>
    withPlatform({ seal: () => [404, null] }, async (url, seen) => {
      const r = await runBin(url, ["theme", "work", "seal", HANDLE, "--dir", dir]);
      assert.equal(r.code, 2, r.stderr);
      assert.match(r.stderr, /henüz desteklemiyor/);
      assert.ok(r.stderr.includes(`request-approval ${HANDLE}`));
      assert.match(lastLine(r.stderr), /^error \[seal_unsupported\]/);
      assert.equal(seen.approvals, 0);
    })));

test("seal of a stale work: work_stale in plain Turkish, exit 2, nothing overwritten", () =>
  withDir((dir) =>
    withPlatform({ seal: () => [409, { error: { code: "work_stale", message: "x", details: { changed: ["live_theme_changed"] } } }] }, async (url) => {
      const r = await runBin(url, ["theme", "work", "seal", HANDLE, "--dir", dir]);
      assert.equal(r.code, 2, r.stderr);
      assert.match(r.stderr, /çalışma güncel değil/);
      assert.match(r.stderr, /üzerine yazılmadı/);
    })));

test("work_revision_limit (seal past the cap, or request-approval that seals): plain Turkish, start a new work; exit 2", async () => {
  const body = { error: { code: "work_revision_limit", message: "x", details: { limit: 20 } } };
  await withDir((dir) =>
    withPlatform({ seal: () => [409, body] }, async (url, seen) => {
      const r = await runBin(url, ["theme", "work", "seal", HANDLE, "--dir", dir]);
      assert.equal(r.code, 2, r.stderr);
      assert.match(r.stderr, /Bir çalışma en fazla 20 kez incelemeye gönderilebilir; yeni bir çalışma başlat\./);
      assert.match(r.stderr, /blocofy theme work start/);
      assert.match(lastLine(r.stderr), /^error \[work_revision_limit\]/);
      assert.equal(seen.approvals, 0);
    }));
  await withDir((dir) =>
    withPlatform({ approvals: () => [409, body] }, async (url) => {
      const r = await runBin(url, ["theme", "work", "request-approval", HANDLE, "--dir", dir, "--json"]);
      assert.equal(r.code, 2, r.stderr);
      const env = JSON.parse(lastLine(r.stderr));
      assert.equal(env.error.code, "work_revision_limit");
      assert.equal(env.error.details.limit, 20);
    }));
  const other = themeWorkRefusal(new CliRefusal(409, { code: "work_revision_limit", details: { limit: 7 } }), { handle: HANDLE, op: "seal" });
  assert.match(other.lines[0], /en fazla 7 kez/);
  assert.doesNotMatch(other.lines.join("\n") + other.message, /plan|yükselt|upgrade/i);
});

test("request-approval: prints the approval URL (no token, no key), never publishes; exit 0", () =>
  withDir((dir) =>
    withPlatform({}, async (url, seen) => {
      const r = await runBin(url, ["theme", "work", "request-approval", HANDLE, "--dir", dir]);
      assert.equal(r.code, 0, r.stdout + r.stderr);
      assert.ok(r.stdout.includes(`Onay URL'i:  ${url}/approve/${AP}`), r.stdout);
      assert.match(r.stdout, /yayın yetkisi vermez/);
      assert.match(r.stdout, /Bu komut yayınlamaz/);
      assert.doesNotMatch(r.stdout + r.stderr, new RegExp(`${API_KEY}|${TOKEN}|token=|nonce`));
      assert.equal(seen.approvals, 1);
      assert.equal(seen.statuses, 0, "no --wait: no polling");
      noPublish(seen);
      const j = await runBin(url, ["theme", "work", "request-approval", HANDLE, "--dir", dir, "--json"]);
      assert.equal(j.code, 0, j.stderr);
      assert.equal(JSON.parse(j.stdout).approval.id, AP);
    })));

test("request-approval --wait: polls the read-only status until published; exit 0", () =>
  withDir((dir) =>
    withPlatform({ statuses: (u) => [status(u, "awaiting_approval"), status(u, "published", { state: "consumed", outcome: { status: "published", theme: "t5new" } })] }, async (url, seen) => {
      const r = await runBin(url, ["theme", "work", "request-approval", HANDLE, "--dir", dir, "--wait", "--interval", "1"]);
      assert.equal(r.code, 0, r.stdout + r.stderr);
      assert.match(r.stdout, /Yayınlandı: çalışma .* canlı sitede \(tema t5new\)/);
      assert.equal(seen.statuses, 2);
      assert.equal(seen.approvals, 1, "waiting never re-requests");
      noPublish(seen);
    })));

test("request-approval --wait: stale / expired / declined / superseded end with 'nothing was published', exit 2", async () => {
  const cases = [
    ["approval_stale", (u) => [status(u, "needs_update", { state: "revoked", revoke_reason: "stale" })], /Canlı site bu arada değişti/],
    ["approval_expired", (u) => [status(u, "ready_for_review", { expired: true })], /süresi doldu/],
    ["approval_declined", (u) => [status(u, "ready_for_review", { state: "revoked", revoke_reason: "declined" })], /reddedildi/],
    ["approval_superseded", (u) => [status(u, "preparing", null)], /düzenlemeye geri alındı/],
  ];
  for (const [code, statuses, re] of cases) {
    await withDir((dir) =>
      withPlatform({ statuses }, async (url, seen) => {
        const r = await runBin(url, ["theme", "work", "request-approval", HANDLE, "--dir", dir, "--wait", "--interval", "1"]);
        assert.equal(r.code, 2, `${code}: ${r.stderr}`);
        assert.match(r.stderr, re, code);
        assert.match(r.stderr, /hiçbir şey yayınlanmadı/i, code);
        assert.match(lastLine(r.stderr), new RegExp(`^error \\[${code}\\]`), code);
        noPublish(seen);
      }));
  }
});

test("request-approval --open opens only this platform's approval page", async () => {
  rmSync(OPENED, { force: true });
  await withDir((dir) =>
    withPlatform({}, async (url) => {
      const r = await runBin(url, ["theme", "work", "request-approval", HANDLE, "--dir", dir, "--open"]);
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /tarayıcıda açılıyor/);
      assert.equal((await readOpened()).trim(), `${url}/approve/${AP}`);
    }));
  rmSync(OPENED, { force: true });
  await withDir((dir) =>
    withPlatform({ approvals: (u) => [200, { status: "approval_required", approval: approval(u, { approval_url: `https://evil.example/approve/${AP}` }), work: work({ state: "sealed" }) }] }, async (url) => {
      const r = await runBin(url, ["theme", "work", "request-approval", HANDLE, "--dir", dir, "--open"]);
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stderr, /tarayıcıda açılmadı/);
      await new Promise((res) => setTimeout(res, 300));
      assert.equal(existsSync(OPENED), false);
    }));
});

test("request-approval refusals and usage: work_stale exit 2; --interval without --wait is a usage error before any request", () =>
  withDir((dir) =>
    withPlatform({ approvals: () => [409, { error: { code: "work_stale", message: "x", details: { changed: ["live_theme_changed"] } } }] }, async (url, seen) => {
      const r = await runBin(url, ["theme", "work", "request-approval", HANDLE, "--dir", dir]);
      assert.equal(r.code, 2, r.stderr);
      assert.match(r.stderr, /çalışma güncel değil/);
      const before = seen.paths.length;
      const u = await runBin(url, ["theme", "work", "request-approval", HANDLE, "--dir", dir, "--interval", "2"]);
      assert.equal(u.code, 1);
      assert.match(lastLine(u.stderr), /--interval needs --wait/);
      assert.equal(seen.paths.length, before);
    })));

test("status shows where the publication stands; --json carries it; an old platform without it still shows the work", () =>
  withDir((dir) =>
    withPlatform({}, async (url) => {
      const r = await runBin(url, ["theme", "work", "status", HANDLE, "--dir", dir]);
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /Yayın:  awaiting_approval/);
      assert.ok(r.stdout.includes(`Onay bekleniyor: ${url}/approve/${AP}`), r.stdout);
      const j = await runBin(url, ["theme", "work", "status", HANDLE, "--dir", dir, "--json"]);
      assert.equal(JSON.parse(j.stdout).publish.phase, "awaiting_approval");
    })).then(() =>
    withDir((dir) =>
      withPlatform({ statuses: () => [[404, { error: { code: "not_found", message: "x" } }]] }, async (url) => {
        const r = await runBin(url, ["theme", "work", "status", HANDLE, "--dir", dir]);
        assert.equal(r.code, 0, r.stderr);
        assert.match(r.stdout, new RegExp(`Çalışma: ${HANDLE}`));
        assert.doesNotMatch(r.stdout, /Yayın:/);
      }))));
