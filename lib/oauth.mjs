import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { fetchWithRetry } from "./http.mjs";
import { isLoopbackCallback, startLoopbackListener } from "./loopback.mjs";

/**
 * ADR-0014 §5 (wave P4) — `blocofy login`: the system browser, Authorization Code + PKCE S256, loopback redirect.
 *
 *   1. Discovery: `GET <origin>/.well-known/oauth-authorization-server`. The issuer must be the origin itself, the
 *      token/revocation endpoints on it; S256 and RFC 9207 `iss` must be supported (an older platform is refused).
 *   2. Loopback listener (127.0.0.1 or [::1], ephemeral port, exact /callback), `state` and the PKCE verifier are 32
 *      random bytes. The browser opens `/authorize?…&resource=<origin>/api/v1` (no scope: the platform pre-checks the
 *      draft profile's). The URL carries no secret.
 *   3. The callback must carry `iss` = the metadata issuer and our `state`; only then is its code looked at.
 *   4. `/token` (authorization_code): the verifier + the same `resource`. Never retried (a code is single-use). The
 *      answer must be a CLI token (`blcf_ct_`, audience `cli`).
 *   5. Success = the canonical identity probe `GET /api/v1/ping` (site + profile + audience `cli`), not a config write.
 * Anything that fails after the code exchange revokes the new login (best effort), so no half-made grant is left.
 */

export const CLI_CLIENT_ID = "blocofy-cli";
export const CLI_TOKEN_PREFIX = "blcf_ct_";
const REQUEST_TIMEOUT_MS = 10_000;

export class LoginError extends Error {
  constructor(code, message, details = {}, exitCode = 1) {
    super(message);
    this.name = "LoginError";
    this.code = code;
    this.details = details;
    this.exitCode = exitCode;
  }
}

const b64url = (buf) => Buffer.from(buf).toString("base64url");
const stripSlash = (u) => String(u).replace(/\/+$/, "");

export function createPkce() {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()), method: "S256" };
}

export const newState = () => b64url(randomBytes(32));

const sameString = (a, b) => {
  const x = Buffer.from(String(a ?? ""));
  const y = Buffer.from(String(b ?? ""));
  return x.length === y.length && timingSafeEqual(x, y);
};

/** https, or http on a loopback address (a local development platform). */
function acceptableOrigin(origin) {
  let u;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  if (u.protocol === "https:") return true;
  return u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "[::1]" || u.hostname === "localhost");
}

/** The resource indicator (RFC 8707) of the CLI audience. */
export const cliResource = (origin) => `${stripSlash(origin)}/api/v1`;

/** RFC 8414 discovery with the checks above. */
export async function discoverMetadata(origin, { fetchImpl = globalThis.fetch } = {}) {
  const base = stripSlash(origin);
  if (!acceptableOrigin(base)) throw new LoginError("LOGIN_DISCOVERY_FAILED", `The platform address must be https:// (got ${base}). Nothing was sent.`);
  let res;
  try {
    res = await fetchWithRetry(`${base}/.well-known/oauth-authorization-server`, { headers: { accept: "application/json" } }, { fetchImpl, timeoutMs: REQUEST_TIMEOUT_MS, retries: 1 });
  } catch (error) {
    throw new LoginError("LOGIN_DISCOVERY_FAILED", `Could not reach ${base} (${error?.name === "TimeoutError" ? "timeout" : "network error"}). Nothing was saved.`);
  }
  let meta = null;
  try {
    meta = res.ok ? await res.json() : null;
  } catch {
    meta = null;
  }
  if (!meta || typeof meta !== "object") throw new LoginError("LOGIN_DISCOVERY_FAILED", `${base} did not answer the login discovery (HTTP ${res.status}). Nothing was saved.`);
  if (meta.issuer !== base) {
    throw new LoginError("LOGIN_ISSUER_MISMATCH", `The platform at ${base} names another issuer (${meta.issuer}); the login was refused. Nothing was saved.`, { issuer: meta.issuer ?? null });
  }
  for (const key of ["authorization_endpoint", "token_endpoint", "revocation_endpoint"]) {
    const v = meta[key];
    if (v === undefined && key === "revocation_endpoint") continue;
    let u;
    try {
      u = new URL(v);
    } catch {
      u = null;
    }
    if (!u || u.origin !== new URL(base).origin) {
      throw new LoginError("LOGIN_ISSUER_MISMATCH", `The platform's ${key} is not on ${base}; the login was refused. Nothing was saved.`, { [key]: v ?? null });
    }
  }
  if (!Array.isArray(meta.code_challenge_methods_supported) || !meta.code_challenge_methods_supported.includes("S256") || meta.authorization_response_iss_parameter_supported !== true) {
    throw new LoginError(
      "LOGIN_UNSUPPORTED_PLATFORM",
      `The platform at ${base} does not support the CLI browser login yet (PKCE S256 + RFC 9207 iss). Nothing was saved. Use the advanced login: blocofy login --token (dev token) or blocofy login --api-key.`,
    );
  }
  return { issuer: meta.issuer, authorization_endpoint: meta.authorization_endpoint, token_endpoint: meta.token_endpoint, revocation_endpoint: meta.revocation_endpoint ?? null };
}

