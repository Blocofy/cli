import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readContentFiles } from "../lib/content-sync.mjs";

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
