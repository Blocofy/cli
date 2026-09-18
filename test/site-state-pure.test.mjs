import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildManifest,
  checkSiteStatePath,
  checkSiteStateTreePaths,
  diffSiteState,
  encodeAssetRefs,
  emptyAssetReport,
  ownerOfPath,
  validateSiteStateTree,
  verifyManifest,
} from "../lib/site-state.mjs";

/**
 * CF-T4 — the CLI's pure site-state mirror (`lib/site-state.mjs`) judged against the SAME vectors the
 * platform's `packages/cms/test/site-state-pure.test.ts` uses (`test/fixtures/site-state-vectors.json`,
 * byte-identical on both sides). A vector that passes on one side and fails on the other is a drift.
 */

const vectors = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/site-state-vectors.json", import.meta.url)), "utf8"));

/** `{"json": value}` → `JSON.stringify(value, null, 2) + "\n"`; `{"text": s}` → `s` (vectors `_comment`). */
function materialize(entry) {
  return "json" in entry ? JSON.stringify(entry.json, null, 2) + "\n" : entry.text;
}

function filesFrom(map) {
  const out = {};
  for (const [path, entry] of Object.entries(map)) out[path] = materialize(entry);
  return out;
}

test("ownerOfPath matches every vector", () => {
  for (const [path, owner] of vectors.ownerOfPath) {
    assert.equal(ownerOfPath(path), owner, path);
  }
});

test("checkSiteStatePath refuses every refusedPaths vector with its code", () => {
  for (const [path, code, why] of vectors.refusedPaths) {
    const refusal = checkSiteStatePath(path);
    assert.ok(refusal, `${why}: ${path} should be refused`);
    assert.equal(refusal.code, code, `${why}: ${path}`);
  }
});

test("checkSiteStatePath accepts every acceptedPaths vector", () => {
  for (const path of vectors.acceptedPaths) {
    assert.equal(checkSiteStatePath(path), null, path);
  }
});

test("checkSiteStateTreePaths reports a casefold collision", () => {
  const findings = checkSiteStateTreePaths(vectors.casefoldCollision);
  assert.ok(findings.some((f) => f.code === "SITE_STATE_PATH_CASEFOLD_COLLISION"));
});

test("checkSiteStateTreePaths reports a file/folder collision", () => {
  const findings = checkSiteStateTreePaths(vectors.fileFolderCollision);
  assert.ok(findings.some((f) => f.code === "SITE_STATE_INVALID_PATH" && f.message.includes("both a file and a folder")));
});

test("validateSiteStateTree accepts the identityOk tree with zero errors", () => {
  const files = filesFrom(vectors.identityOk);
  const findings = validateSiteStateTree(files);
  assert.deepEqual(
    findings.filter((f) => f.level === "error"),
    [],
  );
});

test("validateSiteStateTree earns every identityRefusals vector's code", () => {
  for (const { why, code, files } of vectors.identityRefusals) {
    const findings = validateSiteStateTree(filesFrom(files));
    assert.ok(
      findings.some((f) => f.code === code),
      `${why}: expected ${code}, got ${JSON.stringify(findings)}`,
    );
  }
});

test("asset-ref codec: encodeAssetRefs matches every assetRefRoundTrip.encodes vector", () => {
  const { uuid, sha256 } = vectors.assetRefRoundTrip;
  const shaOf = (candidate) => (candidate === uuid.toLowerCase() ? sha256 : null);
  for (const [input, expected] of vectors.assetRefRoundTrip.encodes) {
    const report = emptyAssetReport();
    assert.equal(encodeAssetRefs(input, shaOf, report), expected, input);
  }
});

test("diffSiteState ignores every diffIgnored vector", () => {
  for (const { why, a, b } of vectors.diffIgnored) {
    assert.deepEqual(diffSiteState(filesFrom(a), filesFrom(b)), [], why);
  }
});

test("diffSiteState reports every diffReported vector exactly", () => {
  for (const { why, a, b, expect } of vectors.diffReported) {
    assert.deepEqual(diffSiteState(filesFrom(a), filesFrom(b)), expect, why);
  }
});

test("buildManifest → verifyManifest round-trips, and a byte change is caught", () => {
  const files = filesFrom(vectors.identityOk);
  const manifest = buildManifest({ files, platformOrigin: "https://example.myblocofy.com", sourceSite: { id: "s1", slug: "site" }, exportedAt: "2026-09-18T00:00:00.000Z" });
  assert.equal(verifyManifest(manifest, files), null);

  const tampered = { ...files, "pages/tr-TR/index.json": files["pages/tr-TR/index.json"].replace("Ana Sayfa", "Something Else") };
  const refusal = verifyManifest(manifest, tampered);
  assert.equal(refusal.code, "SITE_STATE_MANIFEST_DIGEST_MISMATCH");
});

test("buildManifest is exported_at-insensitive (re-export of an unchanged tree digests the same)", () => {
  const files = filesFrom(vectors.identityOk);
  const m1 = buildManifest({ files, platformOrigin: "o", sourceSite: { id: "s1", slug: "site" }, exportedAt: "2026-01-01T00:00:00.000Z" });
  const m2 = buildManifest({ files, platformOrigin: "o", sourceSite: { id: "s1", slug: "site" }, exportedAt: "2026-09-18T00:00:00.000Z" });
  assert.equal(m1.manifest_digest, m2.manifest_digest);
});
