import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * T10.1 — `blocofy settings push [dir] --instance <handle>`. The platform's /api/dev/content accepts `instance` (an
 * owned theme handle; another site's → 404 THEME_INSTANCE_NOT_FOUND, nothing written), advertises
 * `settings_instance: 1` in scope=capabilities, and answers `instance`, `live_applied`, `preview_applied`,
 * `live_requires`. An older server would ignore `instance` and write the live theme, so the CLI refuses locally.
 * Product decision (T10.1 "never implicitly live"): a settings push names its target — `--instance` or `--live`.
 */

const BIN = fileURLToPath(new URL("../bin/blocofy.mjs", import.meta.url));
const TOKEN = "bcf_settingsInstanceToken_0123456789";
const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function tmp() {
  const d = mkdtempSync(join(tmpdir(), "bcf-settings-inst-"));
  dirs.push(d);
  return d;
}

const SETTINGS = JSON.stringify({ theme: { settings: { a: 1 } } });

function project() {
  const dir = tmp();
  mkdirSync(join(dir, ".blocofy"));
  writeFileSync(join(dir, ".blocofy", "project.json"), JSON.stringify({ schema_version: 1, site_id: "s1", site_slug: "site", platform_origin: null }));
  mkdirSync(join(dir, "config"));
  writeFileSync(join(dir, "config", "settings.json"), SETTINGS);
  return dir;
}

function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[p] = readFileSync(p, "utf8");
    }
  };
  walk(dir);
  return out;
}

/** `capabilities`: the scope=capabilities body; `post(body)` → { status, body }. Records every non-identity request. */
async function fakeSite({ capabilities, post }) {
  const reqs = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const url = new URL(req.url, "http://x");
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/api/dev/whoami") return send(200, { site: { id: "s1", slug: "site", name: "Site" }, liveThemeId: "tLIVE" });
    reqs.push({ method: req.method, path: url.pathname, query: url.search, body: raw ? JSON.parse(raw) : null });
    if (url.pathname !== "/api/dev/content") return send(404, { error: "not_found" });
    if (req.method === "GET" && url.searchParams.get("scope") === "capabilities") return send(200, capabilities);
    if (req.method === "POST") {
      const r = post(JSON.parse(raw));
      return send(r.status, r.body);
    }
    send(404, { error: "not_found" });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  after(() => server.close());
  return { url: `http://127.0.0.1:${server.address().port}`, reqs };
}

function run(args, { url, cwd }) {
  return new Promise((resolve) => {
    const home = tmp();
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd,
      env: { PATH: process.env.PATH, HOME: home, BLOCOFY_URL: url, BLOCOFY_TOKEN: TOKEN },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.stdin.end();
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const CAPS = { protocol_version: 2, page_layout_version: 2, default_locale: "en-US", supported_locales: ["en-US"], page_revision_cas: 1, plan_hash: 1, settings_instance: 1, files: {}, diagnostics: [] };
const applied = (extra) => ({ status: 200, body: { ok: true, settingsUpdated: true, schemesUpserted: 0, ...extra } });

test("settings push --instance: sends the handle, the Target block names the instance, output says where it applied", async () => {
  const dir = project();
  const s = await fakeSite({ capabilities: CAPS, post: (b) => applied({ instance: b.instance, live_applied: false, preview_applied: true, live_requires: "theme_publish" }) });
  const r = await run(["settings", "push", dir, "--instance", "tDRAFT"], { url: s.url, cwd: dir });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /Operation: settings push · instance tDRAFT/);
  const posts = s.reqs.filter((q) => q.method === "POST");
  assert.equal(posts.length, 1);
  assert.equal(posts[0].body.instance, "tDRAFT");
  assert.equal(posts[0].body.files["config/settings.json"], SETTINGS);
  assert.match(r.stdout, /Applied to draft theme tDRAFT — visible in its preview; not live until `blocofy theme publish --instance tDRAFT`/);
});

test("settings push (live, control-plane site): says the live site shows it after the next theme deploy", async () => {
  const dir = project();
  const s = await fakeSite({ capabilities: CAPS, post: (b) => applied({ instance: "tLIVE", live_applied: false, preview_applied: true, live_requires: "theme_deploy", echoed: b.instance ?? null }) });
  const r = await run(["settings", "push", dir, "--live", "--yes"], { url: s.url, cwd: dir });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /Operation: settings push · live/);
  assert.equal(s.reqs.filter((q) => q.method === "POST")[0].body.instance, undefined, "no --instance → no instance field");
  assert.match(r.stdout, /Saved; the live site shows it after the next theme deploy\/publish \(live_applied: false\)/);
});

test("settings push (live, applied): says it is live now", async () => {
  const dir = project();
  const s = await fakeSite({ capabilities: CAPS, post: () => applied({ instance: "tLIVE", live_applied: true, preview_applied: true, live_requires: null }) });
  const r = await run(["settings", "push", dir, "--live", "--yes"], { url: s.url, cwd: dir });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Applied to the live theme tLIVE — live now/);
});

