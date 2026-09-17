import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import { CredentialsError, backupPath, credentialsPath, envContext, loadStore, readSecrets, saveStore, secretsPath, writeSecret } from "../lib/credentials.mjs";
import { promptSecret } from "../lib/secret-prompt.mjs";

/**
 * CF-T1 (contract C1) — credential store v2: named contexts, secrets outside credentials.json, lossless v1
 * migration, CREDENTIALS_CORRUPT, env context, secret stores. Supersedes the 0.8.0 flat-file L5–L11 arms (the
 * flat file no longer exists; coexistence of the dev and API pairs is now "two pairs in one context").
 *
 * `HOME` points at a temp dir; child processes run with piped stdin (non-TTY).
 */

const root = fileURLToPath(new URL("..", import.meta.url));
const BIN = join(root, "bin", "blocofy.mjs");

const CANARY = "blcf_live_CANARY7f3a9c2e1b5d4e6f8a0b1c2d3e4f5a6b";
const DEV = { url: "https://store.example.com", token: "bcf_devtoken_0123456789abcdef" };
const API = { apiUrl: "https://app.blocofy.com", apiKey: "blcf_live_filekey0123456789abcdef" };

const ENV_KEYS = ["HOME", "BLOCOFY_URL", "BLOCOFY_TOKEN", "BLOCOFY_API_KEY", "BLOCOFY_API_URL", "BLOCOFY_CONTEXT", "BLOCOFY_SECRET_STORE"];
let home;
let saved;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "blocofy-cred-"));
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.HOME = home;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(home, { recursive: true, force: true });
});

const mode = (p) => statSync(p).mode & 0o777;
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

function writeRaw(content) {
  mkdirSync(dirname(credentialsPath()), { recursive: true });
  writeFileSync(credentialsPath(), typeof content === "string" ? content : JSON.stringify(content));
}

