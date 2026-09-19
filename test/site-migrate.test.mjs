import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { migrateSiteState } from "../lib/site-migrate.mjs";

const execFileAsync = promisify(execFile);
const BIN = fileURLToPath(new URL("../bin/blocofy.mjs", import.meta.url));

/**
 * CF-T4 — `blocofy site migrate`: an OLD separate-pulls directory (`theme pull`'s theme-dirs-at-root layout,
 * `pages pull`'s canonical `pages/<locale>/…/index.json`, `settings pull`'s `config/settings.json`) turned
 * into the site-state v1 tree layout. Purely local (no server stub anywhere in this file — a real network
 * attempt would hang/throw and fail these tests, which is itself the offline-contract check).
 */

const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
function tmp() {
  const d = mkdtempSync(join(tmpdir(), "bcli-site-migrate-"));
  dirs.push(d);
  return d;
}

function put(dir, rel, content) {
  const p = join(dir, ...rel.split("/"));
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, content);
}

function snapshot(dir) {
  const out = {};
  const walk = (abs, rel) => {
    for (const name of readdirSync(abs).sort()) {
      const p = join(abs, name);
      const r = rel ? `${rel}/${name}` : name;
      if (statSync(p).isDirectory()) walk(p, r);
      else out[r] = readFileSync(p, "utf8");
    }
  };
  walk(dir, "");
  return out;
}

function oldFormatFixture(dir) {
  put(dir, "layout/theme.liquid", "LAYOUT");
  put(dir, "section/hero.liquid", "{% schema %}{}{% endschema %}");
  put(dir, "asset/theme.css", "body{color:red}");
  put(dir, "locales/en-US.json", '{"hello":"world"}');
  put(dir, "config/settings_schema.json", "[]");
  put(dir, "config/settings.json", '{"theme":{"color":"red"}}');
  put(dir, "pages/tr-TR/index.json", JSON.stringify({ format_version: 2, slug: "/", title: "Ana Sayfa", locale: "tr-TR", data: { version: 2, sections: [] } }, null, 2) + "\n");
}

test("happy path: dry-run plans every move + leaves pages alone, then --write moves byte-identical content", () => {
  const dir = tmp();
  oldFormatFixture(dir);
  const before = snapshot(dir);

  const plan = migrateSiteState({ dir, write: false });
  assert.equal(plan.refused, false);
  assert.equal(plan.moved, 0);
  assert.deepEqual(
    plan.moves.map((m) => [m.from, m.to]).sort(),
    [
      ["asset/theme.css", "theme/asset/theme.css"],
      ["config/settings.json", "theme/config/settings.json"],
      ["config/settings_schema.json", "theme/config/settings_schema.json"],
      ["layout/theme.liquid", "theme/layout/theme.liquid"],
      ["locales/en-US.json", "theme/locales/en-US.json"],
      ["section/hero.liquid", "theme/section/hero.liquid"],
    ],
  );
  assert.ok(plan.untouched.some((u) => u.path === "pages/tr-TR/index.json"));
  assert.deepEqual(snapshot(dir), before, "dry-run changes nothing on disk");
  assert.equal(plan.needsExport, true, "no blocofy-site.json: still needs `site export` for the rest of the manifest");

  const result = migrateSiteState({ dir, write: true });
  assert.equal(result.refused, false);
  assert.equal(result.moved, 6);

  const after1 = snapshot(dir);
  assert.equal(after1["theme/layout/theme.liquid"], before["layout/theme.liquid"]);
  assert.equal(after1["theme/section/hero.liquid"], before["section/hero.liquid"]);
  assert.equal(after1["theme/asset/theme.css"], before["asset/theme.css"]);
  assert.equal(after1["theme/locales/en-US.json"], before["locales/en-US.json"]);
  assert.equal(after1["theme/config/settings.json"], before["config/settings.json"]);
  assert.equal(after1["theme/config/settings_schema.json"], before["config/settings_schema.json"]);
  // old locations are gone
  assert.equal(after1["layout/theme.liquid"], undefined);
  assert.equal(after1["config/settings.json"], undefined);
  // pages/** never moved (already canonical)
  assert.equal(after1["pages/tr-TR/index.json"], before["pages/tr-TR/index.json"]);
});

test("conflict: target already exists with different content → zero moves, refused", () => {
  const dir = tmp();
  oldFormatFixture(dir);
  put(dir, "theme/layout/theme.liquid", "DIFFERENT CONTENT");
  const before = snapshot(dir);

  const result = migrateSiteState({ dir, write: true });
  assert.equal(result.refused, true);
  assert.equal(result.moved, 0);
  assert.ok(result.diagnostics.some((d) => d.code === "SITE_STATE_MIGRATE_CONFLICT" && d.path === "layout/theme.liquid"));
  assert.deepEqual(snapshot(dir), before, "a refused migration touches nothing");
});

