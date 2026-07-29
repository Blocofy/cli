import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { diffTheme, pullTheme, pushTheme } from "../lib/theme-sync.mjs";

// M4 canonical source-write handshake: the CLI declares the protocol version + the full canonical-write
// capability set on every pull/push, plumbs --dry-run and --idempotency-key, and computes a local diff.

const EXPECTED_CAPS = "validate,dry-run,diff,idempotency-key,target-instance";

function themeDir(files) {
  const dir = mkdtempSync(join(tmpdir(), "blocofy-m4-"));
  for (const [key, content] of Object.entries(files)) {
    const rel = key.startsWith("asset/") ? key : `${key}.liquid`;
    mkdirSync(join(dir, rel.slice(0, rel.lastIndexOf("/"))), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

test("pushTheme sends the canonical handshake headers + dryRun + idempotency-key", async () => {
  let seen = null;
  const fake = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      seen = { headers: req.headers, body: JSON.parse(body) };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, dryRun: true, warnings: [] }));
    });
  });
  fake.listen(0);
  await once(fake, "listening");
  const dir = themeDir({ "section/Hero": "H" });
  after(() => {
    fake.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const result = await pushTheme({
    dir,
    url: `http://localhost:${fake.address().port}`,
    token: "bcf_testtoken1234567890abcd",
    dryRun: true,
    idempotencyKey: "idem-xyz",
  });
  assert.equal(seen.headers["x-blocofy-protocol"], "1");
  assert.equal(seen.headers["x-blocofy-capabilities"], EXPECTED_CAPS);
  assert.equal(seen.headers["x-idempotency-key"], "idem-xyz");
  assert.equal(seen.body.dryRun, true);
  assert.deepEqual(result, { ok: true, dryRun: true, warnings: [] });
});

test("pullTheme sends the canonical handshake headers", async () => {
  let headers = null;
  const fake = createServer((req, res) => {
    headers = req.headers;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ files: {} }));
  });
  fake.listen(0);
  await once(fake, "listening");
  const dir = mkdtempSync(join(tmpdir(), "blocofy-m4-pull-"));
  after(() => {
    fake.close();
    rmSync(dir, { recursive: true, force: true });
  });
  await pullTheme({ dir, url: `http://localhost:${fake.address().port}`, token: "bcf_testtoken1234567890abcd" });
  assert.equal(headers["x-blocofy-protocol"], "1");
  assert.equal(headers["x-blocofy-capabilities"], EXPECTED_CAPS);
});

test("diffTheme reports added / changed / remote-only against the target", async () => {
  const fake = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ files: { "section/Hero": "H", "section/Cta": "OLD", "layout/theme": "L" } }));
  });
  fake.listen(0);
  await once(fake, "listening");
  const dir = themeDir({ "section/Hero": "H", "section/Cta": "NEW", "section/Faq": "F" });
  after(() => {
    fake.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const d = await diffTheme({ dir, url: `http://localhost:${fake.address().port}`, token: "bcf_testtoken1234567890abcd" });
  assert.deepEqual(d.added, ["section/Faq"]);
  assert.deepEqual(d.changed, ["section/Cta"]);
  assert.deepEqual(d.removed, ["layout/theme"]);
});
