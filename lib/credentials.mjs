import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Blocofy CLI credentials. `blocofy login` writes the platform URL + dev token to
 * `~/.blocofy/credentials.json` (0600); `blocofy theme dev` reads it. Environment
 * variables (BLOCOFY_URL/BLOCOFY_TOKEN) take precedence over the file (CI/agents).
 * The token is stored in plaintext on disk (the usual dev-CLI pattern), so the file
 * is locked down to 0600.
 *
 * 0.8.0: the same file also holds the v1 API pair `{ apiUrl, apiKey }` written by
 * `blocofy login --api-key`. The two pairs coexist: `saveCredentials(patch)` MERGES the
 * patch into the existing JSON (an unreadable/corrupt file counts as `{}`), so an API login
 * keeps the dev pair and a later dev login keeps the API pair. `loadCredentials()` (dev
 * pair) is unchanged; `loadApiCredentials()` resolves the v1 pair (BLOCOFY_API_KEY +
 * BLOCOFY_API_URL first, then the file).
 */

const DIR_NAME = ".blocofy";
const FILE_NAME = "credentials.json";

// Resolved per call (not at import): tests redirect HOME to a temp dir, and os.homedir()
// honours $HOME on POSIX.
function dir() {
  return join(homedir(), DIR_NAME);
}

export function credentialsPath() {
  return join(dir(), FILE_NAME);
}

function readExisting() {
  try {
    const data = JSON.parse(readFileSync(credentialsPath(), "utf8"));
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch {
    return {}; // missing/corrupt → start clean
  }
}

/** Merge `patch` into the credentials file and write it with 0600 permissions. */
export function saveCredentials(patch) {
  mkdirSync(dir(), { recursive: true, mode: 0o700 });
  const merged = { ...readExisting(), ...patch };
  writeFileSync(credentialsPath(), JSON.stringify(merged, null, 2) + "\n", { mode: 0o600 });
  chmodSync(credentialsPath(), 0o600); // create-mode is ignored if the file already exists → enforce it
}

/**
 * Resolve credentials: environment first (both vars), then the file. Returns
 * `{ url, token, source }` or null. Trailing slashes are stripped from the URL.
 */
export function loadCredentials() {
  const envUrl = process.env.BLOCOFY_URL;
  const envToken = process.env.BLOCOFY_TOKEN;
  if (envUrl && envToken) {
    return { url: stripSlash(envUrl), token: envToken, source: "env" };
  }
  const data = readExisting();
  if (typeof data.url === "string" && typeof data.token === "string") {
    return { url: stripSlash(data.url), token: data.token, source: "file" };
  }
  return null;
}

/**
 * Resolve the v1 API pair: BLOCOFY_API_KEY + BLOCOFY_API_URL (BOTH required — with only one
 * set this throws and does NOT fall through to the file, so a half-configured CI job fails
 * loudly instead of silently using a developer's file), then the file's `{ apiUrl, apiKey }`.
 * Returns `{ apiUrl, apiKey, source }` or null. The thrown message never contains the key.
 */
export function loadApiCredentials() {
  const envKey = process.env.BLOCOFY_API_KEY;
  const envUrl = process.env.BLOCOFY_API_URL;
  if (envKey && envUrl) {
    return { apiUrl: stripSlash(envUrl), apiKey: envKey, source: "env" };
  }
  if (envKey || envUrl) {
    const missing = envKey ? "BLOCOFY_API_URL" : "BLOCOFY_API_KEY";
    throw new Error(`${missing} is not set — BLOCOFY_API_KEY and BLOCOFY_API_URL must be set together (the credentials file is not consulted while either is set).`);
  }
  const data = readExisting();
  if (typeof data.apiUrl === "string" && typeof data.apiKey === "string") {
    return { apiUrl: stripSlash(data.apiUrl), apiKey: data.apiKey, source: "file" };
  }
  return null;
}

function stripSlash(url) {
  return url.replace(/\/+$/, "");
}
