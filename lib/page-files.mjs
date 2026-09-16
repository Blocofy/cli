import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";

import {
  PAGE_FILE_FORMAT_VERSION,
  PageFileError,
  canonicalizeLocaleCode,
  checkPageSlug,
  checkRelativePagePath,
  isCanonicalLayoutPath,
  legacyPageFilePath,
  pageFilePath,
  parsePageFilePath,
} from "./page-path-codec.mjs";

/**
 * PS-19 — local page files: what a file is (mirror of the platform's `page-files/file-format.ts`), how the CLI
 * reads and writes them without leaving the target directory, and how findings are printed.
 */

export const PAGE_META_KEYS = ["title", "seo_title", "seo_description", "og_image", "canonical_url"];
const NULLABLE_STRING_KEYS = [...PAGE_META_KEYS, "status", "template"];
const V2_KEY_ORDER = ["format_version", "slug", "title", "status", "seo_title", "seo_description", "og_image", "canonical_url", "locale", "template", "data"];

/** A refusal the CLI prints with its stable code. `diagnostics` are platform-shaped findings. */
export class PagesCliError extends Error {
  constructor(code, message, { diagnostics = [], pages = null, status = null } = {}) {
    super(message);
    this.name = "PagesCliError";
    this.code = code;
    this.diagnostics = diagnostics;
    this.pages = pages;
    this.status = status;
  }
}

const isPlainObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const isCanonicalLocale = (v) => typeof v === "string" && canonicalizeLocaleCode(v) === v;

/**
 * Classify one page file. `ctx.defaultLocale` null means offline: a legacy file with no locale key is accepted
 * with `locale: null` (the server decides). `ctx.supportedLocales` omitted → not checked.
 */
export function classifyPageFile(path, content, ctx = {}) {
  const fail = (code, message, extra = {}) => ({ ok: false, path, code, message, ...extra });
  const unsafe = checkRelativePagePath(path);
  if (unsafe) return fail(unsafe.code, unsafe.reason);
  let json;
  try {
    json = JSON.parse(content);
  } catch {
    return fail("PAGES_INVALID_JSON", "file is not valid JSON");
  }
  if (!isPlainObject(json)) return fail("PAGES_INVALID_JSON", "file must contain a JSON object");
  const isV2 = Object.prototype.hasOwnProperty.call(json, "format_version");
  if (isV2 && json.format_version !== PAGE_FILE_FORMAT_VERSION) {
    return fail("PAGES_UNSUPPORTED_FORMAT", `format_version ${JSON.stringify(json.format_version)} is not supported`);
  }
  const slugReason = checkPageSlug(json.slug);
  if (slugReason) return fail("PAGES_INVALID_SLUG", `slug ${JSON.stringify(json.slug)}: ${slugReason}`);
  const slug = json.slug;
  if (!isPlainObject(json.data)) return fail("PAGES_INVALID_JSON", "data must be a JSON object", { slug });
  for (const key of NULLABLE_STRING_KEYS) {
    if (key in json && json[key] !== null && typeof json[key] !== "string") return fail("PAGES_INVALID_JSON", `${key} must be a string or null`, { slug });
  }
  const hasLocale = Object.prototype.hasOwnProperty.call(json, "locale");
  let locale = null;
  let localeSource;
  if (hasLocale) {
    if (!isCanonicalLocale(json.locale)) return fail("PAGES_INVALID_LOCALE", `locale ${JSON.stringify(json.locale)} is not a canonical locale code`, { slug });
    locale = json.locale;
    localeSource = "file";
  } else if (isV2) {
    return fail("PAGES_INVALID_LOCALE", "format_version 2 files must carry an explicit locale", { slug });
  } else {
    locale = ctx.defaultLocale ?? null;
    localeSource = ctx.defaultLocale ? "default" : "unresolved";
  }

  if (isV2) {
    const parsed = parsePageFilePath(path);
    if (parsed.kind === "invalid") return fail(parsed.code, parsed.reason, { locale, slug });
    if (parsed.kind === "other") return fail("PAGES_INVALID_PATH", `format_version 2 files must use the canonical layout (${pageFilePath(locale, slug)})`, { locale, slug });
    if (parsed.locale !== locale) return fail("PAGES_LOCALE_PATH_MISMATCH", `folder locale "${parsed.locale}" does not match file locale "${locale}"`, { locale, slug });
    const expected = pageFilePath(locale, slug);
    if (expected !== path) return fail("PAGES_INVALID_PATH", `slug ${JSON.stringify(slug)} belongs at ${expected}`, { locale, slug });
  } else if (isCanonicalLayoutPath(path) || legacyPageFilePath(slug) !== path) {
    return fail("PAGES_AMBIGUOUS_LAYOUT", `file has no format_version but is not at its legacy location (${legacyPageFilePath(slug)})`, { ...(locale ? { locale } : {}), slug });
  }
  if (locale && ctx.supportedLocales && !ctx.supportedLocales.includes(locale)) {
    return fail("PAGES_UNSUPPORTED_LOCALE", `locale "${locale}" is not published on this site`, { locale, slug });
  }
  return { ok: true, path, layout: isV2 ? "v2" : "legacy", locale, slug, localeSource, parsed: json };
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isPlainObject(value)) return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

