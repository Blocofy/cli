import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  canonicalizeLocaleCode,
  checkPageSlug,
  decodeSegment,
  encodeSegment,
  isCanonicalLayoutPath,
  legacyPageFilePath,
  pageFilePath,
  parsePageFilePath,
} from "../lib/page-path-codec.mjs";

// PS-19 — the platform's page path codec, mirrored. The vectors are byte-identical to
// Blocofy/blocofy packages/cms/test/fixtures/page-path-vectors.json; drift on either side fails both suites.
const vectors = JSON.parse(readFileSync(new URL("./fixtures/page-path-vectors.json", import.meta.url), "utf8"));

test("valid vectors map (locale, slug) → path and back", () => {
  for (const [locale, slug, path] of vectors.valid) {
    assert.equal(pageFilePath(locale, slug), path, `${locale} ${slug.slice(0, 40)}`);
    const parsed = parsePageFilePath(path);
    if (path.includes("/hashed/")) assert.deepEqual({ kind: parsed.kind, locale: parsed.locale }, { kind: "hashed", locale });
    else assert.deepEqual(parsed, { kind: "canonical", locale, slug });
  }
});

test("invalid slugs are refused with PAGES_INVALID_SLUG", () => {
  for (const slug of vectors.invalidSlugs) {
    assert.notEqual(checkPageSlug(slug), null, JSON.stringify(slug.slice(0, 30)));
    assert.throws(() => pageFilePath("en-US", slug), (e) => e.code === "PAGES_INVALID_SLUG");
  }
});

test("non-canonical locales are refused with PAGES_INVALID_LOCALE", () => {
  for (const locale of vectors.invalidLocales) {
    assert.throws(() => pageFilePath(locale, "/"), (e) => e.code === "PAGES_INVALID_LOCALE", locale);
  }
});

test("invalid paths carry the platform's code", () => {
  for (const [path, code] of vectors.invalidPaths) {
    const parsed = parsePageFilePath(path);
    assert.equal(parsed.kind, "invalid", path);
    assert.equal(parsed.code, code, path);
  }
});

test("legacy-shaped paths are 'other'; canonical-shaped ones are recognised", () => {
  for (const path of vectors.legacyShaped) {
    assert.deepEqual(parsePageFilePath(path), { kind: "other" });
    assert.equal(isCanonicalLayoutPath(path), false);
  }
  for (const path of vectors.canonicalShapedLegacyCandidates) assert.equal(isCanonicalLayoutPath(path), true);
});

test("segment codec round-trips and refuses non-canonical escapes", () => {
  for (const seg of ["about", "[slug]", "iletişim", "日本語", "con", "COM1", "a~b", "~", "x.", ".x", "a b", "😀", "%41"]) {
    const enc = encodeSegment(seg);
    assert.match(enc, /^[a-z0-9_.~-]+$/);
    assert.equal(decodeSegment(enc), seg);
  }
  for (const bad of ["~61bout", "~4Bx", "a~", "a~zz", "~ff"]) assert.equal(decodeSegment(bad), null);
});

test("legacy formula and locale canonicalisation match the platform", () => {
  assert.equal(legacyPageFilePath("/"), "pages/index.json");
  assert.equal(legacyPageFilePath("/blog/yazi"), "pages/blog/yazi.json");
  assert.equal(canonicalizeLocaleCode("en-us"), "en-US");
  assert.equal(canonicalizeLocaleCode("ZH-hans-cn"), "zh-Hans-CN");
  assert.equal(canonicalizeLocaleCode("en_US"), null);
});
