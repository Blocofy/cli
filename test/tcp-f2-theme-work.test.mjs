import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";

import { readSavedWork, saveWork, staleLines, themeWorkRefusal } from "../lib/theme-work.mjs";
import { CliRefusal } from "../lib/media-uses.mjs";

// Theme work sessions ("çalışma"), CLI half: `theme work start|status|resume|cancel` over the v1 API key, the project's
// saved work in .blocofy/local.json (no secret), and `theme push --draft --work <wk_…>` writing that work's own theme
// through the dev token (never live). Refusals: the plain Turkish explanation first, the `error [code]` line last
// (or the `--json` envelope); exit 2 for a 4xx, 1 for a usage error / 5xx / lost answer.

const execFileP = promisify(execFile);
const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "blocofy.mjs");
const TOKEN = "bcf_testtoken1234567890abcd";
const API_KEY = "blcf_live_testkey1234567890abcdef";
const HANDLE = "wk_abcdefghijklmnopqrstuvwxyz";
const OTHER = "wk_zyxwvutsrqponmlkjihgfedcba";
const WORK_THEME = "t7k2p9";

const work = (over = {}) => ({
  id: HANDLE, intent: "Başlık", state: "open", state_version: 1, theme: WORK_THEME, sandbox: false,
  base: { theme: "t9live", theme_key: "default", theme_version: "1.3.0" }, stale: false, stale_reasons: [],
  reserved_bytes: 1500, failure_reason: null, created_at: "2026-10-04T10:00:00Z", updated_at: "2026-10-04T10:00:00Z", ended_at: null,
  ...over,
});

function projectDir(files = { "section/Hero": "H" }, local = null) {
  const dir = mkdtempSync(join(tmpdir(), "blocofy-tcp-f2-"));
  for (const [key, content] of Object.entries(files)) {
    const rel = `${key}.liquid`;
    mkdirSync(join(dir, rel.slice(0, rel.lastIndexOf("/"))), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  mkdirSync(join(dir, ".blocofy"), { recursive: true });
  writeFileSync(join(dir, ".blocofy", "project.json"), JSON.stringify({ schema_version: 1, site_id: 14, site_slug: "ksc", platform_origin: null }));
  if (local) writeFileSync(join(dir, ".blocofy", "local.json"), JSON.stringify(local));
  return dir;
}

const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};
const readBody = (req) =>
  new Promise((resolve) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => resolve(raw ? JSON.parse(raw) : null));
  });

/**
 * A platform with the v1 theme-work routes (API key) and the dev theme endpoint (dev token). `answers` overrides a
 * route's answer: `{ start, get, resume, cancel }` → `(req, body, seen) => [status, body, headers?]`.
 */
function platform(answers = {}) {
  const seen = { starts: [], gets: [], resumes: [], cancels: [], pushes: [], themeGets: [], auth: [] };
  const keys = new Map();
  const server = createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    const body = req.method === "POST" ? await readBody(req) : null;
    if (u.pathname.startsWith("/api/v1/")) seen.auth.push(req.headers.authorization);
    if (req.method === "GET" && u.pathname === "/api/dev/whoami") return json(res, 200, { site: { id: 14, slug: "ksc", name: "Ksc" }, liveThemeId: "t9live" });
    if (req.method === "GET" && u.pathname === "/api/v1/ping") return json(res, 200, { site: { id: 14, slug: "ksc", name: "Ksc" } });
    if (req.method === "POST" && u.pathname === "/api/v1/theme-work") {
      const key = req.headers["idempotency-key"];
      seen.starts.push({ body, key });
      if (answers.start) return json(res, ...answers.start(req, body, seen));
      if (keys.has(key)) return json(res, 200, { work: keys.get(key), replayed: true });
      const w = work({ intent: body.intent });
      keys.set(key, w);
      return json(res, 201, { work: w });
    }
    const m = u.pathname.match(/^\/api\/v1\/theme-work\/([^/]+)(\/resume|\/cancel)?$/);
    if (m) {
      const [, handle, tail] = m;
      if (!tail && req.method === "GET") {
        seen.gets.push(handle);
        if (answers.get) return json(res, ...answers.get(req, handle, seen));
        return handle === HANDLE ? json(res, 200, { work: work() }) : json(res, 404, { error: { code: "not_found", message: "Çalışma bulunamadı." } });
      }
      if (tail === "/resume") {
        seen.resumes.push({ handle, body });
        if (answers.resume) return json(res, ...answers.resume(req, body, seen));
        return json(res, 200, { work: work() });
      }
      if (tail === "/cancel") {
        seen.cancels.push({ handle, body });
        if (answers.cancel) return json(res, ...answers.cancel(req, body, seen));
        return json(res, 200, { work: work({ state: "cancelled", state_version: 2, reserved_bytes: 0 }) });
      }
    }
    if (req.method === "GET" && u.pathname === "/api/dev/theme") {
      seen.themeGets.push(req.url);
      return json(res, 200, { files: { "section/Hero": "old" }, protocol: 1 });
    }
    if (req.method === "POST" && u.pathname === "/api/dev/theme") {
      seen.pushes.push({ body, key: req.headers["x-idempotency-key"] });
      return body?.dryRun
        ? json(res, 200, { ok: true, dryRun: true, warnings: [] })
        : json(res, 200, { ok: true, committed: true, deploymentId: 1, sourceRevisionId: 2, pointerVersion: 3 });
    }
    res.writeHead(404).end();
  });
  return { server, seen };
}

