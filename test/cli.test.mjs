import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import {
  LIVERELOAD_PATH,
  contentTypeFor,
  injectLivereload,
  readLocalTemplates,
} from "../lib/local-theme.mjs";
import { startDevServer } from "../lib/dev-server.mjs";

function themeFixture() {
  const dir = mkdtempSync(join(tmpdir(), "blocofy-cli-"));
  mkdirSync(join(dir, "section"), { recursive: true });
  mkdirSync(join(dir, "asset"), { recursive: true });
  mkdirSync(join(dir, "node_modules"), { recursive: true });
  writeFileSync(join(dir, "section", "Hero.liquid"), "HERO");
  writeFileSync(join(dir, "asset", "theme.css"), ".x{}");
  writeFileSync(join(dir, "asset", "logo.svg"), "<svg/>");
  writeFileSync(join(dir, "node_modules", "junk.js"), "ignored");
  writeFileSync(join(dir, "README.md"), "ignored");
  return dir;
}

test("readLocalTemplates: yalnız THEME_DIRS, .liquid strip, asset uzantısı korunur", () => {
  const dir = themeFixture();
  const t = readLocalTemplates(dir);
  assert.deepEqual(Object.keys(t).sort(), ["asset/logo.svg", "asset/theme.css", "section/Hero"]);
  assert.equal(t["section/Hero"], "HERO");
  assert.equal(t["asset/theme.css"], ".x{}");
  rmSync(dir, { recursive: true, force: true });
});

test("injectLivereload: </body>'den önce EventSource enjekte eder", () => {
  assert.match(injectLivereload("<body>x</body>"), /EventSource[\s\S]*<\/body>/);
  assert.match(injectLivereload("nobody"), /EventSource/); // </body> yoksa sona ekler
});

test("contentTypeFor", () => {
  assert.equal(contentTypeFor("/asset/theme.css"), "text/css");
  assert.equal(contentTypeFor("/asset/logo.svg"), "image/svg+xml");
  assert.equal(contentTypeFor("/x.bin"), "application/octet-stream");
});

test("dev server: sayfayı /api/dev/render'a proxy'ler + livereload; asset diskten; SSE", async () => {
  // Sahte platform render endpoint'i.
  let seen = null;
  const fake = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      seen = { auth: req.headers.authorization, body: JSON.parse(body || "{}") };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ html: `<body>page:${seen.body.path}</body>` }));
    });
  });
  fake.listen(0);
  await once(fake, "listening");
  const fakePort = fake.address().port;

  const dir = themeFixture();
  const dev = startDevServer({ dir, url: `http://localhost:${fakePort}`, token: "bcf_test", port: 0 });
  await once(dev.server, "listening");
  const port = dev.server.address().port;
  const baseUrl = `http://localhost:${port}`;

  after(() => {
    dev.close();
    fake.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // Sayfa isteği → render proxy + token + templates gönderilir, livereload eklenir.
  const pageRes = await fetch(`${baseUrl}/hakkimizda`);
  const pageHtml = await pageRes.text();
  assert.equal(pageRes.status, 200);
  assert.match(pageHtml, /page:\/hakkimizda/);
  assert.match(pageHtml, /EventSource/);
  assert.equal(seen.auth, "Bearer bcf_test");
  assert.equal(seen.body.templates["section/Hero"], "HERO");

  // /asset/* → diskten servis.
  const assetRes = await fetch(`${baseUrl}/asset/logo.svg`);
  assert.equal(assetRes.headers.get("content-type"), "image/svg+xml");
  assert.equal(await assetRes.text(), "<svg/>");

  // SSE livereload kanalı event-stream döner.
  const ac = new AbortController();
  const sseRes = await fetch(`${baseUrl}${LIVERELOAD_PATH}`, { signal: ac.signal });
  assert.equal(sseRes.headers.get("content-type"), "text/event-stream");
  ac.abort();
});

test("dev server: platform hata dönerse 4xx + hata sayfası (livereload'lı)", async () => {
  const fake = createServer((req, res) => {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Token tanınmadı." }));
  });
  fake.listen(0);
  await once(fake, "listening");

  const dir = themeFixture();
  const dev = startDevServer({
    dir,
    url: `http://localhost:${fake.address().port}`,
    token: "bcf_bad",
    port: 0,
  });
  await once(dev.server, "listening");

  after(() => {
    dev.close();
    fake.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const res = await fetch(`http://localhost:${dev.server.address().port}/`);
  assert.equal(res.status, 401);
  const html = await res.text();
  assert.match(html, /Token tanınmadı/);
  assert.match(html, /EventSource/);
});
