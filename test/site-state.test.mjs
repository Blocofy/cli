import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * CF-T4 (CLI half) — `blocofy site export | validate | plan | apply | publish` end-to-end, against a
 * stateful fake site (one HTTP origin per site, serving BOTH the dev endpoints `/api/dev/*` and the v1
 * `/api/v1/*` site-state endpoints `plan`/`apply`/`publish`/`media`). The fake server does not reimplement
 * the platform's full business logic (translations, chrome, media policy, …) — it models exactly the state
 * machine the CLI's apply loop must follow: assets missing → theme source differs → N ordinary steps →
 * draft_complete, so the transitions and the CLI's exit codes are what is under test, not the platform.
 */

const BIN = fileURLToPath(new URL("../bin/blocofy.mjs", import.meta.url));
const DEV_TOKEN = "bcf_devtoken_0123456789abcdef";
const API_KEY = "blcf_live_apikey_0123456789abcdef";

const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
function tmp(prefix = "bcf-site-state-") {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/** A minimal multipart/form-data body → the bytes of its `file` part. */
function extractMultipartFile(raw, contentType) {
  const m = /boundary=(.+)$/.exec(contentType ?? "");
  if (!m) return null;
  const boundary = Buffer.from(`--${m[1]}`);
  const parts = [];
  let start = raw.indexOf(boundary);
  while (start !== -1) {
    const next = raw.indexOf(boundary, start + boundary.length);
    if (next === -1) break;
    parts.push(raw.subarray(start + boundary.length, next));
    start = next;
  }
  for (const part of parts) {
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd === -1) continue;
    const headers = part.subarray(0, headerEnd).toString("utf8");
    if (!headers.includes('name="file"')) continue;
    let body = part.subarray(headerEnd + 4);
    if (body.subarray(-2).toString() === "\r\n") body = body.subarray(0, -2);
    return body;
  }
  return null;
}

/**
 * One fake site: dev + v1 on the SAME origin. `requiredAssetShas` and `pageStepsNeeded` drive the plan/apply
 * state machine; `reqs` records every site-state/media/theme-deploy request (identity checks — whoami, ping —
 * are never recorded, matching the existing test convention in test/media-uses.test.mjs / settings-instance.test.mjs).
 */