test("settings push --instance of another site: 404 THEME_INSTANCE_NOT_FOUND → exit 2, no local changes", async () => {
  const dir = project();
  const before = snapshot(dir);
  const s = await fakeSite({ capabilities: CAPS, post: () => ({ status: 404, body: { error: "Theme instance not found.", code: "THEME_INSTANCE_NOT_FOUND" } }) });
  const r = await run(["settings", "push", dir, "--instance", "tOTHER", "--json"], { url: s.url, cwd: dir });
  assert.equal(r.code, 2, r.stderr);
  const envelope = JSON.parse(r.stderr.trim().split("\n").pop());
  assert.equal(envelope.error.code, "THEME_INSTANCE_NOT_FOUND");
  assert.equal(envelope.error.details.status, 404);
  assert.deepEqual(snapshot(dir), before);
  assert.ok(!(r.stdout + r.stderr).includes(TOKEN));
});

test("settings push --instance against a server without settings_instance: refused locally, exit 1, nothing sent", async () => {
  for (const capabilities of [
    { ...CAPS, settings_instance: undefined },
    { files: { "config/settings.json": "{}" } }, // pre-v2 server: scope=capabilities is a full export
  ]) {
    const dir = project();
    const s = await fakeSite({ capabilities, post: () => applied({}) });
    const r = await run(["settings", "push", dir, "--instance", "tDRAFT"], { url: s.url, cwd: dir });
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, /--instance/);
    assert.match(r.stderr, /[Nn]othing was sent/);
    assert.deepEqual(s.reqs.map((q) => `${q.method} ${q.path}${q.query}`), ["GET /api/dev/content?scope=capabilities"], "only identity + capabilities");
  }
});

test("settings push --instance without a handle → usage error; settings pull does not take --instance", async () => {
  const dir = project();
  const s = await fakeSite({ capabilities: CAPS, post: () => applied({}) });
  const r = await run(["settings", "push", dir, "--instance"], { url: s.url, cwd: dir });
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stderr, /--instance needs a theme handle/);
  const p = await run(["settings", "pull", dir, "--instance", "tDRAFT"], { url: s.url, cwd: dir });
  assert.equal(p.code, 1);
  assert.match(p.stderr, /Unknown flag --instance/);
  assert.equal(s.reqs.length, 0, "nothing sent");
});

test("settings push without --instance or --live: usage error, exit 1, zero requests", async () => {
  const dir = project();
  const s = await fakeSite({ capabilities: CAPS, post: () => applied({}) });
  const r = await run(["settings", "push", dir], { url: s.url, cwd: dir });
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stderr, /--instance <handle>/);
  assert.match(r.stderr, /--live/);
  assert.match(r.stderr, /Nothing was sent/);
  assert.equal(s.reqs.length, 0);
  const both = await run(["settings", "push", dir, "--live", "--instance", "tDRAFT"], { url: s.url, cwd: dir });
  assert.equal(both.code, 1, both.stderr);
  assert.match(both.stderr, /either --instance <handle> or --live, not both/);
  assert.equal(s.reqs.length, 0);
});

test("settings push --live in a non-interactive shell needs --yes; nothing is sent without it", async () => {
  const dir = project();
  const s = await fakeSite({ capabilities: CAPS, post: () => applied({ instance: "tLIVE", live_applied: true, preview_applied: true, live_requires: null }) });
  const r = await run(["settings", "push", dir, "--live"], { url: s.url, cwd: dir });
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stderr, /--live --yes/);
  assert.equal(s.reqs.length, 0, "no content request");
  const ok = await run(["settings", "push", dir, "--live", "--yes"], { url: s.url, cwd: dir });
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(s.reqs.filter((q) => q.method === "POST").length, 1);
});
