import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * CF-T1 (contract C1) — where credential SECRETS live. `credentials.json` only records which store holds a
 * context's secret (`secret: { store: "file" | "keychain" | "dpapi" | "secret-service" }`); the value itself is in:
 *
 *   file      `~/.blocofy/secrets.json` (0600, atomic tmp+rename) `{ "<context>": { dev_token, api_key, oauth_tokens } }`.
 *   keychain  macOS Keychain via the `security` binary: service `blocofy-cli`, account `<context>:dev|api|oauth`.
 *             Opt-in for a pasted token (`BLOCOFY_SECRET_STORE=keychain` or `login --keychain`); other platforms → error.
 *
 * ADR-0014 §5.4 (wave P4) — the browser login's token set (kind `oauth`: one JSON string `{access_token,
 * refresh_token, expires_at}`) lives in the OS secure store by default (`oauthSecretStore`):
 *
 *   macOS    keychain        (above)
 *   Windows  dpapi           `%APPDATA%\blocofy\secrets.dpapi`: each value protected with DPAPI (user scope) by
 *                            PowerShell `ConvertFrom-SecureString`; the secret goes in on stdin, never argv
 *   Linux    secret-service  libsecret's `secret-tool` (stdin), when a DBus session is present
 *   any      file            only when chosen explicitly (`--insecure-storage` / `BLOCOFY_SECRET_STORE=file`) and
 *                            announced; an unavailable OS store is an error, never a silent plaintext downgrade
 *
 * Every store exposes `get(context, kind)`, `set(context, kind, value)`, `remove(context, kind?)` with kind
 * `dev|api|oauth`. No method ever puts a secret into an error message.
 */

export const KEYCHAIN_SERVICE = "blocofy-cli";
const FIELD = { dev: "dev_token", api: "api_key", oauth: "oauth_tokens" };
/** Every store name a context may record (`secret: { store }`). */
export const STORE_NAMES = ["file", "keychain", "dpapi", "secret-service"];

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
      // Review M6: `security -i` reads one command per line; a CR/LF/NUL in the secret would start a new command.
      if (/[\r\n\0]/.test(String(value)) || /[\r\n\0]/.test(account(context, kind))) {
        throw new SecretStoreError("SECRET_STORE_INVALID_SECRET", "The secret contains a line break or NUL character and cannot be stored in the macOS keychain. Nothing was saved.");
      }
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

const storeAccount = (context, kind) => `${context}:${kind}`;

/** Windows: the protect/unprotect scripts. The value travels on stdin both ways; argv carries only the script. */
const PS_PROTECT =
  "$s=[Console]::In.ReadToEnd(); $ss=ConvertTo-SecureString -String $s -AsPlainText -Force; [Console]::Out.Write((ConvertFrom-SecureString -SecureString $ss))";
const PS_UNPROTECT =
  "$e=[Console]::In.ReadToEnd().Trim(); $ss=ConvertTo-SecureString -String $e; $b=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($ss); " +
  "try { [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($b)) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }";
const powershell = (exec, script, input) => exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { input });

/** The DPAPI file's default place: `%APPDATA%\blocofy\secrets.dpapi` (user scope). */
export function dpapiPath(env = process.env) {
  return join(env.APPDATA || join(homedir(), "AppData", "Roaming"), "blocofy", "secrets.dpapi");
}

/**
 * Windows DPAPI adapter: the file maps `<context>:<kind>` to a DPAPI-protected blob (useless to another user or
 * machine). An unreadable blob is an error (SECRET_STORE_FAILED), never "not logged in".
 */
export function createDpapiSecretStore({ exec = defaultExec, platform = process.platform, filePath = dpapiPath() } = {}) {
  const ensure = () => {
    if (platform !== "win32") throw new SecretStoreError("SECRET_STORE_UNAVAILABLE", "The DPAPI secret store is only available on Windows.");
  };
  const readAll = () => {
    let raw;
    try {
      raw = readFileSync(filePath, "utf8");
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
    throw new SecretStoreError("CREDENTIALS_CORRUPT", `The protected secrets file is not valid JSON: ${filePath}. Nothing was written.`);
  };
  return {
    name: "dpapi",
    get(context, kind) {
      ensure();
      const blob = readAll()[storeAccount(context, kind)];
      if (typeof blob !== "string" || !blob) return null;
      const r = powershell(exec, PS_UNPROTECT, blob);
      if (r.status !== 0 || r.error) throw new SecretStoreError("SECRET_STORE_FAILED", `Could not read the secret from the Windows protected store (${filePath}); it was not used.`);
      return r.stdout || null;
    },
    set(context, kind, value) {
      ensure();
      const r = powershell(exec, PS_PROTECT, String(value));
      const blob = String(r.stdout ?? "").trim();
      if (r.status !== 0 || r.error || !blob) throw new SecretStoreError("SECRET_STORE_FAILED", "Could not protect the secret with Windows DPAPI. Nothing was saved.");
      const data = readAll();
      data[storeAccount(context, kind)] = blob;
      writeJsonAtomic(filePath, data);
    },
    remove(context, kind = null) {
      ensure();
      const data = readAll();
      let changed = false;
      for (const k of kind ? [kind] : Object.keys(FIELD)) {
        if (storeAccount(context, k) in data) {
          delete data[storeAccount(context, k)];
          changed = true;
        }
      }
      if (changed) writeJsonAtomic(filePath, data);
    },
  };
}

/** Linux Secret Service (libsecret) adapter through `secret-tool`; the secret goes in on stdin. */
export function createSecretServiceStore({ exec = defaultExec, platform = process.platform } = {}) {
  const ensure = () => {
    if (platform !== "linux") throw new SecretStoreError("SECRET_STORE_UNAVAILABLE", "The Secret Service store is only used on Linux.");
  };
  const attrs = (context, kind) => ["service", KEYCHAIN_SERVICE, "account", storeAccount(context, kind)];
  return {
    name: "secret-service",
    get(context, kind) {
      ensure();
      const r = exec("secret-tool", ["lookup", ...attrs(context, kind)]);
      if (r.error && r.error.code === "ENOENT") throw new SecretStoreError("SECRET_STORE_UNAVAILABLE", "`secret-tool` (libsecret) is not installed; the saved login cannot be read.");
      if (r.status !== 0) return null;
      const v = String(r.stdout ?? "").replace(/\r?\n$/, "");
      return v || null;
    },
    set(context, kind, value) {
      ensure();
      const r = exec("secret-tool", ["store", `--label=Blocofy CLI (${context})`, ...attrs(context, kind)], { input: String(value) });
      if (r.status !== 0 || r.error) throw new SecretStoreError("SECRET_STORE_FAILED", `Could not save the secret to the Secret Service (secret-tool exit ${r.status}). Nothing was saved.`);
    },
    remove(context, kind = null) {
      ensure();
      for (const k of kind ? [kind] : Object.keys(FIELD)) exec("secret-tool", ["clear", ...attrs(context, k)]);
    },
  };
}

/** `store` name → adapter. Unknown names are a usage error. */
export function secretStoreFor(name, { filePath, exec, platform, dpapiPath: dpapiFile } = {}) {
  if (name === "file") return createFileSecretStore(filePath);
  if (name === "keychain") return createKeychainSecretStore({ exec, platform });
  if (name === "dpapi") return createDpapiSecretStore({ exec, platform, ...(dpapiFile ? { filePath: dpapiFile } : {}) });
  if (name === "secret-service") return createSecretServiceStore({ exec, platform });
  throw new SecretStoreError("SECRET_STORE_UNAVAILABLE", `Unknown secret store "${name}" (use ${STORE_NAMES.map((n) => `"${n}"`).join(", ")}).`);
}

/** Where a store keeps secrets, in words (login output names it). */
export function storeLabel(name) {
  switch (name) {
    case "keychain":
      return "macOS Keychain";
    case "dpapi":
      return "Windows DPAPI-protected file (OS protected file)";
    case "secret-service":
      return "Linux Secret Service (libsecret)";
    case "file":
      return "plain file ~/.blocofy/secrets.json (0600) — chosen explicitly";
    default:
      return String(name);
  }
}

const OS_STORE = { darwin: "keychain", win32: "dpapi", linux: "secret-service" };

/** Is the Secret Service usable here? A DBus session and an installed `secret-tool`. */
function secretServiceAvailable(env, exec) {
  if (!env.DBUS_SESSION_BUS_ADDRESS) return false;
  const r = exec("secret-tool", ["--help"]);
  return !(r.error && r.error.code === "ENOENT");
}

/**
 * ADR-0014 §5.4 — the store for the browser login's tokens. `insecure` (`--insecure-storage`) or
 * `BLOCOFY_SECRET_STORE=file` choose the 0600 file (`explicit: true`; the caller announces it); another
 * `BLOCOFY_SECRET_STORE` value names an OS store, which must be this OS's. Otherwise this platform's OS store; none
 * available → SECRET_STORE_UNAVAILABLE (never a silent plaintext downgrade).
 */
export function oauthSecretStore({ platform = process.platform, env = process.env, insecure = false, exec = defaultExec } = {}) {
  const unavailable = (why) =>
    new SecretStoreError(
      "SECRET_STORE_UNAVAILABLE",
      `${why} The CLI login is never saved in a plain file automatically. To keep it in ~/.blocofy/secrets.json (0600) instead, choose that explicitly: blocofy login --insecure-storage (or BLOCOFY_SECRET_STORE=file). Nothing was saved.`,
    );
  const requested = env.BLOCOFY_SECRET_STORE;
  if (insecure || requested === "file") return { name: "file", explicit: true };
  if (requested !== undefined && requested !== "") {
    if (!STORE_NAMES.includes(requested)) throw unavailable(`BLOCOFY_SECRET_STORE="${requested}" is not a known store (${STORE_NAMES.join(", ")}).`);
    if (OS_STORE[platform] !== requested) throw unavailable(`The "${requested}" store is not available on this operating system (${platform}).`);
  }
  const name = OS_STORE[platform];
  if (!name) throw unavailable(`No OS secure store is supported on this operating system (${platform}).`);
  if (name === "secret-service" && !secretServiceAvailable(env, exec)) {
    throw unavailable("No Secret Service is available (it needs a desktop DBus session and `secret-tool` from libsecret).");
  }
  return { name, explicit: false };
}