export function pageFileSemanticKey(parsed) {
  const meta = {};
  for (const key of PAGE_META_KEYS) meta[key] = typeof parsed[key] === "string" ? parsed[key] : null;
  return stableStringify({ meta, data: parsed.data ?? null });
}

/** A legacy payload re-serialised as a v2 file: `format_version` first, explicit locale, unknown keys kept. */
export function serializeV2PageFile(parsed, locale) {
  const out = {};
  const source = { ...parsed, format_version: PAGE_FILE_FORMAT_VERSION, locale };
  for (const key of V2_KEY_ORDER) if (key in source) out[key] = source[key];
  for (const key of Object.keys(parsed)) if (!(key in out)) out[key] = parsed[key];
  return JSON.stringify(out, null, 2) + "\n";
}

/**
 * Local files checked for errors that only the local tree can have: duplicates between legacy and v2 files for
 * the same (locale, slug). Files whose locale is unresolved offline are left to the server.
 */
export function checkLocalBatch(classified) {
  const diagnostics = [];
  const groups = new Map();
  for (const c of classified) {
    if (!c.ok) {
      diagnostics.push({ level: "error", code: c.code, message: c.message, path: c.path, ...(c.locale ? { locale: c.locale } : {}), ...(c.slug ? { slug: c.slug } : {}) });
      continue;
    }
    if (c.layout === "legacy") {
      diagnostics.push({
        level: "warning",
        code: "PAGES_LEGACY_LAYOUT",
        message: c.locale ? `legacy layout (deprecated); canonical location is ${pageFilePath(c.locale, c.slug)}` : "legacy layout (deprecated); its language is decided by the site's default locale",
        path: c.path,
        ...(c.locale ? { locale: c.locale } : {}),
        slug: c.slug,
      });
    }
    if (!c.locale) continue;
    const key = `${c.locale} ${c.slug}`;
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const { locale, slug } = group[0];
    if (new Set(group.map((c) => pageFileSemanticKey(c.parsed))).size === 1) {
      for (const c of group.slice(1)) diagnostics.push({ level: "warning", code: "PAGES_DUPLICATE_EQUIVALENT", message: `same content as ${group[0].path}`, path: c.path, locale, slug });
    } else {
      for (const c of group) {
        diagnostics.push({ level: "error", code: "PAGES_DUPLICATE_TARGET", message: `Two files resolve to locale "${locale}", slug "${slug}": ${group.map((g) => g.path).join(", ")}`, path: c.path, locale, slug });
      }
    }
  }
  return diagnostics;
}

// ── filesystem ────────────────────────────────────────────────────────────────────────────────────────────

/** Generic repository-relative path safety (pages and config). */
export function checkRelativePath(rel) {
  if (typeof rel !== "string" || rel === "") return { code: "PAGES_INVALID_PATH", reason: "empty path" };
  if (rel.startsWith("/") || /^[A-Za-z]:/.test(rel) || isAbsolute(rel)) return { code: "PAGES_PATH_ESCAPE", reason: "absolute path" };
  if (rel.includes("\\")) return { code: "PAGES_PATH_ESCAPE", reason: "backslash in path" };
  const parts = rel.split("/");
  if (parts.includes("..")) return { code: "PAGES_PATH_ESCAPE", reason: "'..' in path" };
  if (/[\x00-\x1f\x7f-\x9f]/.test(rel)) return { code: "PAGES_INVALID_PATH", reason: "control character in path" };
  if (parts.some((p) => p === "" || p === ".")) return { code: "PAGES_INVALID_PATH", reason: "empty or '.' path segment" };
  return null;
}

function lstatOrNull(p) {
  try {
    return lstatSync(p);
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
}

/**
 * `root` (already realpath'd) + a relative path → the absolute target, refusing anything that would leave the
 * root: traversal, absolute paths, backslashes, a symlink at any existing ancestor or at the target, and a
 * target that exists but is not a regular file. Null error means safe.
 */
export function resolveContained(root, rel) {
  const unsafe = checkRelativePath(rel);
  if (unsafe) return { error: { ...unsafe, path: rel } };
  const parts = rel.split("/");
  const target = join(root, ...parts);
  const back = relative(root, target);
  if (back.startsWith("..") || isAbsolute(back)) return { error: { code: "PAGES_PATH_ESCAPE", reason: "path leaves the target directory", path: rel } };
  let current = root;
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]);
    const st = lstatOrNull(current);
    if (!st) break;
    if (st.isSymbolicLink()) return { error: { code: "PAGES_PATH_ESCAPE", reason: `${parts.slice(0, i + 1).join("/")} is a symbolic link`, path: rel } };
    const last = i === parts.length - 1;
    if (!last && !st.isDirectory()) return { error: { code: "PAGES_INVALID_PATH", reason: `${parts.slice(0, i + 1).join("/")} is not a directory`, path: rel } };
    if (last && !st.isFile()) return { error: { code: "PAGES_INVALID_PATH", reason: "target exists and is not a regular file", path: rel } };
  }
  return { target };
}