function fakeSite({ id, slug, requiredAssetShas = [], pageStepsNeeded = 1 }) {
  const state = {
    uploaded: new Set(),
    themeDeployed: false,
    remainingSteps: pageStepsNeeded,
    instanceHandle: `t_${id}`,
    published: false,
    swaps: 0,
  };
  const reqs = [];

  function computeStatus() {
    const missing = requiredAssetShas.filter((s) => !state.uploaded.has(s));
    if (missing.length > 0) return { status: "awaiting_assets", missing };
    if (!state.themeDeployed) return { status: "awaiting_theme_source", missing: [] };
    if (state.remainingSteps > 0) return { status: "planned", missing: [] };
    return { status: "draft_complete", missing: [] };
  }
  function planHash() {
    const { status } = computeStatus();
    return `h:${status}:${state.remainingSteps}:${state.themeDeployed}:${state.uploaded.size}`;
  }
  function planBody() {
    const { status, missing } = computeStatus();
    const steps =
      status === "planned"
        ? Array.from({ length: state.remainingSteps }, (_, i) => ({ seq: i + 1, owner: "pages", action: "update_page", key: `p${i}`, live_effect: false }))
        : status === "draft_complete"
          ? []
          : [{ seq: 1, owner: "placeholder", action: "noop", key: "k", live_effect: false }];
    return {
      plan_hash: planHash(),
      manifest_digest: "manifestdigest1",
      target_instance: state.instanceHandle,
      status,
      steps,
      assets_missing: missing,
      theme_source: status === "awaiting_theme_source" ? { digest: "themedigest1", instance: state.instanceHandle, idempotency_key: "site-state:manifestd:theme" } : null,
      preconditions: [],
      diagnostics: [],
    };
  }

  const exportAssetBytes = Buffer.from("asset-bytes-export1");
  const exportAssetSha = sha256(exportAssetBytes);

  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const url = new URL(req.url, "http://x");
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };

    if (url.pathname === "/api/dev/whoami") return send(200, { site: { id, slug, name: slug }, liveThemeId: null });
    if (url.pathname === "/api/v1/ping") return send(200, { ok: true, site: { id, slug, name: slug } });

    if (url.pathname === "/cdn/asset.bin") {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      return res.end(exportAssetBytes);
    }

    reqs.push({ method: req.method, pathname: url.pathname });

    if (url.pathname === "/api/v1/site-state" && req.method === "GET") {
      return send(200, {
        schema_version: 1,
        manifest: { schema_version: 1, kind: "blocofy-site-state", platform_origin: "https://example.myblocofy.com", source_site: { id, slug }, exported_at: "2026-09-18T00:00:00.000Z", manifest_digest: "d1", owners: {} },
        files: { "site/locales.json": JSON.stringify({ default: "tr-TR", supported: ["tr-TR"] }, null, 2) + "\n" },
        assets: [{ sha256: exportAssetSha, bytes: exportAssetBytes.length, mime: "image/png", filename: "pixel.png", url: `http://127.0.0.1:${server.address().port}/cdn/asset.bin` }],
        diagnostics: [],
      });
    }

    if (url.pathname === "/api/v1/site-state/plan" && req.method === "POST") {
      return send(200, planBody());
    }

    if (url.pathname === "/api/v1/site-state/apply" && req.method === "POST") {
      const body = JSON.parse(raw.toString("utf8"));
      if (body.expected_plan_hash !== planHash()) {
        return send(409, { error: { code: "conflict", message: "the site changed since the plan you reviewed", details: { code: "SITE_STATE_PLAN_STALE", plan_hash: planHash() } } });
      }
      const before = computeStatus();
      if (before.status === "planned") state.remainingSteps -= 1;
      const after = computeStatus();
      return send(200, { status: after.status, plan_hash: planHash(), target_instance: state.instanceHandle, applied: [], not_applied: [], report: [], theme_source: after.status === "awaiting_theme_source" ? { digest: "themedigest1", instance: state.instanceHandle, idempotency_key: "site-state:manifestd:theme" } : null });
    }

    if (url.pathname === "/api/v1/site-state/publish" && req.method === "POST") {
      const { status } = computeStatus();
      if (status !== "draft_complete") {
        return send(409, { error: { code: "conflict", message: "this state has not been fully applied yet", details: { code: "SITE_STATE_APPLY_INCOMPLETE", steps: [] } } });
      }
      const swapped = !state.published;
      state.published = true;
      if (swapped) state.swaps += 1;
      return send(200, { status: "published", plan_hash: planHash(), target_instance: state.instanceHandle, swapped, navigation: ["tr-TR/main"], globals: false });
    }

    if (url.pathname === "/api/v1/media" && req.method === "POST") {
      const file = extractMultipartFile(raw, req.headers["content-type"]);
      if (file) state.uploaded.add(sha256(file));
      return send(201, { file: { id: "f1" } });
    }

    if (url.pathname === "/api/dev/theme") {
      if (req.method === "GET") return send(200, { files: {} });
      if (req.method === "POST") {
        const body = JSON.parse(raw.toString("utf8"));
        if (body.dryRun === true) return send(200, { ok: true });
        state.themeDeployed = true;
        return send(200, { ok: true });
      }
    }

    return send(404, { error: { code: "not_found", message: "no route" } });
  });
  return { id, slug, server, reqs, state };
}

async function listen(site) {
  site.server.listen(0, "127.0.0.1");
  await once(site.server, "listening");
  site.url = `http://127.0.0.1:${site.server.address().port}`;
  after(() => site.server.close());
  return site;
}

function project(dir, { site } = {}) {
  mkdirSync(join(dir, ".blocofy"), { recursive: true });
  writeFileSync(join(dir, ".blocofy", "project.json"), JSON.stringify({ schema_version: 1, site_id: site?.id ?? "s1", site_slug: site?.slug ?? "site", platform_origin: null }));
}

/** A minimal, valid, hand-authored site-state tree: one page, one theme file, and (optionally) one asset. */
function writeMinimalTree(dir, { asset = null } = {}) {
  mkdirSync(join(dir, "site"), { recursive: true });
  mkdirSync(join(dir, "theme", "section"), { recursive: true });
  mkdirSync(join(dir, "pages", "tr-TR"), { recursive: true });
  writeFileSync(join(dir, "site", "locales.json"), JSON.stringify({ default: "tr-TR", supported: ["tr-TR"] }, null, 2) + "\n");
  writeFileSync(join(dir, "theme", "section", "Hero.liquid"), "<h1>{{ heading }}</h1>\n");
  writeFileSync(
    join(dir, "pages", "tr-TR", "index.json"),
    JSON.stringify({ format_version: 2, slug: "/", locale: "tr-TR", title: "Ana Sayfa", data: { version: 2, sections: [] } }, null, 2) + "\n",
  );
  if (asset) {
    mkdirSync(join(dir, "media", "files"), { recursive: true });
    writeFileSync(join(dir, "media", "assets.json"), JSON.stringify([{ sha256: asset.sha256, bytes: asset.bytes.length, mime: "image/png", filename: "pixel.png" }], null, 2) + "\n");
    writeFileSync(join(dir, "media", "files", asset.sha256), asset.bytes);
  }
}

