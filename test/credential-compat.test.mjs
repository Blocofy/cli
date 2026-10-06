import assert from "node:assert/strict";
import { test } from "node:test";

import { CREDENTIAL_REFUSAL_CODES, credentialRefusal } from "../lib/credentials.mjs";
import { isValidApiKey } from "../lib/media-uses.mjs";
import { assertCredentialTypes } from "../lib/target.mjs";
import { isValidToken } from "../lib/validate.mjs";

/**
 * ADR-0014 §3.2 / §6 (wave P4) — the CLI's version floor for profiled credentials and its words for the new refusals.
 * `bcf2_` dev tokens need CLI ≥ 0.16.0; `blcf_k2_` API keys work too. A CLI login's own token (`blcf_ct_`, 10 minutes)
 * is never accepted as a pasted credential.
 */

test("profiled prefixes: bcf2_ dev tokens and blcf_k2_ API keys are accepted; blcf_ct_ is not a pasted credential", () => {
  assert.equal(isValidToken("bcf2_abcdefghijklmnopqrstuvwx"), true);
  assert.equal(isValidToken("bcf_abcdefghijklmnopqrstuvwx"), true);
  assert.equal(isValidToken("bcf2_short"), false);
  assert.equal(isValidApiKey("blcf_k2_abcdefghijklmnop"), true);
  assert.equal(isValidApiKey("blcf_live_abcdefghijklmnop"), true);
  assert.equal(isValidApiKey("blcf_ct_payload.signature"), false);
  assert.equal(isValidApiKey("blcf_k2_"), false);
  const resolved = { name: "x", context: { dev: { url: "u" }, api: { url: "u" } } };
  assert.doesNotThrow(() => assertCredentialTypes({ resolved, secrets: { devToken: "bcf2_abcdefghijklmnopqrstuvwx", apiKey: "blcf_k2_abcdefghijklmnop" } }));
  assert.throws(() => assertCredentialTypes({ resolved, secrets: { devToken: "blcf_k2_abcdefghijklmnop", apiKey: null } }), (e) => e.code === "TARGET_CREDENTIAL_WRONG_TYPE");
  assert.throws(() => assertCredentialTypes({ resolved, secrets: { devToken: null, apiKey: "bcf2_abcdefghijklmnopqrstuvwx" } }), (e) => e.code === "TARGET_CREDENTIAL_WRONG_TYPE");
});

test("every new server refusal code has plain Turkish lines and a next step; none is a retry", () => {
  for (const code of ["live_effect_not_permitted", "credential_reapproval_required", "profile_unsupported", "audience_mismatch", "ai_draft", "work_copy_not_writable", "REAUTH_REQUIRED"]) {
    assert.ok(CREDENTIAL_REFUSAL_CODES.has(code), code);
    const r = credentialRefusal(code, {}, { context: "shop" });
    assert.ok(r && r.lines.length >= 2, code);
    assert.match(r.lines[0], /[ğüşıöçİ]|yapılmadı|yazılmadı|Hiçbir/, `${code}: Turkish first line`);
    assert.doesNotMatch(r.lines.join("\n"), /tekrar dene\b/i, `${code}: never invites a retry`);
  }
  assert.equal(credentialRefusal("not_found", {}), null);
});

test("credential_reapproval_required shows the due date and the re-approval link from details; profile_unsupported asks for a newer CLI or credential", () => {
  const r = credentialRefusal("credential_reapproval_required", { due_at: "2027-01-05T00:00:00.000Z", reapprove_url: "https://app.blocofy.com/settings/connections?c=k12", credential: { type: "dev_token", handle: "k12" } });
  const text = r.lines.join("\n");
  assert.match(text, /2027-01-05/);
  assert.match(text, /https:\/\/app\.blocofy\.com\/settings\/connections\?c=k12/);
  assert.match(text, /theme push --draft/);
  // A reapprove_url that is not https is not printed as a link.
  const bad = credentialRefusal("credential_reapproval_required", { due_at: "2027-01-05", reapprove_url: "javascript:alert(1)" });
  assert.doesNotMatch(bad.lines.join("\n"), /javascript:/);
  assert.match(credentialRefusal("profile_unsupported", {}).lines.join("\n"), /npm i -g @blocofy\/cli@latest|blocofy login/);
  assert.match(credentialRefusal("REAUTH_REQUIRED", {}, { context: "shop" }).lines.join("\n"), /blocofy login --context shop/);
});