/**
 * Every `pages/**.json` under `dir`, in lexical path order, WITHOUT following symlinks. Symlinks and non-regular
 * files are findings, not files. Other extensions are ignored (a README next to the pages is fine).
 */
export function collectPageFiles(dir) {
  const root = realpathSync(dir);
  const files = [];
  const errors = [];
  const pagesDir = join(root, "pages");
  const top = lstatOrNull(pagesDir);
  if (!top) return { root, files, errors };
  if (top.isSymbolicLink()) return { root, files, errors: [{ level: "error", code: "PAGES_PATH_ESCAPE", message: "pages/ is a symbolic link", path: "pages" }] };
  if (!top.isDirectory()) return { root, files, errors: [{ level: "error", code: "PAGES_INVALID_PATH", message: "pages is not a directory", path: "pages" }] };
  const walk = (abs, relParts) => {
    const names = readdirSync(abs).sort();
    for (const name of names) {
      const childAbs = join(abs, name);
      const childRel = ["pages", ...relParts, name].join("/");
      const st = lstatSync(childAbs);
      if (st.isSymbolicLink()) {
        errors.push({ level: "error", code: "PAGES_PATH_ESCAPE", message: "symbolic links are not followed", path: childRel });
      } else if (st.isDirectory()) {
        walk(childAbs, [...relParts, name]);
      } else if (!st.isFile()) {
        if (name.endsWith(".json")) errors.push({ level: "error", code: "PAGES_INVALID_PATH", message: "not a regular file", path: childRel });
      } else if (name.endsWith(".json")) {
        files.push([childRel, readFileSync(childAbs, "utf8")]);
      } else if (/\.json\s*$/i.test(name)) {
        // `about.JSON` or `about.json ` would otherwise be skipped silently while the author believes it was pushed.
        errors.push({ level: "error", code: "PAGES_INVALID_PATH", message: "page file names must end in lowercase .json", path: childRel });
      }
    }
  };
  walk(pagesDir, []);
  files.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  errors.sort((a, b) => (a.path < b.path ? -1 : 1));
  return { root, files, errors };
}

/** A target that another target needs as a folder (`a/index.json` vs `a/index.json/index.json`) cannot coexist. */
export function folderConflicts(rels) {
  const set = new Set(rels);
  const out = [];
  for (const rel of rels) {
    const parts = rel.split("/");
    for (let i = 1; i < parts.length; i++) {
      const prefix = parts.slice(0, i).join("/");
      if (set.has(prefix)) out.push({ level: "error", code: "PAGES_INVALID_PATH", message: `${prefix} would have to be both a file and a folder`, path: rel });
    }
  }
  return out;
}

/**
 * Write `entries` ([rel, content]) under `root` in two phases. Every path is validated first; then all content is
 * written to a staging directory inside `root`; only when every file is staged are they renamed into place.
 * A failure before the rename phase leaves the destination exactly as it was.
 */
export function stagedWrite(root, entries, { writeFile = writeFileSync, rename = renameSync } = {}) {
  const errors = folderConflicts(entries.map(([rel]) => rel));
  const targets = [];
  for (const [rel, content] of entries) {
    const r = resolveContained(root, rel);
    if (r.error) errors.push({ level: "error", code: r.error.code, message: r.error.reason, path: rel });
    else targets.push([rel, r.target, content]);
  }
  if (errors.length > 0) throw new PagesCliError(errors[0].code, "Refusing to write outside the target directory; nothing was written.", { diagnostics: errors });

  const staging = mkdtempSync(join(root, ".blocofy-staging-"));
  try {
    targets.forEach(([rel, , content], i) => {
      const staged = join(staging, String(i));
      writeFile(staged, typeof content === "string" ? content : "");
    });
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw new PagesCliError("PAGES_WRITE_FAILED", `Could not stage files (${error?.message ?? error}); nothing was written.`);
  }
  let written = 0;
  try {
    targets.forEach(([, target], i) => {
      mkdirSync(dirname(target), { recursive: true });
      rename(join(staging, String(i)), target);
      written += 1;
    });
  } catch (error) {
    throw new PagesCliError(
      "PAGES_WRITE_FAILED",
      `Stopped after writing ${written} of ${targets.length} files (${error?.message ?? error}); written: ${targets.slice(0, written).map(([rel]) => rel).join(", ") || "none"}.`,
    );
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return written;
}

// ── output ────────────────────────────────────────────────────────────────────────────────────────────────

export function formatDiagnostic(d) {
  const where = d.path ? `\n    ${d.path}` : d.slug ? `\n    ${d.locale ? `locale "${d.locale}", ` : ""}slug "${d.slug}"` : "";
  return `${d.level} [${d.code}]:\n    ${d.message}${where}`;
}

export { PageFileError, pageFilePath };
