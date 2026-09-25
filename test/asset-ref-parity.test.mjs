import assert from "node:assert/strict";
import { test } from "node:test";

import * as siteState from "../lib/site-state.mjs";

const { assetRef, emptyAssetReport, encodeAssetRefs, normalizeAssetRef } = siteState;

/**
 * cli-fix T6 — the CLI's asset-ref grammar mirror (`lib/site-state.mjs`) against the platform's at Blocofy a8e8666c
 * (`packages/cms/src/asset-ref.ts` + `media/media-ref.ts`, W1 C1 + round 1): FULL-VALUE anchored, the tail (path,
 * query, fragment) admits ( ) ' because encodeURIComponent leaves them unescaped, the host never does, and a platform
 * SVG id (`bsvg_` + 26 lowercase Crockford) is a reference like a Directus uuid. The expected sources below are the
 * platform's literal pieces; the vectors are the platform's own test arms (asset-ref.test.ts, site-state-pure.test.ts).
 */

// Platform @ a8e8666c, packages/cms/src/asset-ref.ts:3,10-14 — copied verbatim.
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const HOST = String.raw`(?:(?:https?:)?\/\/[^\s\/?#"'<>()\\]+)?`;
const TAIL = String.raw`(?:\/[^\s?#"<>\\]*)?(?:\?[^\s#"<>\\]*)?(?:#[^\s"<>\\]*)?`;
const PLATFORM_ASSET = new RegExp(String.raw`^${HOST}\/(?:cdn|assets)\/(${UUID})${TAIL}$`, "i");
const PLATFORM_SVG = new RegExp(String.raw`^${HOST}\/cdn\/svg\/(bsvg_[0-9abcdefghjkmnpqrstvwxyz]{26})${TAIL}$`);

const ID = "5d0c94fb-1111-4222-8333-444455556666";
const BSVG = "bsvg_0123456789abcdefghjkmnpqrs";

test("the grammar is the platform's, byte for byte (source and flags)", () => {
  assert.equal(siteState.PLATFORM_ASSET_RE?.source, PLATFORM_ASSET.source);
  assert.equal(siteState.PLATFORM_ASSET_RE?.flags, PLATFORM_ASSET.flags);
  assert.equal(siteState.PLATFORM_SVG_RE?.source, PLATFORM_SVG.source);
  assert.equal(siteState.PLATFORM_SVG_RE?.flags, PLATFORM_SVG.flags);
});

test("normalizeAssetRef: a value that CONTAINS a platform URL is carried unchanged (full-value anchor, R-7)", () => {
  for (const value of [
    `<p>Logo: <img src="https://ornek.myblocofy.com/cdn/${ID}/logo.png"></p>`,
    `<img src="/cdn/${ID}">`,
    `url(/cdn/${ID})`,
    `background-image: url("https://ornek.myblocofy.com/cdn/${ID}")`,
    `bkz. /cdn/${ID}`,
    `/cdn/${ID} /cdn/${ID}`,
    `https://ornek.myblocofy.com/cdn/${ID} ve devamı`,
    `x${ID}`,
    `<img src="https://ornek.myblocofy.com/cdn/svg/${BSVG}/logo.svg">`,
    `logo ${BSVG}`,
    `{"image":"${ID}"}`,
  ]) {
    assert.equal(normalizeAssetRef(value), value, value);
  }
});

test("normalizeAssetRef: a value that IS one reference reduces to its id", () => {
  for (const [value, expected] of [
    [ID.toUpperCase(), ID],
    [`https://ornekmarka.myblocofy.com/cdn/${ID}`, ID],
    [`https://ornekmarka.myblocofy.com/cdn/${ID}/gorsel.webp?width=1200`, ID],
    [`https://cms.blocofy.com/assets/${ID}`, ID],
    [`/cdn/${ID}`, ID],
    [`/cdn/${ID}/gorsel.webp`, ID],
    [`//ornek.myblocofy.com/cdn/${ID}`, ID],
    [`https://ornek.myblocofy.com/cdn/${ID}#frag`, ID],
    [`HTTPS://ORNEK.MYBLOCOFY.COM/cdn/${ID.toUpperCase()}`, ID],
    [`  ${ID}  `, ID],
    [BSVG, BSVG],
    [`/cdn/svg/${BSVG}`, BSVG],
    [`https://ornek.myblocofy.com/cdn/svg/${BSVG}/logo.svg?width=100`, BSVG],
  ]) {
    assert.equal(normalizeAssetRef(value), expected, value);
  }
});

