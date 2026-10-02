import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";

// PS-22 (Pastasel, 2026-10-02): `theme push --draft` updated the existing CLI draft but never said which one, and
// silently dropped `--name`; `--diff` compared against the LIVE theme while the push wrote to that draft. The
// customer could not find the draft and pushed straight to live.

const execFileP = promisify(execFile);
const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "blocofy.mjs");
const TOKEN = "bcf_testtoken1234567890abcd";
const HASH = "ab".repeat(32);

function themeDir(files) {
  const dir = mkdtempSync(join(tmpdir(), "blocofy-ps22-"));
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
const outcomes = (plan) => plan.map(([path, outcome]) => ({ path, outcome, digest: "cd".repeat(32) }));

/** A 6.5 platform: `/api/dev/site` lists `drafts`; the dry run plans against `planTarget`; the apply may name its target. */
function platform({ drafts = [], newDraft = false, planTarget = null, applyTarget, getFiles = {} }) {
  const seen = { getUrls: [], posts: [] };
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url.includes("/api/dev/site")) return json(res, 200, { drafts });
    if (req.method === "GET" && req.url.includes("/api/dev/whoami")) return json(res, 200, { site: { id: 14, slug: "ksc", name: "Ksc" }, liveThemeId: 9 });
    if (req.method === "GET" && req.url.includes("/api/dev/theme")) {
      seen.getUrls.push(req.url);
      return json(res, 200, { files: getFiles, protocol: 1 });
    }
    if (req.method === "POST" && req.url.endsWith("/api/dev/theme")) {
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        const body = JSON.parse(raw || "{}");
        seen.posts.push(body);
        const plan = [["section/Hero", newDraft ? "created" : "updated"]];
        if (body.dryRun) {
          return json(res, 200, {
            ok: true, dryRun: true, warnings: [], manifestHash: HASH, target: "draft", targetInstance: planTarget, newDraft,
            pointerVersion: newDraft ? null : 9, files: outcomes(plan),
          });
        }
        return json(res, 200, {
          committed: true, deploymentId: 584, sourceRevisionId: 580, pointerVersion: 10, files: outcomes(plan),
          readback: { verified: true, files: 1, settings: true }, manifestHash: HASH,
          ...(applyTarget !== undefined ? { targetInstance: applyTarget } : {}),
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

const runBin = (url, argv) =>
  execFileP("node", [BIN, ...argv], { env: { ...process.env, BLOCOFY_URL: url, BLOCOFY_TOKEN: TOKEN } }).then(
    (r) => ({ code: 0, ...r }),
    (e) => ({ code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" }),
  );

test("PS-22: a draft push that reuses the CLI draft names it, and says --name was not applied", async () => {
  const dir = themeDir({ "section/Hero": "H" });
  try {
    const drafts = [{ id: "t1b5b1n1", name: "Re-test draft", source: "import" }];
    await withPlatform({ drafts, planTarget: "t1b5b1n1", applyTarget: "t1b5b1n1" }, async (url) => {
      const r = await runBin(url, ["theme", "push", dir, "--draft", "--name", "Mockup v2"]);
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /Draft: t1b5b1n1 "Re-test draft" \(existing CLI draft, updated\)/);
      assert.match(r.stdout + r.stderr, /--name was not applied/);
      assert.match(r.stdout + r.stderr, /blocofy theme rename t1b5b1n1 "Mockup v2"/);
      assert.match(r.stdout, /blocofy theme publish --instance t1b5b1n1/);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PS-22: a draft push that creates a new draft names it from the apply (the plan only knew 'a new draft')", async () => {
  const dir = themeDir({ "section/Hero": "H" });
  try {
    await withPlatform({ drafts: [], newDraft: true, planTarget: null, applyTarget: "t9new" }, async (url) => {
      const r = await runBin(url, ["theme", "push", dir, "--draft", "--name", "Mockup v2"]);
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /Draft: t9new "Mockup v2" \(new\)/);
      assert.doesNotMatch(r.stdout + r.stderr, /--name was not applied/);
      assert.match(r.stdout, /blocofy theme publish --instance t9new/);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PS-22: an older server that names no target still prints the reused draft found before the push", async () => {
  const dir = themeDir({ "section/Hero": "H" });
  try {
    const drafts = [{ id: "t1b5b1n1", name: "Re-test draft", source: "import" }];
    await withPlatform({ drafts, planTarget: undefined, applyTarget: undefined }, async (url) => {
      const r = await runBin(url, ["theme", "push", dir, "--draft"]);
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /Draft: t1b5b1n1 "Re-test draft" \(existing CLI draft, updated\)/);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PS-22: --diff on a draft push compares against the CLI draft the push writes to — read-only, by handle", async () => {
  const dir = themeDir({ "section/Hero": "H" });
  try {
    const drafts = [{ id: "t2dup", name: "Copy", source: "duplicate" }, { id: "t1b5b1n1", name: "Re-test draft", source: "import" }];
    await withPlatform({ drafts, getFiles: { "section/Hero": "H" } }, async (url, seen) => {
      const r = await runBin(url, ["theme", "push", dir, "--diff"]);
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /Diff vs draft t1b5b1n1 "Re-test draft"/);
      assert.match(r.stdout, /No differences/);
      assert.deepEqual(seen.getUrls.map((u) => new URL(u, "http://x").search), ["?instance=t1b5b1n1"]);
      assert.equal(seen.posts.length, 0, "a diff writes nothing");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PS-22: --diff with no CLI draft yet says so and compares against live, never provisioning one", async () => {
  const dir = themeDir({ "section/Hero": "H" });
  try {
    await withPlatform({ drafts: [{ id: "t2dup", name: "Copy", source: "duplicate" }], getFiles: {} }, async (url, seen) => {
      const r = await runBin(url, ["theme", "push", dir, "--diff"]);
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /No CLI draft yet/);
      assert.match(r.stdout, /Diff vs the LIVE theme/);
      assert.deepEqual(seen.getUrls.map((u) => new URL(u, "http://x").search), [""], "no ?draft=1 (it would provision a draft)");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PS-22: --diff --live still compares against the live theme", async () => {
  const dir = themeDir({ "section/Hero": "H" });
  try {
    await withPlatform({ drafts: [{ id: "t1b5b1n1", name: "Re-test draft", source: "import" }], getFiles: { "section/Hero": "H" } }, async (url, seen) => {
      const r = await runBin(url, ["theme", "push", dir, "--diff", "--live"]);
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /Diff vs the LIVE theme/);
      assert.deepEqual(seen.getUrls.map((u) => new URL(u, "http://x").search), [""]);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PS-23: theme dev help no longer promises the retired remote preview views", async () => {
  const r = await runBin("http://localhost:1", ["--help"]);
  assert.doesNotMatch(r.stdout, /3 auto-reloading views/);
  assert.match(r.stdout, /blocofy theme dev/);
});

test("PS-22 note: TARGET_BINDING_REQUIRED also names the env-credential way to bind (no context needed)", async () => {
  const { enforceBindingPolicy } = await import("../lib/target.mjs");
  for (const commandClass of ["remote-mutation", "local-write"]) {
    const dir = mkdtempSync(join(tmpdir(), "blocofy-ps22-bind-"));
    writeFileSync(join(dir, "x.liquid"), "x"); // not empty: local-write refuses too
    try {
      assert.throws(() => enforceBindingPolicy({ commandClass, binding: null, dir, command: "theme push" }), (e) => {
        assert.equal(e.code, "TARGET_BINDING_REQUIRED");
        assert.match(e.message, /--context <name>/);
        assert.match(e.message, /BLOCOFY_URL \+ BLOCOFY_TOKEN/);
        return true;
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
