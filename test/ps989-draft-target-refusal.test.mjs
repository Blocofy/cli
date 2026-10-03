import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";

import { DRAFT_TARGET_AMBIGUOUS, draftTargetAmbiguousMessage, findCliDraft } from "../lib/theme-sync.mjs";

// #989 (platform): the server no longer GUESSES which draft a draft push / `pull --draft` / `theme dev` sync writes to.
// When it cannot prove the draft is the CLI's (several candidates, a site-state restore draft, a draft without the
// platform-generated "CLI Draft" name) it answers 409 `draft_target_ambiguous` with the candidate handles, having
// written nothing. The CLI says why, lists the candidates, names the exact `--instance` command, exits non-zero and
// never retries. `findCliDraft` mirrors the rule so `push --diff` and the merge probe never read a draft the push
// would refuse.

const execFileP = promisify(execFile);
const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "blocofy.mjs");
const TOKEN = "bcf_testtoken1234567890abcd";
const HASH = "ab".repeat(32);
const RESTORE = { id: "t31restore", name: "Site State · 0123456789ab", source: "import" };
const CLI = { id: "t43cli", name: "CLI Draft — 2026-10-01", source: "import" };
const REFUSAL = {
  error: "draft_target_ambiguous",
  reason: "site_state_restore",
  candidates: [{ instance: "t43cli", name: "CLI Draft — 2026-10-01" }],
  message: "…",
};

