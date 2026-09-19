import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkPages } from "../lib/content-sync.mjs";
import { classifyPageFile, serializeV2PageFile } from "../lib/page-files.mjs";

/** CF-T3 (contract C4) — the local half of base_revision: classifier mirror, migrate-layout, `pages check` warning. */

const DIRS = [];
function tmp() {
  const d = mkdtempSync(join(tmpdir(), "bcli-base-"));
  DIRS.push(d);
  return d;
}
test.after(() => {
  for (const d of DIRS) rmSync(d, { recursive: true, force: true });
});

test("pages check offline: a v2 file without base_revision warns PAGES_BASE_REVISION_MISSING; with one it does not", async () => {
  const dir = tmp();
  const put = (rel, obj) => {
    const p = join(dir, ...rel.split("/"));
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, JSON.stringify(obj));
  };
  put("pages/en-US/index.json", { format_version: 2, slug: "/", locale: "en-US", data: {} });
  put("pages/en-US/routes/about/index.json", { format_version: 2, base_revision: `r1_${"a".repeat(32)}`, slug: "/about", locale: "en-US", data: {} });
  const orig = globalThis.fetch;
  globalThis.fetch = async () => assert.fail("offline");
  try {
    const r = await checkPages({ dir });
    assert.deepEqual(r.diagnostics.map((d) => [d.level, d.code, d.path]), [["warning", "PAGES_BASE_REVISION_MISSING", "pages/en-US/index.json"]]);
  } finally {
    globalThis.fetch = orig;
  }
});

test("classifier mirror: a base_revision that is not a pulled fingerprint is PAGES_INVALID_JSON; null/absent is fine", () => {
  const file = (extra) => JSON.stringify({ format_version: 2, slug: "/", locale: "en-US", data: {}, ...extra });
  assert.equal(classifyPageFile("pages/en-US/index.json", file({ base_revision: "nope" })).code, "PAGES_INVALID_JSON");
  assert.equal(classifyPageFile("pages/en-US/index.json", file({ base_revision: 5 })).code, "PAGES_INVALID_JSON");
  assert.equal(classifyPageFile("pages/en-US/index.json", file({ base_revision: null })).ok, true);
  assert.equal(classifyPageFile("pages/en-US/index.json", file({ base_revision: `r1_${"0".repeat(32)}` })).ok, true);
});

test("migrate-layout keeps base_revision (placed after format_version, value unchanged)", () => {
  const base = `r1_${"b".repeat(32)}`;
  const out = serializeV2PageFile({ slug: "/about", base_revision: base, title: "A", data: {} }, "en-US");
  assert.deepEqual(Object.keys(JSON.parse(out)).slice(0, 2), ["format_version", "base_revision"]);
  assert.equal(JSON.parse(out).base_revision, base);
});
