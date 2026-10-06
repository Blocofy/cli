import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { REFRESH_LOCK_STALE_MS, REFRESH_MIN_VALIDITY_MS, TOKEN_REQUEST_TIMEOUT_MS, accessTokenFor, refreshLockPath } from "../lib/refresh.mjs";

/**
 * ADR-0014 §5.4 (wave P4) — refresh single-flight. A fake /token in this process counts presentations and enforces
 * the platform's single-use rule (a second presentation of the same refresh token = reuse = the family is closed).
 * Contexts are seeded in a temp HOME with the 0600 file store (BLOCOFY_SECRET_STORE=file).
 */

const LIB = (f) => pathToFileURL(fileURLToPath(new URL(`../lib/${f}`, import.meta.url))).href;
const DIRS = [];
after(() => DIRS.forEach((d) => rmSync(d, { recursive: true, force: true })));

function fakeTokenServer({ delayMs = 0 } = {}) {
  const state = { presented: [], spent: new Set(), mode: "ok", rv: 0, family: "open", url: null };
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const form = new URLSearchParams(raw);
    const json = (status, body, headers = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };
    if (req.url !== "/token" || req.method !== "POST") return json(404, {});
    const rt = form.get("refresh_token");
    state.presented.push({ rt, client_id: form.get("client_id"), resource: form.get("resource"), grant_type: form.get("grant_type") });
    if (state.mode === "hang") return; // never answers (the client's timeout decides)
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    if (state.mode === "unavailable") return json(503, { error: "server_error", error_description: "Yenileme işlenemedi." }, { "retry-after": "2" });
    if (state.mode === "spent") return json(503, { error: "server_error", error_description: "Yenileme tamamlanamadı; bu yenileme anahtarı artık kullanılamaz." });
    if (state.family === "revoked" || state.spent.has(rt)) {
      state.family = "revoked";
      return json(400, { error: "invalid_grant", error_description: "refresh_token zaten kullanılmış; bağlantı kapatıldı." });
    }
    state.spent.add(rt);
    state.rv += 1;
    return json(200, { access_token: `blcf_ct_access${state.rv}.sig`, token_type: "Bearer", expires_in: 600, refresh_token: `blcf_rt_refresh${state.rv}`, scope: "themes:read" });
  });
  return {
    state,
    async start() {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      state.url = `http://127.0.0.1:${server.address().port}`;
      return this;
    },
    stop: () => new Promise((r) => server.close(r)),
  };
}

/** A temp HOME with one CLI-login context "shop" whose access token expires at `expiresAt`. */
function seedHome(tokenUrl, { expiresAt, access = "blcf_ct_access0.sig", refresh = "blcf_rt_refresh0", state = null } = {}) {
  const home = mkdtempSync(join(tmpdir(), "blocofy-refresh-"));
  DIRS.push(home);
  const dir = join(home, ".blocofy");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const oauth = {
    url: tokenUrl,
    issuer: tokenUrl,
    client_id: "blocofy-cli",
    token_endpoint: `${tokenUrl}/token`,
    revocation_endpoint: `${tokenUrl}/revoke`,
    dev_url: null,
    profile: { id: "theme-dev", version: 1, label: "Tema geliştirme" },
    secret: { store: "file" },
    ...(state ? { state } : {}),
  };
  writeFileSync(join(dir, "credentials.json"), JSON.stringify({ schema_version: 2, current_context: "shop", contexts: { shop: { platform_origin: tokenUrl, site: { id: "s1", slug: "shop", name: "Shop", domain: null }, oauth, verified_at: null } } }), { mode: 0o600 });
  writeFileSync(join(dir, "secrets.json"), JSON.stringify({ shop: { oauth_tokens: JSON.stringify({ access_token: access, refresh_token: refresh, expires_at: expiresAt }) } }), { mode: 0o600 });
  return home;
}

const readTokens = (home) => JSON.parse(JSON.parse(readFileSync(join(home, ".blocofy", "secrets.json"), "utf8")).shop.oauth_tokens);
const readCtx = (home) => JSON.parse(readFileSync(join(home, ".blocofy", "credentials.json"), "utf8")).contexts.shop;

/** Run `fn` with HOME pointed at `home` (credentials.mjs resolves paths per call). */
async function withHome(home, fn) {
  const prev = process.env.HOME;
  const prevStore = process.env.BLOCOFY_SECRET_STORE;
  process.env.HOME = home;
  process.env.BLOCOFY_SECRET_STORE = "file";
  try {
    return await fn();
  } finally {
    process.env.HOME = prev;
    if (prevStore === undefined) delete process.env.BLOCOFY_SECRET_STORE;
    else process.env.BLOCOFY_SECRET_STORE = prevStore;
  }
}

test("ADR constants: /token timeout 10 s, lock staleness 30 s, at least 60 s of validity left", () => {
  assert.equal(TOKEN_REQUEST_TIMEOUT_MS, 10_000);
  assert.equal(REFRESH_LOCK_STALE_MS, 30_000);
  assert.equal(REFRESH_MIN_VALIDITY_MS, 60_000);
  assert.ok(TOKEN_REQUEST_TIMEOUT_MS < REFRESH_LOCK_STALE_MS);
});

