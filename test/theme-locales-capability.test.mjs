import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { pushTheme } from "../lib/theme-sync.mjs";

// CF-T5 review I1 — the platform replaces stored `locales/*` rows on a canonical deploy only for a client that declares
// the optional capability `theme-locales` (header x-blocofy-optional-capabilities). This CLI sends the workspace's
// locale files, so it declares it on every theme POST; the remote-only merge still keeps remote locale files unless
// `--prune`.

const execFileP = promisify(execFile);
const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "blocofy.mjs");
const TOKEN = "bcf_testtoken1234567890abcd";
const OPTIONAL = "x-blocofy-optional-capabilities";

function themeDir(files) {
  const dir = mkdtempSync(join(tmpdir(), "blocofy-locales-cap-"));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, dirname(rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  mkdirSync(join(dir, ".blocofy"), { recursive: true });
  writeFileSync(join(dir, ".blocofy", "project.json"), JSON.stringify({ schema_version: 1, site_id: 14, site_slug: "ksc", platform_origin: null }));
  return dir;
}

async function withFake(remoteFiles, fn) {
  const seen = { posts: [], gets: [] };
  const server = createServer((req, res) => {
    const send = (body) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.url.includes("/api/dev/whoami")) return send({ site: { id: 14, slug: "ksc", name: "Ksc" }, liveThemeId: 9 });
    if (req.url.includes("/api/dev/site")) return send({ drafts: [{ id: "t-cli", name: "CLI Draft", source: "import" }] });
    if (req.method === "GET" && req.url.includes("/api/dev/theme")) {
      seen.gets.push({ url: req.url, headers: req.headers });
      return send({ files: remoteFiles, protocol: 1 });
    }
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      seen.posts.push({ headers: req.headers, body });
      send(body.dryRun ? { ok: true, dryRun: true, warnings: [] } : { ok: true, committed: true, deploymentId: 3, sourceRevisionId: 4, pointerVersion: 5 });
    });
  });
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

test("CF-T5 I1: canonical push declares theme-locales on the preflight dry run and the real POST", async () => {
  const dir = themeDir({ "section/Hero.liquid": "H", "locales/en-US.json": "{}" });
  try {
    await withFake({}, async (url, seen) => {
      await pushTheme({ dir, url, token: TOKEN, idempotencyKey: "cli-loc-1" });
      assert.equal(seen.posts.length, 2);
      const [pre, real] = seen.posts;
      assert.equal(pre.body.dryRun, true);
      assert.equal(pre.headers[OPTIONAL], "theme-locales");
      assert.equal(real.body.dryRun, undefined);
      assert.equal(real.headers[OPTIONAL], "theme-locales");
      assert.equal(real.body.files["locales/en-US.json"], "{}");
      // the required fence is unchanged
      assert.equal(real.headers["x-blocofy-capabilities"], "validate,dry-run,diff,idempotency-key,target-instance");
    });
    await withFake({}, async (url, seen) => {
      await pushTheme({ dir, url, token: TOKEN, dryRun: true, idempotencyKey: "cli-loc-2" });
      assert.equal(seen.posts[0].headers[OPTIONAL], "theme-locales", "--dry-run POST declares it too");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CF-T5 I1: a normal push keeps a remote-only locale file in the payload; --prune leaves it out and reports it", async () => {
  const dir = themeDir({ "section/Hero.liquid": "H", "locales/en-US.json": "{}" });
  const remote = { "section/Hero": "R", "locales/en-US.json": "{}", "locales/de-DE.json": '{"a":1}' };
  try {
    await withFake(remote, async (url, seen) => {
      const result = await pushTheme({ dir, url, token: TOKEN, idempotencyKey: "cli-loc-3" });
      const real = seen.posts.find((p) => !p.body.dryRun);
      assert.equal(real.headers[OPTIONAL], "theme-locales");
      assert.equal(real.body.files["locales/de-DE.json"], '{"a":1}', "push does not delete a remote locale file");
      assert.deepEqual(result.remoteOnlyKept, ["locales/de-DE.json"]);
    });
    await withFake(remote, async (url, seen) => {
      const reported = [];
      const result = await pushTheme({ dir, url, token: TOKEN, idempotencyKey: "cli-loc-4", prune: true, confirmPrune: async (keys) => (reported.push(...keys), true) });
      const real = seen.posts.find((p) => !p.body.dryRun);
      assert.equal(real.headers[OPTIONAL], "theme-locales");
      assert.ok(!("locales/de-DE.json" in real.body.files), "--prune removes the remote-only locale file");
      assert.deepEqual(reported, ["locales/de-DE.json"]);
      assert.deepEqual(result.remoteOnlyRemoved, ["locales/de-DE.json"]);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CF-T5 I1: `theme push --diff` lists locale files (added, changed, remote-only)", async () => {
  const dir = themeDir({ "locales/en-US.json": '{"x":2}', "locales/fr-FR.json": "{}" });
  try {
    await withFake({ "locales/en-US.json": '{"x":1}', "locales/de-DE.json": "{}" }, async (url, seen) => {
      const r = await runBin(url, ["theme", "push", dir, "--diff"]);
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /\+ locales\/fr-FR\.json/);
      assert.match(r.stdout, /~ locales\/en-US\.json/);
      assert.match(r.stdout, /- locales\/de-DE\.json/);
      assert.equal(seen.posts.length, 0, "diff writes nothing");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
