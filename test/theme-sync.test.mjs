import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { localPathFor } from "../lib/local-theme.mjs";
import { fetchDevSession, fetchSiteStatus, publishInstance, pullTheme, pushTheme } from "../lib/theme-sync.mjs";

test("publishInstance: POST /api/dev/publish {instanceId} → result (Bearer)", async () => {
  let seen = null;
  const fake = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      seen = { method: req.method, auth: req.headers.authorization, url: req.url, body: JSON.parse(body || "{}") };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, published: 20, cloned: true }));
    });
  });
  fake.listen(0);
  await once(fake, "listening");
  after(() => fake.close());

  const r = await publishInstance({ url: `http://localhost:${fake.address().port}`, token: "bcf_t", instanceId: 20 });
  assert.equal(r.published, 20);
  assert.equal(r.cloned, true);
  assert.equal(seen.method, "POST");
  assert.ok(seen.url.endsWith("/api/dev/publish"));
  assert.equal(seen.auth, "Bearer bcf_t");
  assert.equal(seen.body.instanceId, 20);
});

test("publishInstance: sunucu 409 → throw (error metni)", async () => {
  const fake = createServer((req, res) => {
    res.writeHead(409, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Yayınlanacak temada sayfa yok." }));
  });
  fake.listen(0);
  await once(fake, "listening");
  after(() => fake.close());
  await assert.rejects(
    publishInstance({ url: `http://localhost:${fake.address().port}`, token: "bcf_t", instanceId: 20 }),
    /sayfa yok/,
  );
});

test("fetchSiteStatus: GET /api/dev/site → health JSON", async () => {
  const fake = createServer((req, res) => {
    assert.equal(req.method, "GET");
    assert.ok(req.url.endsWith("/api/dev/site"));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        site: { id: 14, slug: "testsite" }, health: "ok", pages_on_live: 12,
        live_theme_instance: { id: 19, name: "Canlı", template_count: 5 }, drafts: [],
      }),
    );
  });
  fake.listen(0);
  await once(fake, "listening");
  after(() => fake.close());
  const s = await fetchSiteStatus({ url: `http://localhost:${fake.address().port}`, token: "bcf_t" });
  assert.equal(s.health, "ok");
  assert.equal(s.pages_on_live, 12);
  assert.equal(s.live_theme_instance.id, 19);
});

test("fetchDevSession: GET /api/dev/session → session JSON (Bearer)", async () => {
  const fake = createServer((req, res) => {
    assert.equal(req.method, "GET");
    assert.equal(req.headers.authorization, "Bearer bcf_t");
    assert.ok(req.url.endsWith("/api/dev/session"));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        draftInstanceId: 77,
        previewUrl: "https://testsite.myblocofy.com/?preview=TOK",
        editorUrl: "https://app.blocofy.com/editor/5?instance=77",
        site: { id: 14, slug: "testsite" },
      }),
    );
  });
  fake.listen(0);
  await once(fake, "listening");
  after(() => fake.close());

  const s = await fetchDevSession({
    url: `http://localhost:${fake.address().port}`,
    token: "bcf_t",
  });
  assert.equal(s.draftInstanceId, 77);
  assert.equal(s.previewUrl, "https://testsite.myblocofy.com/?preview=TOK");
  assert.equal(s.editorUrl, "https://app.blocofy.com/editor/5?instance=77");
});

test("localPathFor: adds .liquid for Liquid kinds, leaves assets raw", () => {
  assert.equal(localPathFor("section/Hero"), "section/Hero.liquid");
  assert.equal(localPathFor("layout/theme"), "layout/theme.liquid");
  assert.equal(localPathFor("asset/theme.css"), "asset/theme.css");
  assert.equal(localPathFor("section/Hero.liquid"), "section/Hero.liquid"); // no double extension
});

test("pullTheme: GET /api/dev/theme → writes to disk with .liquid re-added", async () => {
  const fake = createServer((req, res) => {
    assert.equal(req.method, "GET");
    assert.equal(req.headers.authorization, "Bearer bcf_t");
    assert.ok(req.url.endsWith("/api/dev/theme"));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ files: { "section/Hero": "H", "asset/theme.css": ".x{}" } }));
  });
  fake.listen(0);
  await once(fake, "listening");
  const dir = mkdtempSync(join(tmpdir(), "blocofy-pull-"));
  after(() => {
    fake.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const { count } = await pullTheme({
    dir,
    url: `http://localhost:${fake.address().port}`,
    token: "bcf_t",
  });
  assert.equal(count, 2);
  assert.equal(readFileSync(join(dir, "section", "Hero.liquid"), "utf8"), "H");
  assert.equal(readFileSync(join(dir, "asset", "theme.css"), "utf8"), ".x{}");
});

test("pushTheme: readLocalTemplates → POST {files} (stripped keys); returns result", async () => {
  let received = null;
  const fake = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      assert.equal(req.method, "POST");
      assert.equal(req.headers.authorization, "Bearer bcf_t");
      received = JSON.parse(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, created: 1, updated: 0, skippedDeletes: 2 }));
    });
  });
  fake.listen(0);
  await once(fake, "listening");
  const dir = mkdtempSync(join(tmpdir(), "blocofy-push-"));
  mkdirSync(join(dir, "section"), { recursive: true });
  writeFileSync(join(dir, "section", "Hero.liquid"), "H");
  after(() => {
    fake.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const result = await pushTheme({
    dir,
    url: `http://localhost:${fake.address().port}`,
    token: "bcf_t",
  });
  assert.deepEqual(result, { ok: true, created: 1, updated: 0, skippedDeletes: 2 });
  assert.equal(received.files["section/Hero"], "H"); // stripped key sent
});

test("pushTheme --draft: sends body.draft true; returns draft result", async () => {
  let received = null;
  const fake = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      received = JSON.parse(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, draft: true, instanceId: 77, created: 2, updated: 0, skippedDeletes: 0 }));
    });
  });
  fake.listen(0);
  await once(fake, "listening");
  const dir = mkdtempSync(join(tmpdir(), "blocofy-draft-"));
  mkdirSync(join(dir, "section"), { recursive: true });
  writeFileSync(join(dir, "section", "Hero.liquid"), "H");
  after(() => {
    fake.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const result = await pushTheme({
    dir,
    url: `http://localhost:${fake.address().port}`,
    token: "bcf_t",
    draft: true,
  });
  assert.equal(received.draft, true);
  assert.equal(result.instanceId, 77);
});
