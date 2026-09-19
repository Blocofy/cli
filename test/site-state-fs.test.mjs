import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { SiteStateFsError, hashBuffer, hashFile, readSiteStateTree, stagedWriteTree } from "../lib/site-state-fs.mjs";

const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
function tmp() {
  const d = mkdtempSync(join(tmpdir(), "bcf-site-state-fs-"));
  dirs.push(d);
  return d;
}

test("readSiteStateTree reads text files and separates media/files/<sha> as assets, not files", () => {
  const root = tmp();
  mkdirSync(join(root, "site"), { recursive: true });
  mkdirSync(join(root, "media", "files"), { recursive: true });
  writeFileSync(join(root, "blocofy-site.json"), "{}");
  writeFileSync(join(root, "site", "locales.json"), '{"default":"tr-TR","supported":["tr-TR"]}');
  writeFileSync(join(root, "media", "files", "a".repeat(64)), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  const { files, assets, diagnostics } = readSiteStateTree(root);
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(Object.keys(files).sort(), ["blocofy-site.json", "site/locales.json"]);
  assert.equal(assets.length, 1);
  assert.equal(assets[0].path, `media/files/${"a".repeat(64)}`);
  assert.equal(assets[0].sha256, "a".repeat(64));
  assert.equal(assets[0].bytes, 4);
});

test("readSiteStateTree skips a dot-prefixed entry AT THE ROOT (.git, .blocofy) but walks into one nested deeper", () => {
  const root = tmp();
  mkdirSync(join(root, ".git"), { recursive: true });
  writeFileSync(join(root, ".git", "config"), "junk");
  mkdirSync(join(root, ".blocofy"), { recursive: true });
  writeFileSync(join(root, ".blocofy", "project.json"), "{}");
  mkdirSync(join(root, "theme", "assets"), { recursive: true });
  writeFileSync(join(root, "theme", "assets", ".hidden.css"), "body{}");

  const { files } = readSiteStateTree(root);
  assert.deepEqual(Object.keys(files), ["theme/assets/.hidden.css"]);
});

test("readSiteStateTree reports a symlink as a diagnostic, never follows it", () => {
  const root = tmp();
  mkdirSync(join(root, "site"), { recursive: true });
  writeFileSync(join(root, "site", "real.json"), "{}");
  symlinkSync(join(root, "site", "real.json"), join(root, "site", "linked.json"));

  const { files, diagnostics } = readSiteStateTree(root);
  assert.deepEqual(Object.keys(files), ["site/real.json"]);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].code, "SITE_STATE_SYMLINK");
  assert.equal(diagnostics[0].path, "site/linked.json");
});

test("readSiteStateTree does not follow a symlinked directory", () => {
  const root = tmp();
  const outside = tmp();
  writeFileSync(join(outside, "secret.json"), '{"leak":true}');
  symlinkSync(outside, join(root, "escape"));

  const { files, diagnostics } = readSiteStateTree(root);
  assert.deepEqual(files, {});
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].code, "SITE_STATE_SYMLINK");
  assert.equal(diagnostics[0].path, "escape");
});

test("hashFile hashes the actual bytes on disk", () => {
  const root = tmp();
  writeFileSync(join(root, "x"), "hello");
  const got = hashFile(join(root, "x"));
  // sha256("hello")
  assert.equal(got, "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  assert.equal(got, hashFile(join(root, "x")));
  assert.equal(hashBuffer(Buffer.from("hello")), got);
});

test("stagedWriteTree writes string AND Buffer content, all-or-nothing", () => {
  const root = tmp();
  const written = stagedWriteTree(root, [
    ["blocofy-site.json", "{}"],
    ["media/files/" + "b".repeat(64), Buffer.from([1, 2, 3])],
  ]);
  assert.equal(written, 2);
  assert.equal(readFileSync(join(root, "blocofy-site.json"), "utf8"), "{}");
  assert.deepEqual(readFileSync(join(root, "media", "files", "b".repeat(64))), Buffer.from([1, 2, 3]));
  // no leftover staging directory
  assert.deepEqual(readdirSync(root).filter((n) => n.startsWith(".blocofy-site-state-staging-")), []);
});

test("stagedWriteTree refuses a path that escapes the root, writing nothing", () => {
  const root = tmp();
  assert.throws(() => stagedWriteTree(root, [["blocofy-site.json", "{}"], ["../escape.json", "{}"]]), SiteStateFsError);
  assert.equal(existsSync(join(root, "blocofy-site.json")), false);
});

test("stagedWriteTree refuses a file/folder conflict, writing nothing", () => {
  const root = tmp();
  assert.throws(() => stagedWriteTree(root, [["a", "1"], ["a/b", "2"]]), SiteStateFsError);
  assert.equal(existsSync(join(root, "a")), false);
});
