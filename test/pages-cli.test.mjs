import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../bin/blocofy.mjs", import.meta.url));

// Credentials come from HOME or BLOCOFY_URL/BLOCOFY_TOKEN; every run gets an empty HOME so a developer's login
// never leaks into the arms.
function run(args, env = {}) {
  const home = mkdtempSync(join(tmpdir(), "bcli-home-"));
  const { BLOCOFY_URL: _u, BLOCOFY_TOKEN: _t, ...clean } = process.env;
  const r = spawnSync(process.execPath, [BIN, ...args], { env: { ...clean, HOME: home, ...env }, encoding: "utf8" });
  rmSync(home, { recursive: true, force: true });
  return r;
}
function runAsync(args, env = {}) {
  return new Promise((resolveRun) => {
    const home = mkdtempSync(join(tmpdir(), "bcli-home-"));
    const { BLOCOFY_URL: _u, BLOCOFY_TOKEN: _t, ...clean } = process.env;
    import("node:child_process").then(({ spawn }) => {
      const child = spawn(process.execPath, [BIN, ...args], { env: { ...clean, HOME: home, ...env } });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("close", (status) => {
        rmSync(home, { recursive: true, force: true });
        resolveRun({ status, stdout, stderr });
      });
    });
  });
}
function site(files) {
  const dir = mkdtempSync(join(tmpdir(), "bcli-site-"));
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, ...rel.split("/"));
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, content);
  }
  return dir;
}
/** CF-T2: every remote command verifies its site first (GET /api/dev/whoami) — answered here, not recorded. */
function whoami(req, res) {
  if (req.method !== "GET" || !req.url.endsWith("/api/dev/whoami")) return false;
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ site: { id: "s1", slug: "site", name: "Site" }, liveThemeId: null }));
  return true;
}
/** CF-T2: a page push is a remote mutation → the directory is bound to the fake site. */
function bind(dir) {
  mkdirSync(join(dir, ".blocofy"), { recursive: true });
  writeFileSync(join(dir, ".blocofy", "project.json"), JSON.stringify({ schema_version: 1, site_id: "s1", site_slug: "site", platform_origin: null }));
}
const v2 = (locale, slug) => JSON.stringify({ format_version: 2, slug, locale, data: { version: 2, sections: [] } });
const legacy = (slug, extra = {}) => JSON.stringify({ slug, data: { version: 2, sections: [] }, ...extra });

test("pages check (offline): a locale/path mismatch exits 1 with a coded, readable error", () => {
  const dir = site({ "pages/en-US/routes/about/index.json": v2("tr-TR", "/about") });
  const r = run(["pages", "check", dir]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /error \[PAGES_LOCALE_PATH_MISMATCH\]:/);
  assert.match(r.stderr, /pages\/en-US\/routes\/about\/index\.json/);
  assert.match(r.stdout, /offline/);
  rmSync(dir, { recursive: true, force: true });
});

test("pages check: a clean tree exits 0; --strict turns legacy warnings into exit 1", () => {
  const dir = site({ "pages/en-US/index.json": v2("en-US", "/"), "pages/about.json": legacy("/about", { locale: "en-US" }) });
  assert.equal(run(["pages", "check", dir]).status, 0);
  const strict = run(["pages", "check", dir, "--strict"]);
  assert.equal(strict.status, 1);
  assert.match(strict.stderr, /warning \[PAGES_LEGACY_LAYOUT\]/);
  rmSync(dir, { recursive: true, force: true });
});

test("pages migrate-layout: dry run by default; --dry-run with --write is refused; --write moves", () => {
  const dir = site({ "pages/about.json": legacy("/about", { locale: "en-US" }) });
  const plan = run(["pages", "migrate-layout", dir]);
  assert.equal(plan.status, 0);
  assert.match(plan.stdout, /pages\/about\.json → pages\/en-US\/routes\/about\/index\.json/);
  assert.ok(existsSync(join(dir, "pages", "about.json")));
  assert.equal(run(["pages", "migrate-layout", dir, "--dry-run", "--write"]).status, 1);
  const moved = run(["pages", "migrate-layout", dir, "--write"]);
  assert.equal(moved.status, 0);
  assert.ok(existsSync(join(dir, "pages", "en-US", "routes", "about", "index.json")));
  assert.ok(!existsSync(join(dir, "pages", "about.json")));
  rmSync(dir, { recursive: true, force: true });
});

