import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";

import { draftSyncErrorLine, themeCapacityRefusal } from "../lib/theme-sync.mjs";

// Theme-capacity program (ADR-0013), CLI half. A READ never creates a theme: `theme pull --draft` with no CLI draft is
// answered 404 `target_missing`. A draft push that needs a NEW draft can be refused by the theme-creation admission:
// 422 `quota_exceeded` (+ the typed meter in `details`), 503 `capacity_unavailable` / `resource_busy` (Retry-After) or
// 409 `source_stale`. Nothing was written in every case. The CLI says so in Turkish, in plain words first, keeps the
// technical `error [code]` line last (the `--json` envelope), and exits 2 for a 4xx refusal and 1 for a 5xx.

const execFileP = promisify(execFile);
const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "blocofy.mjs");
const TOKEN = "bcf_testtoken1234567890abcd";
const HASH = "ab".repeat(32);
const MB = 1024 * 1024;
const QUOTA_V2 = { resource: "storage_mb", metricVersion: "v2", usedBytes: 498 * MB, limitBytes: 500 * MB, estimateBytes: 12 * MB };
const QUOTA_V1 = { resource: "theme_drafts", metricVersion: "v1", used: 5, limit: 5 };

function themeDir(files = { "section/Hero": "H" }) {
  const dir = mkdtempSync(join(tmpdir(), "blocofy-tcp-f1-"));
  for (const [key, content] of Object.entries(files)) {
    const rel = `${key}.liquid`;
    mkdirSync(join(dir, rel.slice(0, rel.lastIndexOf("/"))), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  mkdirSync(join(dir, ".blocofy"), { recursive: true });
  writeFileSync(join(dir, ".blocofy", "project.json"), JSON.stringify({ schema_version: 1, site_id: 14, site_slug: "ksc", platform_origin: null }));
  return dir;
}

const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};

/**
 * A platform with no draft yet. `pullMissing`: `GET ?draft=1` answers 404 target_missing (the ADR-0013 D6 server).
 * `applyAnswers`: what each keyed apply attempt is answered, in order (the last one repeats) — `[status, body, headers]`.
 */
function platform({ pullMissing = false, applyAnswers = [] } = {}) {
  const seen = { themeGets: [], plans: [], applies: [], keyless: [] };
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url.includes("/api/dev/site")) return json(res, 200, { drafts: [] });
    if (req.method === "GET" && req.url.includes("/api/dev/whoami")) return json(res, 200, { site: { id: 14, slug: "ksc", name: "Ksc" }, liveThemeId: "t9live" });
    if (req.method === "GET" && req.url.includes("/api/dev/theme")) {
      seen.themeGets.push(req.url);
      if (pullMissing && req.url.includes("draft=1")) {
        return json(res, 404, { error: "target_missing", message: "Bu sitede henüz bir CLI taslağı yok. Önce `blocofy theme push --draft` ile oluştur." });
      }
      return json(res, 200, { files: { "section/Hero": "H" }, protocol: 1 });
    }
    if (req.method === "POST" && req.url.endsWith("/api/dev/theme")) {
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        const body = JSON.parse(raw || "{}");
        if (!req.headers["x-idempotency-key"]) {
          seen.keyless.push(body);
          return json(res, 200, { ok: true, instanceId: "t300", created: 1, updated: 0 });
        }
        if (body.dryRun) {
          seen.plans.push(body);
          return json(res, 200, {
            ok: true, dryRun: true, warnings: [], manifestHash: HASH, target: "draft", targetInstance: null,
            newDraft: true, pointerVersion: null, files: [{ path: "section/Hero", outcome: "created", digest: "cd".repeat(32) }],
          });
        }
        seen.applies.push({ body, key: req.headers["x-idempotency-key"] });
        const [status, answer, headers] = applyAnswers[Math.min(seen.applies.length - 1, applyAnswers.length - 1)];
        return json(res, status, answer, headers);
      });
      return;
    }
    res.writeHead(404).end();
  });
  return { server, seen };
}

async function withPlatform(opts, fn) {
  const { server, seen } = platform(opts);
  server.listen(0);
  await once(server, "listening");
  try {
    return await fn(`http://localhost:${server.address().port}`, seen);
  } finally {
    server.close();
  }
}

