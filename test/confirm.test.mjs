import assert from "node:assert/strict";
import { test } from "node:test";

import { isAffirmative, livePushDecision } from "../lib/confirm.mjs";

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