test("normalizeAssetRef: a media-picker URL whose file name has ( ) ' ! * ~ reduces to its id (a8e8666c)", () => {
  for (const filename of ["logo (1).png", "Omer's logo.png", "kapak (son) - v2!.jpg", "a*b~c.webp"]) {
    const name = encodeURIComponent(filename);
    assert.equal(normalizeAssetRef(`https://ornek.myblocofy.com/cdn/${ID}/${name}`), ID, filename);
    assert.equal(normalizeAssetRef(`https://ornek.myblocofy.com/cdn/${ID}/${name}?width=1200#x(1)`), ID, filename);
    assert.equal(normalizeAssetRef(`/assets/${ID}/${name}`), ID, filename);
    assert.equal(normalizeAssetRef(`https://ornek.myblocofy.com/cdn/svg/${BSVG}/${name}`), BSVG, filename);
  }
  // The host still admits none of ( ) ': such a value is not a platform URL.
  assert.equal(normalizeAssetRef(`https://orn(ek).myblocofy.com/cdn/${ID}`), `https://orn(ek).myblocofy.com/cdn/${ID}`);
});

test("normalizeAssetRef: never invents a reference", () => {
  for (const value of [
    "https://external.com/img/photo.jpg",
    BSVG.toUpperCase(),
    `https://cms.blocofy.com/assets/${BSVG}`,
    `/cdn/${BSVG}`,
    "bsvg_short",
    `/cdn/svg/${ID}`,
    "",
  ]) {
    assert.equal(normalizeAssetRef(value), value, value);
  }
  assert.equal(normalizeAssetRef(null), null);
  assert.equal(normalizeAssetRef(42), 42);
});

test("encodeAssetRefs: anchored, media-picker names, and svg ids through the same lookup (platform arms)", () => {
  const sha256 = "a".repeat(64);
  const svgSha = "c".repeat(64);
  const shaOf = (ref) => (ref === ID ? sha256 : ref === BSVG ? svgSha : null);

  const html = `<p><img src="https://kaynak.myblocofy.com/cdn/${ID}/pixel.png"> metin</p>`;
  const css = `url(/cdn/${ID})`;
  let report = emptyAssetReport();
  assert.deepEqual(encodeAssetRefs({ body: html, bg: css }, shaOf, report), { body: html, bg: css });
  assert.deepEqual([...report.used], []);
  assert.deepEqual([...report.foreign], []);

  report = emptyAssetReport();
  const a = `https://kaynak.myblocofy.com/cdn/${ID}/${encodeURIComponent("logo (1).png")}`;
  const b = `https://kaynak.myblocofy.com/cdn/${ID}/${encodeURIComponent("Omer's logo.png")}`;
  assert.deepEqual(encodeAssetRefs({ a, b }, shaOf, report), { a: assetRef(sha256), b: assetRef(sha256) });
  assert.deepEqual([...report.used], [sha256]);

  report = emptyAssetReport();
  assert.deepEqual(encodeAssetRefs({ a: BSVG, b: `https://kaynak.myblocofy.com/cdn/svg/${BSVG}/logo.svg`, c: ID }, shaOf, report), {
    a: assetRef(svgSha),
    b: assetRef(svgSha),
    c: assetRef(sha256),
  });
  assert.deepEqual([...report.used].sort(), [sha256, svgSha].sort());

  const foreignSvg = "bsvg_zzzzzzzzzzzzzzzzzzzzzzzzzz";
  report = emptyAssetReport();
  assert.deepEqual(encodeAssetRefs({ image: foreignSvg }, shaOf, report), { image: foreignSvg });
  assert.deepEqual([...report.foreign], [foreignSvg]);
});
