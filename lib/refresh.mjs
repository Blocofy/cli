import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { homedir, hostname as osHostname } from "node:os";
import { join } from "node:path";

import { CredentialsError, loadStore, markReauthRequired, readOAuthTokens, writeOAuthTokens } from "./credentials.mjs";

/**
 * ADR-0014 §5.4 (wave P4) — the CLI login's access token, refreshed single-flight.
 *
 * The platform's refresh tokens are single-use: a second presentation of the same token is reuse and closes the whole
 * login (054). So a refresh is never sent twice and never retried:
 *   - in one process: one promise per context;
 *   - across processes: `~/.blocofy/.refresh-<context>.lock` (O_EXCL) holding `{ pid, hostname, acquired_at }`. It is
 *     stale only when its owner on THIS host is gone (`kill(pid, 0)` → ESRCH) or it is older than 30 s; a live
 *     holder's lock is never broken before that. The /token request times out after 10 s, far below the staleness,
 *     so no second process can present the token while the first request is still open.
 * Under the lock the store is read again: when another process already refreshed (≥ 60 s left) no request is made.
 * Otherwise ONE /token request; the rotated pair is written atomically before the lock is released.
 *
 *   error_description "refresh_token_reused" → the context is marked `reauth_required`; no retry (the platform's
 *       (any status)                            explicit "this refresh token is spent" signal; checked first)
 *   invalid_grant (reuse, revoked, expired)  → the same
 *   503 without Retry-After (presentation    → the same (fallback heuristic for platforms without the signal)
 *       recorded, nothing minted)
 *   503 with Retry-After, network, timeout   → REFRESH_FAILED (temporary); the login is kept; no retry here
 */

export const TOKEN_REQUEST_TIMEOUT_MS = 10_000;
export const REFRESH_LOCK_STALE_MS = 30_000;
export const REFRESH_MIN_VALIDITY_MS = 60_000;
const DEFAULT_WAIT_MS = 45_000;
const POLL_MS = 50;

export class RefreshError extends CredentialsError {
  constructor(code, message, details = {}) {
    super(code, message, details);
    this.name = "RefreshError";
  }
}

const reauth = (name, why, reason = why) =>
  new RefreshError(
    "REAUTH_REQUIRED",
    `The CLI login of context "${name}" can no longer be renewed (${why}). Nothing was sent. Log in again: blocofy login --context ${name}`,
    { context: name, reason },
  );

/** The platform's explicit signal that a presented refresh token is spent (single-use, 054). */
export const REFRESH_REUSED = "refresh_token_reused";

export const refreshLockPath = (name, home = homedir()) => join(home, ".blocofy", `.refresh-${name}.lock`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH"; // EPERM: it exists, owned by someone else
  }
}

/** Is the lock at `path` stale? Unreadable content falls back to the file's age. */
function lockIsStale(path, now, host) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { stale: false, raw: null }; // released meanwhile: just try again
  }
  let holder = null;
  try {
    holder = JSON.parse(raw);
  } catch {
    holder = null;
  }
  const acquired = holder ? Date.parse(holder.acquired_at) : NaN;
  let age;
  if (Number.isFinite(acquired)) age = now - acquired;
  else {
    try {
      age = now - statSync(path).mtimeMs;
    } catch {
      return { stale: false, raw: null };
    }
  }
  if (age > REFRESH_LOCK_STALE_MS) return { stale: true, raw };
  if (holder && holder.hostname === host && Number.isInteger(holder.pid) && !alive(holder.pid)) return { stale: true, raw };
  return { stale: false, raw };
}

/** Take the cross-process lock or throw REFRESH_BUSY after `waitMs`. Returns a release() that only removes OUR lock. */
async function acquireLock(path, { waitMs, host, pid }) {
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + waitMs;
  for (;;) {
    const mine = JSON.stringify({ pid, hostname: host, acquired_at: new Date().toISOString() });
    try {
      const fd = openSync(path, "wx", 0o600);
      writeSync(fd, mine);
      closeSync(fd);
      return () => {
        try {
          if (readFileSync(path, "utf8") === mine) rmSync(path, { force: true });
        } catch {
          /* already gone */
        }
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    const { stale, raw } = lockIsStale(path, Date.now(), host);
    if (stale) {
      // Remove only the lock we judged stale (a new holder that replaced it meanwhile is left alone).
      try {
        if (readFileSync(path, "utf8") === raw) rmSync(path, { force: true });
      } catch {
        /* gone */
      }
      continue;
    }
    if (Date.now() > deadline) {
      throw new RefreshError("REFRESH_BUSY", `Another blocofy command is renewing this login and has not finished. Nothing was sent; try again in a moment (the lock frees itself after ${REFRESH_LOCK_STALE_MS / 1000} s).`, { lock: path });
    }
    await sleep(POLL_MS);
  }
}

const fresh = (tokens, now, min) => tokens && Number.isFinite(tokens.expires_at) && tokens.expires_at - now >= min;

/** One /token request (refresh_token grant). Never retried. */
async function presentRefresh({ endpoint, refreshToken, clientId, resource, fetchImpl, timeoutMs }) {
  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId, resource });
  let res;
  try {
    res = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: body.toString(),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return { kind: "unknown", reason: error?.name === "TimeoutError" ? "timeout" : "network error" };
  }
  const text = await res.text().catch(() => "");
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  if (res.ok) return { kind: "ok", json };
  if (json?.error_description === REFRESH_REUSED) return { kind: "reused" };
  if (res.status === 400 && (json?.error === "invalid_grant" || json?.error === "invalid_target" || json?.error === "unauthorized_client")) return { kind: "refused", error: json.error };
  if (res.status === 401 && json?.error === "invalid_client") return { kind: "refused", error: "invalid_client" };
  if (res.status === 503 && !res.headers.get("retry-after")) return { kind: "spent" };
  return { kind: "temporary", status: res.status };
}

