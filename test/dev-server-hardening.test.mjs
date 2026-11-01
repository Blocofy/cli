import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { connect } from "node:net";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { startDevServer } from "../lib/dev-server.mjs";
import { LIVERELOAD_PATH } from "../lib/local-theme.mjs";

const TOKEN = "bcf_secret_should_never_echo";

function themeFixture() {
  const dir = mkdtempSync(join(tmpdir(), "blocofy-dev-hardening-"));
  mkdirSync(join(dir, "section"));
  mkdirSync(join(dir, "asset"));
  writeFileSync(join(dir, "section", "Hero.liquid"), "HERO");
  writeFileSync(join(dir, "asset", "logo.svg"), "<svg/>");
  return dir;
}

/** A fake platform that counts every request it receives (zero-upstream oracle). */
async function fakePlatform() {
  const calls = [];
  const fake = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      calls.push({ method: req.method, url: req.url });
      const sent = JSON.parse(body || "{}");
      res.writeHead(200, { "content-type": "application/json" });
      // Contract 2 (local draft browsing): the answer names the draft it rendered.
      res.end(JSON.stringify({ contract: 2, status: 200, html: "<body>page</body>", target: { instance: sent.instance }, internalOrigins: [] }));
    });
  });
  fake.listen(0, "127.0.0.1");
  await once(fake, "listening");
  return { fake, calls, url: `http://127.0.0.1:${fake.address().port}` };
}

async function devFixture() {
  const platform = await fakePlatform();
  const dir = themeFixture();
  // A draft handle: without one the dev server never dispatches a render (local draft browsing, decision B).
  const dev = startDevServer({ dir, url: platform.url, token: TOKEN, port: 0, instance: "t7k2p9" });
  await once(dev.server, "listening");
  const port = dev.server.address().port;
  after(() => {
    dev.close();
    platform.fake.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dev, port, calls: platform.calls };
}

/**
 * Send a raw HTTP/1.1 request (full control over Host, duplicates and the request target) and collect the
 * response until the server closes or `waitMs` passes. Resolves { status, headers, body, ended }.
 */
function raw(port, lines, { waitMs = 400 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    let data = "";
    let ended = false;
    socket.setEncoding("latin1");
    socket.on("data", (chunk) => (data += chunk));
    socket.on("end", () => (ended = true));
    socket.on("error", reject);
    socket.on("connect", () => socket.write([...lines, "Connection: close", "", ""].join("\r\n")));
    const finish = () => {
      socket.destroy();
      const [head, ...rest] = data.split("\r\n\r\n");
      const [statusLine, ...headerLines] = head.split("\r\n");
      const headers = {};
      for (const line of headerLines) {
        const i = line.indexOf(":");
        if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
      }
      let body = rest.join("\r\n\r\n");
      if (headers["transfer-encoding"] === "chunked") body = dechunk(body);
      resolve({ status: Number(statusLine.split(" ")[1]), headers, body, ended });
    };
    socket.on("close", finish);
    setTimeout(() => !socket.destroyed && finish(), waitMs);
  });
}

/** Decode an HTTP/1.1 chunked body (complete or cut off by `waitMs`). */
function dechunk(text) {
  let out = "";
  let rest = text;
  for (;;) {
    const lineEnd = rest.indexOf("\r\n");
    if (lineEnd < 0) return out;
    const size = parseInt(rest.slice(0, lineEnd), 16);
    if (!size) return out;
    out += rest.slice(lineEnd + 2, lineEnd + 2 + size);
    rest = rest.slice(lineEnd + 2 + size + 2);
  }
}

const own = (port) => `127.0.0.1:${port}`;

test("dev server binds IPv4 loopback 127.0.0.1 only", async () => {
  const { dev } = await devFixture();
  const address = dev.server.address();
  assert.equal(address.address, "127.0.0.1");
  assert.equal(address.family, "IPv4");
});

test("theme dev prints and opens the URL it actually binds (127.0.0.1)", () => {
  const bin = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "blocofy.mjs"), "utf8");
  assert.match(bin, /const localUrl = `http:\/\/127\.0\.0\.1:\$\{port\}`;/);
  assert.doesNotMatch(bin, /const localUrl = `http:\/\/localhost:/);
});

test("own Host: page renders upstream, asset from disk, same-origin SSE without wildcard CORS", async () => {
  const { port, calls } = await devFixture();

  for (const host of [own(port), `localhost:${port}`]) {
    const page = await raw(port, ["GET /about HTTP/1.1", `Host: ${host}`]);
    assert.equal(page.status, 200, host);
    assert.match(page.body, /page/);
  }
  assert.equal(calls.length, 2, "both page GETs reached the render endpoint");

  const asset = await raw(port, ["GET /asset/logo.svg HTTP/1.1", `Host: ${own(port)}`]);
  assert.equal(asset.status, 200);
  assert.equal(asset.headers["content-type"], "image/svg+xml");
  assert.equal(asset.body, "<svg/>");

  // Same-origin EventSource: no Origin header, or the dev server's own origin.
  for (const origin of [null, `http://${own(port)}`, `http://localhost:${port}`]) {
    const sse = await raw(port, [`GET ${LIVERELOAD_PATH} HTTP/1.1`, `Host: ${own(port)}`, ...(origin ? [`Origin: ${origin}`] : [])], {
      waitMs: 200,
    });
    assert.equal(sse.status, 200, String(origin));
    assert.equal(sse.headers["content-type"], "text/event-stream");
    assert.equal(sse.headers["access-control-allow-origin"], undefined, "no wildcard CORS on livereload");
    assert.equal(sse.ended, false, "the stream stays open");
  }
  assert.equal(calls.length, 2, "asset and SSE never call the platform");
});

