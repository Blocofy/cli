import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import { EventEmitter } from "node:events";

import { credentialsPath, loadApiCredentials, loadCredentials, saveCredentials } from "../lib/credentials.mjs";
import { promptSecret } from "../lib/secret-prompt.mjs";

/**
 * D3 / CLI 0.8.0 — credential coexistence (L5–L9) ve sır hijyeni (L10–L11).
 * Plan: multisite-cms docs/architecture/plans/2026-09-16-d3-page-media-use-public-surfaces.md §4.7, Task 9.
 *
 * `HOME` geçici dizine yönlendirilir; `credentialsPath()` HOME'u çağrı anında çözer. Child süreçler
 * `stdin` pipe ile koşar → `process.stdin.isTTY` false (non-TTY kolu).
 */

const root = fileURLToPath(new URL("..", import.meta.url));
const BIN = join(root, "bin", "blocofy.mjs");

// Planted canary: hiçbir stdout/stderr çıktısında GEÇMEMELİ (önek dahil basılmaz).
const CANARY = "blcf_live_CANARY7f3a9c2e1b5d4e6f8a0b1c2d3e4f5a6b";
const DEV = { url: "https://store.example.com", token: "bcf_devtoken_0123456789abcdef" };
const API = { apiUrl: "https://app.blocofy.com", apiKey: "blcf_live_filekey0123456789abcdef" };

const ENV_KEYS = ["HOME", "BLOCOFY_URL", "BLOCOFY_TOKEN", "BLOCOFY_API_KEY", "BLOCOFY_API_URL"];
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

function readFile() {
  return JSON.parse(readFileSync(credentialsPath(), "utf8"));
}

function writeRaw(content) {
  mkdirSync(dirname(credentialsPath()), { recursive: true });
  writeFileSync(credentialsPath(), typeof content === "string" ? content : JSON.stringify(content));
}