function themeDir(files = { "section/Hero": "H" }) {
  const dir = mkdtempSync(join(tmpdir(), "blocofy-ps989-"));
  for (const [key, content] of Object.entries(files)) {
    const rel = `${key}.liquid`;
    mkdirSync(join(dir, rel.slice(0, rel.lastIndexOf("/"))), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  mkdirSync(join(dir, ".blocofy"), { recursive: true });
  writeFileSync(join(dir, ".blocofy", "project.json"), JSON.stringify({ schema_version: 1, site_id: 14, site_slug: "ksc", platform_origin: null }));
  return dir;
}

const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

/** A platform whose theme endpoint refuses the draft pick (`refuseDraft`) and records every theme request. */
function platform({ drafts = [], refuseDraft = false, liveThemeId = "t9live", refuseApplyAfter503 = false, unverifiable = false, liveDraft422 = false }) {
  const seen = { themeGets: [], posts: [], publishes: [] };
  let applyAttempts = 0;
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url.includes("/api/dev/site")) return json(res, 200, { drafts });
    if (req.method === "GET" && req.url.includes("/api/dev/whoami")) return json(res, 200, { site: { id: 14, slug: "ksc", name: "Ksc" }, liveThemeId });
    if (req.method === "GET" && req.url.includes("/api/dev/session")) return json(res, 410, { error: "retired" });
    if (req.method === "GET" && req.url.includes("/api/dev/theme")) {
      seen.themeGets.push(req.url);
      if (refuseDraft && req.url.includes("draft=1")) return json(res, 409, REFUSAL);
      return json(res, 200, { files: {}, protocol: 1 });
    }
    if (req.method === "POST" && req.url.endsWith("/api/dev/publish")) {
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        seen.publishes.push(JSON.parse(raw || "{}"));
        json(res, 200, { ok: true, published: "t43cli", cloned: false });
      });
      return;
    }
    if (req.method === "POST" && req.url.endsWith("/api/dev/theme")) {
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        const body = JSON.parse(raw || "{}");
        seen.posts.push(body);
        if (refuseDraft && body.draft) return json(res, 409, REFUSAL);
        if (unverifiable && body.draft) return json(res, 503, { error: "draft_target_unverifiable", message: "…" });
        if (liveDraft422 && body.draft && body.instance) return json(res, 422, { error: "draft_target_is_live", instance: body.instance, message: "…" });
        if (refuseApplyAfter503 && !body.dryRun) {
          applyAttempts += 1;
          return applyAttempts === 1 ? json(res, 503, { error: "control_plane_unavailable" }) : json(res, 409, REFUSAL);
        }
        if (body.dryRun) {
          return json(res, 200, {
            ok: true, dryRun: true, warnings: [], manifestHash: HASH, target: "draft", targetInstance: body.instance ?? null,
            newDraft: false, pointerVersion: 1, files: [{ path: "section/Hero", outcome: "updated", digest: "cd".repeat(32) }],
          });
        }
        if (!req.headers["x-idempotency-key"]) return json(res, 200, { ok: true, instanceId: body.instance ?? "t300", created: 1, updated: 0 });
        return json(res, 200, {
          committed: true, deploymentId: 1, sourceRevisionId: 1, pointerVersion: 2,
          files: [{ path: "section/Hero", outcome: "updated", digest: "cd".repeat(32) }],
          readback: { verified: true, files: 1, settings: true }, manifestHash: HASH, targetInstance: body.instance ?? null,
        });
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

test("#989 findCliDraft: only a single, CLI-named, non-restore import draft is picked", () => {
  assert.equal(findCliDraft({ drafts: [] }), null);
  assert.equal(findCliDraft({ drafts: [{ id: "t2", name: "Copy", source: "duplicate" }] }), null);
  assert.deepEqual(findCliDraft({ drafts: [CLI] }), CLI);
  const refused = (drafts) => {
    try {
      findCliDraft({ drafts });
    } catch (error) {
      assert.equal(error.code, DRAFT_TARGET_AMBIGUOUS);
      assert.equal(error.status, 409);
      return error;
    }
    assert.fail("expected a refusal");
  };
  assert.equal(refused([RESTORE]).reason, "site_state_restore");
  assert.equal(refused([{ id: "t50", name: "Re-test draft", source: "import" }]).reason, "unrecognized_name");
  const two = refused([CLI, { ...CLI, id: "t44", name: "CLI Draft" }]);
  assert.equal(two.reason, "multiple_candidates");
  assert.deepEqual(two.candidates, [
    { instance: "t43cli", name: "CLI Draft — 2026-10-01", restore: false },
    { instance: "t44", name: "CLI Draft" , restore: false },
  ]);
  // #989 review P2: a --name draft ("CLI Draft — <name>") is the CLI's; a hand-renamed one is not.
  assert.deepEqual(findCliDraft({ drafts: [{ id: "t45", name: "CLI Draft — Mockup v2", source: "import" }] })?.id, "t45");
  assert.equal(refused([{ id: "t46", name: "Mockup v2", source: "import" }]).reason, "unrecognized_name");
  // Restore draft with the LOWER id next to a CLI draft: still refused, the restore is flagged.
  const mixed = refused([RESTORE, CLI]);
  assert.equal(mixed.reason, "site_state_restore");
  assert.deepEqual(mixed.candidates.map((c) => c.restore), [true, false]);
});

test("#989 review P1: the message never pre-fills --instance with a protected draft (restore-only site)", () => {
  const msg = draftTargetAmbiguousMessage(
    { reason: "site_state_restore", candidates: [{ instance: "t31restore", name: "Site State · 0123456789ab", restore: true }], suggestedInstance: null },
    { command: "blocofy theme push ./shop" },
  );
  assert.match(msg, /site-state restore/);
  assert.match(msg, /Nothing was written/);
  assert.match(msg, /t31restore {2}"Site State · 0123456789ab" {2}\(site-state restore draft\)/);
  assert.doesNotMatch(msg, /--instance t31restore/);
  assert.match(msg, /blocofy theme push \.\/shop --instance <handle>/);
  assert.match(msg, /would OVERWRITE it/);
  assert.match(msg, /create a new draft theme in the admin panel/);
  assert.match(msg, /publish or delete the site-state restore draft first/);
});

test("#989 review P1: restore draft with the LOWER id + a CLI draft — only the CLI draft is pre-filled, the restore is warned about", () => {
  for (const err of [
    // server shape (with suggestedInstance) and a local refusal (computed from the flags/names)
    { reason: "site_state_restore", candidates: [{ instance: "t20", name: "Restored copy", restore: true }, { instance: "t43cli", name: "CLI Draft — 2026-10-01", restore: false }], suggestedInstance: "t43cli" },
    { reason: "site_state_restore", candidates: [{ instance: "t20", name: "Site State · 0123456789ab" }, { instance: "t43cli", name: "CLI Draft — 2026-10-01" }] },
  ]) {
    const msg = draftTargetAmbiguousMessage(err, { command: "blocofy theme push" });
    assert.match(msg, /To use the CLI draft: {2}blocofy theme push --instance t43cli/);
    assert.doesNotMatch(msg, /--instance t20/);
    assert.match(msg, /naming t20 with --instance would OVERWRITE it \(including the restore's work\)/);
  }
});

test("#989 review P3: a refusal of a RESENT apply never claims nothing was written", () => {
  const msg = draftTargetAmbiguousMessage({ reason: "multiple_candidates", candidates: [] }, { earlierAttempt: "unknown" });
  assert.doesNotMatch(msg, /Nothing was written/);
  assert.match(msg, /earlier attempt of this push got no answer, so whether it wrote is unknown/);
  assert.match(msg, /blocofy status/);
});

test("#989 push (default draft) with a site-state restore draft: refused locally before any theme request, exit 2", async () => {
  const dir = themeDir();
  try {
    await withPlatform({ drafts: [RESTORE] }, async (url, seen) => {
      const r = await runBin(url, ["theme", "push", dir]);
      assert.equal(r.code, 2, r.stdout + r.stderr);
      assert.match(r.stderr, /draft_target_ambiguous/);
      assert.match(r.stderr, /t31restore/);
      assert.match(r.stderr, new RegExp(`blocofy theme push ${dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} --instance <handle>`));
      assert.doesNotMatch(r.stderr, /--instance t31restore/);
      assert.deepEqual(seen.posts, []);
      assert.deepEqual(seen.themeGets, []);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#989 push: the SERVER's refusal (e.g. a CLI-named draft a restore deployed to) is shown, exit 2, no apply, no retry", async () => {
  const dir = themeDir();
  try {
    await withPlatform({ drafts: [CLI], refuseDraft: true }, async (url, seen) => {
      const r = await runBin(url, ["theme", "push", dir, "--draft"]);
      assert.equal(r.code, 2, r.stdout + r.stderr);
      assert.match(r.stderr, /belongs to a site-state restore/);
      assert.match(r.stderr, /--instance t43cli/);
      assert.equal(seen.posts.length, 1, "only the dry run was sent");
      assert.equal(seen.posts[0].dryRun, true);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#989 push --diff on a draft push with two candidate drafts: refused (no diff against a guessed draft)", async () => {
  const dir = themeDir();
  try {
    await withPlatform({ drafts: [CLI, { ...CLI, id: "t44", name: "CLI Draft" }] }, async (url, seen) => {
      const r = await runBin(url, ["theme", "push", dir, "--diff"]);
      assert.equal(r.code, 2, r.stdout + r.stderr);
      assert.match(r.stderr, /more than one draft/);
      assert.match(r.stderr, /--diff --instance t43cli/);
      assert.deepEqual(seen.themeGets, []);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#989 explicit --instance <restore draft> goes through (the operator chose it)", async () => {
  const dir = themeDir();
  try {
    await withPlatform({ drafts: [RESTORE] }, async (url, seen) => {
      const r = await runBin(url, ["theme", "push", dir, "--instance", "t31restore"]);
      assert.equal(r.code, 0, r.stdout + r.stderr);
      assert.ok(seen.posts.length >= 1 && seen.posts.every((p) => p.instance === "t31restore" && !p.draft));
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#989 --instance <the LIVE theme's handle> needs the --live confirmation: non-TTY without --yes aborts, nothing sent", async () => {
  const dir = themeDir();
  try {
    await withPlatform({ drafts: [] }, async (url, seen) => {
      const r = await runBin(url, ["theme", "push", dir, "--instance", "t9live"]);
      assert.equal(r.code, 1, r.stdout + r.stderr);
      assert.match(r.stderr, /is the LIVE theme/);
      assert.deepEqual(seen.posts, []);
      const ok = await runBin(url, ["theme", "push", dir, "--instance", "t9live", "--yes"]);
      assert.equal(ok.code, 0, ok.stdout + ok.stderr);
      assert.ok(seen.posts.length >= 1);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#989 pull --draft: the server's 409 is shown with the pull --instance command; exit 2, one request, nothing written", async () => {
  const parent = mkdtempSync(join(tmpdir(), "blocofy-ps989-pull-"));
  const dir = themeDir({});
  try {
    await withPlatform({ refuseDraft: true }, async (url, seen) => {
      const r = await runBin(url, ["theme", "pull", dir, "--draft"]);
      assert.equal(r.code, 2, r.stdout + r.stderr);
      assert.match(r.stderr, /draft_target_ambiguous/);
      assert.match(r.stderr, /blocofy theme pull .* --instance t43cli/);
      assert.equal(seen.themeGets.filter((u) => u.includes("draft=1")).length, 1);
      assert.equal(existsSync(join(dir, "section")), false);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  }
});

test("#989 theme dev: a refused draft sync stops the command with the message (exit 2), no retry loop", async () => {
  const dir = themeDir();
  try {
    await withPlatform({ refuseDraft: true }, async (url, seen) => {
      const probe = createServer().listen(0);
      await once(probe, "listening");
      const port = String(probe.address().port);
      probe.close();
      const child = spawn("node", [BIN, "theme", "dev", dir, "--port", port], { env: env(url), stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (d) => (stderr += d));
      const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
      const [code] = await once(child, "exit");
      clearTimeout(timer);
      assert.equal(code, 2, stderr);
      assert.match(stderr, /Refused to pick a draft automatically/);
      assert.match(stderr, /blocofy theme dev .* --instance t43cli/);
      assert.equal(seen.posts.length, 1);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#989 theme dev --instance <live handle> is refused before anything is sent", async () => {
  const dir = themeDir();
  try {
    await withPlatform({}, async (url, seen) => {
      const r = await runBin(url, ["theme", "dev", dir, "--instance", "t9live", "--dry"]);
      assert.equal(r.code, 2, r.stdout + r.stderr);
      assert.match(r.stderr, /the LIVE theme/);
      assert.deepEqual(seen.posts, []);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#989 review P2: theme publish without --instance never publishes a guessed draft (restore-only site): exit 2, nothing published", async () => {
  const dir = themeDir();
  try {
    await withPlatform({ drafts: [RESTORE] }, async (url, seen) => {
      const r = await runBin(url, ["theme", "publish", dir]);
      assert.equal(r.code, 2, r.stdout + r.stderr);
      assert.match(r.stderr, /Nothing was published/);
      assert.match(r.stderr, /would PUBLISH it live/);
      assert.doesNotMatch(r.stderr, /--instance t31restore/);
      assert.deepEqual(seen.publishes, []);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#989 review P2: theme publish picks the single CLI draft; with only non-CLI drafts it asks for --instance", async () => {
  const dir = themeDir();
  try {
    await withPlatform({ drafts: [{ id: "t2dup", name: "Copy", source: "duplicate" }, CLI] }, async (url, seen) => {
      const r = await runBin(url, ["theme", "publish", dir]);
      assert.equal(r.code, 0, r.stdout + r.stderr);
      assert.deepEqual(seen.publishes, [{ instanceId: "t43cli" }]);
    });
    await withPlatform({ drafts: [{ id: "t2dup", name: "Copy", source: "duplicate" }] }, async (url, seen) => {
      const r = await runBin(url, ["theme", "publish", dir]);
      assert.equal(r.code, 1, r.stdout + r.stderr);
      assert.match(r.stderr, /No CLI draft to publish/);
      assert.deepEqual(seen.publishes, []);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#989 review P2: push --draft --instance <draft> sends draft:true WITH the instance", async () => {
  const dir = themeDir();
  try {
    await withPlatform({ drafts: [RESTORE] }, async (url, seen) => {
      const r = await runBin(url, ["theme", "push", dir, "--draft", "--instance", "t31restore"]);
      assert.equal(r.code, 0, r.stdout + r.stderr);
      assert.ok(seen.posts.length >= 1 && seen.posts.every((p) => p.instance === "t31restore" && p.draft === true));
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#989 review P2: push --draft --instance <live handle | raw numeric id | live unknown> is refused locally, nothing sent", async () => {
  const dir = themeDir();
  try {
    for (const [opts, instance] of [
      [{}, "t9live"],
      [{}, "9"],
      [{ liveThemeId: null }, "t43cli"],
    ]) {
      await withPlatform(opts, async (url, seen) => {
        const r = await runBin(url, ["theme", "push", dir, "--draft", "--instance", instance]);
        assert.equal(r.code, 2, r.stdout + r.stderr);
        assert.match(r.stderr, /a draft push never writes live/);
        assert.deepEqual(seen.posts, []);
      });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#989 review P2: the server's 422 draft_target_is_live is reported (exit 2)", async () => {
  const dir = themeDir();
  try {
    await withPlatform({ liveDraft422: true }, async (url) => {
      const r = await runBin(url, ["theme", "push", dir, "--draft", "--instance", "t43cli"]);
      assert.equal(r.code, 2, r.stdout + r.stderr);
      assert.match(r.stderr, /draft_target_is_live/);
      assert.match(r.stderr, /cannot write the LIVE theme/);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#989 review P2: --instance without --draft is fail-closed live — raw numeric id or unknown live needs --yes", async () => {
  const dir = themeDir();
  try {
    for (const [opts, instance] of [
      [{}, "9"],
      [{ liveThemeId: null }, "t43cli"],
    ]) {
      await withPlatform(opts, async (url, seen) => {
        const r = await runBin(url, ["theme", "push", dir, "--instance", instance]);
        assert.equal(r.code, 1, r.stdout + r.stderr);
        assert.match(r.stderr, /may be the LIVE theme/);
        assert.deepEqual(seen.posts, []);
      });
    }
    // A known draft handle next to a known live theme: no prompt.
    await withPlatform({}, async (url) => {
      const r = await runBin(url, ["theme", "push", dir, "--instance", "t43cli"]);
      assert.equal(r.code, 0, r.stdout + r.stderr);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#989 review P3: a refusal on the RESENT apply says the earlier attempt's outcome is unknown and how to check", async () => {
  const dir = themeDir();
  try {
    await withPlatform({ drafts: [CLI], refuseApplyAfter503: true }, async (url) => {
      const r = await runBin(url, ["theme", "push", dir]);
      assert.equal(r.code, 2, r.stdout + r.stderr);
      assert.match(r.stderr, /draft_target_ambiguous/);
      assert.doesNotMatch(r.stderr, /Nothing was written/);
      assert.match(r.stderr, /earlier attempt of this push got no answer, so whether it wrote is unknown/);
      assert.match(r.stderr, /blocofy status/);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#989 review P3: 503 draft_target_unverifiable on push is a clear message, not an unknown-outcome guess", async () => {
  const dir = themeDir();
  try {
    await withPlatform({ drafts: [CLI], unverifiable: true }, async (url) => {
      const r = await runBin(url, ["theme", "push", dir]);
      assert.notEqual(r.code, 0);
      assert.match(r.stderr, /could not verify which draft this push would write to/);
      assert.match(r.stderr, /Nothing was written/);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#989 review P2: theme dev --instance <draft> syncs with draft:true AND the instance", async () => {
  const dir = themeDir();
  try {
    await withPlatform({}, async (url, seen) => {
      const probe = createServer().listen(0);
      await once(probe, "listening");
      const port = String(probe.address().port);
      probe.close();
      const child = spawn("node", [BIN, "theme", "dev", dir, "--port", port, "--instance", "t43cli"], { env: env(url), stdio: ["ignore", "pipe", "pipe"] });
      const deadline = Date.now() + 10000;
      while (seen.posts.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      child.kill("SIGKILL");
      await once(child, "exit");
      assert.equal(seen.posts.length >= 1, true);
      assert.equal(seen.posts[0].instance, "t43cli");
      assert.equal(seen.posts[0].draft, true);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Run `theme dev` against `url` until `until(stderr)` holds or it exits; returns { code, stderr }. */
async function runDev(url, extra, until) {
  const probe = createServer().listen(0);
  await once(probe, "listening");
  const port = String(probe.address().port);
  probe.close();
  const dir = themeDir();
  const child = spawn("node", [BIN, "theme", "dev", dir, "--port", port, ...extra], { env: env(url), stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  const exited = once(child, "exit").then(([code]) => code);
  const deadline = Date.now() + 15000;
  let code = null;
  while (Date.now() < deadline) {
    const done = await Promise.race([exited, new Promise((r) => setTimeout(() => r("tick"), 100))]);
    if (done !== "tick") {
      code = done;
      break;
    }
    if (until(stderr)) break;
  }
  if (code === null) {
    child.kill("SIGKILL");
    await exited;
  }
  rmSync(dir, { recursive: true, force: true });
  return { code, stderr };
}

test("#989 re-review P3: theme dev says a startup 503 draft_target_unverifiable in one line (not swallowed) and keeps serving", async () => {
  await withPlatform({ unverifiable: true }, async (url) => {
    const r = await runDev(url, [], (e) => /could not verify which draft/.test(e));
    assert.equal(r.code, null, `theme dev exited: ${r.stderr}`);
    assert.match(r.stderr, /draft sync: the platform could not verify which draft to write to \(a read failed on its side\)\. Nothing was written/);
  });
});

test("#989 re-review P3: theme dev --instance answered 422 draft_target_is_live stops with a one-line message (exit 2)", async () => {
  await withPlatform({ liveDraft422: true }, async (url, seen) => {
    const r = await runDev(url, ["--instance", "t43cli"], () => false);
    assert.equal(r.code, 2, r.stderr);
    assert.match(r.stderr, /draft sync refused: that is the LIVE theme/);
    assert.equal(seen.posts.length, 1);
  });
});
