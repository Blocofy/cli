import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Blocofy CLI credentials. `blocofy login` writes the platform URL + dev token to
 * `~/.blocofy/credentials.json` (0600); `blocofy theme dev` reads it. Environment
 * variables (BLOCOFY_URL/BLOCOFY_TOKEN) take precedence over the file (CI/agents).
 * The token is stored in plaintext on disk (the usual dev-CLI pattern), so the file
 * is locked down to 0600.
 */

const DIR = join(homedir(), ".blocofy");
const FILE = join(DIR, "credentials.json");

export function credentialsPath() {
  return FILE;
}

/** Write URL + token with 0600 permissions. */
export function saveCredentials({ url, token }) {
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  writeFileSync(FILE, JSON.stringify({ url, token }, null, 2) + "\n", { mode: 0o600 });
  chmodSync(FILE, 0o600); // create-mode is ignored if the file already exists → enforce it
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
  try {
    const data = JSON.parse(readFileSync(FILE, "utf8"));
    if (data && typeof data.url === "string" && typeof data.token === "string") {
      return { url: stripSlash(data.url), token: data.token, source: "file" };
    }
  } catch {
    // missing/corrupt file → null
  }
  return null;
}

function stripSlash(url) {
  return url.replace(/\/+$/, "");
}
