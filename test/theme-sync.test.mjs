import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { localPathFor } from "../lib/local-theme.mjs";
import { pullTheme, pushTheme } from "../lib/theme-sync.mjs";

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