function runCli(args, env = {}, { cwd } = {}) {
  return new Promise((resolvePromise) => {
    const home = tmp("bcf-home-");
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd: cwd ?? home,
      env: { PATH: process.env.PATH, HOME: home, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.stdin.end();
    child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
  });
}

const bothEnv = (site) => ({ BLOCOFY_URL: site.url, BLOCOFY_TOKEN: DEV_TOKEN, BLOCOFY_API_URL: site.url, BLOCOFY_API_KEY: API_KEY });

function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === ".blocofy") continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[p] = true;
    }
  };
  walk(dir);
  return out;
}

// ── export ───────────────────────────────────────────────────────────────────────────────────────────────

test("[export] writes the tree + downloads and hash-verifies every asset", async () => {
  const site = await listen(fakeSite({ id: "s1", slug: "site-a" }));
  const dir = join(tmp(), "export-out");
  const r = await runCli(["site", "export", dir], bothEnv(site));
  assert.equal(r.code, 0, r.stderr);
  assert.equal(readFileSync(join(dir, "site", "locales.json"), "utf8").includes("tr-TR"), true);
  const manifest = JSON.parse(readFileSync(join(dir, "blocofy-site.json"), "utf8"));
  assert.equal(manifest.kind, "blocofy-site-state");
  const assetBytes = Buffer.from("asset-bytes-export1");
  const sha = sha256(assetBytes);
  assert.deepEqual(readFileSync(join(dir, "media", "files", sha)), assetBytes);
  assert.equal(existsSync(join(dir, ".blocofy", "project.json")), true);
});

test("[export] into a directory bound to another site refuses (exit 3), writes nothing", async () => {
  const site = await listen(fakeSite({ id: "s1", slug: "site-a" }));
  const dir = tmp();
  project(dir, { site: { id: "sOTHER", slug: "other-site" } });
  const before = snapshot(dir);
  const r = await runCli(["site", "export", dir, "--json"], bothEnv(site), { cwd: dir });
  assert.equal(r.code, 3, r.stderr);
  assert.equal(JSON.parse(r.stderr.trim().split("\n").pop()).error.code, "TARGET_SITE_MISMATCH");
  assert.deepEqual(snapshot(dir), before);
});

// ── validate ─────────────────────────────────────────────────────────────────────────────────────────────

test("[validate] catches traversal, casefold collision, and identity mismatch OFFLINE — zero requests", async () => {
  const site = await listen(fakeSite({ id: "s1", slug: "site-a" }));
  const dir = tmp();
  mkdirSync(join(dir, "theme", "assets"), { recursive: true });
  mkdirSync(join(dir, "pages", "tr-TR"), { recursive: true });
  // a casefold collision
  writeFileSync(join(dir, "theme", "assets", "Logo.css"), "body{}");
  writeFileSync(join(dir, "theme", "assets", "logo.css"), "body{}");
  // an identity mismatch: path says "/", payload says "/hakkimizda"
  writeFileSync(join(dir, "pages", "tr-TR", "index.json"), JSON.stringify({ format_version: 2, slug: "/hakkimizda", locale: "tr-TR", title: "x", data: { version: 2, sections: [] } }));

  // no credentials at all — validate must not need any network, so this would fail loudly if it tried
  const r = await runCli(["site", "validate", dir, "--json"], {});
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stdout, /error\(s\)/);
  assert.equal(site.reqs.length, 0);
});

test("[validate] accepts a well-formed tree, exit 0", async () => {
  const dir = tmp();
  writeMinimalTree(dir);
  const r = await runCli(["site", "validate", dir], {});
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /0 error\(s\)/);
});

// ── plan / apply ─────────────────────────────────────────────────────────────────────────────────────────

