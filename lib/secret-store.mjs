import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";

/**
 * CF-T1 (contract C1) — where credential SECRETS live. `credentials.json` only records which store holds a
 * context's secret (`secret: { store: "file" | "keychain" }`); the value itself is in one of:
 *
 *   file      `~/.blocofy/secrets.json` (0600, atomic tmp+rename) `{ "<context>": { dev_token, api_key } }`.
 *   keychain  macOS Keychain via the `security` binary: service `blocofy-cli`, account `<context>:dev|api`.
 *             Opt-in only (`BLOCOFY_SECRET_STORE=keychain` or `login --keychain`); other platforms → error.
 *
 * Both stores expose `get(context, kind)`, `set(context, kind, value)`, `remove(context)` with kind `dev|api`.
 * No method ever puts a secret into an error message.
 */

export const KEYCHAIN_SERVICE = "blocofy-cli";
const FIELD = { dev: "dev_token", api: "api_key" };

export class SecretStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SecretStoreError";
    this.code = code;
  }
}

/** Atomic JSON write (unique tmp in the same dir + rename) with 0600 permissions. */
export function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700); // an older, looser directory is tightened too
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export function createFileSecretStore(path) {
  const read = () => {
    let raw;
    try {
      raw = readFileSync(path, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return {};
      throw error;
    }
    try {
      const data = JSON.parse(raw);
      if (data && typeof data === "object" && !Array.isArray(data)) return data;
    } catch {
      /* fall through */
    }
    throw new SecretStoreError("CREDENTIALS_CORRUPT", `The secrets file is not valid JSON: ${path}. Nothing was written.`);
  };
  return {
    name: "file",
    get(context, kind) {
      const v = read()[context]?.[FIELD[kind]];
      return typeof v === "string" && v ? v : null;
    },
    set(context, kind, value) {
      const data = read();
      data[context] = { ...(data[context] ?? {}), [FIELD[kind]]: value };
      writeJsonAtomic(path, data);
    },
    remove(context, kind = null) {
      const data = read();
      if (!(context in data)) return;
      if (kind) {
        delete data[context][FIELD[kind]];
        if (Object.keys(data[context]).length === 0) delete data[context];
      } else {
        delete data[context];
      }
      writeJsonAtomic(path, data);
    },
  };
}

/** Default exec: `spawnSync` with the secret-bearing command on STDIN (never argv — argv is visible in `ps`). */
export function defaultExec(command, args, { input } = {}) {
  const r = spawnSync(command, args, { input, encoding: "utf8" });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "", error: r.error ?? null };
}

const quote = (s) => `"${String(s).replace(/["\\]/g, (c) => `\\${c}`)}"`;

/**
 * macOS Keychain adapter. `exec(command, args, { input })` is injectable so tests never touch a real keychain.
 * Writes go through `security -i` (commands read from stdin) so the secret is not in the process argv.
 */
export function createKeychainSecretStore({ exec = defaultExec, platform = process.platform } = {}) {
  const ensure = () => {
    if (platform !== "darwin") {
      throw new SecretStoreError("SECRET_STORE_UNAVAILABLE", "The keychain secret store is only available on macOS. Use the default file store (unset BLOCOFY_SECRET_STORE, omit --keychain).");
    }
  };
  const account = (context, kind) => `${context}:${kind}`;
  return {
    name: "keychain",
    get(context, kind) {
      ensure();
      const r = exec("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account(context, kind), "-w"]);
      if (r.status !== 0) return null;
      const v = r.stdout.replace(/\r?\n$/, "");
      return v || null;
    },
    set(context, kind, value) {
      ensure();
      const input = `add-generic-password -U -s ${quote(KEYCHAIN_SERVICE)} -a ${quote(account(context, kind))} -w ${quote(value)}\n`;
      const r = exec("security", ["-i"], { input });
      if (r.status !== 0) throw new SecretStoreError("SECRET_STORE_FAILED", `Could not save the secret to the macOS keychain (security exit ${r.status}). Nothing was saved.`);
    },
    remove(context, kind = null) {
      ensure();
      for (const k of kind ? [kind] : ["dev", "api"]) {
        exec("security", ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account(context, k)]);
      }
    },
  };
}

/** `store` name → adapter. Unknown names are a usage error. */
export function secretStoreFor(name, { filePath, exec, platform } = {}) {
  if (name === "file") return createFileSecretStore(filePath);
  if (name === "keychain") return createKeychainSecretStore({ exec, platform });
  throw new SecretStoreError("SECRET_STORE_UNAVAILABLE", `Unknown secret store "${name}" (use "file" or "keychain").`);
}
