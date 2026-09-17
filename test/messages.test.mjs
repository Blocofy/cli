import test from "node:test";
import assert from "node:assert/strict";

import { healthAdvice, retryNotice, statusLine, syncScopeNote } from "../lib/messages.mjs";

test("syncScopeNote: tema dizinleri + config/settings_schema.json synced, pages not-synced", () => {
  const [synced, notSynced] = syncScopeNote();
  for (const d of ["layout/", "section/", "block/", "partial/", "asset/", "template/", "locales/"]) {
    assert.ok(synced.includes(d), `synced ${d} icermeli`);
  }
  assert.ok(synced.includes("config/settings_schema.json"));
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

test("retryNotice: attempt/retries + sebep içeren tek satır", () => {
  assert.equal(
    retryNotice({ attempt: 1, retries: 2, reason: "fetch failed" }),
    "Network error (fetch failed) — retrying (1/2)…",
  );
  assert.equal(retryNotice({ attempt: 2, retries: 2 }), "Network error — retrying (2/2)…");
  assert.equal(retryNotice({ attempt: 1, retries: 3, reason: "HTTP 429", waitMs: 1000 }), "Server temporarily unavailable (HTTP 429) — retrying in 1s (1/3)…");
  assert.equal(retryNotice({ attempt: 2, retries: 3, reason: "fetch failed", waitMs: 900 }), "Network error (fetch failed) — retrying in 0.9s (2/3)…");
});

/** CF-T9: no line may be an imperative publish one-liner; every `theme publish` mention says it REPLACES live. */
function assertNoPublishOneLiner(lines) {
  const text = lines.join("\n");
  assert.doesNotMatch(text, /Fix:/);
  for (const line of lines) {
    if (/theme publish/.test(line)) assert.match(line, /REPLACES the live theme .*deliberate decision/, `unsafe publish advice: ${line}`);
  }
}

test("healthAdvice pages_split: names the non-live theme holding pages, the missing slugs, why, preview-first steps; no one-line publish fix", () => {
  const lines = healthAdvice({
    health: "pages_split",
    live_theme_instance: { id: "t2live", name: "Live", template_count: 9 },
    pages_by_instance: [{ theme_instance: "t2live", count: 5 }, { theme_instance: "t7k2p9", count: 2 }],
    orphaned_pages: 2,
    orphan_missing_slugs: ["/about", "/contact"],
    drafts: [{ id: "t7k2p9", name: "Summer", source: "import" }],
  });
  const text = lines.join("\n");
  assert.match(text, /Missing on the live theme: \/about, \/contact/);
  assert.match(text, /not live: t7k2p9 "Summer" \(2 published pages\)/);
  assert.match(text, /Why: .*not live/);
  assert.match(text, /blocofy theme pull <empty-dir> --instance t7k2p9/);
  assert.match(text, /Open in editor/);
  assert.match(text, /`blocofy theme publish --instance t7k2p9` REPLACES the live theme/);
  assertNoPublishOneLiner(lines);
});

test("healthAdvice live_instance_empty (and an older server without per-instance data): no imperative one-liner; ok → nothing", () => {
  const empty = healthAdvice({ health: "live_instance_empty", live_theme_instance: { id: "t1" }, pages_by_instance: [{ theme_instance: "t9", count: 4 }], drafts: [] });
  assert.match(empty.join("\n"), /no published pages/);
  assert.match(empty.join("\n"), /t9 \(4 published pages\)/);
  assertNoPublishOneLiner(empty);
  const old = healthAdvice({ health: "pages_split", orphaned_pages: 3, live_theme_instance: { id: "t1" } });
  assert.match(old.join("\n"), /3 published page\(s\)/);
  assert.match(old.join("\n"), /--instance <handle>/);
  assertNoPublishOneLiner(old);
  assert.deepEqual(healthAdvice({ health: "ok" }), []);
});