/** Child CLI: temiz env (yalnız PATH + verilenler), stdin pipe (non-TTY) ve hemen kapalı. */
function runCli(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      env: { PATH: process.env.PATH, HOME: home, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.stdin.end();
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("[L5] legacy {url,token} dosyası okunur; loadApiCredentials() null", () => {
  writeRaw(DEV);
  assert.deepEqual(loadCredentials(), { ...DEV, source: "file" });
  assert.equal(loadApiCredentials(), null);
});

test("[L6] saveCredentials({apiUrl,apiKey}) dev {url,token} çiftini KORUR", () => {
  writeRaw(DEV);
  saveCredentials(API);
  assert.deepEqual(readFile(), { ...DEV, ...API });
  assert.deepEqual(loadCredentials(), { ...DEV, source: "file" });
  assert.deepEqual(loadApiCredentials(), { ...API, source: "file" });
});

test("[L7] sonraki dev login saveCredentials({url,token}) {apiUrl,apiKey} çiftini KORUR", () => {
  saveCredentials(API);
  saveCredentials(DEV);
  assert.deepEqual(readFile(), { ...DEV, ...API });
  assert.deepEqual(loadApiCredentials(), { ...API, source: "file" });
  assert.deepEqual(loadCredentials(), { ...DEV, source: "file" });
});

test("[L7b] bozuk dosya üstüne saveCredentials → {} + patch yazılır", () => {
  writeRaw("{not json");
  saveCredentials(API);
  assert.deepEqual(readFile(), API);
});

test("[L8] env BLOCOFY_API_KEY+BLOCOFY_API_URL dosyaya göre öncelikli", () => {
  saveCredentials(API);
  process.env.BLOCOFY_API_KEY = "blcf_live_envkey0123456789abcdef";
  process.env.BLOCOFY_API_URL = "https://staging.blocofy.com/";
  assert.deepEqual(loadApiCredentials(), {
    apiUrl: "https://staging.blocofy.com",
    apiKey: "blcf_live_envkey0123456789abcdef",
    source: "env",
  });
});

test("[L8b] env'in yalnız biri set → hata; dosyaya düşülmez", () => {
  saveCredentials(API);
  process.env.BLOCOFY_API_KEY = "blcf_live_envkey0123456789abcdef";
  assert.throws(() => loadApiCredentials(), /BLOCOFY_API_URL/);
  delete process.env.BLOCOFY_API_KEY;
  process.env.BLOCOFY_API_URL = "https://staging.blocofy.com";
  assert.throws(() => loadApiCredentials(), /BLOCOFY_API_KEY/);
});

test("[L8c] env hata mesajı anahtarı basmaz", () => {
  process.env.BLOCOFY_API_KEY = CANARY;
  let message = "";
  try {
    loadApiCredentials();
  } catch (e) {
    message = String(e?.message ?? e);
  }
  assert.ok(message.length > 0);
  assert.ok(!message.includes(CANARY));
});

test("[L9] dosya modu 0600 — yeni dosyada ve mevcut (0644) dosya üstüne yazımda", () => {
  saveCredentials(API);
  assert.equal(statSync(credentialsPath()).mode & 0o777, 0o600);
  chmodSync(credentialsPath(), 0o644);
  saveCredentials(DEV);
  assert.equal(statSync(credentialsPath()).mode & 0o777, 0o600);
  assert.deepEqual(readFile(), { ...DEV, ...API });
});

test("[L10] non-TTY login --api-key env anahtarıyla kaydeder; canary stdout/stderr'de GEÇMEZ", async () => {
  const r = await runCli(["login", "--api-key"], { BLOCOFY_API_KEY: CANARY, BLOCOFY_API_URL: "https://app.blocofy.com" });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(!r.stdout.includes(CANARY) && !r.stderr.includes(CANARY), "canary leaked to output");
  assert.ok(!(r.stdout + r.stderr).includes("CANARY7f3a"), "canary fragment leaked");
  assert.match(r.stdout, /API key saved/);
  assert.equal(readFile().apiKey, CANARY);
  assert.equal(readFile().apiUrl, "https://app.blocofy.com");
});

test("[L10b] login --api-key <değer> sözdizimi REDDEDİLİR; argv'deki canary echo edilmez, dosya yazılmaz", async () => {
  const r = await runCli(["login", "--api-key", CANARY]);
  assert.equal(r.code, 1);
  assert.ok(!r.stdout.includes(CANARY) && !r.stderr.includes(CANARY), "canary leaked to output");
  assert.match(r.stderr, /takes no value|Nothing was written/);
  assert.equal(existsSync(credentialsPath()), false);
});

test("[L10c] --help ve hata yolu canary basmaz", async () => {
  const help = await runCli(["--help"], { BLOCOFY_API_KEY: CANARY, BLOCOFY_API_URL: "https://app.blocofy.com" });
  assert.equal(help.code, 0);
  assert.ok(!(help.stdout + help.stderr).includes(CANARY));
  // Ağ hatası (kapalı port) → exit 1; mesaj anahtarı taşımaz.
  const err = await runCli(["pages", "media-uses", "pg_1"], { BLOCOFY_API_KEY: CANARY, BLOCOFY_API_URL: "http://127.0.0.1:9" });
  assert.equal(err.code, 1);
  assert.ok(!(err.stdout + err.stderr).includes(CANARY), "canary leaked on network error");
});

test("[L11] non-TTY + env yok → login --api-key exit 1, dosya yazılmaz", async () => {
  const r = await runCli(["login", "--api-key"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /BLOCOFY_API_KEY/);
  assert.equal(existsSync(credentialsPath()), false);
});

test("[L11b] bcf_ dev token v1 anahtarı olarak KABUL EDİLMEZ (login --api-key)", async () => {
  const r = await runCli(["login", "--api-key"], { BLOCOFY_API_KEY: DEV.token, BLOCOFY_API_URL: "https://app.blocofy.com" });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /blcf_live_/);
  assert.ok(!r.stderr.includes(DEV.token));
  assert.equal(existsSync(credentialsPath()), false);
});

test("[L11c] login --api-key, mevcut dev çiftini korur (dosya merge)", async () => {
  writeRaw(DEV);
  const r = await runCli(["login", "--api-key"], { BLOCOFY_API_KEY: API.apiKey, BLOCOFY_API_URL: "https://app.blocofy.com" });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(readFile(), { ...DEV, ...API });
});

// --- lib/secret-prompt.mjs -------------------------------------------------------------------

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
  input.emit("data", "x\u007f"); // yanlış tuş + backspace
  input.emit("data", "live_k\r");
  assert.equal(await p, "blcf_live_k");
  assert.deepEqual(input.rawModes, [true, false]);
  assert.ok(!output.written.includes("blcf"), "secret echoed");
  assert.equal(output.written, "API key: \n");
});

test("promptSecret: Ctrl-C → null (kayıt yok), raw mode geri alınır", async () => {
  const { input, output } = fakeTty();
  const p = promptSecret("API key: ", { input, output });
  input.emit("data", "abc\u0003");
  assert.equal(await p, null);
  assert.deepEqual(input.rawModes, [true, false]);
});
