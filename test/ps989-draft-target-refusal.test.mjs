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
function platform({ drafts = [], refuseDraft = false, liveThemeId = "t9live" }) {
  const seen = { themeGets: [], posts: [] };
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url.includes("/api/dev/site")) return json(res, 200, { drafts });
    if (req.method === "GET" && req.url.includes("/api/dev/whoami")) return json(res, 200, { site: { id: 14, slug: "ksc", name: "Ksc" }, liveThemeId });
    if (req.method === "GET" && req.url.includes("/api/dev/session")) return json(res, 410, { error: "retired" });
    if (req.method === "GET" && req.url.includes("/api/dev/theme")) {
      seen.themeGets.push(req.url);
      if (refuseDraft && req.url.includes("draft=1")) return json(res, 409, REFUSAL);
      return json(res, 200, { files: {}, protocol: 1 });
    }
    if (req.method === "POST" && req.url.endsWith("/api/dev/theme")) {
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        const body = JSON.parse(raw || "{}");
        seen.posts.push(body);
        if (refuseDraft && body.draft) return json(res, 409, REFUSAL);
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
  assert.deepEqual(two.candidates, [{ instance: "t43cli", name: "CLI Draft — 2026-10-01" }, { instance: "t44", name: "CLI Draft" }]);
});

test("#989 draftTargetAmbiguousMessage names why, every candidate and the exact --instance command", () => {
  const msg = draftTargetAmbiguousMessage(
    { reason: "site_state_restore", candidates: [{ instance: "t31restore", name: "Site State · 0123456789ab" }] },
    { command: "blocofy theme push ./shop" },
  );
  assert.match(msg, /site-state restore/);
  assert.match(msg, /Nothing was written/);
  assert.match(msg, /t31restore {2}"Site State · 0123456789ab"/);
  assert.match(msg, /blocofy theme push \.\/shop --instance t31restore/);
});

test("#989 push (default draft) with a site-state restore draft: refused locally before any theme request, exit 2", async () => {
  const dir = themeDir();
  try {
    await withPlatform({ drafts: [RESTORE] }, async (url, seen) => {
      const r = await runBin(url, ["theme", "push", dir]);
      assert.equal(r.code, 2, r.stdout + r.stderr);
      assert.match(r.stderr, /draft_target_ambiguous/);
      assert.match(r.stderr, /t31restore/);
      assert.match(r.stderr, new RegExp(`blocofy theme push ${dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} --instance t31restore`));
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
      assert.match(r.stderr, /is the LIVE theme/);
      assert.deepEqual(seen.posts, []);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