async function withPlatform(answers, fn) {
  const { server, seen } = platform(answers);
  server.listen(0);
  await once(server, "listening");
  try {
    return await fn(`http://localhost:${server.address().port}`, seen);
  } finally {
    server.close();
  }
}

const HOME = mkdtempSync(join(tmpdir(), "blocofy-tcp-f2-home-"));
const env = (url, { api = true, dev = true } = {}) => {
  const e = { ...process.env, HOME };
  for (const k of ["BLOCOFY_URL", "BLOCOFY_TOKEN", "BLOCOFY_API_URL", "BLOCOFY_API_KEY", "BLOCOFY_CONTEXT"]) delete e[k];
  if (dev) Object.assign(e, { BLOCOFY_URL: url, BLOCOFY_TOKEN: TOKEN });
  if (api) Object.assign(e, { BLOCOFY_API_URL: url, BLOCOFY_API_KEY: API_KEY });
  return e;
};
const runBin = (url, argv, opts = {}) =>
  execFileP("node", [BIN, ...argv], { env: env(url, opts), cwd: opts.cwd }).then(
    (r) => ({ code: 0, ...r }),
    (e) => ({ code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" }),
  );
const lastLine = (stderr) => stderr.trimEnd().split("\n").at(-1);
const savedLocal = (dir) => JSON.parse(readFileSync(join(dir, ".blocofy", "local.json"), "utf8"));
const withDir = async (dir, fn) => {
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

// ── pure ───────────────────────────────────────────────────────────────────────────────────────────────────

test("themeWorkRefusal: every work code has a plain Turkish first line and a technical message", () => {
  const cases = [
    ["not_found", {}, /Çalışma bulunamadı/],
    ["not_found", { reason: "target_deleted" }, /teması silinmiş/],
    ["work_forbidden", {}, /başka bir bağlantıya ait/],
    ["work_forbidden", { reason: "revoked" }, /erişimi iptal edilmiş/],
    ["work_state_conflict", { state: "cancelled", stateVersion: 2 }, /uygun durumda değil.*iptal edildi/],
    ["work_stale", {}, /çalışma güncel değil/],
    ["work_sealed", {}, /incelemeye gönderildi/],
    ["work_base_unavailable", {}, /yayında bir teması yok/],
    ["quota_exceeded", { resource: "theme_bytes" }, /Tema alanı bu çalışma için yetmiyor/],
    ["capacity_unavailable", {}, /alanı doğrulayamadı/],
    ["resource_busy", {}, /meşgul/],
    ["idempotency_key_reuse", {}, /başka bir istekle kullanılmış/],
    ["forbidden_scope", {}, /yetkisi yok/],
  ];
  for (const [code, details, re] of cases) {
    const r = themeWorkRefusal(new CliRefusal(409, { code, message: "srv", details }), { op: "resume", handle: HANDLE });
    assert.match(r.lines[0], re, code);
    assert.match(r.message, /\(.+\)/, code);
    assert.deepEqual(r.details, details, code);
  }
  assert.match(themeWorkRefusal(new CliRefusal(404, { code: "not_found" }), { op: "start" }).lines[0], /henüz desteklemiyor/);
  assert.equal(themeWorkRefusal(new CliRefusal(409, { code: "something_else" }), {}), null);
});

test("staleLines: only for a stale work, reasons in words, nothing overwritten", () => {
  assert.equal(staleLines(work()), null);
  const lines = staleLines(work({ stale: true, stale_reasons: ["live_theme_changed", "live_settings_changed"] })).join("\n");
  assert.match(lines, /canlı tema değişti, canlı temanın ayarları değişti/);
  assert.match(lines, /hiçbir şeyin üzerine yazılmadı/);
});

test("saveWork / readSavedWork: keeps the context choice, never a secret, ignores another site's work", () =>
  withDir(projectDir({}, { context: "ksc" }), (dir) => {
    const binding = { root: dir, project: { site_id: 14 } };
    assert.equal(saveWork(binding, work()), true);
    const local = savedLocal(dir);
    assert.equal(local.context, "ksc");
    assert.equal(local.theme_work.handle, HANDLE);
    assert.equal(local.theme_work.theme, WORK_THEME);
    assert.doesNotMatch(JSON.stringify(local), /blcf_|bcf_/);
    assert.deepEqual(readSavedWork(binding), { handle: HANDLE, theme: WORK_THEME, intent: "Başlık" });
    assert.equal(readSavedWork({ root: dir, project: { site_id: 15 } }), null);
    saveWork(binding, null);
    assert.deepEqual(savedLocal(dir), { context: "ksc" });
  }));

// ── end to end (mock platform) ─────────────────────────────────────────────────────────────────────────────

test("work start: API key + Idempotency-Key + intent; prints the handle and next steps; saves it in local.json", () =>
  withDir(projectDir({}, { keep: "me" }), (dir) =>
    withPlatform({}, async (url, seen) => {
      const r = await runBin(url, ["theme", "work", "start", dir, "--intent", "Ana sayfa başlığı", "--idempotency-key", "key-00000001"]);
      assert.equal(r.code, 0, r.stdout + r.stderr);
      assert.deepEqual(seen.starts, [{ body: { intent: "Ana sayfa başlığı" }, key: "key-00000001" }]);
      assert.ok(seen.auth.every((a) => a === `Bearer ${API_KEY}`));
      assert.match(r.stdout, new RegExp(`Çalışma başlatıldı: ${HANDLE}`));
      assert.ok(r.stdout.includes(`--draft --work ${HANDLE}`), r.stdout);
      assert.match(r.stdout, /Canlı site değişmedi/);
      assert.doesNotMatch(r.stdout + r.stderr, new RegExp(API_KEY));
      assert.equal(savedLocal(dir).theme_work.handle, HANDLE);
      assert.equal(savedLocal(dir).keep, "me");
    })));

test("work start without flags: a default intent and a fresh cli-work-<uuid> key; the same key again is a replay", () =>
  withDir(projectDir(), (dir) =>
    withPlatform({}, async (url, seen) => {
      const first = await runBin(url, ["theme", "work", "start", dir, "--json"]);
      assert.equal(first.code, 0, first.stderr);
      const out = JSON.parse(first.stdout);
      assert.match(out.idempotency_key, /^cli-work-[0-9a-f-]{36}$/);
      assert.equal(seen.starts[0].body.intent, "CLI ile tema çalışması");
      assert.equal(out.work.id, HANDLE);
      const again = await runBin(url, ["theme", "work", "start", dir, "--idempotency-key", out.idempotency_key]);
      assert.equal(again.code, 0, again.stderr);
      assert.match(again.stdout, /yeni bir çalışma açılmadı/);
      assert.equal(seen.starts.length, 2);
      assert.equal(seen.starts[1].key, out.idempotency_key);
    })));

test("work start: a lost answer (500) says the outcome is unknown and names the SAME key to retry with; exit 1", () =>
  withDir(projectDir(), (dir) =>
    withPlatform({ start: () => [500, { error: { code: "internal_error", message: "x" } }] }, async (url, seen) => {
      const r = await runBin(url, ["theme", "work", "start", dir, "--idempotency-key", "key-00000009"]);
      assert.equal(r.code, 1, r.stderr);
      assert.match(r.stderr, /başlayıp başlamadığı bilinmiyor/);
      assert.ok(r.stderr.includes("--idempotency-key key-00000009"), r.stderr);
      assert.equal(seen.starts.length, 1, "a 500 is not resent");
      const json = await runBin(url, ["theme", "work", "start", dir, "--idempotency-key", "key-00000009", "--json"]);
      assert.equal(JSON.parse(lastLine(json.stderr)).error.details.idempotencyKey, "key-00000009");
    })));

test("work start: quota_exceeded is a definite refusal — Turkish first, error line last, exit 2, nothing saved", () =>
  withDir(projectDir(), (dir) =>
    withPlatform({ start: () => [422, { error: { code: "quota_exceeded", message: "Tema alanı yetmiyor.", details: { resource: "theme_bytes" } } }] }, async (url) => {
      const r = await runBin(url, ["theme", "work", "start", dir]);
      assert.equal(r.code, 2, r.stderr);
      assert.match(r.stderr, /Tema alanı bu çalışma için yetmiyor/);
      assert.match(lastLine(r.stderr), /^error \[quota_exceeded\]: /);
      assert.equal(existsSync(join(dir, ".blocofy", "local.json")), false);
      const j = await runBin(url, ["theme", "work", "start", dir, "--json"]);
      assert.deepEqual(JSON.parse(lastLine(j.stderr)).error.details, { resource: "theme_bytes", status: 422 });
      assert.doesNotMatch(j.stderr, /Tema alanı bu çalışma/);
    })));

test("work start on a platform without the endpoint (404) says it is not supported yet", () =>
  withDir(projectDir(), (dir) =>
    withPlatform({ start: () => [404, { error: { code: "not_found", message: "Böyle bir v1 ucu yok." } }] }, async (url) => {
      const r = await runBin(url, ["theme", "work", "start", dir]);
      assert.equal(r.code, 2);
      assert.match(r.stderr, /henüz desteklemiyor/);
    })));

test("work commands need the v1 API key: a dev token alone is refused before any request (LOGIN_REQUIRED)", () =>
  withDir(projectDir(), (dir) =>
    withPlatform({}, async (url, seen) => {
      const r = await runBin(url, ["theme", "work", "start", dir], { api: false });
      assert.equal(r.code, 1, r.stderr);
      assert.match(lastLine(r.stderr), /^error \[LOGIN_REQUIRED\]: API key required/);
      assert.equal(seen.starts.length, 0);
    })));

test("work start needs a bound project (it changes a site)", () =>
  withDir(mkdtempSync(join(tmpdir(), "blocofy-tcp-f2-unbound-")), (dir) =>
    withPlatform({}, async (url, seen) => {
      writeFileSync(join(dir, "x.txt"), "x");
      const r = await runBin(url, ["theme", "work", "start", dir]);
      assert.equal(r.code, 3, r.stderr);
      assert.match(lastLine(r.stderr), /TARGET_BINDING_REQUIRED/);
      assert.equal(seen.starts.length, 0);
    })));

test("status / resume / cancel need an explicit handle; a missing one suggests the saved work, never picks it", () =>
  withDir(projectDir({}, { theme_work: { handle: HANDLE, theme: WORK_THEME, intent: "Başlık", site_id: 14 } }), (dir) =>
    withPlatform({}, async (url, seen) => {
      for (const sub of ["status", "resume", "cancel"]) {
        const r = await runBin(url, ["theme", "work", sub, "--dir", dir]);
        assert.equal(r.code, 1, r.stderr);
        assert.ok(lastLine(r.stderr).includes(`saved work is ${HANDLE}`), r.stderr);
        const bad = await runBin(url, ["theme", "work", sub, "t7k2p9", "--dir", dir]);
        assert.equal(bad.code, 1);
        assert.match(lastLine(bad.stderr), /is not a work handle/);
      }
      assert.equal(seen.gets.length + seen.resumes.length + seen.cancels.length, 0);
    })));

test("work status: the work in words; a stale work says the site changed; --json is the wire work", () =>
  withDir(projectDir(), (dir) =>
    withPlatform({ get: () => [200, { work: work({ stale: true, stale_reasons: ["live_source_advanced"] }) }] }, async (url, seen) => {
      const r = await runBin(url, ["theme", "work", "status", HANDLE, "--dir", dir]);
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /Durum: {2}açık/);
      assert.match(r.stdout, /canlı temanın dosyaları değişti/);
      assert.deepEqual(seen.gets, [HANDLE]);
      const j = await runBin(url, ["theme", "work", "status", HANDLE, "--dir", dir, "--json"]);
      assert.equal(JSON.parse(j.stdout).work.id, HANDLE);
    })));

test("work status of another credential's work → work_forbidden, exit 2", () =>
  withDir(projectDir(), (dir) =>
    withPlatform({ get: () => [403, { error: { code: "work_forbidden", message: "Bu çalışma bu bağlantıya ait değil." } }] }, async (url) => {
      const r = await runBin(url, ["theme", "work", "status", OTHER, "--dir", dir]);
      assert.equal(r.code, 2);
      assert.match(r.stderr, /başka bir bağlantıya ait/);
      assert.match(lastLine(r.stderr), /^error \[work_forbidden\]: /);
    })));

test("work resume: --require-fresh is sent; the resumed work becomes the project's saved work", () =>
  withDir(projectDir({}, { keep: "me" }), (dir) =>
    withPlatform({}, async (url, seen) => {
      const r = await runBin(url, ["theme", "work", "resume", HANDLE, "--dir", dir, "--require-fresh"]);
      assert.equal(r.code, 0, r.stderr);
      assert.deepEqual(seen.resumes, [{ handle: HANDLE, body: { require_fresh: true } }]);
      assert.equal(savedLocal(dir).theme_work.handle, HANDLE);
      assert.equal(savedLocal(dir).keep, "me");
    })));

test("work resume of a stale work with --require-fresh → work_stale, exit 2, nothing saved", () =>
  withDir(projectDir(), (dir) =>
    withPlatform({ resume: () => [409, { error: { code: "work_stale", message: "x", details: { changed: ["live_theme_changed"] } } }] }, async (url) => {
      const r = await runBin(url, ["theme", "work", "resume", HANDLE, "--dir", dir, "--require-fresh"]);
      assert.equal(r.code, 2);
      assert.match(r.stderr, /çalışma güncel değil/);
      assert.equal(existsSync(join(dir, ".blocofy", "local.json")), false);
    })));

test("work cancel: reads state_version, sends it, forgets the saved work", () =>
  withDir(projectDir({}, { keep: "me", theme_work: { handle: HANDLE, theme: WORK_THEME, intent: "x", site_id: 14 } }), (dir) =>
    withPlatform({}, async (url, seen) => {
      const r = await runBin(url, ["theme", "work", "cancel", HANDLE, "--dir", dir]);
      assert.equal(r.code, 0, r.stderr);
      assert.deepEqual(seen.cancels, [{ handle: HANDLE, body: { expected_state_version: 1 } }]);
      assert.match(r.stdout, /iptal edildi/);
      assert.deepEqual(savedLocal(dir), { keep: "me" });
    })));

test("work cancel: a resend that meets its own earlier cancel is reported as cancelled; another conflict is exit 2", async () => {
  await withDir(projectDir(), (dir) =>
    withPlatform({ cancel: () => [409, { error: { code: "work_state_conflict", message: "x", details: { state: "cancelled", stateVersion: 2 } } }] }, async (url) => {
      const r = await runBin(url, ["theme", "work", "cancel", HANDLE, "--dir", dir]);
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /iptal edildi/);
    }));
  await withDir(projectDir(), (dir) =>
    withPlatform({ cancel: () => [409, { error: { code: "work_state_conflict", message: "x", details: { state: "sealed", stateVersion: 3 } } }] }, async (url) => {
      const r = await runBin(url, ["theme", "work", "cancel", HANDLE, "--dir", dir]);
      assert.equal(r.code, 2);
      assert.match(r.stderr, /incelemede/);
      assert.match(lastLine(r.stderr), /^error \[work_state_conflict\]: /);
    }));
});

test("push --draft --work: writes the work's own theme as a draft instance through the dev token, never live", () =>
  withDir(projectDir({ "section/Hero": "new" }), (dir) =>
    withPlatform({}, async (url, seen) => {
      const r = await runBin(url, ["theme", "push", dir, "--draft", "--work", HANDLE]);
      assert.equal(r.code, 0, r.stdout + r.stderr);
      assert.deepEqual(seen.gets, [HANDLE]);
      const applied = seen.pushes.filter((p) => !p.body.dryRun);
      assert.equal(applied.length, 1);
      assert.equal(applied[0].body.instance, WORK_THEME);
      assert.equal(applied[0].body.draft, true);
      assert.ok(seen.themeGets.every((g) => g.includes(`instance=${WORK_THEME}`)), seen.themeGets.join(","));
      assert.match(r.stdout, new RegExp(`Çalışma ${HANDLE} güncellendi`));
      assert.match(r.stdout, /Canlı site değişmedi/);
    })));

test("push --work without --draft is the same draft write (--work implies draft)", () =>
  withDir(projectDir({ "section/Hero": "new" }), (dir) =>
    withPlatform({}, async (url, seen) => {
      const r = await runBin(url, ["theme", "push", dir, "--work", HANDLE]);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(seen.pushes.filter((p) => !p.body.dryRun)[0].body.draft, true);
    })));

test("push --work refuses a work that is not open (sealed / cancelled) before any theme request", () =>
  withDir(projectDir(), (dir) =>
    withPlatform({ get: () => [200, { work: work({ state: "sealed", state_version: 4 }) }] }, async (url, seen) => {
      const r = await runBin(url, ["theme", "push", dir, "--draft", "--work", HANDLE]);
      assert.equal(r.code, 2, r.stderr);
      assert.match(r.stderr, /şu an değiştirilemez/);
      assert.match(lastLine(r.stderr), /^error \[work_state_conflict\]: /);
      assert.equal(seen.pushes.length + seen.themeGets.length, 0);
    })));

test("push --work with a deleted work theme (not_found target_deleted) → exit 2, no push", () =>
  withDir(projectDir(), (dir) =>
    withPlatform({ get: () => [404, { error: { code: "not_found", message: "x", details: { reason: "target_deleted" } } }] }, async (url, seen) => {
      const r = await runBin(url, ["theme", "push", dir, "--work", HANDLE]);
      assert.equal(r.code, 2);
      assert.match(r.stderr, /teması silinmiş/);
      assert.equal(seen.pushes.length, 0);
    })));

test("push --work: usage errors (bad handle, with --live, with --instance) and a missing API key, before any request", () =>
  withDir(projectDir(), (dir) =>
    withPlatform({}, async (url, seen) => {
      for (const argv of [["--work", "t7k2p9"], ["--work", HANDLE, "--live"], ["--work", HANDLE, "--instance", "t1"]]) {
        const r = await runBin(url, ["theme", "push", dir, ...argv]);
        assert.equal(r.code, 1, argv.join(" "));
        assert.match(lastLine(r.stderr), /^error \[USAGE\]: /);
      }
      const noKey = await runBin(url, ["theme", "push", dir, "--work", HANDLE], { api: false });
      assert.equal(noKey.code, 1);
      assert.match(lastLine(noKey.stderr), /LOGIN_REQUIRED/);
      assert.equal(seen.gets.length + seen.pushes.length, 0);
    })));

test("push without --work is unchanged: a plain draft push never calls the v1 theme-work API", () =>
  withDir(projectDir({ "section/Hero": "new" }), (dir) =>
    withPlatform({}, async (url, seen) => {
      const r = await runBin(url, ["theme", "push", dir, "--draft", "--instance", "t5draft"]);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(seen.gets.length + seen.starts.length, 0);
      assert.equal(seen.pushes.filter((p) => !p.body.dryRun)[0].body.instance, "t5draft");
    })));

test.after(() => rmSync(HOME, { recursive: true, force: true }));
