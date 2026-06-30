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

test("statusLine: handle'ları öneksiz gösterir", () => {
  const line = statusLine({ draftInstanceId: "t7k2p9", liveThemeId: "t3m1xx" });
  assert.match(line, /Draft theme t7k2p9/);
  assert.match(line, /Live theme → t3m1xx/);
  assert.doesNotMatch(line, /#/); // ham-sayı çağrışımı yapan # yok
});

test("statusLine: liveThemeId yoksa (none)", () => {
  assert.match(statusLine({ draftInstanceId: 19, liveThemeId: null }), /Live theme → \(none\)/);
});

test("statusLine: oturum yoksa null (local-only)", () => {
  assert.equal(statusLine(null), null);
});