test("a token with more than 60 s left is used as is: no /token request", async () => {
  const as = await fakeTokenServer().start();
  try {
    const home = seedHome(as.state.url, { expiresAt: Date.now() + 5 * 60_000 });
    const token = await withHome(home, () => accessTokenFor("shop"));
    assert.equal(token, "blcf_ct_access0.sig");
    assert.equal(as.state.presented.length, 0);
  } finally {
    await as.stop();
  }
});

test("in-process single-flight: three concurrent callers → exactly one /token request; rotation stored atomically", async () => {
  const as = await fakeTokenServer({ delayMs: 150 }).start();
  try {
    const home = seedHome(as.state.url, { expiresAt: Date.now() - 1000 });
    const tokens = await withHome(home, () => Promise.all([accessTokenFor("shop"), accessTokenFor("shop"), accessTokenFor("shop")]));
    assert.deepEqual(tokens, ["blcf_ct_access1.sig", "blcf_ct_access1.sig", "blcf_ct_access1.sig"]);
    assert.equal(as.state.presented.length, 1);
    assert.deepEqual(as.state.presented[0], { rt: "blcf_rt_refresh0", client_id: "blocofy-cli", resource: `${as.state.url}/api/v1`, grant_type: "refresh_token" });
    const stored = readTokens(home);
    assert.equal(stored.refresh_token, "blcf_rt_refresh1", "the rotated refresh token replaces the spent one");
    assert.ok(stored.expires_at > Date.now() + 500_000);
    assert.equal(existsSync(refreshLockPath("shop", home)), false, "lock released");
  } finally {
    await as.stop();
  }
});

test("two PROCESSES with an expired token at the same time → exactly one /token request, both succeed", async () => {
  const as = await fakeTokenServer({ delayMs: 400 }).start();
  try {
    const home = seedHome(as.state.url, { expiresAt: Date.now() - 1000 });
    const code = `import { accessTokenFor } from ${JSON.stringify(LIB("refresh.mjs"))}; process.stdout.write(await accessTokenFor("shop"));`;
    const run = () =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, ["--input-type=module", "-e", code], { env: { ...process.env, HOME: home, BLOCOFY_SECRET_STORE: "file" } });
        let out = "";
        let err = "";
        child.stdout.on("data", (d) => (out += d));
        child.stderr.on("data", (d) => (err += d));
        child.on("close", (status) => resolve({ status, out, err }));
      });
    const [a, b] = await Promise.all([run(), run()]);
    assert.equal(a.status, 0, a.err);
    assert.equal(b.status, 0, b.err);
    assert.equal(a.out, "blcf_ct_access1.sig");
    assert.equal(b.out, "blcf_ct_access1.sig");
    assert.equal(as.state.presented.length, 1, "a second presentation would be reuse (054) and close the family");
    assert.equal(as.state.family, "open");
    // A restart continues with the rotated pair.
    writeFileSync(join(home, ".blocofy", "secrets.json"), JSON.stringify({ shop: { oauth_tokens: JSON.stringify({ ...readTokens(home), expires_at: Date.now() - 1 }) } }), { mode: 0o600 });
    const c = await run();
    assert.equal(c.out, "blcf_ct_access2.sig");
    assert.deepEqual(as.state.presented.map((p) => p.rt), ["blcf_rt_refresh0", "blcf_rt_refresh1"]);
  } finally {
    await as.stop();
  }
});

test("after taking the lock the store is re-read: another process's fresh token is used without a request", async () => {
  const as = await fakeTokenServer().start();
  try {
    const home = seedHome(as.state.url, { expiresAt: Date.now() - 1000 });
    const lock = refreshLockPath("shop", home);
    // A live holder on this host (this test's own pid), just acquired.
    writeFileSync(lock, JSON.stringify({ pid: process.pid, hostname: hostname(), acquired_at: new Date().toISOString() }), { mode: 0o600 });
    setTimeout(() => {
      writeFileSync(join(home, ".blocofy", "secrets.json"), JSON.stringify({ shop: { oauth_tokens: JSON.stringify({ access_token: "blcf_ct_other.sig", refresh_token: "blcf_rt_other", expires_at: Date.now() + 600_000 }) } }), { mode: 0o600 });
      rmSync(lock);
    }, 250);
    const token = await withHome(home, () => accessTokenFor("shop"));
    assert.equal(token, "blcf_ct_other.sig");
    assert.equal(as.state.presented.length, 0);
  } finally {
    await as.stop();
  }
});