test("pages migrate-layout --write: an ambiguous file → exit 1, nothing moved", () => {
  const dir = site({ "pages/about.json": legacy("/about", { locale: "en-US" }), "pages/contact.json": legacy("/contact") });
  const r = run(["pages", "migrate-layout", dir, "--write"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /PAGES_AMBIGUOUS_LAYOUT/);
  assert.match(r.stderr, /no files were moved/);
  assert.ok(existsSync(join(dir, "pages", "about.json")));
  rmSync(dir, { recursive: true, force: true });
});

test("pages push without login exits 1 and sends nothing", () => {
  const dir = site({ "pages/en-US/index.json": v2("en-US", "/") });
  const r = run(["pages", "push", dir, "--dry-run"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Login required/);
  rmSync(dir, { recursive: true, force: true });
});

test("pages push against an old server: PAGES_SERVER_UPGRADE_REQUIRED, exit 1, no POST", async () => {
  const methods = [];
  const server = createServer((req, res) => {
    if (whoami(req, res)) return;
    methods.push(req.method);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ files: {} }));
  });
  server.listen(0);
  await once(server, "listening");
  const dir = site({ "pages/en-US/index.json": v2("en-US", "/") });
  bind(dir);
  try {
    const r = await runAsync(["pages", "push", dir], { BLOCOFY_URL: `http://127.0.0.1:${server.address().port}`, BLOCOFY_TOKEN: "bcf_" + "x".repeat(30) });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /PAGES_SERVER_UPGRADE_REQUIRED/);
    assert.deepEqual(methods, ["GET"]);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pages push --dry-run against a v2 server prints the preflight summary and exits 0", async () => {
  const server = createServer((req, res) => {
    if (whoami(req, res)) return;
    res.writeHead(200, { "content-type": "application/json" });
    if (req.method === "GET") {
      res.end(JSON.stringify({ protocol_version: 2, page_layout_version: 2, default_locale: "en-US", supported_locales: ["en-US"], files: {}, diagnostics: [] }));
      return;
    }
    res.end(JSON.stringify({ ok: true, protocol_version: 2, dry_run: true, pagesUpdated: 0, pagesSkipped: 0, pages: [{ path: "pages/en-US/index.json", locale: "en-US", slug: "/", action: "publish" }], diagnostics: [] }));
  });
  server.listen(0);
  await once(server, "listening");
  const dir = site({ "pages/en-US/index.json": v2("en-US", "/") });
  try {
    const r = await runAsync(["pages", "push", dir, "--dry-run"], { BLOCOFY_URL: `http://127.0.0.1:${server.address().port}`, BLOCOFY_TOKEN: "bcf_" + "x".repeat(30) });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Preflight passed: 1 updates, 0 drafts, 0 unchanged, 0 conflicts, 0 warning\(s\)\./);
    assert.match(r.stdout, /Dry run only; no pages were changed\./);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unknown flag on a pages command is refused without writing", () => {
  const dir = site({ "pages/about.json": legacy("/about", { locale: "en-US" }) });
  const r = run(["pages", "migrate-layout", "--force", dir]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Unknown flag --force/);
  assert.ok(existsSync(join(dir, "pages", "about.json")));
  rmSync(dir, { recursive: true, force: true });
});

test("F2: pages pull against an incomplete export prints every diagnostic, exits 1 and writes nothing", async () => {
  const server = createServer((req, res) => {
    if (whoami(req, res)) return;
    res.writeHead(422, { "content-type": "application/json" });
    res.end(JSON.stringify({ protocol_version: 2, code: "PAGES_EXPORT_INCOMPLETE", error: "2 published page(s) cannot be exported; nothing was exported.", diagnostics: [
      { level: "error", code: "PAGES_INVALID_LOCALE", message: "Page /about has no language", slug: "/about" },
      { level: "error", code: "PAGES_INVALID_SLUG", message: "bad slug", slug: "bad" },
    ] }));
  });
  server.listen(0);
  await once(server, "listening");
  const dir = site({});
  try {
    const r = await runAsync(["pages", "pull", dir], { BLOCOFY_URL: `http://127.0.0.1:${server.address().port}`, BLOCOFY_TOKEN: "bcf_" + "x".repeat(30) });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /PAGES_INVALID_LOCALE/);
    assert.match(r.stderr, /PAGES_INVALID_SLUG/);
    assert.match(r.stderr, /error \[PAGES_EXPORT_INCOMPLETE\]/);
    assert.match(r.stderr, /nothing was exported/);
    assert.ok(!existsSync(join(dir, "pages")));
    assert.ok(!existsSync(join(dir, ".blocofy")), "a failed pull records no binding");
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CF-T3: pages push against 4 consecutive 503 → exit 1; every POST attempt carries the same x-idempotency-key and identical body; retries announced", async () => {
  const posts = [];
  const server = createServer(async (req, res) => {
    if (whoami(req, res)) return;
    let raw = "";
    for await (const c of req) raw += c;
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ protocol_version: 2, page_layout_version: 2, default_locale: "en-US", supported_locales: ["en-US"], files: {}, diagnostics: [] }));
      return;
    }
    posts.push({ key: req.headers["x-idempotency-key"], body: raw });
    res.writeHead(503, { "content-type": "application/json", "retry-after": "0" });
    res.end(JSON.stringify({ error: "busy" }));
  });
  server.listen(0);
  await once(server, "listening");
  const dir = site({ "pages/en-US/index.json": v2("en-US", "/") });
  bind(dir);
  try {
    const r = await runAsync(["pages", "push", dir], { BLOCOFY_URL: `http://127.0.0.1:${server.address().port}`, BLOCOFY_TOKEN: "bcf_" + "x".repeat(30) });
    assert.equal(r.status, 1, r.stderr);
    assert.equal(posts.length, 4, "1 attempt + 3 retries, no more");
    assert.match(posts[0].key, /^cli-[0-9a-f-]{36}$/);
    assert.ok(posts.every((p) => p.key === posts[0].key && p.body === posts[0].body), "a retry must resend the identical request");
    assert.equal((r.stderr.match(/retrying/g) ?? []).length, 3);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
