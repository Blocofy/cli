import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { folderConflicts, resolveContained } from "./page-files.mjs";
import { ASSET_FILES_PREFIX } from "./site-state.mjs";

/**
 * CF-T4 — the site-state tree on a real filesystem: a read that refuses symlinks (lstat every entry) and
 * an all-or-nothing staged write. Kept separate from `lib/site-state.mjs` (pure, read-free) and from
 * `lib/page-files.mjs` (PS-19 `pages/**` specifically) because a site-state tree has its own root shape
 * (`blocofy-site.json`, `site/`, `theme/`, `pages/`, `media/`) and its own binary member (`media/files/<sha256>`).
 */

export class SiteStateFsError extends Error {
  constructor(code, message, diagnostics = []) {
    super(message);
    this.name = "SiteStateFsError";
    this.code = code;
    this.diagnostics = diagnostics;
  }
}

/**
 * Read every file under `root`. Returns `{ root, files, assets, diagnostics }`:
 *   - `files`: relPath → utf8 content, for every path EXCEPT `media/files/<sha256>` (those are binary
 *     asset bytes, never decoded as text — the request body never carries them either, contract §A1).
 *   - `assets`: `{ path, sha256, abs, bytes }` for every `media/files/<sha256>` entry found.
 *   - `diagnostics`: a symlink or a non-regular-file entry (`SITE_STATE_SYMLINK` / `SITE_STATE_INVALID_PATH`),
 *     never thrown — callers that must refuse on any diagnostic (export, plan, apply) check the array.
 * A dot-prefixed entry AT THE ROOT (`.git`, `.blocofy`, `.DS_Store`, …) is silently skipped: those are
 * project tooling, not part of the site-state tree. A dot-prefixed entry found INSIDE a known folder
 * (`theme/assets/.hidden.css`) is walked into and reported by `checkSiteStatePath`, same as the platform.
 */
export function readSiteStateTree(root) {
  const realRoot = realpathSync(root);
  const files = {};
  const assets = [];
  const diagnostics = [];
  const walk = (abs, relParts) => {
    let names;
    try {
      names = readdirSync(abs).sort();
    } catch (error) {
      diagnostics.push({ level: "error", code: "SITE_STATE_INVALID_PATH", message: `could not read directory (${error?.message ?? error})`, path: relParts.join("/") || "." });
      return;
    }
    for (const name of names) {
      if (relParts.length === 0 && name.startsWith(".")) continue;
      const childAbs = join(abs, name);
      const childRel = [...relParts, name].join("/");
      const st = lstatSync(childAbs);
      if (st.isSymbolicLink()) {
        diagnostics.push({ level: "error", code: "SITE_STATE_SYMLINK", message: "symbolic links are not read", path: childRel });
        continue;
      }
      if (st.isDirectory()) {
        walk(childAbs, [...relParts, name]);
        continue;
      }
      if (!st.isFile()) {
        diagnostics.push({ level: "error", code: "SITE_STATE_INVALID_PATH", message: "not a regular file", path: childRel });
        continue;
      }
      if (childRel.startsWith(ASSET_FILES_PREFIX)) {
        assets.push({ path: childRel, sha256: childRel.slice(ASSET_FILES_PREFIX.length), abs: childAbs, bytes: st.size });
      } else {
        files[childRel] = readFileSync(childAbs, "utf8");
      }
    }
  };
  walk(realRoot, []);
  return { root: realRoot, files, assets, diagnostics };
}

/** sha256 (lowercase hex) of a local file's actual bytes. */
export function hashFile(abs) {
  return createHash("sha256").update(readFileSync(abs)).digest("hex");
}

/**
 * All-or-nothing write of a site-state tree. `entries` is `[relPath, content]`, content a string or a
 * `Buffer` (asset bytes). Every path is validated (traversal/absolute/backslash/symlink-in-ancestor)
 * before the first byte is written; then every file is staged into a temp directory under `root`, and
 * only when every file is staged are they renamed into place. Mirrors `page-files.mjs`'s `stagedWrite`,
 * generalized to binary content.
 */
export function stagedWriteTree(root, entries) {
  const errors = folderConflicts(entries.map(([rel]) => rel));
  const targets = [];
  for (const [rel, content] of entries) {
    const r = resolveContained(root, rel);
    if (r.error) errors.push({ level: "error", code: r.error.code, message: r.error.reason, path: rel });
    else targets.push([rel, r.target, content]);
  }
  if (errors.length > 0) {
    throw new SiteStateFsError("SITE_STATE_WRITE_FAILED", "Refusing to write outside the target directory; nothing was written.", errors);
  }

  mkdirSync(root, { recursive: true });
  const staging = mkdtempSync(join(root, ".blocofy-site-state-staging-"));
  try {
    targets.forEach(([, , content], i) => writeFileSync(join(staging, String(i)), content));
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw new SiteStateFsError("SITE_STATE_WRITE_FAILED", `Could not stage files (${error?.message ?? error}); nothing was written.`);
  }
  let written = 0;
  try {
    targets.forEach(([, target], i) => {
      mkdirSync(dirname(target), { recursive: true });
      renameSync(join(staging, String(i)), target);
      written += 1;
    });
  } catch (error) {
    throw new SiteStateFsError(
      "SITE_STATE_WRITE_FAILED",
      `Stopped after writing ${written} of ${targets.length} files (${error?.message ?? error}); written: ${targets.slice(0, written).map(([rel]) => rel).join(", ") || "none"}.`,
    );
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return written;
}
