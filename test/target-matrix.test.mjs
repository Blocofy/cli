import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * CF-T1/T2 — multi-site target matrix (contract C1/C2). Every scenario spawns the real bin against TWO fake
 * sites on 127.0.0.1. Each fake site counts mutating requests (any non-GET, plus `GET /api/dev/theme?draft=1` and
 * `GET /api/dev/session`, which provision a draft server-side). Directory trees are hashed before/after to prove "zero writes".
 */

const BIN = fileURLToPath(new URL("../bin/blocofy.mjs", import.meta.url));
const ORIGIN = "https://app.blocofy.test";

const SECRETS = {
  A: { token: "bcf_alphaDevToken_0123456789abcdef", apiKey: "blcf_live_alphaApiKey_0123456789abcdef", cli: "blcf_ct_alphaCliAccess_0123456789.sig", refresh: "blcf_rt_alphaCliRefresh_0123456789" },
  B: { token: "bcf_betaDevToken_0123456789abcdefgh", apiKey: "blcf_live_betaApiKey_0123456789abcdefgh", cli: "blcf_ct_betaCliAccess_0123456789ab.sig", refresh: "blcf_rt_betaCliRefresh_0123456789ab" },
};
const ALL_SECRETS = [SECRETS.A.token, SECRETS.A.apiKey, SECRETS.B.token, SECRETS.B.apiKey, SECRETS.A.cli, SECRETS.A.refresh, SECRETS.B.cli, SECRETS.B.refresh];

/** Every stdout/stderr captured by this file — scanned for secrets by scenario 18. */
const OUTPUTS = [];
/** Every temp dir created by this file — scanned for secrets by scenario 18, removed at the end. */
const DIRS = [];

function tmp(prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  DIRS.push(d);
  return d;
}

const pageV2 = (label) => JSON.stringify({ format_version: 2, slug: "/", locale: "en-US", title: label, data: { version: 2, sections: [] } }, null, 2) + "\n";

function fakeSite(key, { id, slug, name }) {
  const s = SECRETS[key];
  const state = { requests: [], mutations: 0, whoami: "ok", ping: "ok", platformOrigin: ORIGIN, url: null, themeFiles: null, identitySite: null, whoamiDelayMs: 0, siteApplied: false, cliAudience: "ok", tokenCalls: 0, revokes: [], revoke: "ok" };
  const json = (res, status, body, headers = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  };
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const url = new URL(req.url, "http://x");
    state.requests.push({ method: req.method, url: req.url });
    if (req.method !== "GET" || url.searchParams.get("draft") === "1" || url.pathname === "/api/dev/session") state.mutations += 1;
    const isV1 = url.pathname.startsWith("/api/v1/");
    const auth = req.headers.authorization;
    // ADR-0014 (P4): the platform's OAuth endpoints for a CLI-login context (no bearer; counted, never a site mutation).
    if (url.pathname === "/token" && req.method === "POST") {
      state.mutations -= 1;
      state.tokenCalls += 1;
      const f = new URLSearchParams(raw);
      if (f.get("refresh_token") !== s.refresh) return json(res, 400, { error: "invalid_grant" });
      return json(res, 200, { access_token: s.cli, token_type: "Bearer", expires_in: 600, refresh_token: s.refresh });
    }
    if (url.pathname === "/revoke" && req.method === "POST") {
      state.mutations -= 1;
      state.revokes.push(Object.fromEntries(new URLSearchParams(raw)));
      if (state.revoke === "down") return json(res, 503, { error: "server_error" });
      return json(res, 200, {});
    }
    // A CLI login's token (`blcf_ct_`) is accepted on the v1 REST API and on /api/dev (ADR §5.3).
    const cli = auth === `Bearer ${s.cli}`;
    if (cli && isV1 && state.cliAudience === "mismatch") return json(res, 401, { error: { code: "audience_mismatch", message: "Bu kimlik bilgisi bu uç için değil." } });
    if (!cli && auth !== `Bearer ${isV1 ? s.apiKey : s.token}`) return json(res, 401, isV1 ? { error: { code: "unauthorized", message: "bad key" } } : { error: "Unknown token." });
    // `identitySite` simulates a token that now resolves to another site (identity endpoints only).
    const site = { id, slug, name, domain: `${slug}.myblocofy.test` };
    const identity = state.identitySite ?? site;
    if (url.pathname === "/api/dev/whoami") {
      if (state.whoamiDelayMs) await new Promise((r) => setTimeout(r, state.whoamiDelayMs));
      if (state.whoami === "down") return json(res, 503, { error: "unavailable" }, { "retry-after": "0" });
      if (state.whoami === "malformed") return json(res, 200, "<html>not json</html>");
      return json(res, 200, { site: identity, liveThemeId: `t${key}live`, platform_origin: state.platformOrigin });
    }
    if (url.pathname === "/api/v1/ping") {
      if (state.ping === "down") return json(res, 503, { error: { code: "unavailable" } }, { "retry-after": "0" });
      return json(res, 200, { ok: true, site: identity, platform_origin: state.platformOrigin });
    }
    if (url.pathname === "/api/dev/theme" && req.method === "GET") {
      const instance = url.searchParams.get("instance");
      if (instance && instance !== `t${key}live` && instance !== `t${key}draft`) return json(res, 404, { error: "not_found" });
      return json(res, 200, { protocol: 1, files: state.themeFiles ?? { "layout/theme": `<html>${key}</html>`, "section/Hero": `hero ${key}` } });
    }
    if (url.pathname === "/api/dev/theme" && req.method === "POST") {
      const body = JSON.parse(raw || "{}");
      if (body.instance && body.instance !== `t${key}live` && body.instance !== `t${key}draft`) return json(res, 404, { error: "not_found" });
      if (body.dryRun) return json(res, 200, { ok: true, dryRun: true, warnings: [] });
      return json(res, 200, { ok: true, committed: true, deploymentId: 1, sourceRevisionId: 2, pointerVersion: 3 });
    }
    if (url.pathname === "/api/dev/site") {
      return json(res, 200, { site: { slug }, url: `https://${slug}.myblocofy.test`, live_theme_instance: { id: `t${key}live`, name: "Live", template_count: 2 }, pages_on_live: 1, drafts: [{ id: `t${key}draft`, name: "CLI Draft", source: "import" }], health: "ok" });
    }
    if (url.pathname === "/api/dev/publish") return json(res, 200, { ok: true, published: `t${key}draft`, cloned: false });
    if (url.pathname === "/api/dev/theme/rename" && req.method === "POST") {
      const body = JSON.parse(raw || "{}");
      if (body.instance !== `t${key}live` && body.instance !== `t${key}draft`) return json(res, 404, { error: "not_found" });
      return json(res, 200, { id: body.instance, name: body.name });
    }
    if (url.pathname === "/api/dev/content" && req.method === "GET") {
      const scope = url.searchParams.get("scope");
      if (scope === "settings") return json(res, 200, { files: { "config/settings.json": `{"site":"${key}"}` } });
      const base = { protocol_version: 2, page_layout_version: 2, default_locale: "en-US", supported_locales: ["en-US"], diagnostics: [] };
      if (scope === "capabilities") return json(res, 200, { ...base, files: {} });
      return json(res, 200, { ...base, files: { "pages/en-US/index.json": pageV2(`home ${key}`) } });
    }
    if (url.pathname === "/api/dev/content" && req.method === "POST") {
      const body = JSON.parse(raw || "{}");
      if (body.protocol_version !== 2) return json(res, 200, { settingsUpdated: true, schemesUpserted: 0 });
      return json(res, 200, { ok: true, protocol_version: 2, dry_run: Boolean(body.dry_run), pagesUpdated: body.dry_run ? 0 : 1, pagesSkipped: 0, pages: [{ path: "pages/en-US/index.json", locale: "en-US", slug: "/", action: "publish", outcome: "published" }], diagnostics: [] });
    }
    // cli-fix2: the site-state endpoints, minimal (one step to apply, then a complete draft), so a `site *` cell
    // shows the command completing on the right site. Their state machine is exercised in test/site-state.test.mjs.
    if (url.pathname === "/api/v1/site-state" && req.method === "GET") {
      return json(res, 200, {
        schema_version: 1,
        manifest: { schema_version: 1, kind: "blocofy-site-state", platform_origin: ORIGIN, source_site: { id, slug }, exported_at: "2026-09-18T00:00:00.000Z", manifest_digest: `d${key}`, owners: {} },
        files: { "site/locales.json": JSON.stringify({ default: "en-US", supported: ["en-US"] }, null, 2) + "\n" },
        assets: [],
        diagnostics: [],
      });
    }
    // cli-fix3: until this site has been applied (per reset), the plan has one step, so `site apply` must reach its
    // own apply endpoint on this site, with the plan hash this site gave it.
    const siteState = { plan_hash: `h${key}`, target_instance: `t${key}draft` };
    if (url.pathname === "/api/v1/site-state/plan" && req.method === "POST") {
      const steps = state.siteApplied ? [] : [{ seq: 1, owner: "site", action: "update", key: "site/locales.json", live_effect: false }];
      return json(res, 200, { ...siteState, manifest_digest: `d${key}`, status: steps.length ? "planned" : "draft_complete", steps, assets_missing: [], theme_source: null, preconditions: [], diagnostics: [] });
    }
    if (url.pathname === "/api/v1/site-state/apply" && req.method === "POST") {
      if (JSON.parse(raw || "{}").expected_plan_hash !== siteState.plan_hash) return json(res, 409, { error: { code: "plan_changed", message: "not this site's plan" } });
      state.siteApplied = true;
      return json(res, 200, { ...siteState, status: "draft_complete", applied: [1], not_applied: [], report: [], theme_source: null });
    }
    if (url.pathname === "/api/v1/site-state/publish" && req.method === "POST") {
      return json(res, 200, { ...siteState, status: "published", swapped: true, navigation: [], globals: false });
    }
    const media = url.pathname.match(/^\/api\/v1\/pages\/([^/]+)\/media-uses$/);
    if (media) {
      if (media[1] !== `pg${key}`) return json(res, 404, { error: { code: "not_found", message: "Page not found." } });
      const view = { page: { id: media[1] }, applicable: true, revision: { id: 4, version: 1 }, locale: "en", source_locale: "tr", uses: [], counts: { total: 0, blocked: 0 } };
      return json(res, 200, req.method === "GET" ? view : { ...view, applied: [], written: false });
    }
    return json(res, 404, { error: "not_found" });
  });
  return {
    state,
    get url() {
      return state.url;
    },
    reset() {
      state.requests.length = 0;
      state.mutations = 0;
      state.whoami = "ok";
      state.ping = "ok";
      state.themeFiles = null;
      state.identitySite = null;
      state.whoamiDelayMs = 0;
      state.siteApplied = false;
      state.cliAudience = "ok";
      state.tokenCalls = 0;
      state.revokes = [];
      state.revoke = "ok";
    },
    async start() {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      state.url = `http://127.0.0.1:${server.address().port}`;
    },
    close: () => new Promise((r) => server.close(r)),
  };
}

