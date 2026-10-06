import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { INIT_STATES, inspectInitDir, initApi, readInitState, runInit } from "../lib/init.mjs";

/**
 * ADR-0014 §5.6 (wave P4) — `blocofy init` recovery matrix against a fake platform in this process. The fake keeps the
 * platform's theme-work idempotency (057: the same key returns the same work; another body under the key is 422) and
 * counts every request, so "one work", "zero remote writes" and "the live pointer unchanged" are measured.
 */

const ORIGIN = "https://app.blocofy.test";
const SITE = { id: "s7k2p9", slug: "shop", name: "Shop", domain: "shop.myblocofy.test" };
const TOKEN = "blcf_ct_initTokenCANARY.sig";
const DIRS = [];
after(() => DIRS.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "blocofy-init-"));
  DIRS.push(d);
  return d;
};

function digest(dir) {
  const h = createHash("sha256");
  if (!existsSync(dir)) return "missing";
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      h.update(p.slice(dir.length));
      if (statSync(p).isDirectory()) walk(p);
      else h.update(readFileSync(p));
    }
  };
  walk(dir);
  return h.digest("hex");
}

function fakePlatform() {
  const state = { url: null, live: "tLIVE", works: new Map(), byKey: new Map(), requests: [], mode: null, previewLinks: 0, pagesOnWork: true, liveAfterPost: null };
  const count = (pred) => state.requests.filter(pred).length;
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const u = new URL(req.url, "http://x");
    state.requests.push({ method: req.method, path: u.pathname, query: u.search, key: req.headers["idempotency-key"] ?? null });
    const json = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(401, { error: { code: "invalid_key", message: "x" } });
    // Identity (the bin verifies both endpoints of a CLI login before init starts).
    if (u.pathname === "/api/v1/ping") return json(200, { ok: true, site: SITE, platform_origin: ORIGIN, profile: { id: "theme-dev", version: 1, label: "Tema geliştirme" }, audience: "cli", dev_endpoint: `${state.url}/api/dev`, policy_version: 1 });
    if (u.pathname === "/api/dev/whoami") return json(200, { site: SITE, platform_origin: ORIGIN, liveThemeId: state.live });
    if (u.pathname === "/api/v1/site/status") return json(200, { live_theme_instance: state.live ? { id: state.live, name: "Live" } : null, health: "ok", drafts: [] });
    if (u.pathname === "/api/v1/theme-work" && req.method === "POST") {
      const key = req.headers["idempotency-key"];
      const body = JSON.parse(raw || "{}");
      const known = state.byKey.get(key);
      if (known) {
        if (known.intent !== body.intent) return json(422, { error: { code: "idempotency_key_reuse", message: "Bu anahtar başka bir istekle kullanılmış." } });
        return json(200, { work: state.works.get(known.id), replayed: true });
      }
      const n = state.works.size + 1;
      const work = { id: `wk_${"a".repeat(25)}${n}`, theme: `tWORK${n}`, state: "open", state_version: 1, intent: body.intent };
      state.works.set(work.id, work);
      state.byKey.set(key, { id: work.id, intent: body.intent });
      if (state.liveAfterPost) state.live = state.liveAfterPost;
      if (state.mode === "hang_once") {
        state.mode = null;
        return; // created, but the answer never comes
      }
      if (state.mode === "error_once") {
        state.mode = null;
        return json(500, { error: { code: "internal_error", message: "boom" } });
      }
      return json(201, { work });
    }
    const w = u.pathname.match(/^\/api\/v1\/theme-work\/([^/]+)$/);
    if (w && req.method === "GET") {
      const work = state.works.get(w[1]);
      return work ? json(200, { work }) : json(404, { error: { code: "not_found", message: "Çalışma bulunamadı." } });
    }
    if (u.pathname === "/api/dev/theme" && req.method === "GET") {
      const instance = u.searchParams.get("instance");
      if (![...state.works.values()].some((x) => x.theme === instance)) return json(404, { error: "not_found" });
      return json(200, { protocol: 1, files: { "layout/theme": "<html>{{ content_for_layout }}</html>", "section/Hero": "hero", "asset/site.css": "body{}" } });
    }
    if (u.pathname === "/api/v1/pages" && req.method === "GET") {
      const pages = [{ id: "pLIVE1", slug: "/", theme_instance: state.live }];
      if (state.pagesOnWork) for (const x of state.works.values()) pages.push({ id: `p${x.theme}tpl`, slug: "/blog/[slug]", theme_instance: x.theme }, { id: `p${x.theme}`, slug: "/", theme_instance: x.theme });
      return json(200, { pages, total: pages.length, page: 1, limit: 100 });
    }
    const p = u.pathname.match(/^\/api\/v1\/themes\/([^/]+)\/preview-links$/);
    if (p && req.method === "POST") {
      const body = JSON.parse(raw || "{}");
      if (body.page !== `p${p[1]}`) return json(422, { error: { code: "validation_failed", message: "Bu sayfa seçilen temaya ait değil." } });
      state.previewLinks += 1;
      return json(201, { preview_link: { id: `pl${state.previewLinks}`, url: `https://shop.myblocofy.test/?preview=signedCANARY${state.previewLinks}`, expires_at: "2026-10-07T00:00:00Z" } });
    }
    return json(404, { error: { code: "not_found", message: "?" } });
  });
  return {
    state,
    count,
    posts: () => count((r) => r.method === "POST" && r.path === "/api/v1/theme-work"),
    async start() {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      state.url = `http://127.0.0.1:${server.address().port}`;
      return this;
    },
    stop: () => new Promise((r) => {
      server.closeAllConnections?.();
      server.close(r);
    }),
  };
}

