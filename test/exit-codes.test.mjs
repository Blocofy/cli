import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * CF-T9 (contract C2) — consistent exit codes across commands (0 ok · 1 usage/network/5xx/local · 2 server refusal
 * 4xx · 3 target) and, under --json, the {"error":{code,message,details}} envelope as the LAST stderr line.
 */

const BIN = fileURLToPath(new URL("../bin/blocofy.mjs", import.meta.url));
const TOKEN = "bcf_exitCodesToken_0123456789abcdef";
const API_KEY = "blcf_live_exitCodesKey_0123456789abcdef";
const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function tmp() {
  const d = mkdtempSync(join(tmpdir(), "bcf-exit-"));
  dirs.push(d);
  return d;
}

/** `routes[`${method} ${pathname}`]` → { status, body, headers } | "reset". Identity endpoints always answer. */
async function fakeSite(routes) {
  const reqs = [];
  const server = createServer(async (req, res) => {
    for await (const _ of req);
    const path = new URL(req.url, "http://x").pathname;
    const site = { id: "s1", slug: "site", name: "Site" };
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    };
    if (path === "/api/dev/whoami") return send(200, { site, liveThemeId: "t1" });
    if (path === "/api/v1/ping") return send(200, { ok: true, site });
    reqs.push(`${req.method} ${path}`);
    const r = routes[`${req.method} ${path}`];
    if (r === "reset") return req.socket.destroy();
    if (!r) return send(404, { error: "not_found" });
    send(r.status, r.body ?? {}, r.headers);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  after(() => server.close());
  return { url: `http://127.0.0.1:${server.address().port}`, reqs };
}

function project() {
  const dir = tmp();
  mkdirSync(join(dir, ".blocofy"));
  writeFileSync(join(dir, ".blocofy", "project.json"), JSON.stringify({ schema_version: 1, site_id: "s1", site_slug: "site", platform_origin: null }));
  mkdirSync(join(dir, "config"));
  writeFileSync(join(dir, "config", "settings.json"), "{}");
  return dir;
}

function run(args, { url, cwd }) {
  return new Promise((resolve) => {
    const home = tmp();
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd: cwd ?? home,
      env: { PATH: process.env.PATH, HOME: home, BLOCOFY_URL: url, BLOCOFY_TOKEN: TOKEN, BLOCOFY_API_URL: url, BLOCOFY_API_KEY: API_KEY },
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

/** Last stderr line = envelope; the {"target":…} line precedes it; no secret anywhere. */
function lastEnvelope(r) {
  const lines = r.stderr.trim().split("\n");
  const env = JSON.parse(lines.pop());
  assert.ok(env.error && typeof env.error.code === "string" && typeof env.error.message === "string" && typeof env.error.details === "object", r.stderr);
  for (const s of [TOKEN, API_KEY]) assert.ok(!(r.stdout + r.stderr).includes(s), "secret leaked");
  return { error: env.error, before: lines };
}

test("theme publish: 409 → exit 2 with envelope; 4× 503 → exit 1 after retries; 500 → exit 1, not retried", async () => {
  const dir = project();
  const refused = await fakeSite({ "POST /api/dev/publish": { status: 409, body: { error: "Theme has no pages." } } });
  const r = await run(["theme", "publish", "--instance", "t2", "--json"], { url: refused.url, cwd: dir });
  assert.equal(r.code, 2, r.stderr);
  const { error, before } = lastEnvelope(r);
  assert.deepEqual(error, { code: "HTTP_409", message: "Theme has no pages.", details: { status: 409 } });
  assert.ok(before.some((l) => l.startsWith('{"target"')), "the target block precedes the envelope under --json");

  const busy = await fakeSite({ "POST /api/dev/publish": { status: 503, body: { error: "Temporarily unavailable." }, headers: { "retry-after": "0" } } });
  const b = await run(["theme", "publish", "--instance", "t2", "--json"], { url: busy.url, cwd: dir });
  assert.equal(b.code, 1, b.stderr);
  assert.equal(lastEnvelope(b).error.code, "HTTP_503");
  assert.equal(busy.reqs.filter((q) => q === "POST /api/dev/publish").length, 4);

  const boom = await fakeSite({ "POST /api/dev/publish": { status: 500, body: { error: "boom" } } });
  const x = await run(["theme", "publish", "--instance", "t2"], { url: boom.url, cwd: dir });
  assert.equal(x.code, 1, x.stderr);
  assert.equal(boom.reqs.filter((q) => q === "POST /api/dev/publish").length, 1, "500 is never retried");
});

test("settings push 422 → exit 2; theme rename 404 → exit 2; status network reset → exit 1 NETWORK_ERROR", async () => {
  const dir = project();
  const s = await fakeSite({ "POST /api/dev/content": { status: 422, body: { error: "invalid settings" } } });
  const r = await run(["settings", "push", dir, "--json"], { url: s.url, cwd: dir });
  assert.equal(r.code, 2, r.stderr);
  assert.equal(lastEnvelope(r).error.message, "invalid settings");

  const rn = await run(["theme", "rename", "tX", "New", "--json"], { url: s.url, cwd: dir });
  assert.equal(rn.code, 2, rn.stderr);
  assert.equal(lastEnvelope(rn).error.details.status, 404);

  const reset = await fakeSite({ "GET /api/dev/site": "reset" });
  const st = await run(["status", "--json"], { url: reset.url, cwd: dir });
  assert.equal(st.code, 1, st.stderr);
  assert.equal(lastEnvelope(st).error.code, "NETWORK_ERROR");
  assert.equal((st.stderr.match(/retrying/g) ?? []).length, 3);
});

test("media-uses under --json: 404 → exit 2, normalized envelope (details present); 503 → exit 1", async () => {
  const s = await fakeSite({ "GET /api/v1/pages/pg1/media-uses": { status: 404, body: { error: { code: "not_found", message: "Page not found." } } } });
  const r = await run(["pages", "media-uses", "pg1", "--json"], { url: s.url });
  assert.equal(r.code, 2, r.stderr);
  assert.deepEqual(lastEnvelope(r).error, { code: "not_found", message: "Page not found.", details: {} });
  const busy = await fakeSite({ "GET /api/v1/pages/pg1/media-uses": { status: 503, body: { error: { code: "busy", message: "busy" } }, headers: { "retry-after": "0" } } });
  const b = await run(["pages", "media-uses", "pg1", "--json"], { url: busy.url });
  assert.equal(b.code, 1, b.stderr);
  assert.equal(lastEnvelope(b).error.details.status, 503);
});

test("usage and local refusals: unknown flag and a local pages preflight error print the envelope last under --json (exit 1)", async () => {
  const dir = project();
  const u = await run(["theme", "pull", dir, "--bogus", "--json"], { url: "http://127.0.0.1:9", cwd: dir });
  assert.equal(u.code, 1);
  assert.equal(lastEnvelope(u).error.code, "USAGE_UNKNOWN_FLAG");

  const s = await fakeSite({
    "GET /api/dev/content": { status: 200, body: { protocol_version: 2, default_locale: "en-US", supported_locales: ["en-US"], files: {}, diagnostics: [] } },
  });
  mkdirSync(join(dir, "pages", "en-US"), { recursive: true });
  writeFileSync(join(dir, "pages", "en-US", "index.json"), "{ not json");
  const p = await run(["pages", "push", dir, "--json"], { url: s.url, cwd: dir });
  assert.equal(p.code, 1, p.stderr);
  const { error } = lastEnvelope(p);
  assert.match(error.code, /^PAGES_/);
  assert.ok(Array.isArray(error.details.diagnostics) && error.details.diagnostics.length > 0);
  assert.ok(!s.reqs.includes("POST /api/dev/content"), "nothing was sent");
});

test("review M7: a generic server error that echoes the token is redacted, with and without --json", async () => {
  const dir = project();
  const s = await fakeSite({ "POST /api/dev/publish": { status: 400, body: { error: `bad token ${TOKEN}` } } });
  for (const extra of [[], ["--json"]]) {
    const r = await run(["theme", "publish", "--instance", "t2", ...extra], { url: s.url, cwd: dir });
    assert.equal(r.code, 2, r.stderr);
    assert.ok(!r.stderr.includes(TOKEN), `token leaked ${extra.join(" ")}`);
    assert.match(r.stderr, /bad token \[redacted\]/);
  }
});
