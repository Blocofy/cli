import { closeSync, existsSync, openSync, readFileSync, rmSync, statSync, writeFileSync, writeSync, chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { SecretStoreError, secretStoreFor, writeJsonAtomic } from "./secret-store.mjs";

/**
 * CF-T1 (contract C1) — Blocofy CLI credential store v2.
 *
 * `~/.blocofy/credentials.json` (0600, dir 0700, atomic tmp+rename) holds NAMED CONTEXTS and no secrets:
 *
 *   { "schema_version": 2, "current_context": "<name>|null",
 *     "contexts": { "<name>": { platform_origin, site: {id,slug,name,domain}|null,
 *                               dev: { url, secret: { store } }?, api: { url, secret: { store } }?, verified_at } } }
 *
 * Secrets live in a secret store (lib/secret-store.mjs): `~/.blocofy/secrets.json` by default, the macOS keychain
 * on opt-in. A pre-v2 flat file `{ url, token, apiUrl, apiKey }` is migrated losslessly on first read into
 * `contexts.default` (unverified, `site: null`); the original bytes are kept in `credentials.v1.bak.json`
 * (rollback: copy it back over credentials.json). A corrupt or half file is never rewritten: CREDENTIALS_CORRUPT.
 *
 * Environment variables form an ephemeral "env" context: BLOCOFY_URL+BLOCOFY_TOKEN and/or
 * BLOCOFY_API_URL+BLOCOFY_API_KEY. A half-set pair is a loud error (never a silent fall-through to the file).
 */

export const SCHEMA_VERSION = 2;
export const ENV_CONTEXT = "env";

/** A local credential problem (exit 1). Messages carry paths, never file content or secrets. */
export class CredentialsError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "CredentialsError";
    this.code = code;
    this.details = details;
    this.exitCode = 1;
  }
}

// Resolved per call (not at import): tests redirect HOME, and os.homedir() honours $HOME on POSIX.
const dir = () => join(homedir(), ".blocofy");
export const credentialsPath = () => join(dir(), "credentials.json");
export const secretsPath = () => join(dir(), "secrets.json");
export const backupPath = () => join(dir(), "credentials.v1.bak.json");

const stripSlash = (url) => String(url).replace(/\/+$/, "");
const isStr = (v) => typeof v === "string" && v.length > 0;
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

export const emptyStore = () => ({ schema_version: SCHEMA_VERSION, current_context: null, contexts: {} });

function corrupt(reason) {
  return new CredentialsError("CREDENTIALS_CORRUPT", `The credentials file cannot be used (${reason}): ${credentialsPath()}. Nothing was written. Fix or remove it, then run \`blocofy login\`.`, { path: credentialsPath() });
}

function validPair(pair) {
  return pair === undefined || (isObj(pair) && isStr(pair.url) && isObj(pair.secret) && (pair.secret.store === "file" || pair.secret.store === "keychain"));
}

function validV2(data) {
  if (data.schema_version !== SCHEMA_VERSION || !isObj(data.contexts)) return false;
  if (data.current_context !== null && data.current_context !== undefined && typeof data.current_context !== "string") return false;
  for (const ctx of Object.values(data.contexts)) {
    if (!isObj(ctx) || !validPair(ctx.dev) || !validPair(ctx.api)) return false;
    if (ctx.site !== null && ctx.site !== undefined && !(isObj(ctx.site) && (isStr(ctx.site.id) || Number.isFinite(ctx.site.id)))) return false;
  }
  return true;
}

/**
 * Read the store (migrating a v1 file). `{ secretStore }` options pass through to the secret adapters (tests).
 * A missing file is an empty store and is NOT created.
 */