const identity = { site: SITE, platformOrigin: ORIGIN };
const profile = { id: "theme-dev", version: 1, label: "Tema geliştirme" };
const apiFor = (pf, opts = {}) => initApi({ apiUrl: pf.state.url, devUrl: pf.state.url, token: TOKEN, timeoutMs: 400, retryBackoff: [10, 10, 10], ...opts });
const run = (pf, dir, opts = {}) => runInit({ dir, identity, contextName: "shop", profile, api: apiFor(pf, opts.api), log: () => {}, ...opts.run });

test("states are the ADR's, in order", () => {
  assert.deepEqual(INIT_STATES, ["started", "work_created", "files_pulled", "pinned", "previewed"]);
});

test("fresh directory: one work, files from the WORK's theme, secret-free pin, preview, live read back unchanged", async () => {
  const pf = await fakePlatform().start();
  try {
    const dir = join(tmp(), "site");
    const r = await run(pf, dir);
    assert.equal(r.state, "previewed");
    assert.equal(r.liveUnchanged, true);
    assert.match(r.previewUrl, /preview=signedCANARY1/);
    assert.equal(pf.posts(), 1);
    const post = pf.state.requests.find((x) => x.method === "POST" && x.path === "/api/v1/theme-work");
    const init = readInitState(dir);
    assert.equal(post.key, `init:${init.init_key}`);
    assert.equal(init.state, "previewed");
    assert.equal(init.site_id, SITE.id);
    assert.equal(init.platform_origin, ORIGIN);
    assert.equal(init.work_handle, r.work.id);
    assert.equal(readFileSync(join(dir, "section", "Hero.liquid"), "utf8"), "hero");
    assert.ok(pf.state.requests.some((x) => x.path === "/api/dev/theme" && x.query === `?instance=${r.work.theme}`), "pulled from the work, not live");
    const project = JSON.parse(readFileSync(join(dir, ".blocofy", "project.json"), "utf8"));
    assert.deepEqual(project, { schema_version: 1, site_id: SITE.id, site_slug: "shop", platform_origin: ORIGIN, profile: { id: "theme-dev", version: 1 } });
    const local = JSON.parse(readFileSync(join(dir, ".blocofy", "local.json"), "utf8"));
    assert.equal(local.context, "shop");
    assert.equal(local.theme_work.handle, r.work.id);
    assert.deepEqual(readFileSync(join(dir, ".blocofy", ".gitignore"), "utf8").trim().split("\n").sort(), ["init.json", "local.json"]);
    // Nothing secret on disk: no token, no preview link (it is shown once).
    for (const f of ["init.json", "project.json", "local.json"]) {
      const text = readFileSync(join(dir, ".blocofy", f), "utf8");
      assert.doesNotMatch(text, /CANARY|blcf_|bcf_/, f);
    }
    assert.equal(existsSync(join(dir, ".blocofy", ".init.lock")), false, "lock released");
  } finally {
    await pf.stop();
  }
});