test("[plan→apply] transitions awaiting_assets → awaiting_theme_source → draft_complete", async () => {
  const assetBytes = Buffer.from("required-asset-bytes");
  const sha = sha256(assetBytes);
  const site = await listen(fakeSite({ id: "s1", slug: "site-a", requiredAssetShas: [sha], pageStepsNeeded: 1 }));
  const dir = tmp();
  project(dir, { site });
  writeMinimalTree(dir, { asset: { sha256: sha, bytes: assetBytes } });

  const plan1 = await runCli(["site", "plan", dir, "--json"], bothEnv(site), { cwd: dir });
  assert.equal(plan1.code, 0, plan1.stderr);
  assert.equal(JSON.parse(plan1.stdout).status, "awaiting_assets");

  const apply = await runCli(["site", "apply", dir], bothEnv(site), { cwd: dir });
  assert.equal(apply.code, 0, apply.stderr);
  assert.match(apply.stdout, /draft_complete/);
  assert.equal(site.state.uploaded.has(sha), true);
  assert.equal(site.state.themeDeployed, true);
  assert.equal(site.state.remainingSteps, 0);

  const plan2 = await runCli(["site", "plan", dir, "--json"], bothEnv(site), { cwd: dir });
  assert.equal(JSON.parse(plan2.stdout).status, "draft_complete");
});

test("[apply] a bounded partial apply exits 4 (resumable); a second apply finishes", async () => {
  // 1 awaiting_assets pass + 1 awaiting_theme_source pass + 6 ordinary steps > MAX_APPLY_PASSES (5): the
  // first `site apply` cannot finish within its pass bound.
  const assetBytes = Buffer.from("bounded-asset-bytes");
  const sha = sha256(assetBytes);
  const site = await listen(fakeSite({ id: "s1", slug: "site-a", requiredAssetShas: [sha], pageStepsNeeded: 6 }));
  const dir = tmp();
  project(dir, { site });
  writeMinimalTree(dir, { asset: { sha256: sha, bytes: assetBytes } });

  const first = await runCli(["site", "apply", dir], bothEnv(site), { cwd: dir });
  assert.equal(first.code, 4, first.stderr);
  assert.match(first.stdout, /Run `blocofy site apply` again/);
  assert.equal(site.state.remainingSteps > 0, true, "not finished yet");

  const second = await runCli(["site", "apply", dir], bothEnv(site), { cwd: dir });
  assert.equal(second.code, 0, second.stderr);
  assert.match(second.stdout, /draft_complete/);
  assert.equal(site.state.remainingSteps, 0);
});

test("[apply] PLAN_STALE (the site changed between the CLI's plan and its apply call) exits 2", async () => {
  const site = await listen(fakeSite({ id: "s1", slug: "site-a", pageStepsNeeded: 1 }));
  const dir = tmp();
  project(dir, { site });
  writeMinimalTree(dir);
  site.state.themeDeployed = true; // only the ordinary "planned" step remains, so the CLI's loop goes
  // straight from its first plan() to an apply() call carrying that plan's hash.

  // Race it: the instant the CLI's plan() request is observed, advance server state (as a concurrent
  // client would) so the hash the CLI is about to submit to apply() no longer matches.
  let raced = false;
  site.server.prependListener("request", (req) => {
    if (req.url === "/api/v1/site-state/plan" && !raced) {
      raced = true;
      setImmediate(() => {
        site.state.remainingSteps = 0;
      });
    }
  });

  const r = await runCli(["site", "apply", dir, "--json"], bothEnv(site), { cwd: dir });
  assert.equal(r.code, 2, r.stderr);
  const envelope = JSON.parse(r.stderr.trim().split("\n").pop());
  assert.equal(envelope.error.details.code, "SITE_STATE_PLAN_STALE");
});

// ── publish ──────────────────────────────────────────────────────────────────────────────────────────────

test("[publish] before draft_complete refuses (exit 2, SITE_STATE_APPLY_INCOMPLETE)", async () => {
  const site = await listen(fakeSite({ id: "s1", slug: "site-a", pageStepsNeeded: 1 }));
  const dir = tmp();
  project(dir, { site });
  writeMinimalTree(dir);
  const r = await runCli(["site", "publish", dir, "--yes", "--json"], bothEnv(site), { cwd: dir });
  assert.equal(r.code, 2, r.stderr);
  const envelope = JSON.parse(r.stderr.trim().split("\n").pop());
  assert.equal(envelope.error.details.code, "SITE_STATE_APPLY_INCOMPLETE");
});

