import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { pullContent, readContentFiles } from "../lib/content-sync.mjs";

function tmp() {
  return mkdtempSync(join(tmpdir(), "bcli-content-"));
}

test("settings scope: config/settings.json döner", () => {
  const dir = tmp();
  mkdirSync(join(dir, "config"));
  writeFileSync(join(dir, "config", "settings.json"), '{"theme":{}}');
  assert.deepEqual(Object.keys(readContentFiles(dir, "settings")), ["config/settings.json"]);
  rmSync(dir, { recursive: true, force: true });
});

test("pages scope: pages/**/*.json recursive, json-olmayan atlanır", () => {
  const dir = tmp();
  mkdirSync(join(dir, "pages", "blog"), { recursive: true });
  writeFileSync(join(dir, "pages", "index.json"), "{}");
  writeFileSync(join(dir, "pages", "blog", "post.json"), "{}");
  writeFileSync(join(dir, "pages", "README.md"), "x"); // atla
  assert.deepEqual(Object.keys(readContentFiles(dir, "pages")).sort(), ["pages/blog/post.json", "pages/index.json"]);
  rmSync(dir, { recursive: true, force: true });
});

test("dizin yoksa boş harita", () => {
  const dir = tmp();
  assert.deepEqual(readContentFiles(dir, "pages"), {});
  assert.deepEqual(readContentFiles(dir, "settings"), {});
  rmSync(dir, { recursive: true, force: true });
});

test("pullContent: GET {files} → diske yazar (nested dahil)", async () => {
  const dir = tmp();
  const orig = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({ files: { "config/settings.json": '{"theme":{}}', "pages/index.json": "{}", "pages/blog/post.json": "{}" } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  try {
    const { count } = await pullContent({ dir, url: "https://x.test", token: "bcf_t", scope: "all" });
    assert.equal(count, 3);
    assert.equal(readFileSync(join(dir, "config", "settings.json"), "utf8"), '{"theme":{}}');
    assert.ok(existsSync(join(dir, "pages", "blog", "post.json")));
  } finally {
    globalThis.fetch = orig;
    rmSync(dir, { recursive: true, force: true });
  }
});