test("double run: the second init finds the finished state, starts nothing, creates no second link", async () => {
  const pf = await fakePlatform().start();
  try {
    const dir = join(tmp(), "site");
    const a = await run(pf, dir);
    const before = digest(dir);
    const b = await run(pf, dir);
    assert.equal(b.work.id, a.work.id);
    assert.equal(b.state, "previewed");
    assert.equal(b.previewUrl, null);
    assert.equal(b.previewCreatedEarlier, true);
    assert.equal(pf.posts(), 1);
    assert.equal(pf.state.previewLinks, 1);
    assert.equal(digest(dir).length, before.length);
  } finally {
    await pf.stop();
  }
});

test("timeout after the POST: the resend carries the same key and returns the SAME work", async () => {
  const pf = await fakePlatform().start();
  try {
    pf.state.mode = "hang_once";
    const dir = join(tmp(), "site");
    const r = await run(pf, dir);
    assert.equal(pf.posts(), 2, "one resend");
    const keys = pf.state.requests.filter((x) => x.method === "POST" && x.path === "/api/v1/theme-work").map((x) => x.key);
    assert.equal(keys[0], keys[1]);
    assert.equal(pf.state.works.size, 1);
    assert.equal(r.work.id, [...pf.state.works.keys()][0]);
    assert.equal(r.state, "previewed");
  } finally {
    await pf.stop();
  }
});

test("no definite answer (500): init stops at `started` with its key on disk; the next run replays to the same work", async () => {
  const pf = await fakePlatform().start();
  try {
    pf.state.mode = "error_once";
    const dir = join(tmp(), "site");
    await assert.rejects(run(pf, dir), (e) => e.code === "INIT_OUTCOME_UNKNOWN" && /init/.test(e.message));
    const saved = readInitState(dir);
    assert.equal(saved.state, "started");
    assert.equal(pf.state.works.size, 1, "the platform did start one");
    const r = await run(pf, dir);
    assert.equal(r.work.id, [...pf.state.works.keys()][0]);
    assert.equal(readInitState(dir).init_key, saved.init_key);
    assert.equal(pf.state.works.size, 1);
  } finally {
    await pf.stop();
  }
});

test("two inits at once in the same directory → one work; the other is refused while the first runs", async () => {
  const pf = await fakePlatform().start();
  try {
    const dir = join(tmp(), "site");
    const results = await Promise.allSettled([run(pf, dir), run(pf, dir)]);
    const ok = results.filter((x) => x.status === "fulfilled");
    const refused = results.filter((x) => x.status === "rejected");
    assert.equal(pf.state.works.size, 1);
    assert.equal(ok.length + refused.length, 2);
    for (const x of refused) assert.equal(x.reason.code, "INIT_IN_PROGRESS");
    assert.ok(ok.length >= 1);
  } finally {
    await pf.stop();
  }
});