const A = fakeSite("A", { id: "sA1", slug: "alpha", name: "Alpha Bakery" });
const B = fakeSite("B", { id: "sB2", slug: "beta", name: "Beta Metal" });

before(async () => {
  await A.start();
  await B.start();
});
after(async () => {
  await A.close();
  await B.close();
  for (const d of DIRS) rmSync(d, { recursive: true, force: true });
});

function resetSites() {
  A.reset();
  B.reset();
}

/** Spawn the bin with a clean env (PATH + HOME + extra), stdin piped and closed → non-TTY. */
function run(home, args, { env = {}, cwd } = {}) {
  return new Promise((resolve) => {
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
    child.on("close", (code) => {
      OUTPUTS.push({ args: args.join(" "), stdout, stderr });
      resolve({ code, stdout, stderr });
    });
  });
}

/** Hash of every path (type + bytes) under `dir`; a missing dir hashes to a fixed value. */
function treeHash(dir) {
  const h = createHash("sha256");
  if (!existsSync(dir)) return "missing";
  const walk = (abs, rel) => {
    for (const name of readdirSync(abs).sort()) {
      const childAbs = join(abs, name);
      const childRel = rel ? `${rel}/${name}` : name;
      const st = lstatSync(childAbs);
      if (st.isDirectory()) {
        h.update(`d:${childRel}\n`);
        walk(childAbs, childRel);
      } else {
        h.update(`f:${childRel}:${st.mode & 0o777}\n`);
        h.update(readFileSync(childAbs));
      }
    }
  };
  walk(dir, "");
  return h.digest("hex");
}

function writeTheme(dir, key) {
  mkdirSync(join(dir, "layout"), { recursive: true });
  mkdirSync(join(dir, "section"), { recursive: true });
  mkdirSync(join(dir, "pages", "en-US"), { recursive: true });
  writeFileSync(join(dir, "layout", "theme.liquid"), `<html>${key} local</html>`);
  writeFileSync(join(dir, "section", "Hero.liquid"), `hero ${key} local`);
  writeFileSync(join(dir, "pages", "en-US", "index.json"), pageV2(`home ${key} local`));
}

/** Hand-written binding (what `blocofy link` writes) — used for the legacy RED arm, where no `link` exists. */
function writeBinding(dir, { siteId, slug, context }) {
  mkdirSync(join(dir, ".blocofy"), { recursive: true });
  writeFileSync(join(dir, ".blocofy", "project.json"), JSON.stringify({ schema_version: 1, site_id: siteId, site_slug: slug, platform_origin: ORIGIN }, null, 2) + "\n");
  if (context) writeFileSync(join(dir, ".blocofy", "local.json"), JSON.stringify({ context }) + "\n");
  writeFileSync(join(dir, ".blocofy", ".gitignore"), "local.json\n");
}

function noSecrets(r) {
  for (const secret of ALL_SECRETS) {
    assert.ok(!r.stdout.includes(secret) && !r.stderr.includes(secret), "a secret leaked into CLI output");
  }
}

function jsonError(r) {
  const line = r.stderr.split("\n").map((l) => l.trim()).find((l) => l.startsWith('{"error"'));
  assert.ok(line, `no JSON error envelope on stderr:\n${r.stderr}`);
  return JSON.parse(line).error;
}

// ── scenario 6 (legacy RED arm) ─────────────────────────────────────────────────────────────────────────────

test("[6-legacy] last global login is site B; project A dir (bound to A) push → refused (exit 3), zero mutations on B", async () => {
  resetSites();
  const home = tmp("bcf-mx-home-");
  mkdirSync(join(home, ".blocofy"), { recursive: true });
  // The pre-v2 CLI's single global credential — the "last login" — points at site B.
  writeFileSync(join(home, ".blocofy", "credentials.json"), JSON.stringify({ url: B.url, token: SECRETS.B.token }));
  const projA = tmp("bcf-mx-projA-");
  writeTheme(projA, "A");
  writeBinding(projA, { siteId: "sA1", slug: "alpha" });
  const before = treeHash(projA);

  const r = await run(home, ["theme", "push", projA, "--draft"]);
  assert.equal(B.state.mutations, 0, `site B was mutated (${B.state.requests.map((q) => `${q.method} ${q.url}`).join(", ")})`);
  assert.equal(A.state.mutations, 0);
  assert.equal(r.code, 3, r.stderr);
  assert.equal(treeHash(projA), before);
  noSecrets(r);
});

// ── world: two logged-in contexts (dev + API pair each) and two linked project dirs ────────────────────────

async function world() {
  resetSites();
  const home = tmp("bcf-mx-home-");
  for (const [site, key] of [[A, "A"], [B, "B"]]) {
    const dev = await run(home, ["login", "--url", site.url, "--token", SECRETS[key].token]);
    assert.equal(dev.code, 0, dev.stderr);
    const api = await run(home, ["login", "--api-key"], { env: { BLOCOFY_API_KEY: SECRETS[key].apiKey, BLOCOFY_API_URL: site.url } });
    assert.equal(api.code, 0, api.stderr);
  }
  const projA = tmp("bcf-mx-projA-");
  const projB = tmp("bcf-mx-projB-");
  writeTheme(projA, "A");
  writeTheme(projB, "B");
  assert.equal((await run(home, ["link", projA, "--context", "alpha"])).code, 0);
  assert.equal((await run(home, ["link", projB, "--context", "beta"])).code, 0);
  resetSites();
  return { home, projA, projB };
}

/** A refusal: exit 3, the JSON code, zero requests to both sites (hence zero mutations), dirs byte-identical. */
function assertRefused(r, code, { hashes = [], exit = 3 } = {}) {
  assert.equal(r.code, exit, r.stderr);
  assert.equal(jsonError(r).code, code);
  assert.equal(A.state.mutations + B.state.mutations, 0, "a refused command mutated a site");
  assert.deepEqual([...A.state.requests, ...B.state.requests], [], "a refused command reached the network");
  for (const [dir, hash] of hashes) {
    assert.equal(treeHash(dir), hash, `${dir} changed`);
    assert.ok(!existsSync(dir) || !readdirSync(dir).some((n) => n.startsWith(".blocofy-staging-")), "staging leftovers");
  }
  noSecrets(r);
}

const count = (site, method, path) => site.state.requests.filter((q) => q.method === method && q.url.startsWith(path)).length;

test("[1] two customer contexts: both listed without secrets; each project's target is its own verified site", async () => {
  const { home, projA, projB } = await world();
  const list = await run(home, ["contexts", "--json"]);
  assert.equal(list.code, 0, list.stderr);
  const rows = JSON.parse(list.stdout).contexts;
  assert.deepEqual(rows.map((c) => [c.name, c.site.id, Boolean(c.dev), Boolean(c.api)]), [["alpha", "sA1", true, true], ["beta", "sB2", true, true]]);
  noSecrets(list);
  const tA = await run(home, ["target", projA, "--json"]);
  const tB = await run(home, ["target", projB, "--json"]);
  assert.equal(tA.code, 0, tA.stderr);
  assert.deepEqual([JSON.parse(tA.stdout).target.site.id, JSON.parse(tA.stdout).target.context], ["sA1", "alpha"]);
  const jA = JSON.parse(tA.stdout).target;
  assert.deepEqual([jA.context_source, jA.context_overrides, jA.platform_origin, jA.command, jA.mode], [".blocofy/local.json", [], ORIGIN, "target", "read"]);
  assert.deepEqual([JSON.parse(tB.stdout).target.site.id, JSON.parse(tB.stdout).target.context], ["sB2", "beta"]);
  assert.equal(A.state.mutations + B.state.mutations, 0, "`target` is read-only");
});

test("[2] two project dirs: a push from each dir reaches only its own site", async () => {
  const { home, projA, projB } = await world();
  const rA = await run(home, ["theme", "push", projA]);
  assert.equal(rA.code, 0, rA.stderr);
  assert.match(rA.stderr, /Target:\s+Alpha Bakery · sA1 · alpha\.myblocofy\.test/);
  assert.match(rA.stderr, /Platform:\s+https:\/\/app\.blocofy\.test/);
  assert.match(rA.stderr, /Context:\s+alpha \(from \.blocofy\/local\.json\)/);
  assert.match(rA.stderr, /Binding:\s+.*\.blocofy\/project\.json/);
  assert.match(rA.stderr, /Operation: theme push · draft/);
  assert.ok(A.state.mutations > 0);
  assert.equal(B.state.requests.length, 0);
  resetSites();
  const rB = await run(home, ["theme", "push", projB]);
  assert.equal(rB.code, 0, rB.stderr);
  assert.ok(B.state.mutations > 0);
  assert.equal(A.state.requests.length, 0);
});