function runCli(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { cwd: home, env: { PATH: process.env.PATH, HOME: home, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.stdin.end();
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/** Fake platform answering whoami (dev token) + ping (API key) for one site. */
async function fakeSite({ id = "s1", slug = "shop", token = DEV.token, apiKey = null, whoamiStatus = 200 } = {}) {
  const reqs = [];
  const server = createServer((req, res) => {
    reqs.push(`${req.method} ${req.url}`);
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const site = { id, slug, name: "Shop" };
    if (req.url === "/api/dev/whoami" && req.headers.authorization === `Bearer ${token}`) return whoamiStatus === 200 ? send(200, { site, liveThemeId: null }) : send(whoamiStatus, { error: "down" });
    if (req.url === "/api/v1/ping" && apiKey && req.headers.authorization === `Bearer ${apiKey}`) return send(200, { ok: true, site });
    if (req.url === "/api/dev/site") return send(200, { site: { slug }, drafts: [], health: "ok", live_theme_instance: null });
    send(401, { error: "unauthorized" });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { url: `http://127.0.0.1:${server.address().port}`, reqs, close: () => new Promise((r) => server.close(r)) };
}

// ── migration ────────────────────────────────────────────────────────────────────────────────────────────────

test("v1 → v2 migration is lossless: contexts.default (unverified), secrets moved, exact-bytes backup, all 0600", () => {
  const raw = JSON.stringify({ ...DEV, ...API }, null, 2);
  writeRaw(raw);
  const store = loadStore();
  assert.equal(store.schema_version, 2);
  assert.equal(store.current_context, "default");
  assert.deepEqual(store.contexts.default, {
    platform_origin: null,
    site: null,
    verified_at: null,
    dev: { url: DEV.url, secret: { store: "file" } },
    api: { url: API.apiUrl, secret: { store: "file" } },
  });
  assert.equal(readFileSync(backupPath(), "utf8"), raw, "backup bytes equal the original file");
  const onDisk = readFileSync(credentialsPath(), "utf8");
  assert.ok(!onDisk.includes(DEV.token) && !onDisk.includes(API.apiKey), "credentials.json holds no secret");
  assert.deepEqual(readJson(secretsPath()), { default: { dev_token: DEV.token, api_key: API.apiKey } });
  assert.deepEqual(readSecrets("default", store.contexts.default), { devToken: DEV.token, apiKey: API.apiKey });
  for (const p of [credentialsPath(), secretsPath(), backupPath()]) assert.equal(mode(p), 0o600, p);
  // Idempotent: a second read sees v2 and changes nothing.
  assert.deepEqual(loadStore(), store);
  assert.equal(readFileSync(credentialsPath(), "utf8"), onDisk);
});

test("v1 dev-only file migrates to a context with only the dev pair", () => {
  writeRaw(DEV);
  const store = loadStore();
  assert.deepEqual(Object.keys(store.contexts), ["default"]);
  assert.equal(store.contexts.default.api, undefined);
  assert.deepEqual(readSecrets("default", store.contexts.default), { devToken: DEV.token, apiKey: null });
});

for (const [label, content] of [
  ["invalid JSON", "{not json"],
  ["half dev pair (url without token)", JSON.stringify({ url: DEV.url })],
  ["half API pair (key without url)", JSON.stringify({ ...DEV, apiKey: API.apiKey })],
  ["non-string token", JSON.stringify({ url: DEV.url, token: 42 })],
  ["v2 with a broken context", JSON.stringify({ schema_version: 2, contexts: { a: { dev: { url: 1 } } } })],
  ["JSON array", "[]"],
]) {
  test(`CREDENTIALS_CORRUPT (${label}): nothing written, bytes unchanged, message has the path and no content`, () => {
    writeRaw(content);
    let error;
    try {
      loadStore();
    } catch (e) {
      error = e;
    }
    assert.ok(error instanceof CredentialsError, String(error));
    assert.equal(error.code, "CREDENTIALS_CORRUPT");
    assert.equal(error.exitCode, 1);
    assert.ok(error.message.includes(credentialsPath()));
    assert.ok(!error.message.includes(DEV.url) && !error.message.includes(API.apiKey));
    assert.equal(readFileSync(credentialsPath(), "utf8"), content);
    assert.equal(existsSync(backupPath()), false);
    assert.equal(existsSync(secretsPath()), false);
  });
}

test("a missing file is an empty store and is not created; `{}` likewise", () => {
  assert.deepEqual(loadStore().contexts, {});
  assert.equal(existsSync(credentialsPath()), false);
  writeRaw("{}");
  assert.deepEqual(loadStore().contexts, {});
  assert.equal(readFileSync(credentialsPath(), "utf8"), "{}");
});

test("saveStore writes atomically with 0600 file / 0700 dir and no tmp leftovers", () => {
  saveStore({ current_context: null, contexts: {} });
  assert.equal(mode(credentialsPath()), 0o600);
  assert.equal(mode(dirname(credentialsPath())), 0o700);
  writeSecret("a", "dev", "file", DEV.token);
  assert.equal(mode(secretsPath()), 0o600);
  const leftovers = readdirSync(dirname(credentialsPath())).filter((n) => n.endsWith(".tmp"));
  assert.deepEqual(leftovers, []);
});


// ── env context ─────────────────────────────────────────────────────────────────────────────────────────────

test("env context: full pairs form the ephemeral 'env' context; half-set pairs throw naming the missing variable only", () => {
  assert.equal(envContext({}), null);
  const both = envContext({ BLOCOFY_URL: "https://x.test/", BLOCOFY_TOKEN: DEV.token, BLOCOFY_API_URL: API.apiUrl, BLOCOFY_API_KEY: API.apiKey });
  assert.equal(both.name, "env");
  assert.equal(both.context.dev.url, "https://x.test");
  assert.deepEqual(both.secrets, { devToken: DEV.token, apiKey: API.apiKey });
  assert.throws(() => envContext({ BLOCOFY_API_KEY: CANARY }), (e) => e.code === "ENV_CREDENTIALS_INCOMPLETE" && /BLOCOFY_API_URL/.test(e.message) && !e.message.includes(CANARY));
  assert.throws(() => envContext({ BLOCOFY_API_URL: API.apiUrl }), /BLOCOFY_API_KEY/);
  assert.throws(() => envContext({ BLOCOFY_TOKEN: DEV.token }), (e) => /BLOCOFY_URL/.test(e.message) && !e.message.includes(DEV.token));
});

// ── CLI login / contexts ───────────────────────────────────────────────────────────────────────────────────

test("login (dev): whoami verified → context named after the site slug; secret only in secrets.json", async () => {
  const s = await fakeSite();
  try {
    const r = await runCli(["login", "--url", s.url, "--token", DEV.token]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Site:\s*Shop \(shop\)/);
    assert.ok(!(r.stdout + r.stderr).includes(DEV.token));
    const store = readJson(credentialsPath());
    assert.equal(store.current_context, "shop");
    assert.deepEqual(store.contexts.shop.site, { id: "s1", slug: "shop", name: "Shop", domain: null });
    assert.ok(!readFileSync(credentialsPath(), "utf8").includes(DEV.token));
    assert.equal(readJson(secretsPath()).shop.dev_token, DEV.token);
  } finally {
    await s.close();
  }
});

test("login (dev): whoami failure → TARGET_UNVERIFIED, exit 3, nothing saved", async () => {
  const s = await fakeSite({ whoamiStatus: 503 });
  try {
    const r = await runCli(["login", "--url", s.url, "--token", DEV.token, "--json"]);
    assert.equal(r.code, 3, r.stderr);
    assert.equal(JSON.parse(r.stderr.trim().split("\n").pop()).error.code, "TARGET_UNVERIFIED");
    assert.equal(existsSync(credentialsPath()), false);
    assert.equal(existsSync(secretsPath()), false);
  } finally {
    await s.close();
  }
});

test("login --api-key (non-TTY, env key): ping verified, key saved into the same-site context next to the dev pair; canary never printed", async () => {
  const s = await fakeSite({ apiKey: CANARY });
  try {
    assert.equal((await runCli(["login", "--url", s.url, "--token", DEV.token])).code, 0);
    const r = await runCli(["login", "--api-key"], { BLOCOFY_API_KEY: CANARY, BLOCOFY_API_URL: s.url });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!(r.stdout + r.stderr).includes("CANARY7f3a"), "canary fragment leaked");
    assert.match(r.stdout, /API key saved to context "shop"/);
    const ctx = readJson(credentialsPath()).contexts.shop;
    assert.equal(ctx.dev.url, s.url, "the dev pair is kept");
    assert.equal(ctx.api.url, s.url);
    assert.deepEqual(readJson(secretsPath()).shop, { dev_token: DEV.token, api_key: CANARY });
  } finally {
    await s.close();
  }
});

test("login --api-key <value> is REFUSED; the argv canary is not echoed; nothing written", async () => {
  const r = await runCli(["login", "--api-key", CANARY]);
  assert.equal(r.code, 1);
  assert.ok(!r.stdout.includes(CANARY) && !r.stderr.includes(CANARY), "canary leaked to output");
  assert.match(r.stderr, /takes no value|Nothing was written/);
  assert.equal(existsSync(credentialsPath()), false);
});

test("--help and an unreachable identity endpoint never print the key (unreachable → TARGET_UNVERIFIED, exit 3)", async () => {
  const help = await runCli(["--help"], { BLOCOFY_API_KEY: CANARY, BLOCOFY_API_URL: "https://app.blocofy.com" });
  assert.equal(help.code, 0);
  assert.ok(!(help.stdout + help.stderr).includes(CANARY));
  const err = await runCli(["pages", "media-uses", "pg_1", "--json"], { BLOCOFY_API_KEY: CANARY, BLOCOFY_API_URL: "http://127.0.0.1:9" });
  assert.equal(err.code, 3);
  assert.equal(JSON.parse(err.stderr.trim().split("\n").pop()).error.code, "TARGET_UNVERIFIED");
  assert.match(err.stderr, /Network error .* retrying .*\(3\/3\)/, "the unreachable identity endpoint was retried (CF-T3)");
  assert.ok(!(err.stdout + err.stderr).includes(CANARY), "canary leaked on network error");
});

test("non-TTY + no env → login --api-key exit 1, nothing written; a bcf_ token is not a v1 key", async () => {
  const r = await runCli(["login", "--api-key"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /BLOCOFY_API_KEY/);
  const d = await runCli(["login", "--api-key"], { BLOCOFY_API_KEY: DEV.token, BLOCOFY_API_URL: "https://app.blocofy.com" });
  assert.equal(d.code, 1);
  assert.match(d.stderr, /blcf_live_/);
  assert.ok(!d.stderr.includes(DEV.token));
  assert.equal(existsSync(credentialsPath()), false);
});

test("a migrated (unverified) v1 context gets its site recorded on the first successful whoami", async () => {
  const s = await fakeSite({ id: "s9", slug: "legacy" });
  try {
    writeRaw({ url: s.url, token: DEV.token });
    const r = await runCli(["status"]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /Context:\s+default/);
    const ctx = readJson(credentialsPath()).contexts.default;
    assert.equal(ctx.site.id, "s9");
    assert.ok(ctx.verified_at);
    const list = await runCli(["contexts", "--json"]);
    assert.equal(list.code, 0, list.stderr);
    assert.ok(!list.stdout.includes(DEV.token));
    assert.equal(JSON.parse(list.stdout).contexts[0].site.slug, "legacy");
  } finally {
    await s.close();
  }
});

test("use / logout: `use` sets current_context; logout removes the context and its secrets", async () => {
  const s = await fakeSite();
  try {
    await runCli(["login", "--url", s.url, "--token", DEV.token, "--context", "one"]);
    await runCli(["login", "--url", s.url, "--token", DEV.token, "--context", "two"]);
    assert.equal(readJson(credentialsPath()).current_context, "one");
    assert.equal((await runCli(["use", "two"])).code, 0);
    assert.equal(readJson(credentialsPath()).current_context, "two");
    assert.equal((await runCli(["use", "nope"])).code, 3);
    assert.equal((await runCli(["logout", "--context", "two"])).code, 0);
    const store = readJson(credentialsPath());
    assert.deepEqual(Object.keys(store.contexts), ["one"]);
    assert.equal(store.current_context, null);
    assert.deepEqual(Object.keys(readJson(secretsPath())), ["one"]);
  } finally {
    await s.close();
  }
});

// ── lib/secret-prompt.mjs ───────────────────────────────────────────────────────────────────────────────────

/** Sahte TTY: isTTY + setRawMode; yazılanlar `written`'a düşer, tuşlar `feed` ile beslenir. */
function fakeTty() {
  const input = new EventEmitter();
  input.isTTY = true;
  input.rawModes = [];
  input.setRawMode = (on) => input.rawModes.push(on);
  input.resume = () => {};
  input.pause = () => {};
  input.setEncoding = () => {};
  const output = { written: "", write: (s) => (output.written += s) };
  return { input, output };
}

test("promptSecret: non-TTY stdin → null, hiçbir şey okunmaz", async () => {
  const input = new EventEmitter();
  input.isTTY = false;
  const output = { written: "", write: (s) => (output.written += s) };
  assert.equal(await promptSecret("API key: ", { input, output }), null);
  assert.equal(output.written, "");
});

test("promptSecret: TTY'de raw mode ile okur, echo ETMEZ, backspace işler, Enter'da biter", async () => {
  const { input, output } = fakeTty();
  const p = promptSecret("API key: ", { input, output });
  input.emit("data", "blcf_");
  input.emit("data", "x"); // yanlış tuş + backspace
  input.emit("data", "live_k\r");
  assert.equal(await p, "blcf_live_k");
  assert.deepEqual(input.rawModes, [true, false]);
  assert.ok(!output.written.includes("blcf"), "secret echoed");
  assert.equal(output.written, "API key: \n");
});

test("promptSecret: Ctrl-C → null (kayıt yok), raw mode geri alınır", async () => {
  const { input, output } = fakeTty();
  const p = promptSecret("API key: ", { input, output });
  input.emit("data", "abc");
  assert.equal(await p, null);
  assert.deepEqual(input.rawModes, [true, false]);
});