test("dirty directory → INIT_DIR_NOT_EMPTY: nothing sent, nothing written", async () => {
  const pf = await fakePlatform().start();
  try {
    const dir = tmp();
    writeFileSync(join(dir, "notes.txt"), "mine");
    const before = digest(dir);
    await assert.rejects(run(pf, dir), (e) => e.code === "INIT_DIR_NOT_EMPTY" && e.exitCode === 3);
    assert.equal(digest(dir), before);
    assert.equal(pf.state.requests.length, 0);
    assert.equal(inspectInitDir(dir).kind, "dirty");
  } finally {
    await pf.stop();
  }
});

test("directory bound to another site → INIT_SITE_MISMATCH: no claim, nothing sent, digest unchanged", async () => {
  const pf = await fakePlatform().start();
  try {
    for (const other of [{ site_id: "sOTHER", platform_origin: ORIGIN }, { site_id: SITE.id, platform_origin: "https://other.example" }]) {
      const dir = tmp();
      mkdirSync(join(dir, ".blocofy"));
      writeFileSync(join(dir, ".blocofy", "project.json"), JSON.stringify({ schema_version: 1, site_slug: "x", ...other }));
      writeFileSync(join(dir, ".blocofy", "init.json"), JSON.stringify({ schema_version: 1, init_key: "k", site_id: other.site_id, platform_origin: other.platform_origin, state: "previewed" }));
      const before = digest(dir);
      await assert.rejects(run(pf, dir), (e) => e.code === "INIT_SITE_MISMATCH" && e.exitCode === 3);
      assert.equal(digest(dir), before);
    }
    assert.equal(pf.state.requests.length, 0);
  } finally {
    await pf.stop();
  }
});

test("a project bound without init state (link / pull) is not taken over by init", async () => {
  const pf = await fakePlatform().start();
  try {
    const dir = tmp();
    mkdirSync(join(dir, ".blocofy"));
    writeFileSync(join(dir, ".blocofy", "project.json"), JSON.stringify({ schema_version: 1, site_id: SITE.id, site_slug: "shop", platform_origin: ORIGIN }));
    const before = digest(dir);
    await assert.rejects(run(pf, dir), (e) => e.code === "INIT_ALREADY_BOUND" && /theme work start/.test(e.message));
    assert.equal(digest(dir), before);
    assert.equal(pf.state.requests.length, 0);
  } finally {
    await pf.stop();
  }
});

test("resume from every state: remote readback first, then only the steps not yet done", async () => {
  for (const from of ["work_created", "files_pulled", "pinned"]) {
    const pf = await fakePlatform().start();
    try {
      const dir = join(tmp(), "site");
      // A first run, then the local state rewound to `from` (as if the process died after that step).
      const first = await run(pf, dir);
      const saved = readInitState(dir);
      writeFileSync(join(dir, ".blocofy", "init.json"), JSON.stringify({ ...saved, state: from }));
      if (from === "work_created") for (const f of ["layout", "section", "asset"]) rmSync(join(dir, f), { recursive: true, force: true });
      if (from !== "pinned") rmSync(join(dir, ".blocofy", "project.json"), { force: true });
      pf.state.requests.length = 0;
      const r = await run(pf, dir);
      assert.equal(r.work.id, first.work.id, from);
      assert.equal(r.state, "previewed", from);
      assert.equal(pf.posts(), 0, `${from}: no new work`);
      assert.equal(pf.count((x) => x.method === "GET" && x.path.startsWith("/api/v1/theme-work/")), 1, `${from}: remote readback`);
      assert.equal(pf.count((x) => x.path === "/api/dev/theme"), from === "work_created" ? 1 : 0, `${from}: pull only when not done`);
      assert.ok(existsSync(join(dir, "section", "Hero.liquid")));
      assert.ok(existsSync(join(dir, ".blocofy", "project.json")));
    } finally {
      await pf.stop();
    }
  }
});

