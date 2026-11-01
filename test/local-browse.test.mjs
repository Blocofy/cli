import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { BROWSE_CSP, startDevServer, validateBrowseResponse } from "../lib/dev-server.mjs";

const HANDLE = "t7k2p9";
const THEME_MARK = "THEME_HTML_MUST_NOT_BE_SERVED";

function themeFixture() {
  const dir = mkdtempSync(join(tmpdir(), "blocofy-browse-"));
  mkdirSync(join(dir, "section"));
  writeFileSync(join(dir, "section", "Hero.liquid"), "HERO");
  return dir;
}

const ok = (sent, extra = {}) => ({
  status: 200,
  body: {
    contract: 2,
    status: 200,
    html: `<html><body><a href="https://www.acme.com/en/blog?page=2#c">blog</a><a href="/rel">r</a></body></html>`,
    target: { instance: sent.instance, name: "Yeni tasarım", locale: "en-US" },
    internalOrigins: ["https://www.acme.com", "https://acme.myblocofy.com"],
    ...extra,
  },
});

/**
 * Fake platform recorder: every request is recorded; `/api/dev/theme` answers the sync (`theme`), `/api/dev/render`
 * answers `render(sentBody)` → { status, body } (body: object → JSON, string → raw).
 */
async function fakePlatform({ render = ok, theme = () => ({ status: 200, body: { ok: true, draft: true, instanceId: HANDLE } }) } = {}) {
  const calls = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      let body = null;
      try {
        body = JSON.parse(raw || "{}");
      } catch {
        /* raw */
      }
      calls.push({ method: req.method, url: req.url, body });
      const answer = req.url.endsWith("/api/dev/theme") ? theme(body) : req.url.endsWith("/api/dev/render") ? render(body) : { status: 404, body: {} };
      res.writeHead(answer.status, { "content-type": "application/json" });
      res.end(typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { calls, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

async function devServer(options, platformOptions) {
  const platform = await fakePlatform(platformOptions);
  const dir = themeFixture();
  const warnings = [];
  const dev = startDevServer({ dir, url: platform.url, token: "bcf_test", port: 0, onWarn: (m) => warnings.push(m), ...options });
  await once(dev.server, "listening");
  const port = dev.server.address().port;
  after(() => {
    dev.close();
    platform.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const get = async (path, init) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, init);
    return { status: res.status, headers: res.headers, html: await res.text() };
  };
  return { port, get, calls: platform.calls, renders: () => platform.calls.filter((c) => c.url.endsWith("/api/dev/render")), warnings };
}

function assertBrowseHeaders(headers, what) {
  assert.equal(headers.get("content-security-policy"), BROWSE_CSP, what);
  assert.equal(headers.get("referrer-policy"), "no-referrer", what);
  assert.equal(headers.get("x-content-type-options"), "nosniff", what);
  assert.equal(headers.get("cache-control"), "no-store", what);
  assert.match(headers.get("content-type"), /^text\/html/, what);
}

test("CSP header value", () => {
  assert.equal(BROWSE_CSP, "form-action 'self'; connect-src 'self'; base-uri 'none'");
});

test("no handle: --no-sync without --instance → 503 local page, zero upstream requests of any kind", async () => {
  const { get, calls } = await devServer({ syncDraft: false });
  for (const path of ["/", "/en/blog/x?page=2"]) {
    const r = await get(path);
    assert.equal(r.status, 503);
    assert.match(r.html, /Tema hedefi hazırlanamadı/);
    assert.match(r.html, /--instance/);
    assert.match(r.html, /EventSource/, "the error page reloads on save");
    assertBrowseHeaders(r.headers, "503");
  }
  assert.equal(calls.length, 0);
});

test("no handle: a failed startup sync → 503 with the sync reason, zero render dispatch", async () => {
  const { get, renders, warnings } = await devServer(
    { syncDraft: true },
    { theme: () => ({ status: 500, body: { error: "boom" } }) },
  );
  const r = await get("/");
  assert.equal(r.status, 503);
  assert.match(r.html, /Tema hedefi hazırlanamadı/);
  assert.match(r.html, /draft sync/);
  assert.equal(renders().length, 0);
  assert.equal(warnings.length, 1);
});

test("--no-sync with --instance renders that draft without any sync write", async () => {
  const { get, calls } = await devServer({ syncDraft: false, instance: "d4x9" });
  const r = await get("/");
  assert.equal(r.status, 200);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.endsWith("/api/dev/render"));
  assert.equal(calls[0].body.instance, "d4x9");
});

test("--instance with sync: the named draft is the render target", async () => {
  const { get, calls } = await devServer({ syncDraft: true, instance: "d4x9" }, { theme: () => ({ status: 200, body: { ok: true, draft: true, instanceId: "d4x9" } }) });
  await get("/");
  const theme = calls.find((c) => c.url.endsWith("/api/dev/theme"));
  assert.equal(theme.body.instance, "d4x9");
  assert.equal(calls.find((c) => c.url.endsWith("/api/dev/render")).body.instance, "d4x9");
});

test("request body: exact browse shape with raw path, raw search and the bound localOrigin", async () => {
  const { get, renders, port } = await devServer({ syncDraft: true });
  await get("/en/blog/a%20b?page=2&q=x%26y&ref=");
  await get("/");
  await get("/x?");
  const [first, second, third] = renders().map((c) => c.body);
  assert.deepEqual(Object.keys(first).sort(), ["instance", "localOrigin", "mode", "path", "search", "templates"]);
  assert.equal(first.mode, "browse");
  assert.equal(first.path, "/en/blog/a%20b", "path is sent still percent-encoded (the platform decodes once)");
  assert.equal(first.search, "?page=2&q=x%26y&ref=");
  assert.equal(first.instance, HANDLE);
  assert.equal(first.localOrigin, `http://127.0.0.1:${port}`);
  assert.deepEqual(first.templates, { "section/Hero": "HERO" });
  assert.equal(second.path, "/");
  assert.ok(!("search" in second), "no query → search omitted");
  assert.ok(!("search" in third), "a bare ? → search omitted");
  assert.ok(!("preview" in first));
});

test("200: internal links mapped to the local origin, relative kept; livereload injected; browse headers", async () => {
  const { get, port } = await devServer({ syncDraft: true });
  const r = await get("/");
  assert.equal(r.status, 200);
  assert.match(r.html, new RegExp(`href="http://127\\.0\\.0\\.1:${port}/en/blog\\?page=2#c"`));
  assert.match(r.html, /href="\/rel"/);
  assert.match(r.html, /EventSource/);
  assert.doesNotMatch(r.html, /blocofy-dev-note/, "no CLI note on a 200 (the platform owns the banner)");
  assertBrowseHeaders(r.headers, "200");
});

test("404: status preserved, theme 404 HTML served with a diagnosis note; diagnosis.location never followed", async () => {
  const { get, renders } = await devServer(
    { syncDraft: true },
    {
      render: (sent) => ({
        status: 404,
        body: {
          contract: 2,
          status: 404,
          html: "<html><body><h1>Tema 404</h1></body></html>",
          target: { instance: sent.instance },
          internalOrigins: [],
          diagnosis: { code: "locale_redirect_not_emulated", location: "/tr/x<script>" },
        },
      }),
    },
  );
  const r = await get("/x");
  assert.equal(r.status, 404);
  assert.match(r.html, /<h1>Tema 404<\/h1>/);
  assert.match(r.html, /locale_redirect_not_emulated/);
  assert.match(r.html, /\/tr\/x&lt;script&gt;/, "location shown as escaped text");
  assert.equal(renders().length, 1, "the location is not requested");
  // The platform's local-browse banner sits bottom-left; the note takes the opposite corner so both stay readable.
  const note = r.html.match(/<blocofy-dev-note[^>]*>/)[0];
  assert.match(note, /right:8px/);
  assert.doesNotMatch(note, /left:/);
  assert.match(r.html, /@media \(max-width:640px\)\{blocofy-dev-note\{bottom:112px!important\}\}/, "above the wrapped banner on a phone");
  assertBrowseHeaders(r.headers, "404");
});

test("contract validation matrix: anything but a valid contract-2 answer → 502 terminal page, theme HTML never served", async () => {
  const html = `<body>${THEME_MARK}</body>`;
  const good = (sent) => ({ contract: 2, status: 200, html, target: { instance: sent.instance }, internalOrigins: [] });
  const variants = [
    ["old platform {html}", () => ({ status: 200, body: { html } })],
    ["contract 1", (s) => ({ status: 200, body: { ...good(s), contract: 1 } })],
    ["contract 3", (s) => ({ status: 200, body: { ...good(s), contract: 3 } })],
    ["contract '2'", (s) => ({ status: 200, body: { ...good(s), contract: "2" } })],
    ["status mismatch", (s) => ({ status: 200, body: { ...good(s), status: 404 } })],
    ["404 body on 200", (s) => ({ status: 404, body: { ...good(s), status: 200 } })],
    ["wrong target handle", (s) => ({ status: 200, body: { ...good(s), target: { instance: "other" } } })],
    ["no target", (s) => ({ status: 200, body: { ...good(s), target: undefined } })],
    ["non-string html", (s) => ({ status: 200, body: { ...good(s), html: { x: THEME_MARK } } })],
    ["internalOrigins missing", (s) => ({ status: 200, body: { ...good(s), internalOrigins: undefined } })],
    ["internalOrigins not array", (s) => ({ status: 200, body: { ...good(s), internalOrigins: "https://a.com" } })],
    ["internalOrigins http", (s) => ({ status: 200, body: { ...good(s), internalOrigins: ["http://evil.com"] } })],
    ["internalOrigins path", (s) => ({ status: 200, body: { ...good(s), internalOrigins: ["https://a.com/"] } })],
    ["internalOrigins userinfo", (s) => ({ status: 200, body: { ...good(s), internalOrigins: ["https://u@a.com"] } })],
    ["internalOrigins number", (s) => ({ status: 200, body: { ...good(s), internalOrigins: [42] } })],
    ["internalOrigins javascript", (s) => ({ status: 200, body: { ...good(s), internalOrigins: ["javascript:x"] } })],
    ["raw HTML text", () => ({ status: 200, body: html })],
    ["201", (s) => ({ status: 201, body: good(s) })],
  ];
  for (const [name, render] of variants) {
    const { get } = await devServer({ syncDraft: false, instance: HANDLE }, { render });
    const r = await get("/");
    assert.notEqual(r.status, 200, name);
    assert.ok(!r.html.includes(THEME_MARK), `${name}: theme HTML must not be served`);
    if (name !== "201") {
      assert.equal(r.status, 502, name);
      assert.match(r.html, /Platform sürümü yerel taslak gezinmeyi desteklemiyor/, name);
    }
    assertBrowseHeaders(r.headers, name);
  }
});

test("validateBrowseResponse: http only for local development hosts (fixture stack)", () => {
  const body = (origins) => ({ contract: 2, status: 200, html: "", target: { instance: "h" }, internalOrigins: origins });
  assert.equal(validateBrowseResponse(200, body(["http://acme.localhost:3003", "http://127.0.0.1:3003", "http://localhost:3003"]), "h").ok, true);
  assert.equal(validateBrowseResponse(200, body(["http://acme.localhost.evil.com"]), "h").ok, false);
  assert.equal(validateBrowseResponse(200, body([]), "h").ok, true);
  assert.equal(validateBrowseResponse(200, body([]), "other").ok, false);
});

test("platform refusals: code shown, HTTP status kept, no live fallback", async () => {
  const cases = [
    [422, "instance_is_live", "Yerel gezinme yalnız taslak temada çalışır; bu tema yayında."],
    [404, "instance_not_found", "Tema bulunamadı."],
    [422, "instance_required", "x"],
    [422, "bad_search", "x"],
    [422, "bad_local_origin", "x"],
    [422, "unknown_mode", "x"],
  ];
  for (const [status, code, message] of cases) {
    const { get, renders } = await devServer({ syncDraft: false, instance: HANDLE }, { render: () => ({ status, body: { error: { code, message } } }) });
    const r = await get("/");
    assert.equal(r.status, status, code);
    assert.match(r.html, new RegExp(code), code);
    assert.ok(r.html.includes(message), code);
    assert.equal(renders().length, 1, `${code}: one request, no retry or fallback`);
    assertBrowseHeaders(r.headers, code);
  }
  // Legacy error shape (401/403/429) keeps working.
  const { get } = await devServer({ syncDraft: false, instance: HANDLE }, { render: () => ({ status: 401, body: { error: "Unknown token.", code: "unauthorized" } }) });
  const r = await get("/");
  assert.equal(r.status, 401);
  assert.match(r.html, /Unknown token\./);
  assert.match(r.html, /unauthorized/);
});

/** Raw HTTP (fetch cannot send a POST form exactly like a browser would; raw keeps the request explicit). */
function raw(port, lines, body = "") {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    let data = "";
    socket.setEncoding("utf8");
    socket.on("data", (c) => (data += c));
    socket.on("error", reject);
    socket.on("close", () => {
      const [head, ...rest] = data.split("\r\n\r\n");
      const [statusLine, ...headerLines] = head.split("\r\n");
      const headers = new Map(headerLines.map((l) => [l.slice(0, l.indexOf(":")).toLowerCase(), l.slice(l.indexOf(":") + 1).trim()]));
      resolve({ status: Number(statusLine.split(" ")[1]), headers, body: rest.join("\r\n\r\n") });
    });
    socket.on("connect", () => socket.write([...lines, "Connection: close", "", body].join("\r\n")));
  });
}

