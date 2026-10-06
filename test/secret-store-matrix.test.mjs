import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import {
  KEYCHAIN_SERVICE,
  createDpapiSecretStore,
  createKeychainSecretStore,
  createSecretServiceStore,
  oauthSecretStore,
  secretStoreFor,
  storeLabel,
} from "../lib/secret-store.mjs";

/**
 * ADR-0014 §5.4 (wave P4) — the secure-store matrix for the CLI login's tokens. Every OS adapter runs against an
 * injected exec (no real keychain / DPAPI / Secret Service is touched); the secret never reaches argv.
 */

const SECRET = JSON.stringify({ access_token: "blcf_ct_CANARYaccess.sig", refresh_token: "blcf_rt_CANARYrefresh", expires_at: 1 });
const home = mkdtempSync(join(tmpdir(), "blocofy-store-matrix-"));
after(() => rmSync(home, { recursive: true, force: true }));
const noSecretInArgv = (calls) => assert.ok(calls.every((c) => !c.args.some((a) => String(a).includes("CANARY"))), "secret in argv");

test("matrix: auto picks the OS store — macOS Keychain, Windows DPAPI file, Linux Secret Service", () => {
  const exec = () => ({ status: 0, stdout: "", stderr: "", error: null });
  assert.equal(oauthSecretStore({ platform: "darwin", env: {}, exec }).name, "keychain");
  assert.equal(oauthSecretStore({ platform: "win32", env: { APPDATA: home }, exec }).name, "dpapi");
  assert.equal(oauthSecretStore({ platform: "linux", env: { DBUS_SESSION_BUS_ADDRESS: "unix:path=/x" }, exec }).name, "secret-service");
});

test("matrix: no OS store available → refused, never a silent plaintext downgrade", () => {
  const missingTool = () => ({ status: null, stdout: "", stderr: "", error: Object.assign(new Error("spawn"), { code: "ENOENT" }) });
  // Linux without a DBus session, Linux without secret-tool, an unknown platform.
  for (const [platform, env, exec] of [
    ["linux", {}, () => ({ status: 0, stdout: "", stderr: "", error: null })],
    ["linux", { DBUS_SESSION_BUS_ADDRESS: "unix:path=/x" }, missingTool],
    ["freebsd", {}, () => ({ status: 0, stdout: "", stderr: "", error: null })],
  ]) {
    assert.throws(
      () => oauthSecretStore({ platform, env, exec }),
      (e) => e.code === "SECRET_STORE_UNAVAILABLE" && /--insecure-storage/.test(e.message),
      `${platform} must refuse`,
    );
  }
});

test("matrix: the 0600 file only on an explicit choice (--insecure-storage or BLOCOFY_SECRET_STORE=file), and it is announced", () => {
  const exec = () => ({ status: 0, stdout: "", stderr: "", error: null });
  const flag = oauthSecretStore({ platform: "darwin", env: {}, insecure: true, exec });
  assert.equal(flag.name, "file");
  assert.equal(flag.explicit, true);
  const env = oauthSecretStore({ platform: "linux", env: { BLOCOFY_SECRET_STORE: "file" }, exec });
  assert.equal(env.name, "file");
  assert.match(storeLabel("file"), /0600/);
  assert.match(storeLabel("keychain"), /Keychain/);
  assert.match(storeLabel("dpapi"), /DPAPI/);
  assert.match(storeLabel("secret-service"), /Secret Service/);
  // An explicit OS store on the wrong OS is refused, not downgraded.
  assert.throws(() => oauthSecretStore({ platform: "linux", env: { BLOCOFY_SECRET_STORE: "keychain" }, exec }), (e) => e.code === "SECRET_STORE_UNAVAILABLE");
  assert.throws(() => oauthSecretStore({ platform: "darwin", env: { BLOCOFY_SECRET_STORE: "nope" }, exec }), (e) => e.code === "SECRET_STORE_UNAVAILABLE");
});