const inflight = new Map();

/**
 * The DI core. `source`: `{ read() → tokens|null, write(tokens), needsReauth() → bool, markReauth() }`;
 * `endpoint`: `{ tokenEndpoint, clientId, resource }`.
 */
export async function freshAccess({ name, source, endpoint, lockPath, fetchImpl = globalThis.fetch, now = Date.now, requestTimeoutMs = TOKEN_REQUEST_TIMEOUT_MS, waitMs = DEFAULT_WAIT_MS, minValidityMs = REFRESH_MIN_VALIDITY_MS, host = osHostname(), pid = process.pid }) {
  if (source.needsReauth()) throw reauth(name, "a previous renewal was refused");
  const first = source.read();
  if (!first) throw reauth(name, "no saved login");
  if (fresh(first, now(), minValidityMs)) return first.access_token;

  const key = lockPath;
  if (inflight.has(key)) return inflight.get(key);
  const run = (async () => {
    const release = await acquireLock(lockPath, { waitMs, host, pid });
    try {
      if (source.needsReauth()) throw reauth(name, "a previous renewal was refused");
      const tokens = source.read();
      if (!tokens) throw reauth(name, "no saved login");
      if (fresh(tokens, now(), minValidityMs)) return tokens.access_token; // another process renewed it
      if (!tokens.refresh_token) {
        source.markReauth();
        throw reauth(name, "the login has no renewal token left");
      }
      const r = await presentRefresh({ endpoint: endpoint.tokenEndpoint, refreshToken: tokens.refresh_token, clientId: endpoint.clientId, resource: endpoint.resource, fetchImpl, timeoutMs: requestTimeoutMs });
      if (r.kind === "ok") {
        const access = r.json?.access_token;
        const expiresIn = Number(r.json?.expires_in);
        if (typeof access !== "string" || !access.startsWith("blcf_ct_") || !Number.isFinite(expiresIn)) {
          // The presented token is spent; what came back is not a CLI token. Never used, never retried.
          source.markReauth();
          throw reauth(name, "the platform answered with an unexpected token");
        }
        // Rotation: the new refresh token replaces the spent one. Without one the login ends at this access token.
        const next = { access_token: access, refresh_token: typeof r.json.refresh_token === "string" && r.json.refresh_token ? r.json.refresh_token : null, expires_at: now() + expiresIn * 1000 };
        source.write(next);
        return access;
      }
      if (r.kind === "reused") {
        source.markReauth();
        throw reauth(name, "its renewal token was already used (refresh_token_reused)", REFRESH_REUSED);
      }
      if (r.kind === "refused") {
        source.markReauth();
        throw reauth(name, r.error === "invalid_grant" ? "it was revoked, expired, or its renewal token was used twice" : r.error);
      }
      if (r.kind === "spent") {
        source.markReauth();
        throw reauth(name, "the platform could not complete the renewal and the renewal token is spent");
      }
      throw new RefreshError(
        "REFRESH_FAILED",
        r.kind === "unknown"
          ? `Could not renew the CLI login of context "${name}" (${r.reason}). Nothing else was sent. Try again; if the platform reports the login closed, log in again (blocofy login --context ${name}).`
          : `The platform could not renew the CLI login of context "${name}" right now (HTTP ${r.status}). Nothing else was sent; try again in a moment.`,
        { context: name, ...(r.status ? { status: r.status } : { reason: r.reason }) },
      );
    } finally {
      release();
    }
  })();
  inflight.set(key, run);
  try {
    return await run;
  } finally {
    inflight.delete(key);
  }
}

/** The access token of a saved CLI-login context (refreshed when needed). `opts` override the DI defaults (tests). */
export function accessTokenFor(name, opts = {}) {
  const ctxNow = () => loadStore().contexts[name];
  const ctx = ctxNow();
  if (!ctx?.oauth) throw new CredentialsError("LOGIN_REQUIRED", `Context "${name}" is not a CLI login. Run \`blocofy login --context ${name}\`.`, { context: name });
  const source = {
    read: () => readOAuthTokens(name, ctxNow() ?? ctx),
    write: (tokens) => writeOAuthTokens(name, ctx.oauth.secret.store, tokens),
    needsReauth: () => (ctxNow()?.oauth?.state ?? null) === "reauth_required",
    markReauth: () => markReauthRequired(name),
  };
  const endpoint = { tokenEndpoint: ctx.oauth.token_endpoint, clientId: ctx.oauth.client_id, resource: `${String(ctx.oauth.url).replace(/\/+$/, "")}/api/v1` };
  return freshAccess({ name, source, endpoint, lockPath: refreshLockPath(name), ...opts });
}