test("lock staleness: a dead holder on this host (ESRCH) or an age over 30 s is broken; a live holder is never broken early", async () => {
  const as = await fakeTokenServer().start();
  try {
    // dead pid
    const dead = spawn(process.execPath, ["-e", ""]);
    const deadPid = dead.pid;
    await once(dead, "close");
    let home = seedHome(as.state.url, { expiresAt: Date.now() - 1000 });
    writeFileSync(refreshLockPath("shop", home), JSON.stringify({ pid: deadPid, hostname: hostname(), acquired_at: new Date().toISOString() }));
    assert.equal(await withHome(home, () => accessTokenFor("shop")), "blcf_ct_access1.sig");

    // old lock (a live pid on another host cannot be probed: only the age frees it)
    home = seedHome(as.state.url, { expiresAt: Date.now() - 1000, refresh: "blcf_rt_x" });
    writeFileSync(refreshLockPath("shop", home), JSON.stringify({ pid: 1, hostname: "other-host", acquired_at: new Date(Date.now() - 31_000).toISOString() }));
    assert.equal(await withHome(home, () => accessTokenFor("shop")), "blcf_ct_access2.sig");

    // live and recent: waited for, not broken (a short wait limit makes the test finish)
    home = seedHome(as.state.url, { expiresAt: Date.now() - 1000, refresh: "blcf_rt_y" });
    const lock = refreshLockPath("shop", home);
    writeFileSync(lock, JSON.stringify({ pid: process.pid, hostname: hostname(), acquired_at: new Date().toISOString() }));
    await assert.rejects(
      withHome(home, () => accessTokenFor("shop", { waitMs: 300 })),
      (e) => e.code === "REFRESH_BUSY" && !/blcf_rt_/.test(e.message),
    );
    assert.equal(existsSync(lock), true, "a live holder's lock is never removed before it is stale");
    assert.equal(as.state.presented.filter((p) => p.rt === "blcf_rt_y").length, 0);
  } finally {
    await as.stop();
  }
});

test("reuse / invalid_grant → reauth_required, no retry; later calls refuse without a request", async () => {
  const as = await fakeTokenServer().start();
  try {
    const home = seedHome(as.state.url, { expiresAt: Date.now() - 1000 });
    as.state.spent.add("blcf_rt_refresh0"); // the refresh token was already presented once (e.g. a copied store)
    await assert.rejects(withHome(home, () => accessTokenFor("shop")), (e) => e.code === "REAUTH_REQUIRED" && /blocofy login/.test(e.message));
    assert.equal(as.state.presented.length, 1, "never retried");
    assert.equal(readCtx(home).oauth.state, "reauth_required");
    await assert.rejects(withHome(home, () => accessTokenFor("shop")), (e) => e.code === "REAUTH_REQUIRED");
    assert.equal(as.state.presented.length, 1, "a context that needs a new login sends nothing");
  } finally {
    await as.stop();
  }
});

test("503 after the presentation was recorded (no Retry-After) → reauth_required, no retry; 503 with Retry-After → temporary, token kept", async () => {
  const as = await fakeTokenServer().start();
  try {
    let home = seedHome(as.state.url, { expiresAt: Date.now() - 1000 });
    as.state.mode = "spent";
    await assert.rejects(withHome(home, () => accessTokenFor("shop")), (e) => e.code === "REAUTH_REQUIRED");
    assert.equal(as.state.presented.length, 1);

    home = seedHome(as.state.url, { expiresAt: Date.now() - 1000 });
    as.state.mode = "unavailable";
    await assert.rejects(withHome(home, () => accessTokenFor("shop")), (e) => e.code === "REFRESH_FAILED");
    assert.equal(as.state.presented.length, 2, "one request, no retry");
    assert.equal(readCtx(home).oauth.state, undefined, "a refusal before the presentation was recorded keeps the login");
    assert.equal(readTokens(home).refresh_token, "blcf_rt_refresh0");
  } finally {
    await as.stop();
  }
});

test("/token that never answers: the request times out (injected short timeout), no retry, lock released", async () => {
  const as = await fakeTokenServer().start();
  try {
    const home = seedHome(as.state.url, { expiresAt: Date.now() - 1000 });
    as.state.mode = "hang";
    const started = Date.now();
    await assert.rejects(withHome(home, () => accessTokenFor("shop", { requestTimeoutMs: 200 })), (e) => e.code === "REFRESH_FAILED");
    assert.ok(Date.now() - started < 5000);
    assert.equal(as.state.presented.length, 1);
    assert.equal(existsSync(refreshLockPath("shop", home)), false);
  } finally {
    await as.stop();
  }
});

test("a context marked reauth_required or without a refresh token refuses before any request", async () => {
  const as = await fakeTokenServer().start();
  try {
    const home = seedHome(as.state.url, { expiresAt: Date.now() - 1000, state: "reauth_required" });
    await assert.rejects(withHome(home, () => accessTokenFor("shop")), (e) => e.code === "REAUTH_REQUIRED");
    const home2 = seedHome(as.state.url, { expiresAt: Date.now() - 1000, refresh: null });
    await assert.rejects(withHome(home2, () => accessTokenFor("shop")), (e) => e.code === "REAUTH_REQUIRED");
    assert.equal(as.state.presented.length, 0);
  } finally {
    await as.stop();
  }
});
