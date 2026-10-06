import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { isLoopbackCallback, loopbackRedirectUri, startLoopbackListener } from "../lib/loopback.mjs";
import { CLI_CLIENT_ID, createPkce, revokeToken, runBrowserLogin } from "../lib/oauth.mjs";

/**
 * ADR-0014 §5.1/§5.2 (wave P4) — the browser login against a fake authorization server + platform in this process.
 * The "browser" follows the authorize redirect to the CLI's loopback callback, as a real one would.
 */

const BIN = fileURLToPath(new URL("../bin/blocofy.mjs", import.meta.url));
const DIRS = [];
after(() => DIRS.forEach((d) => rmSync(d, { recursive: true, force: true })));
const b64url = (buf) => Buffer.from(buf).toString("base64url");

/** The platform's redirect rule (packages/cms oauth-clients.ts `isLoopbackCallback`), mirrored for the fake AS. */
function serverAcceptsRedirect(uri) {
  let url;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.href !== uri || url.protocol !== "http:" || url.username || url.password || url.search || url.hash) return false;
  if (url.hostname !== "127.0.0.1" && url.hostname !== "[::1]") return false;
  const port = Number(url.port);
  return url.pathname === "/callback" && url.port !== "" && port >= 1024 && port <= 65535;
}

function fakeAuthServer(opts = {}) {
  const state = { url: null, requests: [], codes: new Map(), revoked: [], tokenCalls: 0, authorize: null, ...opts };
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const u = new URL(req.url, "http://x");
    state.requests.push(`${req.method} ${u.pathname}`);
    const json = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const origin = state.url;
    if (u.pathname === "/.well-known/oauth-authorization-server") {
      return json(200, {
        issuer: state.issuer ?? origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: state.tokenEndpoint ?? `${origin}/token`,
        registration_endpoint: `${origin}/register`,
        revocation_endpoint: `${origin}/revoke`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: state.noS256 ? ["plain"] : ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        authorization_response_iss_parameter_supported: !state.noIssSupport,
      });
    }
    if (u.pathname === "/authorize") {
      const p = u.searchParams;
      state.authorize = Object.fromEntries(p);
      const redirect = p.get("redirect_uri");
      if (p.get("client_id") !== "blocofy-cli" || p.get("response_type") !== "code" || p.get("code_challenge_method") !== "S256" || !serverAcceptsRedirect(redirect)) {
        res.writeHead(400);
        return res.end("bad authorize request");
      }
      const back = new URL(redirect);
      if (state.deny) back.searchParams.set("error", "access_denied");
      else {
        const code = `code_${state.codes.size + 1}`;
        state.codes.set(code, { challenge: p.get("code_challenge"), redirect, resource: p.get("resource") });
        back.searchParams.set("code", code);
      }
      back.searchParams.set("state", state.badState ? "not-the-state" : p.get("state"));
      if (!state.noIss) back.searchParams.set("iss", state.badIss ?? origin);
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }
    if (u.pathname === "/token" && req.method === "POST") {
      state.tokenCalls += 1;
      const f = new URLSearchParams(raw);
      const c = state.codes.get(f.get("code"));
      const challenge = b64url(createHash("sha256").update(f.get("code_verifier") ?? "").digest());
      if (!c || c.challenge !== challenge || c.redirect !== f.get("redirect_uri") || f.get("client_id") !== "blocofy-cli" || f.get("grant_type") !== "authorization_code") {
        return json(400, { error: "invalid_grant", error_description: "PKCE doğrulaması başarısız." });
      }
      if (f.get("resource") !== c.resource || f.get("resource") !== `${origin}/api/v1`) return json(400, { error: "invalid_target" });
      state.codes.delete(f.get("code"));
      const prefix = state.mcpToken ? "blcf_at_" : "blcf_ct_";
      return json(200, { access_token: `${prefix}accessCANARY.sig`, token_type: "Bearer", expires_in: 600, refresh_token: "blcf_rt_refreshCANARY", scope: "themes:read themes:write" });
    }
    if (u.pathname === "/api/v1/ping") {
      if (req.headers.authorization !== "Bearer blcf_ct_accessCANARY.sig") return json(401, { error: { code: "audience_mismatch", message: "x" } });
      return json(200, {
        ok: true,
        site: { id: "s7k2p9", name: "Shop", slug: "shop", domain: "shop.myblocofy.test" },
        platform_origin: origin,
        ...(state.noProfile ? {} : { profile: { id: "theme-dev", version: 1, label: "Tema geliştirme" } }),
        audience: state.pingAudience ?? "cli",
        dev_endpoint: "https://shop.myblocofy.test/api/dev",
        policy_version: 1,
      });
    }
    if (u.pathname === "/revoke" && req.method === "POST") {
      state.revoked.push(Object.fromEntries(new URLSearchParams(raw)));
      return json(200, {});
    }
    return json(404, {});
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

/** A browser: opens the authorize URL and follows its redirect to the loopback callback. */
const browser = (seen = []) => async (url) => {
  seen.push(url);
  const r = await fetch(url, { redirect: "manual" });
  const location = r.headers.get("location");
  if (location) await fetch(location).catch(() => {});
};

const quiet = () => {};

test("PKCE S256: a 32-byte verifier, its SHA-256 challenge, base64url without padding", () => {
  const { verifier, challenge, method } = createPkce();
  assert.equal(method, "S256");
  assert.equal(Buffer.from(verifier, "base64url").length, 32);
  assert.equal(challenge, b64url(createHash("sha256").update(verifier).digest()));
  assert.doesNotMatch(verifier + challenge, /[=+/]/);
  assert.notEqual(createPkce().verifier, verifier);
});

test("happy path: discovery, PKCE, state, loopback /callback, iss check, code exchange with the CLI resource, canonical ping", async () => {
  const as = await fakeAuthServer().start();
  try {
    const seen = [];
    const result = await runBrowserLogin({ origin: as.state.url, openBrowser: browser(seen), print: quiet });
    const a = as.state.authorize;
    assert.equal(a.client_id, CLI_CLIENT_ID);
    assert.equal(a.code_challenge_method, "S256");
    assert.equal(a.resource, `${as.state.url}/api/v1`);
    assert.match(a.redirect_uri, /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    assert.ok(Buffer.from(a.state, "base64url").length === 32, "state is 32 random bytes");
    assert.equal(a.scope, undefined, "the server pre-checks the draft profile's scopes");
    // The URL the user sees carries no secret: the challenge, never the verifier.
    assert.ok(!seen[0].includes("code_verifier"));
    assert.equal(as.state.tokenCalls, 1);
    assert.equal(result.tokens.access_token, "blcf_ct_accessCANARY.sig");
    assert.equal(result.tokens.refresh_token, "blcf_rt_refreshCANARY");
    assert.ok(result.tokens.expires_at > Date.now() + 590_000);
    assert.deepEqual(result.identity.site, { id: "s7k2p9", name: "Shop", slug: "shop", domain: "shop.myblocofy.test" });
    assert.deepEqual(result.identity.profile, { id: "theme-dev", version: 1, label: "Tema geliştirme" });
    assert.equal(result.identity.audience, "cli");
    assert.equal(result.identity.devUrl, "https://shop.myblocofy.test");
    assert.equal(result.metadata.revocation_endpoint, `${as.state.url}/revoke`);
    assert.deepEqual(as.state.revoked, []);
  } finally {
    await as.stop();
  }
});

test("[::1] loopback works the same way (skipped when IPv6 loopback is unavailable)", async (t) => {
  let probe;
  try {
    probe = await startLoopbackListener({ host: "::1", timeoutMs: 1000 });
  } catch {
    t.skip("no IPv6 loopback here");
    return;
  }
  assert.match(probe.redirectUri, /^http:\/\/\[::1\]:\d+\/callback$/);
  probe.close();
  const as = await fakeAuthServer().start();
  try {
    const result = await runBrowserLogin({ origin: as.state.url, openBrowser: browser(), print: quiet, callbackHost: "::1" });
    assert.match(as.state.authorize.redirect_uri, /^http:\/\/\[::1\]:\d+\/callback$/);
    assert.equal(result.identity.audience, "cli");
  } finally {
    await as.stop();
  }
});

test("loopback rule (RFC 8252 §7.3/§8.3): 127.0.0.1 and [::1] on any port ≥ 1024, exact /callback; localhost refused", async () => {
  assert.equal(loopbackRedirectUri("127.0.0.1", 49152), "http://127.0.0.1:49152/callback");
  assert.equal(loopbackRedirectUri("::1", 5000), "http://[::1]:5000/callback");
  for (const [host, port] of [["localhost", 5000], ["0.0.0.0", 5000], ["192.168.1.2", 5000], ["127.0.0.1", 80], ["127.0.0.1", 70000]]) {
    assert.throws(() => loopbackRedirectUri(host, port), (e) => e.code === "LOGIN_LOOPBACK_REFUSED", `${host}:${port}`);
  }
  assert.equal(isLoopbackCallback("http://127.0.0.1:5000/callback"), true);
  assert.equal(isLoopbackCallback("http://[::1]:5000/callback"), true);
  for (const bad of ["http://localhost:5000/callback", "https://127.0.0.1:5000/callback", "http://127.0.0.1:5000/callback/", "http://127.0.0.1:5000/cb", "http://127.0.0.1:5000/callback?x=1", "http://127.0.0.1/callback", "http://u@127.0.0.1:5000/callback"]) {
    assert.equal(isLoopbackCallback(bad), false, bad);
  }
  // A login asked to call back on localhost refuses before ANY request.
  const as = await fakeAuthServer().start();
  try {
    await assert.rejects(runBrowserLogin({ origin: as.state.url, openBrowser: browser(), print: quiet, callbackHost: "localhost" }), (e) => e.code === "LOGIN_LOOPBACK_REFUSED");
    assert.deepEqual(as.state.requests, []);
  } finally {
    await as.stop();
  }
});

test("listener: only GET /callback is accepted, once; other paths 404; it closes after the callback", async () => {
  const l = await startLoopbackListener({ host: "127.0.0.1", timeoutMs: 5000 });
  const base = l.redirectUri.replace(/\/callback$/, "");
  assert.equal((await fetch(`${base}/favicon.ico`)).status, 404);
  assert.equal((await fetch(`${base}/callback/x?code=1`)).status, 404);
  const waiting = l.wait();
  const r = await fetch(`${base}/callback?code=abc&state=s&iss=i`);
  assert.equal(r.status, 200);
  assert.doesNotMatch(await r.text(), /abc/, "the page does not echo the code");
  const params = await waiting;
  assert.equal(params.get("code"), "abc");
  await assert.rejects(fetch(`${base}/callback?code=second`), "closed after one callback");
});

test("listener timeout: no callback within the limit → LOGIN_TIMEOUT and the port is closed", async () => {
  const l = await startLoopbackListener({ host: "127.0.0.1", timeoutMs: 150 });
  await assert.rejects(l.wait(), (e) => e.code === "LOGIN_TIMEOUT");
  await assert.rejects(fetch(l.redirectUri));
});

test("state mismatch → refused, the code is never exchanged", async () => {
  const as = await fakeAuthServer({ badState: true }).start();
  try {
    await assert.rejects(runBrowserLogin({ origin: as.state.url, openBrowser: browser(), print: quiet }), (e) => e.code === "LOGIN_STATE_MISMATCH");
    assert.equal(as.state.tokenCalls, 0);
  } finally {
    await as.stop();
  }
});

test("RFC 9207: an iss other than the metadata issuer, or no iss, is refused; the code is never exchanged", async () => {
  for (const opts of [{ badIss: "https://evil.example" }, { noIss: true }]) {
    const as = await fakeAuthServer(opts).start();
    try {
      await assert.rejects(runBrowserLogin({ origin: as.state.url, openBrowser: browser(), print: quiet }), (e) => e.code === "LOGIN_ISS_MISMATCH", JSON.stringify(opts));
      assert.equal(as.state.tokenCalls, 0);
    } finally {
      await as.stop();
    }
  }
});

test("discovery: an issuer other than the platform origin, no S256, or no iss support → refused before the browser opens", async () => {
  for (const [opts, code] of [[{ issuer: "https://evil.example" }, "LOGIN_ISSUER_MISMATCH"], [{ noS256: true }, "LOGIN_UNSUPPORTED_PLATFORM"], [{ noIssSupport: true }, "LOGIN_UNSUPPORTED_PLATFORM"], [{ tokenEndpoint: "https://evil.example/token" }, "LOGIN_ISSUER_MISMATCH"]]) {
    const as = await fakeAuthServer(opts).start();
    const seen = [];
    try {
      await assert.rejects(runBrowserLogin({ origin: as.state.url, openBrowser: browser(seen), print: quiet }), (e) => e.code === code, JSON.stringify(opts));
      assert.equal(seen.length, 0, "no browser");
    } finally {
      await as.stop();
    }
  }
});

test("the owner declines (error=access_denied) → LOGIN_DENIED, nothing exchanged", async () => {
  const as = await fakeAuthServer({ deny: true }).start();
  try {
    await assert.rejects(runBrowserLogin({ origin: as.state.url, openBrowser: browser(), print: quiet }), (e) => e.code === "LOGIN_DENIED");
    assert.equal(as.state.tokenCalls, 0);
  } finally {
    await as.stop();
  }
});

test("audience: a non-CLI token, or a ping that is not audience=cli / has no profile → refused and the new login revoked", async () => {
  for (const opts of [{ mcpToken: true }, { pingAudience: "mcp" }, { noProfile: true }]) {
    const as = await fakeAuthServer(opts).start();
    try {
      await assert.rejects(runBrowserLogin({ origin: as.state.url, openBrowser: browser(), print: quiet }), (e) => ["LOGIN_AUDIENCE_MISMATCH", "LOGIN_UNSUPPORTED_PLATFORM"].includes(e.code) && !/CANARY/.test(e.message), JSON.stringify(opts));
      assert.equal(as.state.revoked.length, 1, "the half-made login is revoked");
      assert.equal(as.state.revoked[0].client_id, "blocofy-cli");
      assert.equal(as.state.revoked[0].token, "blcf_rt_refreshCANARY");
    } finally {
      await as.stop();
    }
  }
});

test("revokeToken reports revoked / refused / unreachable honestly", async () => {
  const as = await fakeAuthServer().start();
  try {
    assert.deepEqual(await revokeToken({ endpoint: `${as.state.url}/revoke`, token: "blcf_rt_x", clientId: CLI_CLIENT_ID }), { outcome: "revoked", status: 200 });
    assert.equal((await revokeToken({ endpoint: `${as.state.url}/nope`, token: "blcf_rt_x", clientId: CLI_CLIENT_ID })).outcome, "refused");
  } finally {
    await as.stop();
  }
  assert.equal((await revokeToken({ endpoint: `${as.state.url}/revoke`, token: "blcf_rt_x", clientId: CLI_CLIENT_ID, timeoutMs: 500 })).outcome, "unreachable");
});

// ── the bin: unattended never opens a browser ────────────────────────────────────────────────────────────────

function runBin(args, env = {}) {
  const home = mkdtempSync(join(tmpdir(), "blocofy-login-bin-"));
  DIRS.push(home);
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { env: { PATH: process.env.PATH, HOME: home, ...env }, timeout: 20_000 }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code : 0, stdout, stderr, home });
    });
  });
}