test("a symlink anywhere in the tree refuses the whole migration", () => {
  const dir = tmp();
  oldFormatFixture(dir);
  const outside = tmp();
  writeFileSync(join(outside, "evil.liquid"), "EVIL");
  symlinkSync(join(outside, "evil.liquid"), join(dir, "layout", "linked.liquid"));
  const before = snapshot(dir);

  const result = migrateSiteState({ dir, write: true });
  assert.equal(result.refused, true);
  assert.equal(result.moved, 0);
  assert.ok(result.diagnostics.some((d) => d.code === "SITE_STATE_SYMLINK"));
  assert.deepEqual(snapshot(dir), before);
});

test("an already-migrated (real site-state) tree: nothing to do, exit clean for dry-run and --write alike", () => {
  const dir = tmp();
  put(dir, "blocofy-site.json", JSON.stringify({ schema_version: 1, kind: "blocofy-site-state" }) + "\n");
  put(dir, "site/locales.json", '{"default":"tr-TR","supported":["tr-TR"]}');
  put(dir, "theme/layout/theme.liquid", "LAYOUT");
  put(dir, "theme/config/settings.json", "{}");
  put(dir, "pages/tr-TR/index.json", JSON.stringify({ format_version: 2, slug: "/", title: "Ana Sayfa", locale: "tr-TR", data: { version: 2, sections: [] } }, null, 2) + "\n");
  const before = snapshot(dir);

  const dry = migrateSiteState({ dir, write: false });
  assert.equal(dry.refused, false);
  assert.equal(dry.moves.length, 0);
  assert.equal(dry.needsExport, false);

  const write = migrateSiteState({ dir, write: true });
  assert.equal(write.refused, false);
  assert.equal(write.moves.length, 0);
  assert.equal(write.moved, 0);
  assert.deepEqual(snapshot(dir), before);
});

test("idempotence: running --write twice is a no-op the second time", () => {
  const dir = tmp();
  oldFormatFixture(dir);

  const first = migrateSiteState({ dir, write: true });
  assert.equal(first.refused, false);
  assert.equal(first.moved, 6);
  const afterFirst = snapshot(dir);

  const second = migrateSiteState({ dir, write: true });
  assert.equal(second.refused, false);
  assert.equal(second.moved, 0);
  assert.equal(second.moves.length, 0);
  assert.deepEqual(snapshot(dir), afterFirst, "a second --write changes nothing");
});

test("a project binding (.blocofy/project.json) is never read, moved, or reported", () => {
  const dir = tmp();
  oldFormatFixture(dir);
  put(dir, ".blocofy/project.json", '{"schema_version":1,"site_id":"s1"}');
  const bindingBefore = readFileSync(join(dir, ".blocofy", "project.json"), "utf8");

  const plan = migrateSiteState({ dir, write: false });
  assert.ok(!plan.moves.some((m) => m.from.startsWith(".blocofy/") || m.to.startsWith(".blocofy/")));
  assert.ok(!plan.untouched.some((u) => u.path.startsWith(".blocofy/")));

  migrateSiteState({ dir, write: true });
  assert.equal(readFileSync(join(dir, ".blocofy", "project.json"), "utf8"), bindingBefore);
});

test("a legacy flat page file is left alone with a pointer to `pages migrate-layout`", () => {
  const dir = tmp();
  put(dir, "layout/theme.liquid", "LAYOUT");
  put(dir, "pages/about.json", JSON.stringify({ slug: "/about", title: "About", data: { version: 2, sections: [] } }, null, 2) + "\n");

  const plan = migrateSiteState({ dir, write: false });
  assert.equal(plan.refused, false);
  const left = plan.untouched.find((u) => u.path === "pages/about.json");
  assert.ok(left, "the legacy page file is reported, not silently dropped");
  assert.match(left.reason, /pages migrate-layout/);
});

// ── CLI-level: no credentials anywhere in this block — a real network attempt would fail these tests. ─────

test("CLI: dry-run exits 0, prints the plan, and needs no login", async () => {
  const dir = tmp();
  put(dir, "layout/theme.liquid", "LAYOUT");
  const { stdout } = await execFileAsync(process.execPath, [BIN, "site", "migrate", dir]);
  assert.match(stdout, /move\s+layout\/theme\.liquid → theme\/layout\/theme\.liquid/);
  assert.match(stdout, /1 file\(s\) would move/);
});

test("CLI: --write moves the files and exits 0", async () => {
  const dir = tmp();
  put(dir, "layout/theme.liquid", "LAYOUT");
  const { stdout } = await execFileAsync(process.execPath, [BIN, "site", "migrate", dir, "--write"]);
  assert.match(stdout, /Moved 1 file\(s\)/);
  assert.equal(readFileSync(join(dir, "theme", "layout", "theme.liquid"), "utf8"), "LAYOUT");
});

test("CLI: a conflict exits 1 and moves nothing", async () => {
  const dir = tmp();
  put(dir, "layout/theme.liquid", "A");
  put(dir, "theme/layout/theme.liquid", "B");
  await assert.rejects(execFileAsync(process.execPath, [BIN, "site", "migrate", dir, "--write"]), (e) => {
    assert.equal(e.code, 1);
    assert.match(e.stderr, /Migration refused/);
    return true;
  });
  assert.equal(readFileSync(join(dir, "layout", "theme.liquid"), "utf8"), "A");
});