test("local state is not authority: a saved work the platform does not know stops init (INIT_WORK_MISSING)", async () => {
  const pf = await fakePlatform().start();
  try {
    const dir = join(tmp(), "site");
    mkdirSync(join(dir, ".blocofy"), { recursive: true });
    writeFileSync(join(dir, ".blocofy", "init.json"), JSON.stringify({ schema_version: 1, init_key: "11111111-1111-4111-8111-111111111111", site_id: SITE.id, platform_origin: ORIGIN, state: "work_created", work_handle: `wk_${"z".repeat(26)}`, work_theme: "tGONE", live_before: "tLIVE" }));
    await assert.rejects(run(pf, dir), (e) => e.code === "INIT_WORK_MISSING");
    assert.equal(pf.posts(), 0);
  } finally {
    await pf.stop();
  }
});

test("the live theme changed during init → no success: liveUnchanged false (the caller exits 5)", async () => {
  const pf = await fakePlatform().start();
  try {
    pf.state.liveAfterPost = "tSOMEONE_ELSE";
    const r = await run(pf, join(tmp(), "site"));
    assert.equal(r.liveUnchanged, false);
    assert.equal(r.liveBefore, "tLIVE");
    assert.equal(r.liveAfter, "tSOMEONE_ELSE");
  } finally {
    await pf.stop();
  }
});

test("no page on the work's theme → the preview is not claimed: state stays `pinned`", async () => {
  const pf = await fakePlatform().start();
  try {
    pf.state.pagesOnWork = false;
    const dir = join(tmp(), "site");
    const r = await run(pf, dir);
    assert.equal(r.state, "pinned");
    assert.equal(r.previewUrl, null);
    assert.equal(r.preview, "no_page");
    assert.equal(readInitState(dir).state, "pinned");
  } finally {
    await pf.stop();
  }
});

test("idempotency_key_reuse (422) is a definite refusal: no new work, the message says not to delete init.json", async () => {
  const pf = await fakePlatform().start();
  try {
    const dir = join(tmp(), "site");
    mkdirSync(join(dir, ".blocofy"), { recursive: true });
    const key = "22222222-2222-4222-8222-222222222222";
    pf.state.byKey.set(`init:${key}`, { id: "wk_x", intent: "something else" });
    writeFileSync(join(dir, ".blocofy", "init.json"), JSON.stringify({ schema_version: 1, init_key: key, site_id: SITE.id, platform_origin: ORIGIN, state: "started", work_handle: null, live_before: "tLIVE" }));
    await assert.rejects(run(pf, dir), (e) => e.code === "idempotency_key_reuse" && /init\.json/.test(e.lines.join("\n")));
    assert.equal(pf.state.works.size, 0);
  } finally {
    await pf.stop();
  }
});

// ── the bin: `blocofy init` end to end with a saved CLI login ───────────────────────────────────────────────

const BIN = fileURLToPath(new URL("../bin/blocofy.mjs", import.meta.url));

function homeWithLogin(pf) {
  const home = tmp();
  mkdirSync(join(home, ".blocofy"), { recursive: true, mode: 0o700 });
  const oauth = { url: pf.state.url, issuer: pf.state.url, client_id: "blocofy-cli", token_endpoint: `${pf.state.url}/token`, revocation_endpoint: `${pf.state.url}/revoke`, dev_url: pf.state.url, profile: { id: "theme-dev", version: 1, label: "Tema geliştirme" }, secret: { store: "file" } };
  writeFileSync(join(home, ".blocofy", "credentials.json"), JSON.stringify({ schema_version: 2, current_context: "shop", contexts: { shop: { platform_origin: ORIGIN, site: SITE, oauth, verified_at: null } } }), { mode: 0o600 });
  writeFileSync(join(home, ".blocofy", "secrets.json"), JSON.stringify({ shop: { oauth_tokens: JSON.stringify({ access_token: TOKEN, refresh_token: "blcf_rt_initRefreshCANARY", expires_at: Date.now() + 600_000 }) } }), { mode: 0o600 });
  return home;
}

