import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * ADR-0014 (wave P4 follow-up) — a draft-only login writes only into its own theme work. For such a context
 * `theme push` and `theme dev` default to the work saved by `init` / `theme work start` (.blocofy/local.json, else
 * .blocofy/init.json); explicit flags win; without a saved work the command stops with a Turkish hint before any
 * request (so before any write).
 */

const BIN = fileURLToPath(new URL("../bin/blocofy.mjs", import.meta.url));
const ORIGIN = "https://app.blocofy.test";
const SITE = { id: "s7k2p9", slug: "shop", name: "Shop", domain: null };
const TOKEN = "blcf_ct_draftOnlyCANARY.sig";
const SAVED = { handle: `wk_${"a".repeat(26)}`, theme: "tWORKSAVED" };
const OTHER = { handle: `wk_${"b".repeat(26)}`, theme: "tWORKOTHER" };
const DIRS = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "blocofy-dow-"));
  DIRS.push(d);
  return d;
};

const state = { url: null, requests: [] };
const server = createServer(async (req, res) => {
  let raw = "";
  for await (const c of req) raw += c;
  const u = new URL(req.url, "http://x");
  state.requests.push({ method: req.method, path: u.pathname, query: u.search, body: raw });
  const json = (status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(401, { error: { code: "invalid_key", message: "x" } });
  if (u.pathname === "/api/v1/ping") return json(200, { ok: true, site: SITE, platform_origin: ORIGIN, profile: { id: "theme-dev", version: 1, label: "Tema geliştirme" }, audience: "cli", dev_endpoint: `${state.url}/api/dev`, policy_version: 1 });
  if (u.pathname === "/api/dev/whoami") return json(200, { site: SITE, platform_origin: ORIGIN, liveThemeId: "tLIVE" });
  const w = u.pathname.match(/^\/api\/v1\/theme-work\/([^/]+)$/);
  if (w) {
    const work = [SAVED, OTHER].find((x) => x.handle === w[1]);
    return work ? json(200, { work: { id: work.handle, theme: work.theme, state: "open", state_version: 1 } }) : json(404, { error: { code: "not_found", message: "?" } });
  }
  if (u.pathname === "/api/dev/theme" && req.method === "POST") return json(200, { ok: true, committed: true, instanceId: JSON.parse(raw || "{}").instance ?? null, deploymentId: 1, sourceRevisionId: 2, pointerVersion: 3 });
  if (u.pathname === "/api/dev/theme" && req.method === "GET") return json(200, { protocol: 1, files: {} });
  if (u.pathname === "/api/dev/site") return json(200, { site: { slug: "shop" }, live_theme_instance: { id: "tLIVE", name: "Live" }, drafts: [], health: "ok" });
  if (u.pathname === "/api/dev/session") return json(200, { draftInstanceId: null, previewUrl: "https://x/?p=1", editorUrl: "https://x/e", site: SITE });
  return json(404, { error: { code: "not_found", message: "?" } });
});

before(async () => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  state.url = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((r) => server.close(r));
  DIRS.forEach((d) => rmSync(d, { recursive: true, force: true }));
});

/** HOME with a browser-login context "shop"; a project bound to it; `work` saved in local.json and/or init.json. */
function setup({ local = SAVED, init = null } = {}) {
  const home = tmp();
  mkdirSync(join(home, ".blocofy"), { recursive: true, mode: 0o700 });
  const oauth = { url: state.url, issuer: state.url, client_id: "blocofy-cli", token_endpoint: `${state.url}/token`, revocation_endpoint: `${state.url}/revoke`, dev_url: state.url, profile: { id: "theme-dev", version: 1, label: "Tema geliştirme" }, secret: { store: "file" } };
  writeFileSync(join(home, ".blocofy", "credentials.json"), JSON.stringify({ schema_version: 2, current_context: "shop", contexts: { shop: { platform_origin: ORIGIN, site: SITE, oauth, verified_at: null } } }), { mode: 0o600 });
  writeFileSync(join(home, ".blocofy", "secrets.json"), JSON.stringify({ shop: { oauth_tokens: JSON.stringify({ access_token: TOKEN, refresh_token: "blcf_rt_x", expires_at: Date.now() + 600_000 }) } }), { mode: 0o600 });
  const proj = tmp();
  mkdirSync(join(proj, ".blocofy"));
  mkdirSync(join(proj, "section"));
  writeFileSync(join(proj, "section", "Hero.liquid"), "hero");
  writeFileSync(join(proj, ".blocofy", "project.json"), JSON.stringify({ schema_version: 1, site_id: SITE.id, site_slug: "shop", platform_origin: ORIGIN, profile: { id: "theme-dev", version: 1 } }));
  writeFileSync(join(proj, ".blocofy", "local.json"), JSON.stringify({ context: "shop", ...(local ? { theme_work: { handle: local.handle, theme: local.theme, intent: "blocofy init", site_id: SITE.id } } : {}) }));
  if (init) writeFileSync(join(proj, ".blocofy", "init.json"), JSON.stringify({ schema_version: 1, init_key: "k", site_id: SITE.id, platform_origin: ORIGIN, state: "previewed", work_handle: init.handle, work_theme: init.theme }));
  return { home, proj };
}