test("a form POST gets the 405 'forms are not sent' page with browse headers and never reaches the platform", async () => {
  const { port, calls } = await devServer({ syncDraft: false, instance: HANDLE });
  const res = await raw(port, [
    "POST /api/forms/contact/submit HTTP/1.1",
    `Host: 127.0.0.1:${port}`,
    `Origin: http://127.0.0.1:${port}`,
    "Content-Type: application/x-www-form-urlencoded",
    "Content-Length: 7",
  ], "a=b&c=d");
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("allow"), "GET, HEAD");
  assert.equal(res.headers.get("content-security-policy"), BROWSE_CSP);
  assert.equal(res.headers.get("referrer-policy"), "no-referrer");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.match(res.body, /Yerel önizlemede formlar gönderilmez/);
  assert.match(res.body, /<a href="\/" onclick="history\.back\(\);return false">Forma geri dön<\/a>/, "a way back to the form");
  assert.equal(calls.length, 0);
});

test("HEAD and a network failure carry the browse headers too", async () => {
  const { get } = await devServer({ syncDraft: false, instance: HANDLE });
  const head = await get("/", { method: "HEAD" });
  assertBrowseHeaders(head.headers, "HEAD");

  const dir = themeFixture();
  const dead = startDevServer({ dir, url: "http://127.0.0.1:9", token: "t", port: 0, instance: HANDLE });
  await once(dead.server, "listening");
  after(() => {
    dead.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const res = await fetch(`http://127.0.0.1:${dead.server.address().port}/`);
  assert.equal(res.status, 502);
  assertBrowseHeaders(res.headers, "502");
});
