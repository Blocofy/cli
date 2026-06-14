import assert from "node:assert/strict";
import { test } from "node:test";

import { hyperlink, openCommand } from "../lib/term.mjs";
import { isValidToken, isValidUrl, normalizeUrl } from "../lib/validate.mjs";

test("openCommand: platform-specific opener", () => {
  assert.deepEqual(openCommand("https://x", "darwin"), { cmd: "open", args: ["https://x"] });
  assert.deepEqual(openCommand("https://x", "linux"), { cmd: "xdg-open", args: ["https://x"] });
  assert.deepEqual(openCommand("https://x", "win32"), {
    cmd: "cmd",
    args: ["/c", "start", "", "https://x"],
  });
});

test("hyperlink: OSC 8 wrap (clickable) with visible label", () => {
  const h = hyperlink("https://x", "Open");
  assert.ok(h.includes("https://x"));
  assert.ok(h.includes("Open"));
  assert.ok(h.includes("]8;;")); // OSC 8 introducer
});

test("normalizeUrl: trim, strip trailing slash, prepend https for bare domain", () => {
  assert.equal(normalizeUrl("  https://x.com/  "), "https://x.com");
  assert.equal(normalizeUrl("store.myblocofy.com"), "https://store.myblocofy.com");
  assert.equal(normalizeUrl("http://x.com"), "http://x.com");
  assert.equal(normalizeUrl(""), "");
});

test("isValidUrl / isValidToken", () => {
  assert.equal(isValidUrl("https://x.com"), true);
  assert.equal(isValidUrl("ftp://x"), false);
  assert.equal(isValidUrl("x.com"), false);
  assert.equal(isValidToken("bcf_abcdefghij"), true);
  assert.equal(isValidToken("nope"), false);
  assert.equal(isValidToken("bcf_x"), false);
});
