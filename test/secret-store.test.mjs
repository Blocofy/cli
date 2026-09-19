import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { KEYCHAIN_SERVICE, createFileSecretStore, createKeychainSecretStore } from "../lib/secret-store.mjs";

/** CF-T1 (contract C1) — secret store adapters. The keychain adapter runs only against an injected exec. */

const CANARY = "blcf_live_CANARY7f3a9c2e1b5d4e6f8a0b1c2d3e4f5a6b";
const home = mkdtempSync(join(tmpdir(), "blocofy-secrets-"));
after(() => rmSync(home, { recursive: true, force: true }));
const mode = (p) => statSync(p).mode & 0o777;
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

// ── secret stores ──────────────────────────────────────────────────────────────────────────────────────────

test("file secret store: set/get/remove per context and kind; 0600", () => {
  const path = join(home, ".blocofy", "secrets.json");
  const store = createFileSecretStore(path);
  store.set("a", "dev", "t1");
  store.set("a", "api", "k1");
  store.set("b", "dev", "t2");
  assert.equal(mode(path), 0o600);
  assert.equal(store.get("a", "api"), "k1");
  store.remove("a", "api");
  assert.equal(store.get("a", "api"), null);
  assert.equal(store.get("a", "dev"), "t1");
  store.remove("a");
  assert.deepEqual(readJson(path), { b: { dev_token: "t2" } });
});

test("keychain adapter (injected exec): secret goes via stdin to `security -i`, never argv; get/remove shapes", () => {
  const calls = [];
  const exec = (command, args, opts = {}) => {
    calls.push({ command, args, input: opts.input ?? null });
    if (args[0] === "find-generic-password") return { status: 0, stdout: `${CANARY}\n`, stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  };
  const kc = createKeychainSecretStore({ exec, platform: "darwin" });
  kc.set("shop", "api", CANARY);
  assert.equal(calls[0].command, "security");
  assert.deepEqual(calls[0].args, ["-i"]);
  assert.ok(calls[0].input.includes(CANARY));
  assert.ok(calls[0].input.includes(`-s "${KEYCHAIN_SERVICE}"`) && calls[0].input.includes('-a "shop:api"'));
  assert.ok(calls.every((c) => !c.args.some((a) => a.includes(CANARY))), "secret in argv");
  assert.equal(kc.get("shop", "api"), CANARY);
  assert.deepEqual(calls[1].args, ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", "shop:api", "-w"]);
  kc.remove("shop");
  assert.deepEqual(calls.slice(2).map((c) => c.args.slice(0, 5)), [
    ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", "shop:dev"],
    ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", "shop:api"],
  ]);
});

test("keychain adapter: a failed write throws without the secret; a missing item reads as null; non-macOS is refused", () => {
  const failing = createKeychainSecretStore({ exec: () => ({ status: 45, stdout: "", stderr: "" }), platform: "darwin" });
  assert.throws(() => failing.set("a", "dev", CANARY), (e) => e.code === "SECRET_STORE_FAILED" && !e.message.includes(CANARY));
  assert.equal(failing.get("a", "dev"), null);
  let called = false;
  const linux = createKeychainSecretStore({ exec: () => ((called = true), { status: 0, stdout: "", stderr: "" }), platform: "linux" });
  assert.throws(() => linux.get("a", "dev"), (e) => e.code === "SECRET_STORE_UNAVAILABLE");
  assert.equal(called, false);
});

test("review M6: keychain set refuses a secret containing CR, LF or NUL before running `security -i` (no command injection); message has no secret", () => {
  for (const bad of ["bcf_abc\ndelete-generic-password -s blocofy-cli", "bcf_abc\rx", "bcf_abc\0x"]) {
    const calls = [];
    const store = createKeychainSecretStore({ platform: "darwin", exec: (command, args, opts) => (calls.push({ command, args, opts }), { status: 0, stdout: "", stderr: "" }) });
    assert.throws(() => store.set("ctx", "dev", bad), (e) => e.code === "SECRET_STORE_INVALID_SECRET" && !e.message.includes("bcf_abc"));
    assert.equal(calls.length, 0, "security was invoked with a multi-line secret");
  }
});