export function loadStore(options = {}) {
  let raw;
  try {
    raw = readFileSync(credentialsPath(), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return emptyStore();
    throw new CredentialsError("CREDENTIALS_UNREADABLE", `Cannot read ${credentialsPath()} (${error?.code ?? "error"}).`, { path: credentialsPath() });
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw corrupt("not valid JSON");
  }
  if (!isObj(data)) throw corrupt("not a JSON object");
  if ("schema_version" in data) {
    if (!validV2(data)) throw corrupt("unexpected structure");
    return { schema_version: SCHEMA_VERSION, current_context: data.current_context ?? null, contexts: data.contexts };
  }
  return migrateV1(raw, data, options);
}

/** v1 `{url, token, apiUrl, apiKey}` → v2 `contexts.default`. Validates EVERYTHING before the first write. */
function migrateV1(raw, data, options) {
  const known = ["url", "token", "apiUrl", "apiKey"];
  if (Object.keys(data).length === 0) return emptyStore();
  for (const k of known) if (k in data && !isStr(data[k])) throw corrupt(`field "${k}" is not a string`);
  const hasDev = isStr(data.url) || isStr(data.token);
  const hasApi = isStr(data.apiUrl) || isStr(data.apiKey);
  if (hasDev && !(isStr(data.url) && isStr(data.token))) throw corrupt("the dev URL/token pair is incomplete");
  if (hasApi && !(isStr(data.apiUrl) && isStr(data.apiKey))) throw corrupt("the API URL/key pair is incomplete");
  if (!hasDev && !hasApi) throw corrupt("no credential pair found");

  const context = { platform_origin: null, site: null, verified_at: null };
  if (hasDev) context.dev = { url: stripSlash(data.url), secret: { store: "file" } };
  if (hasApi) context.api = { url: stripSlash(data.apiUrl), secret: { store: "file" } };
  const store = { schema_version: SCHEMA_VERSION, current_context: "default", contexts: { default: context } };

  // 1) exact-bytes backup (never overwrite an older, different backup)
  mkdirSync(dir(), { recursive: true, mode: 0o700 });
  let backup = backupPath();
  if (existsSync(backup) && readFileSync(backup, "utf8") !== raw) backup = join(dir(), `credentials.v1.bak.${Date.now()}.json`);
  if (!existsSync(backup)) {
    writeFileSync(backup, raw, { mode: 0o600 });
    chmodSync(backup, 0o600);
  }
  // 2) secrets, 3) the v2 file (a crash between steps re-runs an idempotent migration from the untouched v1 file)
  const secrets = secretStoreFor("file", { filePath: secretsPath(), ...options.secretStore });
  if (hasDev) secrets.set("default", "dev", data.token);
  if (hasApi) secrets.set("default", "api", data.apiKey);
  saveStore(store);
  return store;
}

const LOCK_STALE_MS = 10000;
const LOCK_WAIT_MS = 15000;
export const lockPath = () => join(dir(), ".lock");

/**
 * Review M5 — run the synchronous load-modify-save `fn` under an exclusive `~/.blocofy/.lock` (O_EXCL create), so two
 * concurrent logins/logouts cannot overwrite each other's context or secret. A lock older than 10 s is stale (a
 * crashed process) and is taken over; waiting longer than 15 s is CREDENTIALS_LOCKED.
 */
export function withStoreLock(fn) {
  mkdirSync(dir(), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + LOCK_WAIT_MS;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try {
      const fd = openSync(lockPath(), "wx", 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    try {
      if (Date.now() - statSync(lockPath()).mtimeMs > LOCK_STALE_MS) {
        rmSync(lockPath(), { force: true });
        continue;
      }
    } catch {
      continue; // released between the open and the stat
    }
    if (Date.now() > deadline) {
      throw new CredentialsError("CREDENTIALS_LOCKED", `Another blocofy command is updating ${credentialsPath()}. Nothing was written; try again (or remove ${lockPath()} if no blocofy command is running).`, { path: lockPath() });
    }
    Atomics.wait(pause, 0, 0, 20);
  }
  try {
    return fn();
  } finally {
    rmSync(lockPath(), { force: true });
  }
}

export function saveStore(store) {
  writeJsonAtomic(credentialsPath(), { schema_version: SCHEMA_VERSION, current_context: store.current_context ?? null, contexts: store.contexts });
}

/** The secret-store name for NEW secrets: `--keychain` flag or BLOCOFY_SECRET_STORE, default "file". */
export function defaultSecretStoreName({ keychain = false, env = process.env } = {}) {
  if (keychain) return "keychain";
  const v = env.BLOCOFY_SECRET_STORE;
  if (v === undefined || v === "" || v === "file") return "file";
  if (v === "keychain") return "keychain";
  throw new CredentialsError("SECRET_STORE_UNAVAILABLE", `BLOCOFY_SECRET_STORE must be "file" or "keychain".`);
}

export function openSecretStore(name, options = {}) {
  try {
    return secretStoreFor(name, { filePath: secretsPath(), ...options });
  } catch (error) {
    throw asCredentialsError(error);
  }
}

function asCredentialsError(error) {
  if (error instanceof SecretStoreError) return new CredentialsError(error.code, error.message);
  return error;
}

/** `{ devToken, apiKey }` for a stored context (null where the pair or its secret is absent). */
export function readSecrets(name, ctx, options = {}) {
  try {
    const get = (kind) => (ctx[kind] ? openSecretStore(ctx[kind].secret.store, options).get(name, kind) : null);
    return { devToken: get("dev"), apiKey: get("api") };
  } catch (error) {
    throw asCredentialsError(error);
  }
}

export function writeSecret(name, kind, storeName, value, options = {}) {
  try {
    openSecretStore(storeName, options).set(name, kind, value);
  } catch (error) {
    throw asCredentialsError(error);
  }
}

export function removeSecrets(name, ctx, options = {}) {
  for (const kind of ["dev", "api"]) {
    if (!ctx?.[kind]) continue;
    try {
      openSecretStore(ctx[kind].secret.store, options).remove(name, kind);
    } catch (error) {
      throw asCredentialsError(error);
    }
  }
}

/**
 * The ephemeral "env" context, or null when no variable is set. Half-set pairs throw (the message names the
 * missing variable only).
 */
export function envContext(env = process.env) {
  const pair = (urlVar, secretVar) => {
    const url = env[urlVar];
    const secret = env[secretVar];
    if (url && secret) return { url: stripSlash(url), secret };
    if (url || secret) {
      const missing = url ? secretVar : urlVar;
      throw new CredentialsError("ENV_CREDENTIALS_INCOMPLETE", `${missing} is not set — ${urlVar} and ${secretVar} must be set together (the credentials file is not consulted while either is set).`);
    }
    return null;
  };
  const dev = pair("BLOCOFY_URL", "BLOCOFY_TOKEN");
  const api = pair("BLOCOFY_API_URL", "BLOCOFY_API_KEY");
  if (!dev && !api) return null;
  return {
    name: ENV_CONTEXT,
    source: "env",
    context: { platform_origin: null, site: null, ...(dev ? { dev: { url: dev.url } } : {}), ...(api ? { api: { url: api.url } } : {}) },
    secrets: { devToken: dev?.secret ?? null, apiKey: api?.secret ?? null },
  };
}