const env = (url) => ({ ...process.env, BLOCOFY_URL: url, BLOCOFY_TOKEN: TOKEN });
const runBin = (url, argv) =>
  execFileP("node", [BIN, ...argv], { env: env(url) }).then(
    (r) => ({ code: 0, ...r }),
    (e) => ({ code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" }),
  );

/** The last stderr line — the shared `error [code]: …` line (or the `--json` envelope). */
const lastLine = (stderr) => stderr.trimEnd().split("\n").at(-1);

// ── pure messages ──────────────────────────────────────────────────────────────────────────────────────────

test("themeCapacityRefusal: target_missing tells the user to create the draft with push --draft first", () => {
  const r = themeCapacityRefusal({ code: "target_missing", status: 404 }, { pushCommand: "blocofy theme push ./shop" });
  assert.match(r.lines[0], /^Bu sitede henüz bir CLI taslağı yok/);
  assert.match(r.lines.join("\n"), /blocofy theme push \.\/shop --draft/);
  assert.match(r.lines.join("\n"), /Hiçbir dosya yazılmadı/);
  assert.match(r.message, /No CLI draft/);
  assert.deepEqual(r.details, {});
});

test("themeCapacityRefusal: quota_exceeded shows the storage meter (V2) and never advises deleting a draft", () => {
  const r = themeCapacityRefusal({ code: "quota_exceeded", status: 422, body: { error: "quota_exceeded", details: QUOTA_V2 } }, { pushCommand: "blocofy theme push" });
  const text = r.lines.join("\n");
  assert.match(r.lines[0], /^Depolama alanın dolu/);
  assert.match(text, /498 MB \/ 500 MB/);
  assert.match(text, /12 MB/);
  assert.match(text, /Hiçbir şey yazılmadı/);
  assert.match(text, /Plan & faturalandırma/);
  assert.doesNotMatch(text, /sil|delete/i);
  assert.deepEqual(r.details, QUOTA_V2);
});

test("themeCapacityRefusal: quota_exceeded with a count meter (V1) and with no details at all", () => {
  const v1 = themeCapacityRefusal({ code: "quota_exceeded", status: 422, body: { details: QUOTA_V1 } }, {});
  assert.match(v1.lines.join("\n"), /5 \/ 5/);
  const bare = themeCapacityRefusal({ code: "quota_exceeded", status: 422, body: { error: "quota_exceeded" } }, {});
  assert.match(bare.lines[0], /sınırına ulaşıldı|dolu/);
  assert.doesNotMatch(bare.lines.join("\n"), /undefined|NaN/);
  assert.deepEqual(bare.details, {});
});

test("themeCapacityRefusal: capacity_unavailable / resource_busy say try again later and pass the server's Retry-After", () => {
  for (const code of ["capacity_unavailable", "resource_busy"]) {
    const r = themeCapacityRefusal({ code, status: 503, retryAfter: "5" }, {});
    assert.match(r.lines.join("\n"), /Biraz sonra tekrar dene/);
    assert.match(r.lines.join("\n"), /Hiçbir şey yazılmadı/);
    assert.equal(r.details.retryAfterSeconds, 5);
  }
  assert.match(themeCapacityRefusal({ code: "resource_busy", status: 503 }, {}).lines[0], /meşgul/);
  assert.equal("retryAfterSeconds" in themeCapacityRefusal({ code: "resource_busy", status: 503 }, {}).details, false);
});

test("themeCapacityRefusal: source_stale says the live theme changed and to run the command again", () => {
  const r = themeCapacityRefusal({ code: "source_stale", status: 409 }, { pushCommand: "blocofy theme push" });
  assert.match(r.lines[0], /^Canlı tema bu sırada değişti/);
  assert.match(r.lines.join("\n"), /blocofy theme push/);
  assert.match(r.lines.join("\n"), /Hiçbir şey yazılmadı/);
});

test("themeCapacityRefusal: a refusal of a RESENT apply never claims nothing was written", () => {
  const r = themeCapacityRefusal({ code: "capacity_unavailable", status: 503, phase: "apply", earlierAttempt: "unknown" }, {});
  const text = r.lines.join("\n");
  assert.doesNotMatch(text, /Hiçbir şey yazılmadı/);
  assert.match(text, /bilinmiyor/);
  assert.match(text, /blocofy status/);
  assert.equal(r.details.earlierAttempt, "unknown");
  assert.doesNotMatch(r.message, /Nothing was written/);
});

test("themeCapacityRefusal: any other code is not handled here (null), draft_target_ambiguous included", () => {
  for (const code of ["draft_target_ambiguous", "draft_target_unverifiable", "idempotency_conflict", undefined]) {
    assert.equal(themeCapacityRefusal({ code, status: 409 }, {}), null);
  }
});

test("draftSyncErrorLine (theme dev): one Turkish line per capacity refusal", () => {
  assert.match(draftSyncErrorLine({ code: "quota_exceeded", body: { details: QUOTA_V2 } }), /^draft sync: Depolama alanın dolu.*498 MB \/ 500 MB/);
  assert.match(draftSyncErrorLine({ code: "capacity_unavailable" }), /^draft sync: .*Biraz sonra tekrar dene/);
  assert.match(draftSyncErrorLine({ code: "resource_busy" }), /^draft sync: .*meşgul/);
  assert.match(draftSyncErrorLine({ code: "source_stale" }), /^draft sync: Canlı tema bu sırada değişti/);
  for (const code of ["quota_exceeded", "capacity_unavailable", "resource_busy", "source_stale"]) {
    assert.equal(draftSyncErrorLine({ code }).includes("\n"), false);
  }
  // Unchanged #989 lines.
  assert.match(draftSyncErrorLine({ code: "draft_target_unverifiable" }), /could not verify which draft/);
  assert.match(draftSyncErrorLine({ message: "boom" }), /^draft sync failed: boom$/);
});

// ── end to end (mock platform) ─────────────────────────────────────────────────────────────────────────────

test("pull --draft with no CLI draft: 404 target_missing → push --draft advice, exit 2, one request, nothing written", async () => {
  const dir = themeDir({});
  try {
    await withPlatform({ pullMissing: true }, async (url, seen) => {
      const r = await runBin(url, ["theme", "pull", dir, "--draft"]);
      assert.equal(r.code, 2, r.stdout + r.stderr);
      assert.match(r.stderr, /Bu sitede henüz bir CLI taslağı yok/);
      assert.ok(r.stderr.includes(`blocofy theme push ${dir} --draft`), r.stderr);
      assert.match(lastLine(r.stderr), /^error \[target_missing\]: /);
      assert.equal(seen.themeGets.filter((u) => u.includes("draft=1")).length, 1);
      assert.equal(existsSync(join(dir, "section")), false);
      assert.doesNotMatch(r.stdout, /Downloaded/);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pull --draft --json: target_missing is the machine envelope only (last stderr line)", async () => {
  const dir = themeDir({});
  try {
    await withPlatform({ pullMissing: true }, async (url) => {
      const r = await runBin(url, ["theme", "pull", dir, "--draft", "--json"]);
      assert.equal(r.code, 2, r.stderr);
      const envelope = JSON.parse(lastLine(r.stderr));
      assert.equal(envelope.error.code, "target_missing");
      assert.equal(envelope.error.details.status, 404);
      assert.doesNotMatch(r.stderr, /Bu sitede henüz/);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("push (new draft) refused 422 quota_exceeded: the meter is shown, exit 2, the apply is not resent", async () => {
  const dir = themeDir();
  try {
    await withPlatform({ applyAnswers: [[422, { error: "quota_exceeded", message: "…", details: QUOTA_V2 }]] }, async (url, seen) => {
      const r = await runBin(url, ["theme", "push", dir]);
      assert.equal(r.code, 2, r.stdout + r.stderr);
      assert.match(r.stderr, /Depolama alanın dolu/);
      assert.match(r.stderr, /498 MB \/ 500 MB/);
      assert.doesNotMatch(r.stderr, /sil|delete/i);
      assert.match(lastLine(r.stderr), /^error \[quota_exceeded\]: /);
      assert.equal(seen.applies.length, 1);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("push --json quota_exceeded: the envelope carries the server's meter in details", async () => {
  const dir = themeDir();
  try {
    await withPlatform({ applyAnswers: [[422, { error: "quota_exceeded", message: "…", details: QUOTA_V2 }]] }, async (url) => {
      const r = await runBin(url, ["theme", "push", dir, "--json"]);
      assert.equal(r.code, 2, r.stderr);
      const envelope = JSON.parse(lastLine(r.stderr));
      assert.equal(envelope.error.code, "quota_exceeded");
      assert.equal(envelope.error.details.usedBytes, QUOTA_V2.usedBytes);
      assert.equal(envelope.error.details.status, 422);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("push refused 503 capacity_unavailable: retried within the policy (Retry-After honoured), then 'try later', exit 1", async () => {
  const dir = themeDir();
  try {
    await withPlatform({ applyAnswers: [[503, { error: "capacity_unavailable", message: "…" }, { "retry-after": "0" }]] }, async (url, seen) => {
      const r = await runBin(url, ["theme", "push", dir]);
      assert.equal(r.code, 1, r.stdout + r.stderr);
      assert.equal(seen.applies.length, 4); // 1 + 3 retries, all under the SAME key
      assert.equal(new Set(seen.applies.map((a) => a.key)).size, 1);
      assert.match(r.stderr, /retrying in 0s \(1\/3\)/);
      assert.match(r.stderr, /Biraz sonra tekrar dene/);
      assert.match(r.stderr, /Hiçbir şey yazılmadı/);
      // A definite "nothing written" answer, never the unknown-outcome advice.
      assert.doesNotMatch(r.stderr, /unknown|bilinmiyor/);
      assert.match(lastLine(r.stderr), /^error \[capacity_unavailable\]: /);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("push refused 503 resource_busy: the server's Retry-After paces the retries; 'site busy' message, exit 1", async () => {
  const dir = themeDir();
  try {
    await withPlatform({ applyAnswers: [[503, { error: "resource_busy", message: "…" }, { "retry-after": "1" }]] }, async (url, seen) => {
      const r = await runBin(url, ["theme", "push", dir]);
      assert.equal(r.code, 1, r.stdout + r.stderr);
      assert.equal(seen.applies.length, 4);
      assert.match(r.stderr, /retrying in 1s \(3\/3\)/);
      assert.match(r.stderr, /meşgul/);
      assert.doesNotMatch(r.stderr, /unknown|bilinmiyor/);
      assert.match(lastLine(r.stderr), /^error \[resource_busy\]: /);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("push: an apply whose earlier attempt had no definite answer, then resource_busy, does not claim nothing was written", async () => {
  const dir = themeDir();
  try {
    const answers = [[503, { error: "control_plane_unavailable" }, { "retry-after": "0" }], [503, { error: "resource_busy", message: "…" }, { "retry-after": "0" }]];
    await withPlatform({ applyAnswers: answers }, async (url) => {
      const r = await runBin(url, ["theme", "push", dir]);
      assert.equal(r.code, 1, r.stdout + r.stderr);
      assert.match(r.stderr, /meşgul/);
      assert.match(r.stderr, /bilinmiyor/);
      assert.doesNotMatch(r.stderr, /Hiçbir şey yazılmadı/);
      assert.match(lastLine(r.stderr), /^error \[resource_busy\]: /);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("push refused 409 source_stale: live changed → run it again, exit 2, not resent", async () => {
  const dir = themeDir();
  try {
    await withPlatform({ applyAnswers: [[409, { error: "source_stale", message: "…" }]] }, async (url, seen) => {
      const r = await runBin(url, ["theme", "push", dir]);
      assert.equal(r.code, 2, r.stdout + r.stderr);
      assert.equal(seen.applies.length, 1);
      assert.match(r.stderr, /Canlı tema bu sırada değişti/);
      assert.match(r.stderr, /Hiçbir şey yazılmadı/);
      assert.match(lastLine(r.stderr), /^error \[source_stale\]: /);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("help: theme pull --draft is read-only — it never claims to create the draft and points to push --draft", async () => {
  const r = await execFileP("node", [BIN, "--help"]);
  const section = r.stdout.slice(r.stdout.indexOf("blocofy theme pull"), r.stdout.indexOf("blocofy theme push"));
  assert.doesNotMatch(section, /creates the draft if missing/);
  assert.match(section, /never creates/);
  assert.match(section, /theme push --draft/);
});

// ── G2 acceptance: the wording branches on details.resource ───────────────────────────────────────────────

const THEME_BYTES = { resource: "theme_bytes", protectionVersion: "tp1", policyVersion: 3, usedBytes: 49 * MB, estimateBytes: 2 * MB, allowanceBytes: 50 * MB };

test("quota_exceeded theme_bytes: the site's theme space is full — free space or contact support; no plan upgrade, no 'new draft'", () => {
  const r = themeCapacityRefusal({ code: "quota_exceeded", status: 422, body: { error: "quota_exceeded", details: THEME_BYTES } }, { pushCommand: "blocofy theme push" });
  const text = r.lines.join("\n");
  assert.match(r.lines[0], /^Sitenin tema alanı dolu/);
  assert.match(text, /49 MB \/ 50 MB/);
  assert.match(text, /2 MB/);
  assert.match(text, /taslak temayı sil/);
  assert.match(text, /arşivle/);
  assert.match(text, /destek/);
  assert.match(text, /Hiçbir şey yazılmadı/);
  for (const s of [text, r.short, r.message]) {
    assert.doesNotMatch(s, /plan|Plan & faturalandırma|yükselt|upgrade/i);
    assert.doesNotMatch(s, /yeni taslak|new draft/i);
  }
  assert.doesNotMatch(text, /tp1|policyVersion|v2|v1/);
  assert.equal(r.details.resource, "theme_bytes");
  assert.match(draftSyncErrorLine({ code: "quota_exceeded", body: { details: THEME_BYTES } }), /^draft sync: Sitenin tema alanı dolu/);
});

test("quota_exceeded theme_drafts (legacy count): keeps the plan message", () => {
  const r = themeCapacityRefusal({ code: "quota_exceeded", status: 422, body: { details: QUOTA_V1 } }, {});
  const text = r.lines.join("\n");
  assert.match(r.lines[0], /^Planının sınırına ulaşıldı/);
  assert.match(text, /Plan & faturalandırma/);
  assert.match(text, /Taslak tema sayısı: 5 \/ 5/);
  assert.doesNotMatch(text, /Sitenin tema alanı/);
});

test("capacity_unavailable: a temporary platform-side refusal — try again later; never the plan, never 'new draft'", () => {
  const r = themeCapacityRefusal({ code: "capacity_unavailable", status: 503, retryAfter: "5", body: { error: "capacity_unavailable", details: { resource: "theme_bytes", reason: "unavailable" } } }, {});
  const text = r.lines.join("\n");
  assert.match(r.lines[0], /geçici/);
  assert.match(text, /Biraz sonra tekrar dene \(en az 5 sn sonra\)/);
  for (const s of [text, r.short, r.message]) {
    assert.doesNotMatch(s, /plan|yükselt|upgrade|dolu/i);
    assert.doesNotMatch(s, /yeni taslak|new draft/i);
  }
});

test("push --draft --instance to an EXISTING draft refused theme_bytes: space wording, no plan upgrade, no 'new draft'; exit 2", async () => {
  const dir = themeDir();
  try {
    await withPlatform({ applyAnswers: [[422, { error: "quota_exceeded", message: "…", details: THEME_BYTES }]] }, async (url, seen) => {
      const r = await runBin(url, ["theme", "push", dir, "--draft", "--instance", "t300"]);
      assert.equal(r.code, 2, r.stdout + r.stderr);
      assert.equal(seen.applies.length, 1);
      assert.match(r.stderr, /Sitenin tema alanı dolu/);
      assert.match(r.stderr, /taslak temayı sil/);
      assert.doesNotMatch(r.stderr, /Plan & faturalandırma|planını yükselt|yeni taslak/i);
      assert.match(lastLine(r.stderr), /^error \[quota_exceeded\]: /);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