function run(home, args) {
  state.requests.length = 0;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { cwd: home, env: { PATH: process.env.PATH, HOME: home }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.stdin.end();
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const themeWrites = () => state.requests.filter((r) => r.method === "POST" && r.path === "/api/dev/theme").map((r) => JSON.parse(r.body || "{}"));
const writes = () => state.requests.filter((r) => r.method !== "GET");

test("theme push (no target flag) on a draft-only login → the saved work: read back, then written as its draft", async () => {
  const { home, proj } = setup();
  const r = await run(home, ["theme", "push", proj]);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(state.requests.some((q) => q.method === "GET" && q.path === `/api/v1/theme-work/${SAVED.handle}`), "the work is read back");
  const pushed = themeWrites();
  assert.ok(pushed.length >= 1 && pushed.every((b) => b.instance === SAVED.theme && b.draft === true), JSON.stringify(pushed));
  assert.equal(pushed.filter((b) => !b.dryRun).length, 1, "one real write (after the dry-run plan)");
  assert.match(r.stderr + r.stdout, new RegExp(SAVED.handle));
});

test("theme push falls back to .blocofy/init.json's work when local.json has none", async () => {
  const { home, proj } = setup({ local: null, init: SAVED });
  const r = await run(home, ["theme", "push", proj]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(themeWrites()[0].instance, SAVED.theme);
});

test("explicit flags win: --work <other> and --instance <theme> are used as given", async () => {
  const { home, proj } = setup();
  let r = await run(home, ["theme", "push", proj, "--work", OTHER.handle]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(themeWrites()[0].instance, OTHER.theme);
  r = await run(home, ["theme", "push", proj, "--draft", "--instance", OTHER.theme]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(themeWrites()[0].instance, OTHER.theme);
  assert.ok(!state.requests.some((q) => q.path.startsWith("/api/v1/theme-work/")), "--instance does not consult the saved work");
});

test("no saved work: theme push and theme dev stop with a Turkish hint (init / theme work start), exit 3, zero requests", async () => {
  const { home, proj } = setup({ local: null });
  for (const args of [["theme", "push", proj], ["theme", "dev", proj, "--dry"]]) {
    const r = await run(home, [...args]);
    assert.equal(r.code, 3, `${args.join(" ")}: ${r.stderr}`);
    assert.match(r.stderr, /THEME_WORK_REQUIRED/);
    assert.match(r.stderr, /blocofy init/);
    assert.match(r.stderr, /blocofy theme work start/);
    assert.match(r.stderr, /Hiçbir şey gönderilmedi/);
    assert.deepEqual(state.requests, [], "nothing was sent");
  }
  // --json carries the code as the last line.
  const j = await run(home, ["theme", "push", proj, "--json"]);
  assert.equal(JSON.parse(j.stderr.trim().split("\n").pop()).error.code, "THEME_WORK_REQUIRED");
  assert.deepEqual(writes(), []);
});

test("theme dev on a draft-only login syncs into the saved work's theme; --instance wins; --no-sync needs no work", async () => {
  let { home, proj } = setup();
  let r = await run(home, ["theme", "dev", proj, "--dry"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout + r.stderr, new RegExp(`${SAVED.handle}.*${SAVED.theme}|${SAVED.theme}.*${SAVED.handle}`));
  r = await run(home, ["theme", "dev", proj, "--dry", "--instance", OTHER.theme]);
  assert.equal(r.code, 0, r.stderr);
  assert.doesNotMatch(r.stdout + r.stderr, new RegExp(SAVED.theme));
  ({ home, proj } = setup({ local: null }));
  r = await run(home, ["theme", "dev", proj, "--dry", "--no-sync"]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(writes(), []);
});