test("[3] two concurrent processes (explicit contexts) each hit only their own site", async () => {
  const { home, projA, projB } = await world();
  const [rA, rB] = await Promise.all([run(home, ["pages", "push", projA, "--context", "alpha"]), run(home, ["pages", "push", projB, "--context", "beta"])]);
  assert.equal(rA.code, 0, rA.stderr);
  assert.equal(rB.code, 0, rB.stderr);
  assert.equal(count(A, "POST", "/api/dev/content"), 1);
  assert.equal(count(B, "POST", "/api/dev/content"), 1);
  assert.match(rA.stderr, /sA1/);
  assert.match(rB.stderr, /sB2/);
  assert.doesNotMatch(rA.stderr, /sB2/);
});

test("[4] `use beta` (global switch) does not change project A's target", async () => {
  const { home, projA } = await world();
  assert.equal((await run(home, ["use", "beta"])).code, 0);
  const r = await run(home, ["theme", "push", projA]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /Context:\s+alpha/);
  assert.ok(A.state.mutations > 0);
  assert.equal(B.state.requests.length, 0, "site B was contacted after `use beta`");
});

test("[5] project A dir + --context beta pull → refused, zero writes", async () => {
  const { home, projA } = await world();
  const before = treeHash(projA);
  for (const args of [["theme", "pull", projA], ["pages", "pull", projA], ["settings", "pull", projA], ["theme", "pull", projA, "--draft"]]) {
    resetSites();
    const r = await run(home, [...args, "--context", "beta", "--json"]);
    assertRefused(r, "TARGET_SITE_MISMATCH", { hashes: [[projA, before]] });
  }
});

test("[6] project A dir + context beta push/publish/rename/media-decide → refused, zero mutations", async () => {
  const { home, projA } = await world();
  const before = treeHash(projA);
  const decisions = join(tmp("bcf-mx-dec-"), "d.json");
  writeFileSync(decisions, JSON.stringify({ decisions: [{ path: "p", facet: "target", decision: "inherit" }] }));
  const commands = [
    ["theme", "push", projA],
    ["theme", "push", projA, "--live", "--yes"],
    ["theme", "push", projA, "--prune", "--yes"],
    ["pages", "push", projA],
    ["settings", "push", projA, "--live", "--yes"],
    ["theme", "publish"],
    ["theme", "rename", "tAlive", "New"],
    ["pages", "media-decide", "pgA", "--decisions", decisions],
  ];
  for (const args of commands) {
    resetSites();
    const r = await run(home, [...args, "--context", "beta", "--json"], { cwd: projA });
    assertRefused(r, "TARGET_SITE_MISMATCH", { hashes: [[projA, before]] });
  }
  // 1.8: BLOCOFY_CONTEXT=beta against the project's own local.json (alpha) is a conflict — refused before any request.
  resetSites();
  assertRefused(await run(home, ["theme", "push", projA, "--json"], { env: { BLOCOFY_CONTEXT: "beta" } }), "TARGET_CONTEXT_CONFLICT", { hashes: [[projA, before]] });
});

test("[7] dev token A + API key B in one context → TARGET_CREDENTIAL_MISMATCH at login --api-key and (hand-edited file) at command time", async () => {
  const { home, projA } = await world();
  const homeHash = treeHash(join(home, ".blocofy"));
  const login = await run(home, ["login", "--api-key", "--context", "alpha", "--json"], { env: { BLOCOFY_API_KEY: SECRETS.B.apiKey, BLOCOFY_API_URL: B.url } });
  assert.equal(login.code, 3, login.stderr);
  assert.equal(jsonError(login).code, "TARGET_CREDENTIAL_MISMATCH");
  assert.equal(treeHash(join(home, ".blocofy")), homeHash, "login saved something");
  assert.equal(A.state.mutations + B.state.mutations, 0);
  noSecrets(login);

  // Hand-edit: context alpha's API pair now points at site B.
  const credPath = join(home, ".blocofy", "credentials.json");
  const secPath = join(home, ".blocofy", "secrets.json");
  const cred = JSON.parse(readFileSync(credPath, "utf8"));
  cred.contexts.alpha.api.url = B.url;
  writeFileSync(credPath, JSON.stringify(cred));
  const sec = JSON.parse(readFileSync(secPath, "utf8"));
  sec.alpha.api_key = SECRETS.B.apiKey;
  writeFileSync(secPath, JSON.stringify(sec));
  const before = treeHash(projA);
  for (const args of [["pages", "push", projA], ["theme", "push", projA], ["pages", "media-uses", "pgA"]]) {
    resetSites();
    const r = await run(home, [...args, "--json"], { cwd: projA });
    assert.equal(r.code, 3, r.stderr);
    assert.equal(jsonError(r).code, "TARGET_CREDENTIAL_MISMATCH");
    assert.equal(A.state.mutations + B.state.mutations, 0);
    assert.deepEqual([...A.state.requests, ...B.state.requests].map((q) => q.url).sort(), ["/api/dev/whoami", "/api/v1/ping"], "only identity endpoints were called");
    assert.equal(treeHash(projA), before);
    noSecrets(r);
  }
});

test("[8] site A credentials + a site B theme handle: requests go only to A; A's 404 → exit 2 (server refusal), no local write", async () => {
  const { home, projA } = await world();
  const before = treeHash(projA);
  const pull = await run(home, ["theme", "pull", projA, "--instance", "tBlive"]);
  assert.equal(pull.code, 2, pull.stderr);
  assert.equal(count(A, "GET", "/api/dev/theme?instance=tBlive"), 1);
  assert.equal(B.state.requests.length, 0);
  assert.equal(treeHash(projA), before);
  resetSites();
  const push = await run(home, ["theme", "push", projA, "--instance", "tBlive", "--json"]);
  assert.equal(push.code, 2, push.stderr);
  assert.deepEqual(JSON.parse(push.stderr.trim().split("\n").pop()).error, { code: "not_found", message: "not_found", details: { status: 404 } }, "--json: the envelope is the last stderr line");
  assert.equal(B.state.requests.length, 0);
  assert.equal(treeHash(projA), before);
  noSecrets(pull);
  noSecrets(push);
});

test("[9] site A credentials + a site B page handle (media-uses / media-decide): only A contacted, A's 404 → exit 2, no local write", async () => {
  const { home, projA } = await world();
  const before = treeHash(projA);
  const decisions = join(tmp("bcf-mx-dec-"), "d.json");
  writeFileSync(decisions, JSON.stringify({ decisions: [{ path: "p", facet: "target", decision: "inherit" }] }));
  const uses = await run(home, ["pages", "media-uses", "pgB"], { cwd: projA });
  assert.equal(uses.code, 2, uses.stderr);
  assert.equal(JSON.parse(uses.stderr.trim().split("\n").pop()).error.code, "not_found");
  resetSites();
  const decide = await run(home, ["pages", "media-decide", "pgB", "--decisions", decisions], { cwd: projA });
  assert.equal(decide.code, 2, decide.stderr);
  assert.equal(count(A, "GET", "/api/v1/pages/pgB/media-uses"), 1);
  assert.equal(count(A, "POST", "/api/v1/pages/pgB/media-uses"), 0);
  assert.equal(B.state.requests.length, 0);
  assert.equal(treeHash(projA), before);
});

test("[10] unbound dir, non-TTY: mutations refused before any request (TTY pick: target.test.mjs 'several matches')", async () => {
  const { home } = await world();
  const loose = tmp("bcf-mx-loose-");
  writeTheme(loose, "A");
  const before = treeHash(loose);
  for (const args of [["theme", "push", loose], ["pages", "push", loose], ["theme", "dev", loose, "--dry"]]) {
    resetSites();
    assertRefused(await run(home, [...args, "--context", "alpha", "--json"]), "TARGET_BINDING_REQUIRED", { hashes: [[loose, before]] });
  }
  resetSites();
  assertRefused(await run(home, ["theme", "push", loose, "--json"]), "TARGET_BINDING_REQUIRED", { hashes: [[loose, before]] });
});

test("[11] CI: env credentials, no binding → mutation and non-empty pull refused; a pull into an empty dir binds it (no local.json)", async () => {
  resetSites();
  const home = tmp("bcf-mx-ci-");
  const env = { BLOCOFY_URL: A.url, BLOCOFY_TOKEN: SECRETS.A.token };
  const loose = tmp("bcf-mx-loose-");
  writeTheme(loose, "A");
  const before = treeHash(loose);
  for (const args of [["theme", "push", loose, "--live", "--yes"], ["pages", "push", loose], ["settings", "push", loose, "--live", "--yes"], ["theme", "pull", loose], ["pages", "pull", loose]]) {
    resetSites();
    assertRefused(await run(home, [...args, "--json"], { env }), "TARGET_BINDING_REQUIRED", { hashes: [[loose, before]] });
  }
  resetSites();
  const fresh = join(tmp("bcf-mx-ci-out-"), "theme");
  const pull = await run(home, ["theme", "pull", fresh], { env });
  assert.equal(pull.code, 0, pull.stderr);
  assert.match(pull.stderr, /Context:\s+env/);
  assert.match(pull.stderr, /Binding:\s+none \(new pull\)/);
  assert.deepEqual(JSON.parse(readFileSync(join(fresh, ".blocofy", "project.json"), "utf8")), { schema_version: 1, site_id: "sA1", site_slug: "alpha", platform_origin: ORIGIN });
  assert.equal(existsSync(join(fresh, ".blocofy", "local.json")), false);
  assert.equal(readFileSync(join(fresh, ".blocofy", ".gitignore"), "utf8"), "local.json\n");
  assert.equal(readFileSync(join(fresh, "layout", "theme.liquid"), "utf8"), "<html>A</html>");
  assert.equal(existsSync(join(home, ".blocofy")), false, "the env context wrote nothing to HOME");
});