function runBin(home, args, { cwd } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { cwd: cwd ?? home, env: { PATH: process.env.PATH, HOME: home }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.stdin.end();
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const noToken = (r) => assert.doesNotMatch(r.stdout + r.stderr, /initTokenCANARY|initRefreshCANARY/);

test("bin: `init <dir> --site shop --context shop` (non-interactive) → draft ready, live unchanged, exit 0; a second run starts nothing", async () => {
  const pf = await fakePlatform().start();
  try {
    const home = homeWithLogin(pf);
    const dir = join(tmp(), "my-site");
    const r = await runBin(home, ["init", dir, "--site", "shop", "--context", "shop"]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Taslak hazır\. Canlı siten değişmedi\./);
    assert.match(r.stdout, /preview=signedCANARY1/, "the preview link is shown once");
    assert.match(r.stdout, /theme push .* --draft --work wk_/);
    noToken(r);
    assert.equal(pf.posts(), 1);
    for (const f of readdirSync(join(dir, ".blocofy"))) assert.doesNotMatch(readFileSync(join(dir, ".blocofy", f), "utf8"), /CANARY|blcf_/, f);
    const again = await runBin(home, ["init", dir, "--site", "shop"]);
    assert.equal(again.code, 0, again.stderr);
    assert.match(again.stdout, /daha önce oluşturuldu/);
    assert.equal(pf.posts(), 1);
    assert.equal(pf.state.previewLinks, 1);
  } finally {
    await pf.stop();
  }
});

test("bin: non-interactive init never guesses: no --site → INIT_SITE_REQUIRED, no credential → INIT_LOGIN_REQUIRED; nothing sent", async () => {
  const pf = await fakePlatform().start();
  try {
    const empty = tmp();
    let r = await runBin(empty, ["init", join(tmp(), "x"), "--json"]);
    assert.equal(r.code, 3);
    assert.equal(JSON.parse(r.stderr.trim().split("\n").pop()).error.code, "INIT_SITE_REQUIRED");
    r = await runBin(empty, ["init", join(tmp(), "x"), "--site", "shop", "--json"]);
    assert.equal(r.code, 3);
    assert.equal(JSON.parse(r.stderr.trim().split("\n").pop()).error.code, "INIT_LOGIN_REQUIRED");
    assert.equal(pf.state.requests.length, 0);
  } finally {
    await pf.stop();
  }
});

test("bin: dirty directory and another site's --site are refused with exit 3 before any write", async () => {
  const pf = await fakePlatform().start();
  try {
    const home = homeWithLogin(pf);
    const dirty = tmp();
    writeFileSync(join(dirty, "README.md"), "mine");
    const before = digest(dirty);
    let r = await runBin(home, ["init", dirty, "--site", "shop", "--context", "shop"]);
    assert.equal(r.code, 3);
    assert.match(r.stderr, /INIT_DIR_NOT_EMPTY/);
    assert.match(r.stderr, /boş değil/);
    assert.equal(digest(dirty), before);
    assert.equal(pf.state.requests.length, 0);
    const fresh = join(tmp(), "y");
    r = await runBin(home, ["init", fresh, "--site", "other-shop", "--context", "shop", "--json"]);
    assert.equal(r.code, 3);
    assert.equal(JSON.parse(r.stderr.trim().split("\n").pop()).error.code, "INIT_SITE_MISMATCH");
    assert.equal(pf.posts(), 0);
    assert.equal(existsSync(fresh), false);
  } finally {
    await pf.stop();
  }
});

test("bin: the live theme changed meanwhile → not a success, exit 5", async () => {
  const pf = await fakePlatform().start();
  try {
    pf.state.liveAfterPost = "tSOMEONE_ELSE";
    const home = homeWithLogin(pf);
    const r = await runBin(home, ["init", join(tmp(), "z"), "--site", "shop", "--context", "shop"]);
    assert.equal(r.code, 5, r.stderr);
    assert.match(r.stderr, /INIT_LIVE_CHANGED/);
    assert.match(r.stderr, /başarı denmedi/);
    assert.doesNotMatch(r.stdout, /Taslak hazır/);
  } finally {
    await pf.stop();
  }
});