test("foreign, malformed or ambiguous Host is refused before any branch", async () => {
  const { port, calls } = await devFixture();
  const cases = [
    ["evil host", ["Host: evil.example"]],
    ["wrong port", [`Host: 127.0.0.1:${port + 1}`]],
    ["no port", ["Host: 127.0.0.1"]],
    ["evil suffix", [`Host: 127.0.0.1.evil.example:${port}`]],
    ["localhost suffix", [`Host: localhost.evil.example:${port}`]],
    ["userinfo", [`Host: user@127.0.0.1:${port}`]],
    ["duplicate", [`Host: ${own(port)}`, `Host: ${own(port)}`]],
    ["ambiguous duplicate", [`Host: ${own(port)}`, "Host: evil.example"]],
    ["ipv6 loopback", [`Host: [::1]:${port}`]],
    ["forwarded host is not authority", ["Host: evil.example", `X-Forwarded-Host: ${own(port)}`, `Forwarded: host=${own(port)}`]],
  ];
  for (const path of ["/about", "/asset/logo.svg", LIVERELOAD_PATH]) {
    for (const [name, headers] of cases) {
      const res = await raw(port, [`GET ${path} HTTP/1.1`, ...headers]);
      assert.ok(res.status >= 400 && res.status < 500, `${name} ${path} → ${res.status}`);
      assert.notEqual(res.headers["content-type"], "text/event-stream", `${name} ${path} must not open SSE`);
      assert.ok(!res.body.includes("<svg/>"), `${name} ${path} must not serve the asset`);
      assert.ok(!res.body.includes(TOKEN), `${name} ${path} must not echo the credential`);
    }
  }
  // Absolute-form request target (proxy-style) with an otherwise valid Host.
  const absolute = await raw(port, ["GET http://evil.example/about HTTP/1.1", `Host: ${own(port)}`]);
  assert.ok(absolute.status >= 400 && absolute.status < 500, `absolute-form → ${absolute.status}`);
  assert.equal(calls.length, 0, "zero upstream dispatch for every refusal");
});

test("a foreign Origin is refused on page, asset and SSE; Referer is not authority", async () => {
  const { port, calls } = await devFixture();
  const origins = ["https://evil.example", "null", `http://127.0.0.1:${port + 1}`, `https://${own(port)}`, `http://${own(port)}.evil.example`];
  for (const path of ["/about", "/asset/logo.svg", LIVERELOAD_PATH]) {
    for (const origin of origins) {
      const res = await raw(port, [`GET ${path} HTTP/1.1`, `Host: ${own(port)}`, `Origin: ${origin}`, `Referer: http://${own(port)}/`]);
      assert.equal(res.status, 403, `${origin} ${path}`);
      assert.notEqual(res.headers["content-type"], "text/event-stream");
      assert.ok(!res.body.includes(TOKEN));
    }
  }
  assert.equal(calls.length, 0);
});

test("only GET and HEAD: other methods get 405 + Allow before any branch", async () => {
  const { port, calls } = await devFixture();
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    for (const path of ["/about", "/asset/logo.svg", LIVERELOAD_PATH, "/api/forms/x/submit"]) {
      const res = await raw(port, [`${method} ${path} HTTP/1.1`, `Host: ${own(port)}`, "Content-Length: 0"]);
      assert.equal(res.status, 405, `${method} ${path}`);
      assert.equal(res.headers.allow, "GET, HEAD");
      assert.notEqual(res.headers["content-type"], "text/event-stream");
    }
  }
  assert.equal(calls.length, 0, "no authenticated upstream dispatch for refused methods");
});

test("HEAD answers headers only: no body, no stream, no upstream render", async () => {
  const { port, calls } = await devFixture();
  const page = await raw(port, ["HEAD /about HTTP/1.1", `Host: ${own(port)}`]);
  assert.equal(page.status, 200);
  assert.equal(page.body, "");

  const asset = await raw(port, ["HEAD /asset/logo.svg HTTP/1.1", `Host: ${own(port)}`]);
  assert.equal(asset.status, 200);
  assert.equal(asset.headers["content-type"], "image/svg+xml");
  assert.equal(asset.body, "");

  const sse = await raw(port, [`HEAD ${LIVERELOAD_PATH} HTTP/1.1`, `Host: ${own(port)}`], { waitMs: 600 });
  assert.equal(sse.status, 200);
  assert.equal(sse.body, "");
  assert.equal(sse.ended, true, "HEAD on the livereload path does not hold a stream open");

  assert.equal(calls.length, 0, "HEAD never dispatches an authenticated render");
});
