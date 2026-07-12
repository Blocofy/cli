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
  mkdirSync(join(dir, "config"), { recursive: true });
  writeFileSync(join(dir, "config", "settings_schema.json"), "[]");
  writeFileSync(join(dir, "config", "color_schemes.json"), "[]");
  return dir;
}

test("readLocalTemplates: THEME_DIRS + config/settings_schema.json, .liquid stripped, asset kept", () => {
  const dir = themeFixture();
  const t = readLocalTemplates(dir);
  assert.deepEqual(Object.keys(t).sort(), [
    "asset/logo.svg",
    "asset/theme.css",
    "config/settings_schema.json",
    "section/Hero",
  ]);
  assert.equal(t["section/Hero"], "HERO");
  assert.equal(t["asset/theme.css"], ".x{}");
  assert.equal(t["config/settings_schema.json"], "[]");
  // diger config/* sync DISI (color_schemes/theme.json kendi sistemi)
  assert.equal(t["config/color_schemes.json"], undefined);
  rmSync(dir, { recursive: true, force: true });
});

test("injectLivereload: inserts EventSource before </body>", () => {
  assert.match(injectLivereload("<body>x</body>"), /EventSource[\s\S]*<\/body>/);
  assert.match(injectLivereload("nobody"), /EventSource/); // appends when no </body>
});

test("contentTypeFor", () => {
  assert.equal(contentTypeFor("/asset/theme.css"), "text/css");
  assert.equal(contentTypeFor("/asset/logo.svg"), "image/svg+xml");
  assert.equal(contentTypeFor("/x.bin"), "application/octet-stream");
});

test("dev server: proxies page to /api/dev/render + livereload; asset from disk; SSE", async () => {
  // Fake platform render endpoint.
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

  // Page request → render proxied with token + templates, livereload injected.
  const pageRes = await fetch(`${baseUrl}/about`);
  const pageHtml = await pageRes.text();
  assert.equal(pageRes.status, 200);
  assert.match(pageHtml, /page:\/about/);
  assert.match(pageHtml, /EventSource/);
  assert.equal(seen.auth, "Bearer bcf_test");
  assert.equal(seen.body.templates["section/Hero"], "HERO");

  // /asset/* → served from disk.
  const assetRes = await fetch(`${baseUrl}/asset/logo.svg`);
  assert.equal(assetRes.headers.get("content-type"), "image/svg+xml");
  assert.equal(await assetRes.text(), "<svg/>");

  // SSE livereload channel returns an event-stream.
  const ac = new AbortController();
  const sseRes = await fetch(`${baseUrl}${LIVERELOAD_PATH}`, { signal: ac.signal });
  assert.equal(sseRes.headers.get("content-type"), "text/event-stream");
  // Cross-origin iframe'ler subscribe edebilsin.
  assert.equal(sseRes.headers.get("access-control-allow-origin"), "*");
  ac.abort();
});

test("dev server syncDraft: startup pushes local theme to a draft (/api/dev/theme {draft})", async () => {
  let themePost = null;
  const fake = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      if (req.url.endsWith("/api/dev/theme")) {
        themePost = JSON.parse(body || "{}");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ ok: true, draft: true, instanceId: 77, created: 1, updated: 0, skippedDeletes: 0 }),
        );
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ html: "<body>x</body>" }));
    });
  });
  fake.listen(0);
  await once(fake, "listening");
  const dir = themeFixture();
  const dev = startDevServer({
    dir,
    url: `http://localhost:${fake.address().port}`,
    token: "bcf_t",
    port: 0,
    syncDraft: true,
  });
  await once(dev.server, "listening");
  after(() => {
    dev.close();
    fake.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // İlk push fire-and-forget → birkaç tick bekle.
  for (let i = 0; i < 20 && !themePost; i++) await new Promise((r) => setTimeout(r, 25));
  assert.ok(themePost, "startup should push to /api/dev/theme");
  assert.equal(themePost.draft, true);
  assert.equal(themePost.files["section/Hero"], "HERO");
});

test("dev server: platform error → 4xx + error page (with livereload)", async () => {
  const fake = createServer((req, res) => {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Unknown token." }));
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
  assert.match(html, /Unknown token/);
  assert.match(html, /EventSource/);
});
