import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { migrateLayout } from "../lib/content-sync.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "bcli-migrate-"));
const legacy = (slug, extra = {}) => JSON.stringify({ slug, title: slug, data: { version: 2, sections: [] }, ...extra }, null, 2) + "\n";
const v2 = (locale, slug, extra = {}) => JSON.stringify({ format_version: 2, slug, title: slug, locale, data: { version: 2, sections: [] }, ...extra }, null, 2) + "\n";

function put(dir, rel, content) {
  const p = join(dir, ...rel.split("/"));
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, content);
}
function snapshot(dir) {
  const out = {};
  const walk = (abs, rel) => {
    for (const name of readdirSync(abs).sort()) {
      const p = join(abs, name);
      const r = rel ? `${rel}/${name}` : name;
      if (statSync(p).isDirectory()) walk(p, r);
      else out[r] = readFileSync(p, "utf8");
    }
  };
  walk(dir, "");
  return out;
}
function capabilities() {
  const orig = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push(init.method ?? "GET");
    return new Response(JSON.stringify({ protocol_version: 2, page_layout_version: 2, default_locale: "tr-TR", supported_locales: ["tr-TR", "en-US"], files: {}, diagnostics: [] }), { status: 200 });
  };
  return { calls, restore: () => (globalThis.fetch = orig) };
}

test("dry run: plans deterministic moves and changes nothing", async () => {
  const dir = tmp();
  put(dir, "pages/index.json", legacy("/", { locale: "en-US" }));
  put(dir, "pages/about.json", legacy("/about", { locale: "tr-TR" }));
  const before = snapshot(dir);
  const r = await migrateLayout({ dir, write: false });
  assert.equal(r.refused, false);
  assert.deepEqual(r.moves.map((m) => [m.from, m.to]), [
    ["pages/about.json", "pages/tr-TR/routes/about/index.json"],
    ["pages/index.json", "pages/en-US/index.json"],
  ]);
  assert.equal(r.moved, 0);
  assert.deepEqual(snapshot(dir), before);
  rmSync(dir, { recursive: true, force: true });
});

test("--write: rewrites as v2 at the canonical path and removes the legacy file", async () => {
  const dir = tmp();
  put(dir, "pages/blog/post.json", legacy("/blog/post", { locale: "en-US", extra_key: 1 }));
  put(dir, "pages/index.json", legacy("/"));
  const server = capabilities();
  try {
    const r = await migrateLayout({ dir, url: "https://x.test", token: "bcf_t", write: true });
    assert.equal(r.refused, false);
    assert.equal(r.moved, 2);
    assert.deepEqual(Object.keys(snapshot(dir)), ["pages/en-US/routes/blog/post/index.json", "pages/tr-TR/index.json"]);
    const moved = JSON.parse(readFileSync(join(dir, "pages", "en-US", "routes", "blog", "post", "index.json"), "utf8"));
    assert.deepEqual(Object.keys(moved), ["format_version", "slug", "title", "locale", "data", "extra_key"]);
    assert.equal(JSON.parse(readFileSync(join(dir, "pages", "tr-TR", "index.json"), "utf8")).locale, "tr-TR");
    assert.deepEqual(server.calls, ["GET"]);
  } finally {
    server.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ambiguity refuses the whole migration: a locale-less file offline → zero moves, even for the provable ones", async () => {
  const dir = tmp();
  put(dir, "pages/about.json", legacy("/about", { locale: "en-US" }));
  put(dir, "pages/contact.json", legacy("/contact"));
  const before = snapshot(dir);
  const r = await migrateLayout({ dir, write: true });
  assert.equal(r.refused, true);
  assert.equal(r.moved, 0);
  assert.deepEqual(r.diagnostics.filter((d) => d.level === "error").map((d) => [d.code, d.path]), [["PAGES_AMBIGUOUS_LAYOUT", "pages/contact.json"]]);
  assert.deepEqual(snapshot(dir), before);
  rmSync(dir, { recursive: true, force: true });
});

test("a conflicting canonical file refuses with PAGES_DUPLICATE_TARGET and moves nothing", async () => {
  const dir = tmp();
  put(dir, "pages/about.json", legacy("/about", { locale: "en-US", title: "Legacy" }));
  put(dir, "pages/en-US/routes/about/index.json", v2("en-US", "/about", { title: "Canonical" }));
  put(dir, "pages/other.json", legacy("/other", { locale: "en-US" }));
  const before = snapshot(dir);
  const r = await migrateLayout({ dir, write: true });
  assert.equal(r.refused, true);
  assert.equal(r.moved, 0);
  assert.ok(r.diagnostics.some((d) => d.code === "PAGES_DUPLICATE_TARGET"));
  assert.deepEqual(snapshot(dir), before);
  rmSync(dir, { recursive: true, force: true });
});

test("an equivalent canonical file: warning, legacy file left in place, not deleted", async () => {
  const dir = tmp();
  put(dir, "pages/about.json", legacy("/about", { locale: "en-US" }));
  put(dir, "pages/en-US/routes/about/index.json", v2("en-US", "/about"));
  const r = await migrateLayout({ dir, write: true });
  assert.equal(r.refused, false);
  assert.deepEqual(r.moves, []);
  assert.ok(r.diagnostics.some((d) => d.code === "PAGES_DUPLICATE_EQUIVALENT" && d.path === "pages/about.json"));
  assert.ok(existsSync(join(dir, "pages", "about.json")));
  rmSync(dir, { recursive: true, force: true });
});

test("a broken file anywhere refuses the migration", async () => {
  const dir = tmp();
  put(dir, "pages/about.json", legacy("/about", { locale: "en-US" }));
  put(dir, "pages/broken.json", "{bozuk");
  const before = snapshot(dir);
  const r = await migrateLayout({ dir, write: true });
  assert.equal(r.refused, true);
  assert.deepEqual(snapshot(dir), before);
  rmSync(dir, { recursive: true, force: true });
});

test("legacy /a and /a/index.json migrate to paths that can coexist", async () => {
  const dir = tmp();
  put(dir, "pages/a.json", legacy("/a", { locale: "en-US" }));
  put(dir, "pages/a/index.json.json", legacy("/a/index.json", { locale: "en-US" }));
  const r = await migrateLayout({ dir, write: true });
  assert.equal(r.refused, false);
  assert.equal(r.moved, 2);
  assert.deepEqual(Object.keys(snapshot(dir)), ["pages/en-US/routes/a/index.json", "pages/en-US/routes/a/~69ndex.json/index.json"]);
  rmSync(dir, { recursive: true, force: true });
});
