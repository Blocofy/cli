import assert from "node:assert/strict";
import { test } from "node:test";

import { isAffirmative, livePushDecision, resolvePushMode } from "../lib/confirm.mjs";

test("resolvePushMode: flag yok → draft (yeni güvenli varsayılan)", () => {
  assert.deepEqual(resolvePushMode({}), { mode: "draft" });
});

test("resolvePushMode: --draft → draft", () => {
  assert.deepEqual(resolvePushMode({ draft: true }), { mode: "draft" });
});

test("resolvePushMode: --live → live", () => {
  assert.deepEqual(resolvePushMode({ live: true }), { mode: "live" });
});

test("resolvePushMode: --instance → instance (handle taşınır)", () => {
  assert.deepEqual(resolvePushMode({ instance: "t7k2p9" }), { mode: "instance", instance: "t7k2p9" });
});

test("resolvePushMode: --instance --live → instance kazanır (açık-hedef)", () => {
  assert.deepEqual(resolvePushMode({ instance: "t7k2p9", live: true }), { mode: "instance", instance: "t7k2p9" });
});

test("resolvePushMode: --live --draft → draft (güvenli olan kazanır)", () => {
  assert.deepEqual(resolvePushMode({ live: true, draft: true }), { mode: "draft" });
});

test("livePushDecision: --draft → onay gerekmez", () => {
  assert.deepEqual(livePushDecision({ draft: true, yes: false, confirm: false, isTTY: false }), {
    autoApproved: true, needsPrompt: false, mustAbort: false,
  });
});

test("livePushDecision: --yes / --confirm → açık onay (prompt yok)", () => {
  assert.equal(livePushDecision({ draft: false, yes: true, confirm: false, isTTY: false }).autoApproved, true);
  assert.equal(livePushDecision({ draft: false, yes: false, confirm: true, isTTY: true }).autoApproved, true);
});

test("livePushDecision: non-TTY + onay yok → ABORT (agent kazara canlıya basamaz)", () => {
  const d = livePushDecision({ draft: false, yes: false, confirm: false, isTTY: false });
  assert.equal(d.mustAbort, true);
  assert.equal(d.autoApproved, false);
});

test("livePushDecision: interaktif TTY + onay yok → y/N sorulur", () => {
  const d = livePushDecision({ draft: false, yes: false, confirm: false, isTTY: true });
  assert.equal(d.needsPrompt, true);
  assert.equal(d.mustAbort, false);
});

test("isAffirmative: yalnız y/yes (case-insensitive)", () => {
  for (const a of ["y", "Y", "yes", "YES", " yes "]) assert.equal(isAffirmative(a), true);
  for (const a of ["", "n", "no", "x", null, undefined]) assert.equal(isAffirmative(a), false);
});
