import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { folderConflicts, resolveContained } from "./page-files.mjs";
import { THEME_DIRS } from "./local-theme.mjs";
import { MANIFEST_PATH, THEME_SETTINGS_PATH, checkSiteStatePath, ownerOfPath } from "./site-state.mjs";
import { readSiteStateTree } from "./site-state-fs.mjs";

/**
 * CF-T4 — `blocofy site migrate`: turns a directory produced by the OLDER separate pulls (`theme pull`'s
 * theme-dirs-at-root layout, `pages pull`'s canonical `pages/<locale>/…/index.json`, `settings pull`'s
 * `config/settings.json`) into the site-state v1 tree layout (contract §A1). Purely local, zero network:
 * this reuses `readSiteStateTree` — the same symlink-refusing walk `site export`/`site validate` use — to
 * read, and the same contained-path helpers (`resolveContained`, `folderConflicts`) `pages migrate-layout`
 * writes with. No new fs primitives, no identity/target call.
 *
 * `pages/**` files are NEVER moved — a site state uses the exact canonical location `pages pull` already
 * writes (contract §A1). A page still at the OLD flat layout (`pages/<slug>.json`) is left alone with a
 * note pointing at `blocofy pages migrate-layout`, which already owns that reasoning (locale resolution,
 * legacy-vs-canonical detection); duplicating it here would drift.
 *
 * This never invents the owners a directory of separate pulls never had — site/locales.json, globals,
 * media-policy, content-model, translations, navigation, theme/chrome/**, blocofy-site.json itself. Those
 * can only come from the server; `needsExport` says whether this tree is missing its manifest for exactly
 * that reason, so the caller can point at `blocofy site export`.
 */

const SETTINGS_SOURCE = "config/settings.json";
const SETTINGS_SCHEMA_SOURCE = "config/settings_schema.json";
const SETTINGS_SCHEMA_TARGET = "theme/config/settings_schema.json";

/** Old-format relative path → its site-state v1 target, or null when this command does not know how to move it. */
function mapOldPath(path) {
  if (path === SETTINGS_SOURCE) return THEME_SETTINGS_PATH;
  if (path === SETTINGS_SCHEMA_SOURCE) return SETTINGS_SCHEMA_TARGET;
  const top = path.split("/")[0];
  return THEME_DIRS.has(top) ? `theme/${path}` : null;
}

/**
 * Read-only plan: every move this tree needs, every file left alone (and why), every refusal. Never
 * touches disk beyond the read. `moves` is empty and `refused` true together only on a hard error
 * (conflict, symlink, unreadable entry) — never on "nothing to migrate".
 */
export function planSiteMigrate(dir) {
  const tree = readSiteStateTree(dir);
  const errors = [...tree.diagnostics];
  const moves = [];
  const untouched = [];
  const claimed = new Map();

  for (const path of Object.keys(tree.files).sort()) {
    if (path === MANIFEST_PATH || ownerOfPath(path) !== null) {
      untouched.push({ path, reason: "already in the site-state tree layout" });
      continue;
    }
    const target = mapOldPath(path);
    if (target === null) {
      untouched.push({
        path,
        reason: path.startsWith("pages/")
          ? "old flat page layout — run `blocofy pages migrate-layout` first"
          : "not part of the site-state tree — left alone",
      });
      continue;
    }
    const refusal = checkSiteStatePath(target);
    if (refusal) {
      errors.push({ level: "error", code: refusal.code, message: `${path} → ${target}: ${refusal.reason}`, path });
      continue;
    }
    const existing = tree.files[target];
    if (existing !== undefined) {
      if (existing === tree.files[path]) {
        untouched.push({ path, reason: `${target} already holds the same content; left in place (remove ${path} yourself)` });
        continue;
      }
      errors.push({ level: "error", code: "SITE_STATE_MIGRATE_CONFLICT", message: `${target} already exists with different content than ${path}`, path });
      continue;
    }
    const claimant = claimed.get(target);
    if (claimant) {
      errors.push({ level: "error", code: "SITE_STATE_MIGRATE_CONFLICT", message: `${path} and ${claimant} would both move to ${target}`, path });
      continue;
    }
    claimed.set(target, path);
    moves.push({ from: path, to: target, content: tree.files[path] });
  }
  for (const asset of tree.assets) untouched.push({ path: asset.path, reason: "already in the site-state tree layout" });

  moves.sort((a, b) => (a.from < b.from ? -1 : 1));
  const remaining = Object.keys(tree.files).filter((p) => !moves.some((m) => m.from === p));
  errors.push(...folderConflicts([...remaining, ...moves.map((m) => m.to)]));

  const refused = errors.length > 0;
  const needsExport = tree.files[MANIFEST_PATH] === undefined;
  return { root: tree.root, moves, untouched, diagnostics: errors, refused, needsExport };
}

/**
 * Performs `moves` (from `planSiteMigrate`) on `root`: every target is revalidated (contained, not already
 * present) before the first byte is written; then each file is written+renamed into place and only then is
 * its old location removed. A mid-loop fs failure (real I/O error, not a logic conflict — those were already
 * refused by the plan) leaves everything moved so far in place and throws, naming how many completed.
 */
export function writeSiteMigrate(root, moves) {
  for (const m of moves) {
    const r = resolveContained(root, m.to);
    if (r.error) throw new Error(`internal: ${m.to} is not a valid site-state target (${r.error.reason})`);
    if (existsSync(r.target)) throw new Error(`${m.to} appeared during migration; stopped before moving it.`);
  }
  let moved = 0;
  for (const m of moves) {
    const { target } = resolveContained(root, m.to);
    mkdirSync(dirname(target), { recursive: true });
    const temp = `${target}.blocofy-tmp`;
    writeFileSync(temp, m.content, { flag: "wx" });
    renameSync(temp, target);
    const { target: legacy } = resolveContained(root, m.from);
    rmSync(legacy);
    moved += 1;
  }
  return moved;
}

/** `blocofy site migrate`: plan, and with `write: true` perform it. Any refusal moves zero files. */
export function migrateSiteState({ dir, write = false }) {
  const plan = planSiteMigrate(dir);
  if (!write || plan.refused) return { ...plan, moved: 0 };
  const moved = writeSiteMigrate(plan.root, plan.moves);
  return { ...plan, moved };
}