test("bin: `blocofy login` without a terminal (CI) never opens a browser, sends nothing and points to the advanced options", async () => {
  const as = await fakeAuthServer().start();
  try {
    for (const env of [{}, { CI: "true" }]) {
      const r = await runBin(["login", "--api-url", as.state.url], env);
      assert.equal(r.code, 1);
      assert.match(r.stderr, /LOGIN_UNATTENDED/);
      assert.match(r.stderr, /--token/);
      assert.equal(existsSync(join(r.home, ".blocofy", "credentials.json")), false);
    }
    assert.deepEqual(as.state.requests, []);
  } finally {
    await as.stop();
  }
});

test("bin (B6): `login --token <value>` warns that argv is visible; nothing is saved when verification fails", async () => {
  const r = await runBin(["login", "--url", "http://127.0.0.1:9", "--token", "bcf_argvTokenCANARY_0123456789"]);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /warning \[TOKEN_IN_ARGV\]/);
  assert.doesNotMatch(r.stderr + r.stdout, /argvTokenCANARY/);
  assert.equal(existsSync(join(r.home, ".blocofy", "credentials.json")), false);
});

test("bin: an OS store that is not available here is never replaced by a plaintext file; nothing is sent", async () => {
  // BLOCOFY_SECRET_STORE naming another OS's store (the unit matrix covers the store choice itself).
  const other = process.platform === "darwin" ? "dpapi" : "keychain";
  const as = await fakeAuthServer().start();
  try {
    const r = await runBin(["login", "--api-url", as.state.url], { BLOCOFY_SECRET_STORE: other });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /SECRET_STORE_UNAVAILABLE|LOGIN_UNATTENDED/);
    assert.deepEqual(as.state.requests, []);
    assert.ok(!existsSync(join(r.home, ".blocofy", "secrets.json")), "no plaintext fallback was written");
  } finally {
    await as.stop();
  }
});

test("hygiene: no secret bearing file is left by a refused login", () => {
  for (const d of DIRS) {
    const p = join(d, ".blocofy", "secrets.json");
    if (existsSync(p)) assert.doesNotMatch(readFileSync(p, "utf8"), /CANARY/);
  }
});