test("keychain adapter holds the login's token set under <context>:oauth (stdin, never argv)", () => {
  const calls = [];
  const kc = createKeychainSecretStore({
    platform: "darwin",
    exec: (command, args, opts = {}) => {
      calls.push({ command, args, input: opts.input ?? null });
      return args[0] === "find-generic-password" ? { status: 0, stdout: `${SECRET}\n`, stderr: "" } : { status: 0, stdout: "", stderr: "" };
    },
  });
  kc.set("shop", "oauth", SECRET);
  assert.ok(calls[0].input.includes('-a "shop:oauth"') && calls[0].input.includes(`-s "${KEYCHAIN_SERVICE}"`));
  assert.equal(kc.get("shop", "oauth"), SECRET);
  kc.remove("shop", "oauth");
  assert.deepEqual(calls.at(-1).args.slice(0, 5), ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", "shop:oauth"]);
  noSecretInArgv(calls);
});

test("Windows DPAPI adapter: PowerShell protects via stdin; the file holds only the protected blob", () => {
  const calls = [];
  // A stand-in for DPAPI: a reversible transform, so the test can prove the file never holds the plaintext.
  const protect = (s) => Buffer.from(s, "utf8").toString("hex");
  const unprotect = (h) => Buffer.from(h.trim(), "hex").toString("utf8");
  const exec = (command, args, opts = {}) => {
    calls.push({ command, args, input: opts.input ?? null });
    const script = args.at(-1);
    if (/ConvertFrom-SecureString/.test(script)) return { status: 0, stdout: protect(opts.input), stderr: "", error: null };
    if (/SecureStringToBSTR/.test(script)) return { status: 0, stdout: unprotect(opts.input), stderr: "", error: null };
    return { status: 1, stdout: "", stderr: "", error: null };
  };
  const path = join(home, "blocofy", "secrets.dpapi");
  const store = createDpapiSecretStore({ exec, platform: "win32", filePath: path });
  store.set("shop", "oauth", SECRET);
  assert.equal(calls[0].command, "powershell.exe");
  assert.equal(calls[0].input, SECRET);
  const raw = readFileSync(path, "utf8");
  assert.ok(!raw.includes("CANARY"), "plaintext in the DPAPI file");
  assert.equal(store.get("shop", "oauth"), SECRET);
  assert.equal(store.get("shop", "dev"), null);
  store.remove("shop", "oauth");
  assert.equal(store.get("shop", "oauth"), null);
  noSecretInArgv(calls);
  // A failed protect throws without the secret and writes nothing new.
  const failing = createDpapiSecretStore({ exec: () => ({ status: 1, stdout: "", stderr: "x", error: null }), platform: "win32", filePath: join(home, "x", "secrets.dpapi") });
  assert.throws(() => failing.set("a", "oauth", SECRET), (e) => e.code === "SECRET_STORE_FAILED" && !e.message.includes("CANARY"));
  assert.equal(existsSync(join(home, "x", "secrets.dpapi")), false);
  // An unreadable stored value is an error, not "logged out" and not a fallback.
  const broken = createDpapiSecretStore({ exec: (c, a, o) => (/SecureStringToBSTR/.test(a.at(-1)) ? { status: 1, stdout: "", stderr: "", error: null } : exec(c, a, o)), platform: "win32", filePath: path });
  broken.set("z", "oauth", SECRET);
  assert.throws(() => broken.get("z", "oauth"), (e) => e.code === "SECRET_STORE_FAILED");
  assert.throws(() => createDpapiSecretStore({ exec, platform: "linux", filePath: path }).get("a", "oauth"), (e) => e.code === "SECRET_STORE_UNAVAILABLE");
});

test("Linux Secret Service adapter: secret-tool store reads the secret from stdin; lookup/clear by attributes", () => {
  const calls = [];
  const exec = (command, args, opts = {}) => {
    calls.push({ command, args, input: opts.input ?? null });
    if (args[0] === "lookup") return { status: 0, stdout: SECRET, stderr: "", error: null };
    return { status: 0, stdout: "", stderr: "", error: null };
  };
  const ss = createSecretServiceStore({ exec, platform: "linux" });
  ss.set("shop", "oauth", SECRET);
  assert.equal(calls[0].command, "secret-tool");
  assert.deepEqual(calls[0].args, ["store", "--label=Blocofy CLI (shop)", "service", KEYCHAIN_SERVICE, "account", "shop:oauth"]);
  assert.equal(calls[0].input, SECRET);
  assert.equal(ss.get("shop", "oauth"), SECRET);
  assert.deepEqual(calls[1].args, ["lookup", "service", KEYCHAIN_SERVICE, "account", "shop:oauth"]);
  ss.remove("shop", "oauth");
  assert.deepEqual(calls[2].args, ["clear", "service", KEYCHAIN_SERVICE, "account", "shop:oauth"]);
  noSecretInArgv(calls);
  const missing = createSecretServiceStore({ exec: () => ({ status: 1, stdout: "", stderr: "", error: null }), platform: "linux" });
  assert.equal(missing.get("a", "oauth"), null);
  assert.throws(() => missing.set("a", "oauth", SECRET), (e) => e.code === "SECRET_STORE_FAILED" && !e.message.includes("CANARY"));
});

test("secretStoreFor names every store; an unknown name is refused", () => {
  const exec = () => ({ status: 0, stdout: "", stderr: "", error: null });
  assert.equal(secretStoreFor("dpapi", { exec, platform: "win32", dpapiPath: join(home, "d.dpapi") }).name, "dpapi");
  assert.equal(secretStoreFor("secret-service", { exec, platform: "linux" }).name, "secret-service");
  assert.throws(() => secretStoreFor("plaintext-elsewhere", {}), (e) => e.code === "SECRET_STORE_UNAVAILABLE");
});