test("[12] a dir with provenance for A (from a pull), pulled again with context beta → refused, zero writes", async () => {
  const { home } = await world();
  const fresh = join(tmp("bcf-mx-prov-"), "site");
  const first = await run(home, ["theme", "pull", fresh, "--context", "alpha"]);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(JSON.parse(readFileSync(join(fresh, ".blocofy", "local.json"), "utf8")).context, "alpha");
  const before = treeHash(fresh);
  for (const args of [["theme", "pull", fresh], ["pages", "pull", fresh], ["settings", "pull", fresh]]) {
    resetSites();
    assertRefused(await run(home, [...args, "--context", "beta", "--json"]), "TARGET_SITE_MISMATCH", { hashes: [[fresh, before]] });
  }
  // Without --context the provenance (local.json) keeps it on A.
  resetSites();
  const again = await run(home, ["pages", "pull", fresh]);
  assert.equal(again.code, 0, again.stderr);
  assert.equal(B.state.requests.length, 0);
});

test("[13] half / corrupt v1 credentials file → CREDENTIALS_CORRUPT (exit 1), file bytes unchanged, nothing else written", async () => {
  const projA = tmp("bcf-mx-projA-");
  writeTheme(projA, "A");
  writeBinding(projA, { siteId: "sA1", slug: "alpha" });
  const before = treeHash(projA);
  for (const content of [JSON.stringify({ url: A.url }), `{"url":"${A.url}","token":"${SECRETS.A.token}"`]) {
    resetSites();
    const home = tmp("bcf-mx-corrupt-");
    mkdirSync(join(home, ".blocofy"));
    writeFileSync(join(home, ".blocofy", "credentials.json"), content);
    for (const args of [["theme", "push", projA], ["theme", "pull", projA], ["contexts"]]) {
      const r = await run(home, [...args, "--json"]);
      assert.equal(r.code, 1, r.stderr);
      const err = jsonError(r);
      assert.equal(err.code, "CREDENTIALS_CORRUPT");
      assert.ok(err.message.includes("credentials.json") && !err.message.includes(A.url), "message must carry the path, not content");
      assert.equal(readFileSync(join(home, ".blocofy", "credentials.json"), "utf8"), content);
      assert.deepEqual(readdirSync(join(home, ".blocofy")), ["credentials.json"]);
      assert.equal(A.state.requests.length + B.state.requests.length, 0);
      assert.equal(treeHash(projA), before);
      noSecrets(r);
    }
  }
});

test("[14] identity endpoint down → TARGET_UNVERIFIED (exit 3), no mutation", async () => {
  const { home, projA } = await world();
  const before = treeHash(projA);
  for (const [knob, args] of [["whoami", ["theme", "push", projA]], ["ping", ["pages", "push", projA]], ["ping", ["pages", "media-uses", "pgA"]]]) {
    resetSites();
    A.state[knob] = "down";
    const r = await run(home, [...args, "--json"], { cwd: projA });
    assert.equal(r.code, 3, r.stderr);
    assert.equal(jsonError(r).code, "TARGET_UNVERIFIED");
    assert.equal(A.state.mutations + B.state.mutations, 0);
    assert.ok(A.state.requests.every((q) => q.url === "/api/dev/whoami" || q.url === "/api/v1/ping"), "a non-identity request was sent");
    assert.equal(A.state.requests.filter((q) => q.url === (knob === "whoami" ? "/api/dev/whoami" : "/api/v1/ping")).length, 4, "CF-T3: the identity read is retried 3 times before TARGET_UNVERIFIED");
    assert.equal(treeHash(projA), before);
    noSecrets(r);
  }
});

test("[15] malformed identity response (target display failure) → no write, not even a new directory", async () => {
  const { home, projA } = await world();
  const before = treeHash(projA);
  A.state.whoami = "malformed";
  const r = await run(home, ["theme", "pull", projA, "--json"]);
  assert.equal(r.code, 3, r.stderr);
  assert.equal(jsonError(r).code, "TARGET_UNVERIFIED");
  assert.equal(treeHash(projA), before);
  const fresh = join(tmp("bcf-mx-mal-"), "new");
  const r2 = await run(home, ["theme", "pull", fresh, "--context", "alpha", "--json"]);
  assert.equal(r2.code, 3, r2.stderr);
  assert.equal(existsSync(fresh), false);
  assert.equal(count(A, "GET", "/api/dev/theme"), 0);
  assert.equal(A.state.mutations, 0);
});

test("[16] two processes, same project + context, concurrently: both succeed, same target, no credential rewrite", async () => {
  const { home, projA } = await world();
  const homeHash = treeHash(join(home, ".blocofy"));
  const [r1, r2] = await Promise.all([run(home, ["theme", "push", projA]), run(home, ["theme", "push", projA])]);
  assert.equal(r1.code, 0, r1.stderr);
  assert.equal(r2.code, 0, r2.stderr);
  // TPUSH-5: this fake reports no readback, so the CLI claims the commit, never "atomically".
  for (const r of [r1, r2]) assert.match(r.stdout, /✓ Deployed: /);
  assert.equal(count(A, "POST", "/api/dev/theme"), 4, "preflight + real POST per push");
  assert.equal(B.state.requests.length, 0);
  assert.equal(treeHash(join(home, ".blocofy")), homeHash);
});

test("[17] two processes, different project contexts, concurrently: each pulls only its own site and binds its own dir", async () => {
  const { home } = await world();
  const outA = join(tmp("bcf-mx-cA-"), "a");
  const outB = join(tmp("bcf-mx-cB-"), "b");
  const [rA, rB] = await Promise.all([run(home, ["theme", "pull", outA, "--context", "alpha"]), run(home, ["theme", "pull", outB, "--context", "beta"])]);
  assert.equal(rA.code, 0, rA.stderr);
  assert.equal(rB.code, 0, rB.stderr);
  assert.equal(count(A, "GET", "/api/dev/theme"), 1);
  assert.equal(count(B, "GET", "/api/dev/theme"), 1);
  assert.equal(readFileSync(join(outA, "layout", "theme.liquid"), "utf8"), "<html>A</html>");
  assert.equal(readFileSync(join(outB, "layout", "theme.liquid"), "utf8"), "<html>B</html>");
  assert.equal(JSON.parse(readFileSync(join(outA, ".blocofy", "project.json"), "utf8")).site_id, "sA1");
  assert.equal(JSON.parse(readFileSync(join(outB, ".blocofy", "project.json"), "utf8")).site_id, "sB2");
});

test("[19] null platform origin: a pre-C3 binding (null) against an upgraded server proceeds with one warning, never rewritten; a recorded origin against a server that reports none → TARGET_UNVERIFIED", async () => {
  const { home, projA } = await world();
  const projectPath = join(projA, ".blocofy", "project.json");
  const legacy = JSON.stringify({ schema_version: 1, site_id: "sA1", site_slug: "alpha", platform_origin: null }, null, 2) + "\n";
  writeFileSync(projectPath, legacy);
  const r = await run(home, ["theme", "push", projA]);
  assert.equal(r.code, 0, r.stderr);
  const warnings = r.stderr.split("\n").filter((l) => l.startsWith("warning ["));
  assert.deepEqual(warnings, [`warning [TARGET_BINDING_ORIGIN_MISSING]: The project binding is missing its platform origin; run \`blocofy link --adopt\` to record ${ORIGIN}.`]);
  assert.ok(A.state.mutations > 0);
  assert.equal(readFileSync(projectPath, "utf8"), legacy, "project.json is never auto-rewritten");
  resetSites();
  const j = await run(home, ["pages", "push", projA, "--dry-run", "--json"]);
  assert.equal(j.code, 0, j.stderr);
  assert.equal(JSON.parse(j.stderr.split("\n").find((l) => l.startsWith('{"warning"'))).warning.code, "TARGET_BINDING_ORIGIN_MISSING");

  // Reverse: the binding records an origin, the server stops reporting one.
  const projB2 = tmp("bcf-mx-projA2-");
  writeTheme(projB2, "A");
  writeBinding(projB2, { siteId: "sA1", slug: "alpha", context: "alpha" });
  const before = treeHash(projB2);
  resetSites();
  A.state.platformOrigin = null;
  try {
    const u = await run(home, ["theme", "push", projB2, "--json"]);
    assert.equal(u.code, 3, u.stderr);
    const err = jsonError(u);
    assert.equal(err.code, "TARGET_UNVERIFIED");
    assert.match(err.message, /does not report its platform origin/);
    assert.equal(A.state.mutations, 0);
    assert.equal(treeHash(projB2), before);
  } finally {
    A.state.platformOrigin = ORIGIN;
  }
});

