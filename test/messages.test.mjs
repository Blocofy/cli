import test from "node:test";
import assert from "node:assert/strict";

import { statusLine, syncScopeNote } from "../lib/messages.mjs";

test("syncScopeNote: tema dizinleri synced, config/pages not-synced", () => {
  const [synced, notSynced] = syncScopeNote();
  for (const d of ["layout/", "section/", "block/", "partial/", "asset/", "template/"]) {
    assert.ok(synced.includes(d), `synced ${d} içermeli`);
  }
  assert.ok(notSynced.includes("config/"));
  assert.ok(notSynced.includes("pages/"));
});

test("statusLine: draft + live id", () => {
  assert.equal(statusLine({ draftInstanceId: 19, liveThemeId: 18 }), "Local files → Draft theme #19    ·    Live theme → #18");
});

test("statusLine: liveThemeId yoksa (none)", () => {
  assert.match(statusLine({ draftInstanceId: 19, liveThemeId: null }), /Live theme → \(none\)/);
});

test("statusLine: oturum yoksa null (local-only)", () => {
  assert.equal(statusLine(null), null);
});