export function authorizeUrl(meta, { redirectUri, challenge, state, resource, clientId = CLI_CLIENT_ID }) {
  const u = new URL(meta.authorization_endpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("state", state);
  u.searchParams.set("resource", resource);
  return u.toString();
}

/** RFC 9207 first (also on error answers), then state, then the answer itself. Returns the code. */
export function validateCallback(params, { issuer, state }) {
  if (!params.has("iss") || !sameString(params.get("iss"), issuer)) {
    throw new LoginError("LOGIN_ISS_MISMATCH", "The browser answer did not come from this platform (iss mismatch); the login was refused. Nothing was saved.");
  }
  if (!sameString(params.get("state"), state)) {
    throw new LoginError("LOGIN_STATE_MISMATCH", "The browser answer does not belong to this login (state mismatch); the login was refused. Nothing was saved.");
  }
  const error = params.get("error");
  if (error) {
    throw new LoginError(
      "LOGIN_DENIED",
      error === "access_denied" ? "The login was not approved in the browser. Nothing was saved." : `The platform refused the login (${error}). Nothing was saved.`,
      { error },
    );
  }
  const code = params.get("code");
  if (!code) throw new LoginError("LOGIN_DENIED", "The browser answer carried no authorization code. Nothing was saved.");
  return code;
}

async function postForm(url, fields, { fetchImpl, timeoutMs = REQUEST_TIMEOUT_MS }) {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(fields).toString(),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text().catch(() => "");
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { res, json };
}

/** The code exchange. Never retried (a resend of a spent code makes the platform revoke what it issued). */
export async function exchangeCode(meta, { code, verifier, redirectUri, resource, clientId = CLI_CLIENT_ID, fetchImpl = globalThis.fetch, now = Date.now }) {
  let out;
  try {
    out = await postForm(meta.token_endpoint, { grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier, resource }, { fetchImpl });
  } catch (error) {
    throw new LoginError("LOGIN_TOKEN_FAILED", `The platform did not answer the login's code exchange (${error?.name === "TimeoutError" ? "timeout" : "network error"}). Nothing was saved; run \`blocofy login\` again.`);
  }
  const { res, json } = out;
  if (!res.ok || !json) {
    throw new LoginError("LOGIN_TOKEN_FAILED", `The platform refused the login's code exchange (${json?.error ?? `HTTP ${res.status}`}). Nothing was saved; run \`blocofy login\` again.`, { error: json?.error ?? null, status: res.status });
  }
  const tokens = {
    access_token: typeof json.access_token === "string" ? json.access_token : null,
    refresh_token: typeof json.refresh_token === "string" && json.refresh_token ? json.refresh_token : null,
    expires_at: now() + Number(json.expires_in) * 1000,
  };
  return { tokens, tokenType: json.token_type ?? null };
}

/**
 * RFC 7009 revocation: `revoked` (HTTP 200 — the platform answers 200 for an unknown or already revoked token too),
 * `refused` (another 4xx/5xx answer: NOT revoked), `unreachable` (network/timeout: NOT revoked).
 */
export async function revokeToken({ endpoint, token, clientId = CLI_CLIENT_ID, fetchImpl = globalThis.fetch, timeoutMs = REQUEST_TIMEOUT_MS }) {
  try {
    const { res } = await postForm(endpoint, { token, client_id: clientId }, { fetchImpl, timeoutMs });
    if (res.status === 200) return { outcome: "revoked", status: 200 };
    return { outcome: res.status >= 500 ? "unreachable" : "refused", status: res.status };
  } catch {
    return { outcome: "unreachable", status: null };
  }
}

/** The canonical identity probe (`GET /api/v1/ping`) of a CLI token: site + profile + audience `cli`. */
export async function probeIdentity(origin, accessToken, { fetchImpl = globalThis.fetch, onRetry = null } = {}) {
  let res;
  try {
    res = await fetchWithRetry(`${stripSlash(origin)}/api/v1/ping`, { headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" } }, { fetchImpl, timeoutMs: 15_000, onRetry });
  } catch (error) {
    throw new LoginError("LOGIN_IDENTITY_UNVERIFIED", `Could not confirm the new login with the platform (${error?.name === "TimeoutError" ? "timeout" : "network error"}). Nothing was saved.`);
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok || !body || typeof body !== "object") {
    const code = body?.error?.code ?? null;
    throw new LoginError(code === "audience_mismatch" ? "LOGIN_AUDIENCE_MISMATCH" : "LOGIN_IDENTITY_UNVERIFIED", `The platform did not confirm the new login (${code ?? `HTTP ${res.status}`}). Nothing was saved.`, { server_code: code, status: res.status });
  }
  const site = body.site;
  if (!site || typeof site !== "object" || !(typeof site.id === "string" || Number.isFinite(site.id))) {
    throw new LoginError("LOGIN_IDENTITY_UNVERIFIED", "The platform's identity answer names no site. Nothing was saved.");
  }
  if (body.audience !== "cli") {
    throw new LoginError("LOGIN_AUDIENCE_MISMATCH", `The new login is not a CLI login (audience ${body.audience ?? "missing"}); it was refused. Nothing was saved.`, { audience: body.audience ?? null });
  }
  const p = body.profile;
  if (!p || typeof p !== "object" || typeof p.id !== "string") {
    throw new LoginError("LOGIN_UNSUPPORTED_PLATFORM", "The platform does not report the login's profile (it is older than the CLI login). Nothing was saved. Use the advanced login: blocofy login --token.");
  }
  let devUrl = null;
  if (typeof body.dev_endpoint === "string") {
    try {
      const u = new URL(body.dev_endpoint);
      if ((u.protocol === "https:" || u.protocol === "http:") && /\/api\/dev\/?$/.test(u.pathname)) devUrl = `${u.origin}${u.pathname.replace(/\/api\/dev\/?$/, "")}`;
    } catch {
      devUrl = null;
    }
  }
  return {
    site: { id: site.id, slug: typeof site.slug === "string" ? site.slug : null, name: typeof site.name === "string" ? site.name : null, domain: typeof site.domain === "string" ? site.domain : null },
    platformOrigin: typeof body.platform_origin === "string" && body.platform_origin ? body.platform_origin : null,
    profile: { id: p.id, version: Number.isInteger(p.version) ? p.version : null, label: typeof p.label === "string" ? p.label : null },
    audience: body.audience,
    devUrl,
    policyVersion: body.policy_version ?? null,
  };
}

/**
 * The whole browser login. `openBrowser(url)` opens the system browser (may throw: the URL is printed anyway);
 * `print(line)` writes a progress line (stderr). Returns `{ tokens, identity, metadata }`.
 */
export async function runBrowserLogin({ origin, openBrowser, print = () => {}, fetchImpl = globalThis.fetch, callbackHost = "127.0.0.1", timeoutMs, onRetry = null }) {
  const base = stripSlash(origin);
  // The loopback rule is checked before any request (localhost refused).
  const listenerOpts = { host: callbackHost, ...(timeoutMs ? { timeoutMs } : {}) };
  if (callbackHost !== "127.0.0.1" && callbackHost !== "::1") await startLoopbackListener(listenerOpts); // throws
  const metadata = await discoverMetadata(base, { fetchImpl });
  const pkce = createPkce();
  const state = newState();
  const resource = cliResource(base);
  let listener;
  try {
    listener = await startLoopbackListener(listenerOpts);
  } catch (error) {
    if (error?.code === "LOGIN_LOOPBACK_REFUSED") throw error;
    if (callbackHost !== "127.0.0.1") throw new LoginError("LOGIN_LOOPBACK_UNAVAILABLE", `Could not listen on ${callbackHost} for the login callback. Nothing was saved.`);
    try {
      listener = await startLoopbackListener({ ...listenerOpts, host: "::1" }); // 127.0.0.1 unavailable: the IPv6 loopback
    } catch {
      throw new LoginError("LOGIN_LOOPBACK_UNAVAILABLE", "Could not listen on the loopback address for the login callback. Nothing was saved.");
    }
  }
  if (!isLoopbackCallback(listener.redirectUri)) {
    listener.close();
    throw new LoginError("LOGIN_LOOPBACK_REFUSED", "The login callback address is not a loopback address. Nothing was saved.");
  }
  const url = authorizeUrl(metadata, { redirectUri: listener.redirectUri, challenge: pkce.challenge, state, resource });
  print(url);
  try {
    await openBrowser(url);
  } catch {
    /* the URL is printed: the user opens it by hand */
  }
  const params = await listener.wait();
  const code = validateCallback(params, { issuer: metadata.issuer, state });
  const { tokens } = await exchangeCode(metadata, { code, verifier: pkce.verifier, redirectUri: listener.redirectUri, resource, fetchImpl });

  const abandon = async (error) => {
    const token = tokens.refresh_token ?? tokens.access_token;
    if (token && metadata.revocation_endpoint) await revokeToken({ endpoint: metadata.revocation_endpoint, token, fetchImpl });
    throw error;
  };
  if (!tokens.access_token || !tokens.access_token.startsWith(CLI_TOKEN_PREFIX) || !Number.isFinite(tokens.expires_at)) {
    return abandon(new LoginError("LOGIN_AUDIENCE_MISMATCH", "The platform answered with a token that is not a CLI login token; it was not used and the new connection was revoked. Nothing was saved."));
  }
  let identity;
  try {
    identity = await probeIdentity(base, tokens.access_token, { fetchImpl, onRetry });
  } catch (error) {
    return abandon(error);
  }
  return { tokens, identity, metadata, abandon };
}