test("[20] review I1: theme pull refuses any key the push would not read back (case-folded .BLOCOFY, .git, dot-dirs, unknown top dirs) — zero writes", async () => {
  const { home, projA } = await world();
  const before = treeHash(projA);
  const hostile = [
    { ".BLOCOFY/project.json": JSON.stringify({ schema_version: 1, site_id: "sB2", site_slug: "beta", platform_origin: ORIGIN }) },
    { ".Blocofy-Staging-x/a": "x" },
    { ".git/hooks/pre-commit": "#!/bin/sh\necho pwned" },
    { "section/.hidden/x": "x" },
    // (A flat `README.md` IS written: the starter themes ship one and the platform serves it — the
    //  cross-repo smoke proved a fresh site could not be pulled otherwise. A tooling file is not.)
    { "package.json": "{}" },
    // A ROOT FILE THE PLATFORM DOES NOT SHIP. The denylist this replaced accepted anything not named after a
    // lockfile, so a server that answered with `CLAUDE.md` planted agent instructions at the developer's
    // project root on an ordinary pull. Only the root names a theme actually has come down.
    { "CLAUDE.md": "# planted instructions" },
    { "AGENTS.md": "# planted instructions" },
    { "next.config.js": "module.exports = {}" },
    { "Layout/theme": "<html>case</html>" },
    // `settings pull` owns this name; a theme row must not shadow it. (A theme's OWN config rows — e.g.
    // `config/theme.json` — DO come down: refusing them refused the whole pull on a fresh site, which the
    // cross-repo smoke caught. See theme-sync.test.mjs.)
    { "config/settings.json": "{}" },
    { "config/nested/evil.json": "{}" },
  ];
  for (const bad of hostile) {
    resetSites();
    A.state.themeFiles = { "layout/theme": "<html>A</html>", ...bad };
    const r = await run(home, ["theme", "pull", projA, "--json"]);
    assert.notEqual(r.code, 0, `${Object.keys(bad)[0]} was accepted:\n${r.stderr}`);
    assert.equal(treeHash(projA), before, `${Object.keys(bad)[0]} changed the tree`);
    assert.equal(JSON.parse(readFileSync(join(projA, ".blocofy", "project.json"), "utf8")).site_id, "sA1");
  }
  // The legitimate set still pulls (incl. config/settings_schema.json and a nested asset path).
  resetSites();
  A.state.themeFiles = { "layout/theme": "<html>A2</html>", "asset/img/logo.svg": "<svg/>", "config/settings_schema.json": "[]", "config/theme.json": "{}", "README.md": "# theme", "blueprint.json": "{}" };
  const ok = await run(home, ["theme", "pull", projA]);
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(readFileSync(join(projA, "config", "settings_schema.json"), "utf8"), "[]");
  assert.equal(readFileSync(join(projA, "config", "theme.json"), "utf8"), "{}");
  assert.equal(readFileSync(join(projA, "README.md"), "utf8"), "# theme");
});