test("[publish] non-TTY without --yes refuses locally, with NO site-state request", async () => {
  const site = await listen(fakeSite({ id: "s1", slug: "site-a", pageStepsNeeded: 0 }));
  const dir = tmp();
  project(dir, { site });
  writeMinimalTree(dir);
  const r = await runCli(["site", "publish", dir], bothEnv(site), { cwd: dir });
  assert.equal(r.code, 1, r.stderr);
  assert.equal(site.reqs.length, 0);
});

test("[publish] a completed apply publishes; --yes confirms non-interactively", async () => {
  const site = await listen(fakeSite({ id: "s1", slug: "site-a", pageStepsNeeded: 1 }));
  const dir = tmp();
  project(dir, { site });
  writeMinimalTree(dir);
  site.state.themeDeployed = true;
  site.state.remainingSteps = 0; // already draft_complete

  const r = await runCli(["site", "publish", dir, "--yes"], bothEnv(site), { cwd: dir });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Published/);
  assert.equal(site.state.published, true);
});

test("[plan] a symlink inside the local tree refuses (exit 1, SITE_STATE_SYMLINK), no site-state request", async () => {
  const site = await listen(fakeSite({ id: "s1", slug: "site-a" }));
  const dir = tmp();
  project(dir, { site });
  writeMinimalTree(dir);
  symlinkSync(join(dir, "theme", "section", "Hero.liquid"), join(dir, "theme", "section", "linked.liquid"));

  const r = await runCli(["site", "plan", dir, "--json"], bothEnv(site), { cwd: dir });
  assert.equal(r.code, 1, r.stderr);
  const envelope = JSON.parse(r.stderr.trim().split("\n").pop());
  assert.equal(envelope.error.details.diagnostics?.[0]?.code, "SITE_STATE_SYMLINK");
  assert.equal(site.reqs.length, 0);
});

// ── target matrix ────────────────────────────────────────────────────────────────────────────────────────

test("[plan] a dev token for site A + an API key for site B refuses (exit 3), with no site-state request", async () => {
  const siteA = await listen(fakeSite({ id: "sA", slug: "site-a" }));
  const siteB = await listen(fakeSite({ id: "sB", slug: "site-b" }));
  const dir = tmp();
  project(dir, { site: siteA });
  writeMinimalTree(dir);
  const r = await runCli(["site", "plan", dir, "--json"], { BLOCOFY_URL: siteA.url, BLOCOFY_TOKEN: DEV_TOKEN, BLOCOFY_API_URL: siteB.url, BLOCOFY_API_KEY: API_KEY }, { cwd: dir });
  assert.equal(r.code, 3, r.stderr);
  assert.equal(JSON.parse(r.stderr.trim().split("\n").pop()).error.code, "TARGET_CREDENTIAL_MISMATCH");
  assert.equal(siteA.reqs.length, 0);
  assert.equal(siteB.reqs.length, 0);
});

// ── secrets never leak ───────────────────────────────────────────────────────────────────────────────────

test("no secret (dev token or API key) appears in any command's stdout/stderr", async () => {
  const site = await listen(fakeSite({ id: "s1", slug: "site-a", pageStepsNeeded: 1 }));
  const dir = tmp();
  project(dir, { site });
  writeMinimalTree(dir);
  const outputs = [];
  outputs.push(await runCli(["site", "plan", dir, "--json"], bothEnv(site), { cwd: dir }));
  outputs.push(await runCli(["site", "apply", dir], bothEnv(site), { cwd: dir }));
  outputs.push(await runCli(["site", "publish", dir, "--yes"], bothEnv(site), { cwd: dir }));
  // a deliberately WRONG key, to also exercise the refusal/error paths for a secret leak
  outputs.push(await runCli(["site", "plan", dir, "--json"], { ...bothEnv(site), BLOCOFY_API_KEY: "blcf_live_wrong_should_not_leak_0123456789" }, { cwd: dir }));
  for (const o of outputs) {
    assert.doesNotMatch(o.stdout, /bcf_devtoken_0123456789abcdef/);
    assert.doesNotMatch(o.stderr, /bcf_devtoken_0123456789abcdef/);
    assert.doesNotMatch(o.stdout, /blcf_live_apikey_0123456789abcdef/);
    assert.doesNotMatch(o.stderr, /blcf_live_apikey_0123456789abcdef/);
  }
});