test("[21] review I3: `pages migrate-layout --write` outside a binding never uses the default context (offline); an explicit --context goes online", async () => {
  const { home } = await world(); // world() leaves current_context = alpha
  const loose = tmp("bcf-mx-migrate-");
  mkdirSync(join(loose, "pages"), { recursive: true });
  writeFileSync(join(loose, "pages", "about.json"), JSON.stringify({ slug: "/about", locale: "en-US", data: { version: 2, sections: [] } }));
  resetSites();
  const r = await run(home, ["pages", "migrate-layout", loose, "--write"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(A.state.requests.length + B.state.requests.length, 0, "a local write used the global default context");
  assert.ok(existsSync(join(loose, "pages", "en-US", "routes", "about", "index.json")));
  const again = tmp("bcf-mx-migrate-");
  mkdirSync(join(again, "pages"), { recursive: true });
  writeFileSync(join(again, "pages", "about.json"), JSON.stringify({ slug: "/about", locale: "en-US", data: { version: 2, sections: [] } }));
  resetSites();
  const explicit = await run(home, ["pages", "migrate-layout", again, "--write", "--context", "alpha"]);
  assert.equal(explicit.code, 0, explicit.stderr);
  assert.ok(count(A, "GET", "/api/dev/whoami") >= 1, "an explicit --context is honoured");
  assert.equal(B.state.requests.length, 0);
});

test("[22] review I4a: project bound to A + env credentials for B → every command refused (exit 3), zero mutations, no writes", async () => {
  const { home, projA } = await world();
  const env = { BLOCOFY_URL: B.url, BLOCOFY_TOKEN: SECRETS.B.token };
  const commands = [["theme", "push", projA], ["pages", "push", projA], ["theme", "pull", projA], ["theme", "dev", projA, "--dry"], ["status"], ["target", projA]];
  // 1.8: with the project's own local.json (alpha) present, the env pair is a CONFLICTING choice — refused before any request.
  const withLocal = treeHash(projA);
  for (const args of commands) {
    resetSites();
    assertRefused(await run(home, [...args, "--json"], { env, cwd: projA }), "TARGET_CONTEXT_CONFLICT", { hashes: [[projA, withLocal]] });
  }
  // CI shape (committed project.json, no local.json): the env pair is the only choice and the binding-vs-remote check refuses it.
  rmSync(join(projA, ".blocofy", "local.json"));
  const before = treeHash(projA);
  for (const args of commands) {
    resetSites();
    const r = await run(home, [...args, "--json"], { env, cwd: projA });
    assert.equal(r.code, 3, `${args.join(" ")}: ${r.stderr}`);
    assert.equal(jsonError(r).code, "TARGET_SITE_MISMATCH", args.join(" "));
    assert.equal(A.state.mutations + B.state.mutations, 0, args.join(" "));
    assert.deepEqual(B.state.requests.map((q) => q.url), ["/api/dev/whoami"], `${args.join(" ")}: only B's identity endpoint`);
    assert.equal(A.state.requests.length, 0);
    assert.equal(treeHash(projA), before);
    noSecrets(r);
  }
});

test("[23] review I4b: a context recorded for A whose token now resolves to B → refused (exit 3) by the recorded-site check, even outside a project", async () => {
  const { home } = await world();
  const loose = tmp("bcf-mx-swap-");
  const bSite = { id: "sB2", slug: "beta", name: "Beta Metal", domain: "beta.myblocofy.test" };
  for (const args of [["target", loose, "--context", "alpha"], ["status", "--context", "alpha"], ["pages", "media-uses", "pgA", "--context", "alpha"]]) {
    resetSites();
    A.state.identitySite = bSite;
    const r = await run(home, [...args, "--json"], { cwd: loose });
    assert.equal(r.code, 3, `${args.join(" ")}: ${r.stderr}`);
    assert.equal(jsonError(r).code, "TARGET_SITE_MISMATCH", args.join(" "));
    assert.ok(A.state.requests.every((q) => q.url === "/api/dev/whoami" || q.url === "/api/v1/ping"), "only identity endpoints were called");
    assert.equal(A.state.mutations + B.state.mutations, 0);
    assert.deepEqual(readdirSync(loose), []);
  }
});

test("[24] review I4c: `status` and `target` refuse a mismatch end-to-end inside a bound project (context for B via --context; BLOCOFY_CONTEXT=beta vs local.json alpha is a conflict)", async () => {
  const { home, projA } = await world();
  for (const args of [["status"], ["target"]]) {
    resetSites();
    assertRefused(await run(home, [...args, "--json"], { cwd: projA, env: { BLOCOFY_CONTEXT: "beta" } }), "TARGET_CONTEXT_CONFLICT");
    resetSites();
    const r = await run(home, [...args, "--context", "beta", "--json"], { cwd: projA });
    assert.equal(r.code, 3, r.stderr);
    assert.equal(jsonError(r).code, "TARGET_SITE_MISMATCH");
    assert.equal(count(B, "GET", "/api/dev/site"), 0, "status must not read the other site");
    assert.equal(A.state.requests.length + B.state.mutations, 0);
    assert.equal(r.stdout, "");
  }
});

test("[25] review M1: `theme pull --draft` (provisions a server draft) into an unbound empty dir → TARGET_BINDING_REQUIRED, zero requests", async () => {
  const { home } = await world();
  const fresh = join(tmp("bcf-mx-draft-"), "theme");
  resetSites();
  assertRefused(await run(home, ["theme", "pull", fresh, "--draft", "--context", "alpha", "--json"]), "TARGET_BINDING_REQUIRED", { hashes: [[fresh, "missing"]] });
  // A live pull into the same empty dir still binds it.
  resetSites();
  const live = await run(home, ["theme", "pull", fresh, "--context", "alpha"]);
  assert.equal(live.code, 0, live.stderr);
  assert.equal(A.state.mutations, 0);
});

test("[26] review M2: `link --adopt` repairs a corrupt project.json (the refusal message recommends exactly that)", async () => {
  const { home } = await world();
  const dir = tmp("bcf-mx-corruptbind-");
  mkdirSync(join(dir, ".blocofy"));
  writeFileSync(join(dir, ".blocofy", "project.json"), "{ not json");
  resetSites();
  const refused = await run(home, ["link", dir, "--context", "alpha", "--json"]);
  assert.equal(refused.code, 3, refused.stderr);
  assert.equal(jsonError(refused).code, "TARGET_BINDING_INVALID");
  assert.match(jsonError(refused).message, /--adopt/);
  const adopted = await run(home, ["link", dir, "--context", "alpha", "--adopt"]);
  assert.equal(adopted.code, 0, adopted.stderr);
  assert.equal(JSON.parse(readFileSync(join(dir, ".blocofy", "project.json"), "utf8")).site_id, "sA1");
});

test("[27] review M3: `link --adopt` with env credentials removes a stale local.json (which would otherwise pick another context)", async () => {
  const { home } = await world();
  const dir = tmp("bcf-mx-stalelocal-");
  writeBinding(dir, { siteId: "sB2", slug: "beta", context: "beta" });
  resetSites();
  const r = await run(home, ["link", dir, "--adopt"], { env: { BLOCOFY_URL: A.url, BLOCOFY_TOKEN: SECRETS.A.token } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(readFileSync(join(dir, ".blocofy", "project.json"), "utf8")).site_id, "sA1");
  assert.equal(existsSync(join(dir, ".blocofy", "local.json")), false, "stale local.json (context beta) survived");
});

test("[28] review M4: two pulls into the same empty dir for different sites — the later one refuses on the claimed binding, zero writes of its own", async () => {
  const { home } = await world();
  const fresh = join(tmp("bcf-mx-race-"), "site");
  B.state.whoamiDelayMs = 1500; // B passes the empty-dir check, then stalls on its identity read
  const slow = run(home, ["theme", "pull", fresh, "--context", "beta", "--json"]);
  while (count(B, "GET", "/api/dev/whoami") === 0) await new Promise((r) => setTimeout(r, 20));
  const fast = await run(home, ["theme", "pull", fresh, "--context", "alpha"]);
  const late = await slow;
  assert.equal(fast.code, 0, fast.stderr);
  assert.equal(late.code, 3, late.stderr);
  assert.equal(jsonError(late).code, "TARGET_SITE_MISMATCH");
  assert.equal(JSON.parse(readFileSync(join(fresh, ".blocofy", "project.json"), "utf8")).site_id, "sA1");
  assert.equal(readFileSync(join(fresh, "layout", "theme.liquid"), "utf8"), "<html>A</html>");
  assert.equal(count(B, "GET", "/api/dev/theme"), 0, "the refused pull fetched nothing");
});

test("[29] 1.8 argument dir ≠ cwd: `theme publish <dir>`, `status <dir>`, `theme rename … --dir`, `pages media-uses|media-decide … --dir` resolve the ARGUMENT's binding, never cwd's", async () => {
  const { home, projA, projB } = await world();
  const beforeB = treeHash(projB);
  const decisions = join(tmp("bcf-mx-dec-"), "d.json");
  writeFileSync(decisions, JSON.stringify({ decisions: [{ path: "p", facet: "target", decision: "inherit" }] }));
  const cases = [
    [["theme", "publish", projA], "POST", "/api/dev/publish"],
    [["theme", "publish", projA, "--instance", "tAdraft"], "POST", "/api/dev/publish"],
    [["theme", "rename", "tAlive", "New", "name", "--dir", projA], "POST", "/api/dev/theme/rename"],
    [["status", projA], "GET", "/api/dev/site"],
    [["pages", "media-uses", "pgA", "--dir", projA], "GET", "/api/v1/pages/pgA/media-uses"],
    [["pages", "media-decide", "pgA", "--decisions", decisions, "--dir", projA], "POST", "/api/v1/pages/pgA/media-uses"],
  ];
  for (const [args, method, path] of cases) {
    resetSites();
    const r = await run(home, [...args, "--json"], { cwd: projB });
    assert.equal(r.code, 0, `${args.join(" ")}: ${r.stderr}`);
    assert.equal(B.state.requests.length, 0, `${args.join(" ")}: cwd's site B was contacted`);
    assert.ok(count(A, method, path) >= 1, `${args.join(" ")}: A's ${method} ${path} not called`);
    const target = JSON.parse(r.stderr.split("\n").find((l) => l.startsWith('{"target"'))).target;
    assert.equal(target.site.id, "sA1", args.join(" "));
    assert.equal(target.context, "alpha", args.join(" "));
    assert.ok(target.binding.endsWith(join(projA.split("/").pop(), ".blocofy", "project.json")), `${args.join(" ")}: binding ${target.binding}`);
    assert.equal(treeHash(projB), beforeB);
    noSecrets(r);
  }
  // A missing argument dir is a usage error before any request; so is a second positional for publish/status.
  // cli-fix T5: the same rule for `target [dir]` (a missing dir is not climbed to an ancestor's binding) and for
  // `pages media-uses|media-decide` (a directory given as a positional is refused, not silently dropped for cwd's).
  for (const args of [
    ["theme", "publish", join(projA, "nope")],
    ["status", join(projA, "nope")],
    ["theme", "rename", "tAlive", "New", "--dir", join(projA, "nope")],
    ["pages", "media-uses", "pgA", "--dir", join(projA, "nope")],
    ["theme", "publish", projA, projB],
    ["status", projA, projB],
    ["target", join(projA, "nope")],
    ["target", projA, projB],
    ["pages", "media-uses", "pgA", projA],
    ["pages", "media-decide", "pgA", projA, "--decisions", decisions],
  ]) {
    resetSites();
    const r = await run(home, [...args, "--json"], { cwd: projB });
    assert.equal(r.code, 1, `${args.join(" ")}: ${r.stderr}`);
    assert.equal(A.state.requests.length + B.state.requests.length, 0, args.join(" "));
    assert.equal(jsonError(r).code, "USAGE", args.join(" "));
  }
  // The usage lines of the two page media commands name the directory option (as --help and the README do).
  for (const args of [["pages", "media-uses"], ["pages", "media-decide", "pgA"], ["pages", "media-uses", "pgA", projA]]) {
    const r = await run(home, args, { cwd: projB });
    assert.equal(r.code, 1, args.join(" "));
    assert.match(r.stderr, /Usage: blocofy pages media-(uses|decide) <page-handle>.*\[--dir <dir>\]/, `${args.join(" ")}: ${r.stderr}`);
  }
  // Without an argument the default is still cwd (bound to B).
  resetSites();
  const here = await run(home, ["theme", "publish"], { cwd: projB });
  assert.equal(here.code, 0, here.stderr);
  assert.equal(A.state.requests.length, 0);
  assert.equal(count(B, "POST", "/api/dev/publish"), 1);
});

test("[30] 1.8 wrong credential type: a v1 key (blcf_) where the dev token (bcf_) belongs, or the reverse — env or stored — is refused before any request, and the two are never merged", async () => {
  const { home, projA } = await world();
  const loose = tmp("bcf-mx-wrongtype-");
  rmSync(join(projA, ".blocofy", "local.json")); // CI shape: committed project.json only
  const before = treeHash(projA);
  const cases = [
    // [args, env, cwd, names the variable/pair]
    [["target", loose], { BLOCOFY_URL: A.url, BLOCOFY_TOKEN: SECRETS.A.apiKey }, loose, /BLOCOFY_TOKEN[\s\S]*blcf_[\s\S]*BLOCOFY_API_KEY/],
    [["theme", "pull", join(loose, "new")], { BLOCOFY_URL: A.url, BLOCOFY_TOKEN: SECRETS.A.apiKey }, loose, /BLOCOFY_TOKEN/],
    [["pages", "media-uses", "pgA"], { BLOCOFY_API_URL: A.url, BLOCOFY_API_KEY: SECRETS.A.token }, loose, /BLOCOFY_API_KEY[\s\S]*bcf_[\s\S]*blcf_live_/],
    [["theme", "push", projA], { BLOCOFY_URL: A.url, BLOCOFY_TOKEN: SECRETS.A.token, BLOCOFY_API_URL: A.url, BLOCOFY_API_KEY: SECRETS.A.token }, projA, /BLOCOFY_API_KEY/],
    [["site", "plan", projA], { BLOCOFY_URL: A.url, BLOCOFY_TOKEN: SECRETS.A.apiKey, BLOCOFY_API_URL: A.url, BLOCOFY_API_KEY: SECRETS.A.apiKey }, projA, /BLOCOFY_TOKEN/],
  ];
  for (const [args, env, cwd, pattern] of cases) {
    resetSites();
    const r = await run(home, [...args, "--json"], { env, cwd });
    assert.equal(r.code, 1, `${args.join(" ")}: ${r.stderr}`);
    const err = jsonError(r);
    assert.equal(err.code, "TARGET_CREDENTIAL_WRONG_TYPE", args.join(" "));
    assert.match(err.message, pattern, args.join(" "));
    assert.match(err.message, /separate/);
    assert.deepEqual([...A.state.requests, ...B.state.requests], [], `${args.join(" ")}: a request was sent with the wrong credential type`);
    assert.equal(treeHash(projA), before);
    assert.deepEqual(readdirSync(loose), []);
    noSecrets(r);
  }
  // Login keeps them apart too: a v1 key given as --token is pointed at `login --api-key`, nothing sent or saved.
  resetSites();
  const homeHash = treeHash(join(home, ".blocofy"));
  const login = await run(home, ["login", "--url", A.url, "--token", SECRETS.A.apiKey, "--context", "x"]);
  assert.equal(login.code, 1, login.stderr);
  assert.match(login.stderr, /login --api-key/);
  assert.deepEqual([...A.state.requests, ...B.state.requests], []);
  assert.equal(treeHash(join(home, ".blocofy")), homeHash);
  noSecrets(login);
  // A hand-edited store: context alpha's dev secret is now alpha's v1 key.
  const secPath = join(home, ".blocofy", "secrets.json");
  const sec = JSON.parse(readFileSync(secPath, "utf8"));
  sec.alpha.dev_token = SECRETS.A.apiKey;
  writeFileSync(secPath, JSON.stringify(sec));
  for (const args of [["status", projA], ["theme", "push", projA], ["pages", "media-uses", "pgA", "--dir", projA]]) {
    resetSites();
    const r = await run(home, [...args, "--context", "alpha", "--json"], { cwd: loose });
    assert.equal(r.code, 1, `${args.join(" ")}: ${r.stderr}`);
    const err = jsonError(r);
    assert.equal(err.code, "TARGET_CREDENTIAL_WRONG_TYPE", args.join(" "));
    assert.match(err.message, /context "alpha"/);
    assert.match(err.message, /blocofy login --context alpha/);
    assert.deepEqual([...A.state.requests, ...B.state.requests], [], args.join(" "));
    noSecrets(r);
  }
});

// ── [31] 1.8 closure: the COMPLETE remote command matrix × every case ─────────────────────────────────────────
//
// Owner: CLI/platform security. Threshold: zero silent fallback and zero cross-target read/write. Every remote
// command (class: m = remote-mutation, w = local-write, r = read, o = offline-capable read that opts into the `use`
// default) is run in each cell; the oracle is the exit/error code, which site was contacted, the target block's
// site + context source, byte-identical trees for refusals, and no secret in any output (scenario 18).

function matrixCommands(dir, decisions) {
  return [
    ["target", ["target", dir], "o"],
    ["status", ["status", dir], "o"],
    ["pages check", ["pages", "check", dir], "o"],
    ["pages migrate-layout", ["pages", "migrate-layout", dir], "r?"],
    ["theme dev --no-sync", ["theme", "dev", dir, "--no-sync", "--dry"], "r"],
    ["theme dev", ["theme", "dev", dir, "--dry"], "m"],
    ["theme pull", ["theme", "pull", dir], "w"],
    ["theme pull --draft", ["theme", "pull", dir, "--draft"], "m"],
    ["theme push", ["theme", "push", dir], "m"],
    ["theme push --diff", ["theme", "push", dir, "--diff"], "r"],
    ["theme push --dry-run", ["theme", "push", dir, "--dry-run"], "r"],
    ["theme publish", ["theme", "publish", dir], "m"],
    ["theme rename", ["theme", "rename", "tAlive", "New", "--dir", dir], "m"],
    ["pages pull", ["pages", "pull", dir], "w"],
    ["pages push", ["pages", "push", dir], "m"],
    ["pages push --dry-run", ["pages", "push", dir, "--dry-run"], "r"],
    ["pages media-uses", ["pages", "media-uses", "pgA", "--dir", dir], "r"],
    ["pages media-decide", ["pages", "media-decide", "pgA", "--decisions", decisions, "--dir", dir], "m"],
    ["settings pull", ["settings", "pull", dir], "w"],
    ["settings push", ["settings", "push", dir, "--live", "--yes"], "m"],
    ["site export", ["site", "export", dir], "w"],
    ["site plan", ["site", "plan", dir], "r"],
    ["site apply", ["site", "apply", dir], "m"],
    ["site publish", ["site", "publish", dir, "--yes"], "m"],
  ];
}

/** The target block of a run (stderr JSON line, or `blocofy target --json`'s stdout). */
function targetOf(r, name) {
  const line = r.stderr.split("\n").find((l) => l.startsWith('{"target"'));
  if (line) return JSON.parse(line).target;
  if (name === "target") return JSON.parse(r.stdout).target;
  assert.fail(`${name}: no target block\n${r.stderr}`);
}

test("[31] 1.8 closure matrix: every remote command × {conflicting authorities, explicit other site, argument dir from another project while `use` points elsewhere, CI env pair, wrong credential type, unbound dir across two terminals}", async () => {
  const { home, projA, projB } = await world();
  const decisions = join(tmp("bcf-mx-dec-"), "d.json");
  writeFileSync(decisions, JSON.stringify({ decisions: [{ path: "p", facet: "target", decision: "inherit" }] }));
  const envB = { BLOCOFY_URL: B.url, BLOCOFY_TOKEN: SECRETS.B.token, BLOCOFY_API_URL: B.url, BLOCOFY_API_KEY: SECRETS.B.apiKey };
  const envA = { BLOCOFY_URL: A.url, BLOCOFY_TOKEN: SECRETS.A.token, BLOCOFY_API_URL: A.url, BLOCOFY_API_KEY: SECRETS.A.apiKey };
  const swappedA = { BLOCOFY_URL: A.url, BLOCOFY_TOKEN: SECRETS.A.apiKey, BLOCOFY_API_URL: A.url, BLOCOFY_API_KEY: SECRETS.A.token };
  // CI checkout: the committed project.json only (no local.json), bound to A.
  const projCI = tmp("bcf-mx-ci-proj-");
  writeTheme(projCI, "A");
  writeBinding(projCI, { siteId: "sA1", slug: "alpha" });
  const loose = tmp("bcf-mx-unbound-");
  writeTheme(loose, "A");
  let cells = 0;

  const refusal = async (label, args, opts, code, { exit = 3, dirs = [] } = {}) => {
    const hashes = dirs.map((d) => [d, treeHash(d)]);
    resetSites();
    const r = await run(home, [...args, "--json"], opts);
    assert.equal(r.code, exit, `${label}: ${r.stderr}`);
    assert.equal(jsonError(r).code, code, label);
    assert.deepEqual([...A.state.requests, ...B.state.requests], [], `${label}: a refused command reached the network`);
    for (const [d, h] of hashes) assert.equal(treeHash(d), h, `${label}: ${d} changed`);
    noSecrets(r);
    cells += 1;
  };
  const reachesOnly = async (label, name, args, opts, site, other, { source, siteId }) => {
    resetSites();
    const r = await run(home, [...args, "--json"], opts);
    assert.deepEqual(other.state.requests, [], `${label}: the other site was contacted (exit ${r.code})\n${r.stderr}`);
    // cli-fix T5 + cli-fix2: a success cell proves the command WORKED on the right site, not only that it chose it:
    // exit 0 for every command, and a `site *` command completed through its own endpoint on that site.
    assert.equal(r.code, 0, `${label}: exit ${r.code}\n${r.stderr}`);
    if (name.startsWith("site ")) {
      const endpoint = { "site export": "GET /api/v1/site-state", "site plan": "POST /api/v1/site-state/plan", "site apply": "POST /api/v1/site-state/apply", "site publish": "POST /api/v1/site-state/publish" }[name];
      assert.ok(site.state.requests.some((q) => `${q.method} ${q.url}` === endpoint), `${label}: ${endpoint} was not reached`);
    }
    assert.ok(count(site, "GET", "/api/dev/whoami") + count(site, "GET", "/api/v1/ping") >= 1, `${label}: identity not verified`);
    const t = targetOf(r, name);
    assert.deepEqual([t.site.id, t.context_source, t.platform_origin], [siteId, source, ORIGIN], label);
    assert.ok(typeof t.mode === "string" && t.mode.length > 0, `${label}: no mode`);
    noSecrets(r);
    cells += 1;
  };

  for (const [name, args] of matrixCommands(projA, decisions)) {
    // (a) env pair for B + project A's local.json (alpha) → conflict, from another project's cwd.
    await refusal(`${name} · env B vs local.json`, args, { cwd: projB, env: envB }, "TARGET_CONTEXT_CONFLICT", { dirs: [projA, projB] });
    // (b) BLOCOFY_CONTEXT=beta vs local.json alpha → conflict.
    await refusal(`${name} · BLOCOFY_CONTEXT vs local.json`, args, { cwd: projB, env: { BLOCOFY_CONTEXT: "beta" } }, "TARGET_CONTEXT_CONFLICT", { dirs: [projA] });
    // (c) an explicit --context for the other site → refused offline.
    await refusal(`${name} · --context beta on project A`, [...args, "--context", "beta"], { cwd: projB }, "TARGET_SITE_MISMATCH", { dirs: [projA] });
  }
  for (const [name, args] of matrixCommands(projCI, decisions)) {
    // (d) wrong credential type in the CI env (dev and API secrets swapped) → refused before any request.
    await refusal(`${name} · swapped credential types`, args, { cwd: loose, env: swappedA }, "TARGET_CREDENTIAL_WRONG_TYPE", { exit: 1, dirs: [projCI] });
  }
  for (const [name, args, kind] of matrixCommands(loose, decisions)) {
    // (e) env pair + BLOCOFY_CONTEXT in an unbound dir (nothing pins the site) → conflict for every read; a write
    // is refused even earlier by the binding policy.
    const expected = kind === "m" || kind === "w" ? "TARGET_BINDING_REQUIRED" : "TARGET_CONTEXT_CONFLICT";
    await refusal(`${name} · unbound env vs BLOCOFY_CONTEXT`, args, { cwd: loose, env: { ...envA, BLOCOFY_CONTEXT: "beta" } }, expected, { dirs: [loose] });
  }

  // (f) argument dir ≠ cwd, while "terminal 2" has switched the global default to beta: only A is contacted.
  assert.equal((await run(home, ["use", "beta"])).code, 0);
  for (const [name, args] of matrixCommands(projA, decisions)) {
    await reachesOnly(`${name} · arg projA from cwd projB, use=beta`, name, args, { cwd: projB }, A, B, { source: ".blocofy/local.json", siteId: "sA1" });
  }
  // (g) CI: env pairs for A + committed project.json (no local.json), cwd elsewhere.
  for (const [name, args] of matrixCommands(projCI, decisions)) {
    await reachesOnly(`${name} · CI env A`, name, args, { cwd: loose, env: envA }, A, B, { source: "env", siteId: "sA1" });
  }

  // (h) unbound dir across two terminals: `use` moves only status / target / pages check (and says so);
  // every other command refuses before any request whatever the default is.
  for (const [ctxName, site, other, siteId] of [["beta", B, A, "sB2"], ["alpha", A, B, "sA1"]]) {
    assert.equal((await run(home, ["use", ctxName])).code, 0);
    for (const [name, args, kind] of matrixCommands(loose, decisions)) {
      const label = `${name} · unbound, use=${ctxName}`;
      if (kind === "o") {
        await reachesOnly(label, name, args, { cwd: loose }, site, other, { source: "current_context", siteId });
      } else if (kind === "r?") {
        resetSites();
        const r = await run(home, [...args, "--json"], { cwd: loose });
        assert.deepEqual([...A.state.requests, ...B.state.requests], [], `${label}: the default context was used (exit ${r.code})`);
        cells += 1;
      } else {
        await refusal(label, args, { cwd: loose }, kind === "r" ? "TARGET_CONTEXT_REQUIRED" : "TARGET_BINDING_REQUIRED", { dirs: [loose] });
      }
    }
  }
  assert.ok(cells >= 24 * 8, `only ${cells} cells ran`);
});

// ── ADR-0014 (wave P4): CLI-login (OAuth) contexts ─────────────────────────────────────────────────────────

/** Seed a CLI-login context (what `blocofy login` saves) for `site` into `home` (file store). */
function seedCliLogin(home, name, site, key, { expiresAt = Date.now() + 5 * 60_000 } = {}) {
  const dir = join(home, ".blocofy");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const credPath = join(dir, "credentials.json");
  const secPath = join(dir, "secrets.json");
  const store = existsSync(credPath) ? JSON.parse(readFileSync(credPath, "utf8")) : { schema_version: 2, current_context: null, contexts: {} };
  const secrets = existsSync(secPath) ? JSON.parse(readFileSync(secPath, "utf8")) : {};
  store.contexts[name] = {
    platform_origin: ORIGIN,
    site: { id: key === "A" ? "sA1" : "sB2", slug: key === "A" ? "alpha" : "beta", name: key === "A" ? "Alpha Bakery" : "Beta Metal", domain: null },
    oauth: { url: site.url, issuer: site.url, client_id: "blocofy-cli", token_endpoint: `${site.url}/token`, revocation_endpoint: `${site.url}/revoke`, dev_url: site.url, profile: { id: "theme-dev", version: 1, label: "Tema geliştirme" }, secret: { store: "file" } },
    verified_at: null,
  };
  secrets[name] = { oauth_tokens: JSON.stringify({ access_token: SECRETS[key].cli, refresh_token: SECRETS[key].refresh, expires_at: expiresAt }) };
  writeFileSync(credPath, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 });
  writeFileSync(secPath, JSON.stringify(secrets, null, 2) + "\n", { mode: 0o600 });
}

test("[32] CLI-login contexts A/B: each reaches only its own site; a login for B on project A is refused offline; A's token with B's theme handle reaches only A", async () => {
  resetSites();
  const home = tmp("bcf-mx-home-");
  seedCliLogin(home, "cli-alpha", A, "A");
  seedCliLogin(home, "cli-beta", B, "B");
  const projA = tmp("bcf-mx-projA-");
  writeTheme(projA, "A");
  writeBinding(projA, { siteId: "sA1", slug: "alpha", context: "cli-alpha" });

  // (a) its own site, both identity endpoints verified with the CLI token, then the draft write on A only.
  let r = await run(home, ["theme", "push", projA, "--draft", "--json"]);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(A.state.requests.some((q) => q.url === "/api/v1/ping") && A.state.requests.some((q) => q.url === "/api/dev/whoami"));
  assert.ok(A.state.mutations > 0);
  assert.deepEqual(B.state.requests, []);
  noSecrets(r);

  // (b) the login for B on project A → refused before any request.
  resetSites();
  const before = treeHash(projA);
  r = await run(home, ["theme", "push", projA, "--draft", "--context", "cli-beta", "--json"]);
  assertRefused(r, "TARGET_SITE_MISMATCH", { hashes: [[projA, before]] });

  // (c) A's login naming B's theme handle: only A is asked, A answers 404 → exit 2, nothing written.
  resetSites();
  const empty = join(tmp("bcf-mx-pull-"), "new");
  r = await run(home, ["theme", "pull", empty, "--instance", "tBdraft", "--context", "cli-alpha", "--json"]);
  assert.equal(r.code, 2, r.stderr);
  assert.deepEqual(B.state.requests, []);
  assert.equal(A.state.mutations, 0);
  assert.equal(existsSync(empty), false);
  noSecrets(r);
});

test("[33] audience: the platform's 401 audience_mismatch stops the command (plain words, no retry, zero mutations); an MCP token is never taken as an API key", async () => {
  resetSites();
  const home = tmp("bcf-mx-home-");
  seedCliLogin(home, "cli-alpha", A, "A");
  const projA = tmp("bcf-mx-projA-");
  writeTheme(projA, "A");
  writeBinding(projA, { siteId: "sA1", slug: "alpha", context: "cli-alpha" });
  A.state.cliAudience = "mismatch";
  const before = treeHash(projA);
  let r = await run(home, ["theme", "push", projA, "--draft"]);
  assert.equal(r.code, 3, r.stderr);
  assert.match(r.stderr, /bu uç için değil/);
  assert.equal(A.state.mutations, 0);
  assert.equal(A.state.requests.filter((q) => q.url === "/api/v1/ping").length, 1, "a 401 is never retried");
  assert.equal(treeHash(projA), before);

  // An MCP connector token (blcf_at_) pasted as an API key: refused locally, nothing sent.
  resetSites();
  r = await run(home, ["login", "--api-key", "--json"], { env: { BLOCOFY_API_KEY: "blcf_at_mcpConnectorToken_0123456789", BLOCOFY_API_URL: A.url } });
  assert.equal(r.code, 1);
  assert.deepEqual(A.state.requests, []);
  r = await run(home, ["status", "--json"], { env: { BLOCOFY_API_KEY: "blcf_at_mcpConnectorToken_0123456789", BLOCOFY_API_URL: A.url } });
  assert.equal(jsonError(r).code, "TARGET_CREDENTIAL_WRONG_TYPE");
  assert.deepEqual(A.state.requests, []);
});

test("[34] an expired CLI-login token is renewed once (single /token request), then the command proceeds on its own site", async () => {
  resetSites();
  const home = tmp("bcf-mx-home-");
  seedCliLogin(home, "cli-alpha", A, "A", { expiresAt: Date.now() - 1000 });
  const r = await run(home, ["target", "--context", "cli-alpha", "--json"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(A.state.tokenCalls, 1);
  const stored = JSON.parse(JSON.parse(readFileSync(join(home, ".blocofy", "secrets.json"), "utf8"))["cli-alpha"].oauth_tokens);
  assert.ok(stored.expires_at > Date.now() + 500_000);
  const again = await run(home, ["target", "--context", "cli-alpha", "--json"]);
  assert.equal(again.code, 0);
  assert.equal(A.state.tokenCalls, 1, "a fresh token is not renewed again");
  assert.deepEqual(B.state.requests, []);
  noSecrets(r);
});

test("[35] logout honesty: revoked → exit 0; platform unreachable → local cleared, server NOT revoked, exit 4; a pasted pair → not_applicable", async () => {
  resetSites();
  const home = tmp("bcf-mx-home-");
  seedCliLogin(home, "cli-alpha", A, "A");
  seedCliLogin(home, "cli-beta", B, "B");
  let r = await run(home, ["logout", "--context", "cli-alpha", "--json"]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).logout, { context: "cli-alpha", local: "cleared", server: "revoked", server_status: 200 });
  assert.deepEqual(A.state.revokes, [{ token: SECRETS.A.refresh, client_id: "blocofy-cli" }]);

  B.state.revoke = "down";
  r = await run(home, ["logout", "--context", "cli-beta"]);
  assert.equal(r.code, 4);
  assert.match(r.stdout, /Yerel giriş silindi/);
  assert.match(r.stdout, /İPTAL EDİLMEDİ.*\/settings\/connections/);
  const store = JSON.parse(readFileSync(join(home, ".blocofy", "credentials.json"), "utf8"));
  assert.deepEqual(Object.keys(store.contexts), []);
  assert.deepEqual(JSON.parse(readFileSync(join(home, ".blocofy", "secrets.json"), "utf8")), {});
  noSecrets(r);

  const w = await world();
  r = await run(w.home, ["logout", "--context", "alpha", "--json"]);
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(r.stdout).logout.server, "not_applicable");
  assert.deepEqual(A.state.requests, []);
});

test("[18] secret leakage scan: every captured stdout/stderr and every file written outside the secret stores", () => {
  assert.ok(OUTPUTS.length > 50, `only ${OUTPUTS.length} outputs captured`);
  for (const o of OUTPUTS) {
    for (const secret of ALL_SECRETS) assert.ok(!o.stdout.includes(secret) && !o.stderr.includes(secret), `secret leaked in output of: blocofy ${o.args}`);
  }
  let scanned = 0;
  const walk = (abs) => {
    for (const name of readdirSync(abs)) {
      const p = join(abs, name);
      if (lstatSync(p).isDirectory()) {
        walk(p);
        continue;
      }
      // The secret stores and the v1 rollback backup hold secrets by design (0600, under ~/.blocofy).
      if (name === "secrets.json" || name.startsWith("credentials.v1.bak")) continue;
      const content = readFileSync(p, "utf8");
      // Scenario 13 / 6-legacy plant pre-v2 or truncated credentials.json fixtures on purpose; every v2 file the CLI
      // wrote is scanned.
      if (name === "credentials.json" && !content.startsWith('{\n  "schema_version": 2')) continue;
      scanned += 1;
      for (const secret of ALL_SECRETS) assert.ok(!content.includes(secret), `secret found in ${p}`);
      if (name === "project.json" || name === "local.json") assert.doesNotMatch(content, /bcf_|blcf_live_|blcf_ct_|blcf_rt_/);
    }
  };
  for (const d of DIRS) if (existsSync(d)) walk(d);
  assert.ok(scanned > 50, `only ${scanned} files scanned`);
});
