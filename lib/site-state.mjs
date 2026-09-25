import { createHash } from "node:crypto";

import { canonicalizeLocaleCode, pageFilePath, parsePageFilePath } from "./page-path-codec.mjs";
import { classifyPageFile } from "./page-files.mjs";

/**
 * CF-T4 — Declarative Site State, the PURE half. Mirror of the platform's `packages/cms/src/site-state/*`
 * (paths.ts, canonical.ts, manifest.ts, diff.ts, validate.ts), one file because the CLI keeps its mirrors
 * flat (see `lib/page-path-codec.mjs`). No database, no filesystem, no network — `test/fixtures/site-state-vectors.json`
 * is the shared oracle with the platform; a vector changed on one side and not the other is a drift.
 *
 * Page-path pieces (`pageFilePath`, `parsePageFilePath`, `canonicalizeLocaleCode`, `classifyPageFile`) are
 * NOT re-implemented here — they are the CLI's existing PS-19 mirrors (`page-path-codec.mjs`, `page-files.mjs`),
 * reused so there is exactly one page-path grammar in this codebase.
 */

export const SITE_STATE_SCHEMA_VERSION = 1;
export const SITE_STATE_KIND = "blocofy-site-state";
export const MANIFEST_PATH = "blocofy-site.json";

export const SITE_STATE_OWNERS = [
  "locales",
  "globals",
  "media_policy",
  "content_model",
  "translations",
  "navigation",
  "theme",
  "settings",
  "chrome",
  "pages",
  "media_decisions",
  "assets",
];

export const SITE_LOCALES_PATH = "site/locales.json";
export const SITE_GLOBALS_PATH = "site/globals.json";
export const SITE_MEDIA_POLICY_PATH = "site/media-policy.json";
export const SITE_CONTENT_MODEL_PATH = "site/content-model.json";
export const SITE_TRANSLATIONS_PATH = "site/translations.json";
export const THEME_SETTINGS_PATH = "theme/config/settings.json";
export const THEME_CHROME_HEADER_PATH = "theme/chrome/header_group.json";
export const THEME_CHROME_FOOTER_PATH = "theme/chrome/footer_group.json";
export const ASSETS_INDEX_PATH = "media/assets.json";
export const ASSET_FILES_PREFIX = "media/files/";
export const PAGE_FILE_NAME = "index.json";
export const PAGE_MEDIA_DECISIONS_NAME = "media-decisions.json";

export const SITE_STATE_LIMITS = {
  pageFiles: 500,
  pageBytes: 4 * 1024 * 1024,
  themeFiles: 256,
  themeBytes: 4 * 1024 * 1024,
  navigationMenus: 50,
  navigationItems: 500,
  assetFiles: 200,
  assetBytes: 50 * 1024 * 1024,
  assetTotalBytes: 256 * 1024 * 1024,
  requestBytes: 16 * 1024 * 1024,
  segmentBytes: 200,
  pathBytes: 400,
};

const utf8 = new TextEncoder();
const byteLength = (s) => utf8.encode(s).length;

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
const WINDOWS_FORBIDDEN = /[<>:"|?*]/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const LOCALE_SEGMENT = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
const NAV_HANDLE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

// ── paths ────────────────────────────────────────────────────────────────────────────────────────────────

/** Why this path may not appear in a site-state tree, or null when it may. */
export function checkSiteStatePath(path) {
  const invalid = (reason) => ({ code: "SITE_STATE_INVALID_PATH", reason });
  if (typeof path !== "string" || path === "") return invalid("empty path");
  if (byteLength(path) > SITE_STATE_LIMITS.pathBytes) return invalid(`path is longer than ${SITE_STATE_LIMITS.pathBytes} bytes`);
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) return invalid("absolute path");
  if (path.includes("\\")) return invalid("backslash in path");
  if (CONTROL.test(path)) return invalid("control character in path");
  if (LONE_SURROGATE.test(path)) return invalid("path is not well-formed Unicode");
  if (path.normalize("NFC") !== path) return invalid("path is not in Unicode NFC form");
  for (const segment of path.split("/")) {
    if (segment === "") return invalid("empty path segment");
    if (segment === "." || segment === "..") return invalid("'.' or '..' path segment");
    if (segment.startsWith(".")) return invalid("leading-dot path segment");
    if (segment.endsWith(".") || segment.endsWith(" ") || segment.startsWith(" ")) {
      return invalid("path segment ends with a dot or space");
    }
    if (WINDOWS_FORBIDDEN.test(segment)) return invalid("path segment contains a character Windows refuses");
    if (WINDOWS_RESERVED.test(segment.split(".")[0] ?? "")) return invalid("Windows reserved path segment");
    if (byteLength(segment) > SITE_STATE_LIMITS.segmentBytes) {
      return invalid(`path segment is longer than ${SITE_STATE_LIMITS.segmentBytes} bytes`);
    }
  }
  if (path === MANIFEST_PATH) return null;
  return ownerOfPath(path) === null ? { code: "SITE_STATE_UNKNOWN_PATH", reason: "not a site-state file" } : null;
}

/** Which owner this path belongs to, or null when nothing owns it. */
export function ownerOfPath(path) {
  if (path === MANIFEST_PATH) return null;
  if (path === SITE_LOCALES_PATH) return "locales";
  if (path === SITE_GLOBALS_PATH) return "globals";
  if (path === SITE_MEDIA_POLICY_PATH) return "media_policy";
  if (path === SITE_CONTENT_MODEL_PATH) return "content_model";
  if (path === SITE_TRANSLATIONS_PATH) return "translations";
  if (path === ASSETS_INDEX_PATH) return "assets";
  if (path === THEME_SETTINGS_PATH) return "settings";
  if (path === THEME_CHROME_HEADER_PATH || path === THEME_CHROME_FOOTER_PATH) return "chrome";

  const parts = path.split("/");
  if (parts[0] === "site" && parts[1] === "navigation") {
    if (parts.length !== 4 || !LOCALE_SEGMENT.test(parts[2]) || !parts[3].endsWith(".json")) return null;
    return NAV_HANDLE.test(parts[3].slice(0, -".json".length)) ? "navigation" : null;
  }
  if (parts[0] === "pages") {
    const last = parts[parts.length - 1];
    if (last === PAGE_FILE_NAME) return parsePageFilePath(path).kind === "invalid" ? null : "pages";
    if (last === PAGE_MEDIA_DECISIONS_NAME) {
      const sibling = [...parts.slice(0, -1), PAGE_FILE_NAME].join("/");
      return parsePageFilePath(sibling).kind === "invalid" ? null : "media_decisions";
    }
    return null;
  }
  if (path.startsWith(ASSET_FILES_PREFIX)) {
    return SHA256_HEX.test(path.slice(ASSET_FILES_PREFIX.length)) ? "assets" : null;
  }
  if (parts[0] === "theme" && parts.length >= 2) {
    if (parts[1] === "chrome") return null;
    return "theme";
  }
  return null;
}

export function pageStatePaths(locale, slug) {
  const page = pageFilePath(locale, slug);
  return { page, mediaDecisions: page.slice(0, -PAGE_FILE_NAME.length) + PAGE_MEDIA_DECISIONS_NAME };
}

export function navigationPath(locale, handle) {
  return `site/navigation/${locale}/${handle}.json`;
}

export function chromePath(area) {
  return area === "header" ? THEME_CHROME_HEADER_PATH : THEME_CHROME_FOOTER_PATH;
}

const foldPath = (path) => path.normalize("NFC").toLowerCase();

/** Whole-tree path checks: every path's own grammar, plus casefold + file/folder collisions. */
export function checkSiteStateTreePaths(paths) {
  const out = [];
  for (const path of paths) {
    const refusal = checkSiteStatePath(path);
    if (refusal) out.push({ level: "error", code: refusal.code, message: refusal.reason, path });
  }
  const byFold = new Map();
  for (const path of [...paths].sort()) {
    const fold = foldPath(path);
    const seen = byFold.get(fold);
    if (seen !== undefined && seen !== path) {
      out.push({
        level: "error",
        code: "SITE_STATE_PATH_CASEFOLD_COLLISION",
        message: `${path} and ${seen} are the same file on a case-insensitive filesystem`,
        path,
      });
    } else {
      byFold.set(fold, path);
    }
  }
  const folders = new Set();
  for (const path of paths) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) folders.add(foldPath(parts.slice(0, i).join("/")));
  }
  for (const path of [...paths].sort()) {
    if (folders.has(foldPath(path))) {
      out.push({
        level: "error",
        code: "SITE_STATE_INVALID_PATH",
        message: `${path} is both a file and a folder in this tree`,
        path,
      });
    }
  }
  return out;
}

// ── canonical (semantic view + asset-ref codec) ─────────────────────────────────────────────────────────

export const ASSET_REF_PREFIX = "asset:sha256:";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Mirror of the platform's `SVG_ASSET_ID_RE` (media/media-ref.ts): a platform SVG asset id, stored lowercase only. */
const SVG_ASSET_ID_RE = /^bsvg_[0-9abcdefghjkmnpqrstvwxyz]{26}$/;
// Mirror of the platform's asset-ref.ts grammar (W1 C1 + a8e8666c), piece for piece: FULL-VALUE anchored — only a
// value that IS one platform asset URL matches; HTML, CSS url(...) or a sentence containing one is carried as is.
// Whitespace, ", <, > and \ appear nowhere; the host also excludes ' ( ); the path, query and fragment admit ( ) '
// (encodeURIComponent leaves them unescaped in a media-picker URL such as ".../logo%20(1).png").
const ASSET_UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const ASSET_HOST = String.raw`(?:(?:https?:)?\/\/[^\s\/?#"'<>()\\]+)?`;
const ASSET_TAIL = String.raw`(?:\/[^\s?#"<>\\]*)?(?:\?[^\s#"<>\\]*)?(?:#[^\s"<>\\]*)?`;
export const PLATFORM_ASSET_RE = new RegExp(String.raw`^${ASSET_HOST}\/(?:cdn|assets)\/(${ASSET_UUID})${ASSET_TAIL}$`, "i");
export const PLATFORM_SVG_RE = new RegExp(String.raw`^${ASSET_HOST}\/cdn\/svg\/(bsvg_[0-9abcdefghjkmnpqrstvwxyz]{26})${ASSET_TAIL}$`);
export const PLATFORM_METADATA_KEY = "platform";
export const MEDIA_DECISION_AUDIT_FIELDS = ["decided_by", "decided_at", "policy_version"];

export const assetRef = (sha256) => `${ASSET_REF_PREFIX}${sha256}`;

export function parseAssetRef(value) {
  if (typeof value !== "string" || !value.startsWith(ASSET_REF_PREFIX)) return null;
  const sha = value.slice(ASSET_REF_PREFIX.length);
  return SHA256_HEX.test(sha) ? sha : null;
}

/**
 * Mirror of the platform's `parseMediaRef` (media/media-ref.ts): a bare stored reference → its canonical id (a
 * Directus uuid, lowercased; a platform SVG id exactly as stored), or null.
 */
function mediaRefId(value) {
  if (typeof value !== "string") return null;
  if (SVG_ASSET_ID_RE.test(value)) return value;
  if (UUID_RE.test(value)) return value.toLowerCase();
  return null;
}

/** Mirror of the platform's `normalizeAssetRef` (asset-ref.ts): a value that IS one platform asset reference → its id. */
export function normalizeAssetRef(value) {
  if (typeof value !== "string") return value;
  const v = value.trim();
  if (!v) return value;
  const bare = mediaRefId(v);
  if (bare) return bare;
  const m = v.match(PLATFORM_ASSET_RE) ?? v.match(PLATFORM_SVG_RE);
  if (m) return mediaRefId(m[1]) ?? value;
  return value;
}

export function emptyAssetReport() {
  return { used: new Set(), foreign: new Set(), missing: new Set() };
}

function mapStrings(value, fn) {
  if (typeof value === "string") return fn(value);
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = mapStrings(v, fn);
    return out;
  }
  return value;
}

export function encodeAssetRefs(value, shaOf, report) {
  return mapStrings(value, (s) => {
    // Full-value anchored (W1 C1): only a string that IS one reference is rewritten. A platform SVG id goes through
    // the same lookup as a Directus uuid.
    const ref = mediaRefId(normalizeAssetRef(s));
    if (ref === null) return s;
    const sha = shaOf(ref);
    if (sha === null) {
      report.foreign.add(ref);
      return s;
    }
    report.used.add(sha);
    return assetRef(sha);
  });
}

export function decodeAssetRefs(value, uuidOf, report) {
  return mapStrings(value, (s) => {
    const sha = parseAssetRef(s);
    if (sha === null) return s;
    const uuid = uuidOf(sha);
    if (uuid === null) {
      report.missing.add(sha);
      return s;
    }
    report.used.add(sha);
    return uuid;
  });
}

const DROPPED_TOP_LEVEL = ["exported_at", "source_site", "base_revision"];
const DROPPED_FROM_PAGE = ["status", "dynamic_collection"];

const isRecord = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/** Text normalization for a non-JSON file (a theme source file): NFC + LF. */
export const normalizeText = (content) => content.normalize("NFC").replace(/\r\n?/g, "\n");

function withoutKeys(record, keys) {
  const out = { ...record };
  for (const key of keys) delete out[key];
  return out;
}

function canonicalValue(path, parsed) {
  if (!isRecord(parsed)) {
    if (Array.isArray(parsed) && path.endsWith("media-decisions.json")) {
      return parsed.map((entry) => (isRecord(entry) ? withoutKeys(entry, MEDIA_DECISION_AUDIT_FIELDS) : entry));
    }
    return parsed;
  }
  const out = withoutKeys(parsed, path.endsWith("/index.json") && path.startsWith("pages/") ? [...DROPPED_TOP_LEVEL, ...DROPPED_FROM_PAGE] : DROPPED_TOP_LEVEL);
  if (isRecord(out.data)) out.data = withoutKeys(out.data, [PLATFORM_METADATA_KEY]);
  if (Array.isArray(out.decisions)) {
    out.decisions = out.decisions.map((e) => (isRecord(e) ? withoutKeys(e, MEDIA_DECISION_AUDIT_FIELDS) : e));
  }
  return out;
}

/** The comparable value of one file: parsed + provenance-stripped JSON, or normalized text. */
export function canonicalFileView(path, content) {
  if (!path.endsWith(".json")) return normalizeText(content);
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    return normalizeText(content);
  }
  return canonicalValue(path, parsed);
}

export function fileDigest(path, content) {
  return sha256Hex(stableStringify(canonicalFileView(path, content)));
}

export function sha256Hex(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Key-order-insensitive JSON (mirror of page-files/base-revision.ts). */
export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

// ── manifest ─────────────────────────────────────────────────────────────────────────────────────────────

/** Per-owner file lists + digests for a tree (the manifest file itself is never an owner's file). */
export function computeOwners(files) {
  const byOwner = new Map();
  for (const path of Object.keys(files).sort()) {
    if (path === MANIFEST_PATH) continue;
    const owner = ownerOfPath(path);
    if (owner === null) continue;
    byOwner.set(owner, [...(byOwner.get(owner) ?? []), path]);
  }
  const owners = {};
  for (const owner of SITE_STATE_OWNERS) {
    const paths = byOwner.get(owner);
    if (!paths || paths.length === 0) continue;
    owners[owner] = {
      files: paths,
      digest: sha256Hex(stableStringify(paths.map((p) => [p, fileDigest(p, files[p])]))),
    };
  }
  return owners;
}

export function manifestDigestOf(owners) {
  return sha256Hex(
    stableStringify(
      Object.keys(owners)
        .sort()
        .map((owner) => [owner, owners[owner].digest]),
    ),
  );
}

export function buildManifest({ files, platformOrigin, sourceSite, exportedAt }) {
  const owners = computeOwners(files);
  return {
    schema_version: SITE_STATE_SCHEMA_VERSION,
    kind: SITE_STATE_KIND,
    platform_origin: platformOrigin,
    source_site: sourceSite,
    exported_at: exportedAt,
    manifest_digest: manifestDigestOf(owners),
    owners,
  };
}

/** Is this manifest one this build understands, and does it describe exactly these files? */
export function verifyManifest(manifest, files) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return { code: "SITE_STATE_UNSUPPORTED_SCHEMA", message: "manifest must be a JSON object" };
  }
  const m = manifest;
  if (m.kind !== SITE_STATE_KIND) {
    return { code: "SITE_STATE_UNSUPPORTED_SCHEMA", message: `kind ${JSON.stringify(m.kind)} is not ${SITE_STATE_KIND}` };
  }
  if (m.schema_version !== SITE_STATE_SCHEMA_VERSION) {
    return {
      code: "SITE_STATE_UNSUPPORTED_SCHEMA",
      message: `schema_version ${JSON.stringify(m.schema_version)} is not supported (this CLI reads ${SITE_STATE_SCHEMA_VERSION})`,
    };
  }
  const owners = computeOwners(files);
  const digest = manifestDigestOf(owners);
  if (m.manifest_digest !== digest) {
    return { code: "SITE_STATE_MANIFEST_DIGEST_MISMATCH", message: "the files do not match the manifest digest; re-export the site state" };
  }
  const declared = stableStringify(m.owners ?? {});
  if (declared !== stableStringify(owners)) {
    return { code: "SITE_STATE_MANIFEST_DIGEST_MISMATCH", message: "the manifest's owner list does not match the files" };
  }
  return null;
}

/** The instance name an apply targets for a manifest: stable, so a resume finds its own work. */
export function siteStateInstanceName(manifestDigest) {
  return `Site State · ${manifestDigest.slice(0, 12)}`;
}

export function themeSourceIdempotencyKey(manifestDigest) {
  return `site-state:${manifestDigest.slice(0, 12)}:theme`;
}

// ── diff ─────────────────────────────────────────────────────────────────────────────────────────────────

function comparable(path) {
  return path !== MANIFEST_PATH && !path.startsWith(ASSET_FILES_PREFIX) && ownerOfPath(path) !== null;
}

export function diffSiteState(a, b) {
  const paths = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(comparable).sort();
  const out = [];
  for (const path of paths) {
    const left = a[path];
    const right = b[path];
    const owner = ownerOfPath(path);
    if (left === undefined) out.push({ owner, key: path, change: "added" });
    else if (right === undefined) out.push({ owner, key: path, change: "removed" });
    else if (stableStringify(canonicalFileView(path, left)) !== stableStringify(canonicalFileView(path, right))) {
      out.push({ owner, key: path, change: "changed" });
    }
  }
  return out;
}

export function diffOwner(owner, a, b) {
  return diffSiteState(a, b).filter((d) => d.owner === owner);
}

// ── validate (structural, offline) ──────────────────────────────────────────────────────────────────────

const error = (code, message, path) => ({ level: "error", code, message, ...(path ? { path } : {}) });

function parsedJson(path, content, out) {
  try {
    return JSON.parse(content);
  } catch {
    out.push(error("SITE_STATE_INVALID_FILE", "file is not valid JSON", path));
    return undefined;
  }
}

/**
 * Every structural refusal a tree can earn offline: paths, the path↔content binding, duplicate
 * identities and the limits. `files` maps every tree path (media/files/<sha> included, content unused
 * for those) to its string content.
 */
export function validateSiteStateTree(files) {
  const out = [];
  const paths = Object.keys(files).sort();
  out.push(...checkSiteStateTreePaths(paths));

  const pagePaths = paths.filter((p) => ownerOfPath(p) === "pages");
  const identities = new Map();
  for (const path of pagePaths) {
    const at = parsePageFilePath(path);
    if (at.kind !== "canonical" && at.kind !== "hashed") {
      out.push(error("SITE_STATE_INVALID_PATH", "page files use the canonical layout", path));
      continue;
    }
    const classified = classifyPageFile(path, files[path], { defaultLocale: at.locale });
    if (!classified.ok) {
      const code = classified.code === "PAGES_INVALID_JSON" ? "SITE_STATE_INVALID_FILE" : "SITE_STATE_IDENTITY_MISMATCH";
      out.push(error(code, `${classified.code}: ${classified.message}`, path));
      continue;
    }
    if (classified.layout !== "v2") {
      out.push(error("SITE_STATE_IDENTITY_MISMATCH", "a site state carries format_version 2 page files only", path));
      continue;
    }
    const key = `${classified.locale}\u0000${classified.slug}`;
    const seen = identities.get(key);
    if (seen) out.push(error("SITE_STATE_DUPLICATE_IDENTITY", `${path} and ${seen} are the same page`, path));
    else identities.set(key, path);
  }

  for (const path of paths.filter((p) => ownerOfPath(p) === "media_decisions")) {
    const sibling = path.slice(0, -PAGE_MEDIA_DECISIONS_NAME.length) + PAGE_FILE_NAME;
    if (files[sibling] === undefined) {
      out.push(error("SITE_STATE_IDENTITY_MISMATCH", "media decisions without their page file", path));
      continue;
    }
    const value = parsedJson(path, files[path], out);
    if (value === undefined) continue;
    if (!Array.isArray(value)) {
      out.push(error("SITE_STATE_INVALID_FILE", "media decisions must be a JSON array", path));
      continue;
    }
    const uses = new Set();
    for (const entry of value) {
      if (!isRecord(entry) || typeof entry.path !== "string" || typeof entry.facet !== "string") {
        out.push(error("SITE_STATE_INVALID_FILE", "a media decision needs `path` and `facet`", path));
        continue;
      }
      const key = `${entry.path}\u0000${entry.facet}`;
      if (uses.has(key)) out.push(error("SITE_STATE_DUPLICATE_IDENTITY", `two decisions for ${key.replace("\u0000", " ")}`, path));
      uses.add(key);
    }
  }

  const navPaths = paths.filter((p) => ownerOfPath(p) === "navigation");
  if (navPaths.length > SITE_STATE_LIMITS.navigationMenus) {
    out.push(error("SITE_STATE_LIMIT_EXCEEDED", `${navPaths.length} menus; at most ${SITE_STATE_LIMITS.navigationMenus}`));
  }
  for (const path of navPaths) {
    const value = parsedJson(path, files[path], out);
    if (value === undefined) continue;
    if (!isRecord(value)) {
      out.push(error("SITE_STATE_INVALID_FILE", "a navigation file must be a JSON object", path));
      continue;
    }
    const segments = path.split("/");
    const locale = segments[2];
    const handle = segments[3].slice(0, -".json".length);
    if (value.locale !== locale || value.handle !== handle) {
      out.push(error("SITE_STATE_IDENTITY_MISMATCH", `this file is ${locale} "${handle}"`, path));
    }
    const items = value.items;
    if (!Array.isArray(items)) {
      out.push(error("SITE_STATE_INVALID_FILE", "navigation items must be an array", path));
      continue;
    }
    if (items.length > SITE_STATE_LIMITS.navigationItems) {
      out.push(error("SITE_STATE_LIMIT_EXCEEDED", `${items.length} items; at most ${SITE_STATE_LIMITS.navigationItems}`, path));
    }
    const ids = new Set();
    for (const item of items) {
      if (!isRecord(item) || typeof item.id !== "string" || typeof item.label !== "string" || !isRecord(item.link)) {
        out.push(error("SITE_STATE_INVALID_FILE", "a navigation item needs `id`, `label` and `link`", path));
        continue;
      }
      if (ids.has(item.id)) out.push(error("SITE_STATE_DUPLICATE_IDENTITY", `two navigation items are "${item.id}"`, path));
      ids.add(item.id);
      const link = item.link;
      if (link.type === "page") {
        if (typeof link.locale !== "string" || typeof link.slug !== "string") {
          out.push(error("SITE_STATE_INVALID_FILE", "a page link needs `locale` and `slug`", path));
        }
      } else if (link.type !== "custom" || typeof link.url !== "string") {
        out.push(error("SITE_STATE_UNSUPPORTED_LINK", `link type ${JSON.stringify(link.type)} is not carried by a site state`, path));
      }
    }
    for (const item of items) {
      if (isRecord(item) && item.parent != null && !ids.has(String(item.parent))) {
        out.push(error("SITE_STATE_INVALID_FILE", `parent ${JSON.stringify(item.parent)} is not an item of this menu`, path));
      }
    }
  }

  for (const path of [THEME_CHROME_HEADER_PATH, THEME_CHROME_FOOTER_PATH]) {
    const content = files[path];
    if (content === undefined) continue;
    const value = parsedJson(path, content, out);
    if (value === undefined) continue;
    const area = path === THEME_CHROME_HEADER_PATH ? "header" : "footer";
    if (!isRecord(value) || value.area !== area) {
      out.push(error("SITE_STATE_IDENTITY_MISMATCH", `this file is the ${area} group`, path));
    }
  }

  const translations = files[SITE_TRANSLATIONS_PATH];
  if (translations !== undefined) {
    const value = parsedJson(SITE_TRANSLATIONS_PATH, translations, out);
    const groups = isRecord(value) ? value.groups : undefined;
    if (!Array.isArray(groups)) {
      if (value !== undefined) out.push(error("SITE_STATE_INVALID_FILE", "translations need a `groups` array", SITE_TRANSLATIONS_PATH));
    } else {
      const groupIds = new Set();
      const members = new Set();
      for (const group of groups) {
        if (!isRecord(group) || typeof group.group !== "string" || !Array.isArray(group.members)) {
          out.push(error("SITE_STATE_INVALID_FILE", "a translation group needs `group` and `members`", SITE_TRANSLATIONS_PATH));
          continue;
        }
        if (groupIds.has(group.group)) {
          out.push(error("SITE_STATE_DUPLICATE_IDENTITY", `two groups are "${group.group}"`, SITE_TRANSLATIONS_PATH));
        }
        groupIds.add(group.group);
        const locales = new Set();
        for (const member of group.members) {
          if (!isRecord(member) || typeof member.locale !== "string" || typeof member.slug !== "string") {
            out.push(error("SITE_STATE_INVALID_FILE", "a member needs `locale` and `slug`", SITE_TRANSLATIONS_PATH));
            continue;
          }
          const key = `${member.locale}\u0000${member.slug}`;
          if (members.has(key)) {
            out.push(error("SITE_STATE_DUPLICATE_IDENTITY", `${member.locale} ${member.slug} is in two groups`, SITE_TRANSLATIONS_PATH));
          }
          members.add(key);
          if (locales.has(member.locale)) {
            out.push(error("SITE_STATE_TRANSLATION_REFUSED", `group ${group.group} has two ${member.locale} pages`, SITE_TRANSLATIONS_PATH));
          }
          locales.add(member.locale);
          if (canonicalizeLocaleCode(member.locale) !== member.locale) {
            out.push(error("SITE_STATE_INVALID_FILE", `locale ${JSON.stringify(member.locale)} is not canonical`, SITE_TRANSLATIONS_PATH));
          }
          if (!identities.has(key)) {
            out.push(error("SITE_STATE_TRANSLATION_REFUSED", `${member.locale} ${member.slug} has no page file`, SITE_TRANSLATIONS_PATH));
          }
        }
        if (group.members.length < 2) {
          out.push(error("SITE_STATE_TRANSLATION_REFUSED", `group ${group.group} has fewer than two members`, SITE_TRANSLATIONS_PATH));
        }
      }
    }
  }

  const assetsIndex = files[ASSETS_INDEX_PATH];
  const declaredShas = new Set();
  if (assetsIndex !== undefined) {
    const value = parsedJson(ASSETS_INDEX_PATH, assetsIndex, out);
    if (value !== undefined && !Array.isArray(value)) {
      out.push(error("SITE_STATE_INVALID_FILE", "media/assets.json must be a JSON array", ASSETS_INDEX_PATH));
    } else if (Array.isArray(value)) {
      if (value.length > SITE_STATE_LIMITS.assetFiles) {
        out.push(error("SITE_STATE_LIMIT_EXCEEDED", `${value.length} assets; at most ${SITE_STATE_LIMITS.assetFiles}`, ASSETS_INDEX_PATH));
      }
      let total = 0;
      for (const entry of value) {
        if (!isRecord(entry) || typeof entry.sha256 !== "string" || parseAssetRef(`asset:sha256:${entry.sha256}`) === null) {
          out.push(error("SITE_STATE_INVALID_FILE", "an asset needs a lowercase sha256", ASSETS_INDEX_PATH));
          continue;
        }
        if (declaredShas.has(entry.sha256)) {
          out.push(error("SITE_STATE_DUPLICATE_IDENTITY", `${entry.sha256} is listed twice`, ASSETS_INDEX_PATH));
        }
        declaredShas.add(entry.sha256);
        const size = typeof entry.bytes === "number" ? entry.bytes : 0;
        total += size;
        if (size > SITE_STATE_LIMITS.assetBytes) {
          out.push(error("SITE_STATE_LIMIT_EXCEEDED", `${entry.sha256} is larger than ${SITE_STATE_LIMITS.assetBytes} bytes`, ASSETS_INDEX_PATH));
        }
      }
      if (total > SITE_STATE_LIMITS.assetTotalBytes) {
        out.push(error("SITE_STATE_LIMIT_EXCEEDED", `assets total more than ${SITE_STATE_LIMITS.assetTotalBytes} bytes`, ASSETS_INDEX_PATH));
      }
    }
  }
  for (const path of paths.filter((p) => p.startsWith(ASSET_FILES_PREFIX))) {
    const sha = path.slice(ASSET_FILES_PREFIX.length);
    if (!declaredShas.has(sha)) {
      out.push(error("SITE_STATE_IDENTITY_MISMATCH", "this file is not listed in media/assets.json", path));
    }
  }

  if (pagePaths.length > SITE_STATE_LIMITS.pageFiles) {
    out.push(error("SITE_STATE_LIMIT_EXCEEDED", `${pagePaths.length} page files; at most ${SITE_STATE_LIMITS.pageFiles}`));
  }
  const pageBytes = pagePaths.reduce((n, p) => n + byteLength(files[p]), 0);
  if (pageBytes > SITE_STATE_LIMITS.pageBytes) {
    out.push(error("SITE_STATE_LIMIT_EXCEEDED", `${pageBytes} bytes of page files; at most ${SITE_STATE_LIMITS.pageBytes}`));
  }
  const themePaths = paths.filter((p) => ownerOfPath(p) === "theme");
  if (themePaths.length > SITE_STATE_LIMITS.themeFiles) {
    out.push(error("SITE_STATE_LIMIT_EXCEEDED", `${themePaths.length} theme files; at most ${SITE_STATE_LIMITS.themeFiles}`));
  }
  const themeBytes = themePaths.reduce((n, p) => n + byteLength(files[p]), 0);
  if (themeBytes > SITE_STATE_LIMITS.themeBytes) {
    out.push(error("SITE_STATE_LIMIT_EXCEEDED", `${themeBytes} bytes of theme files; at most ${SITE_STATE_LIMITS.themeBytes}`));
  }
  return out;
}

/** The HTTP status a refusal code answers with (frozen contract §A2) — used to shape CLI-side exit codes. */
export function siteStateStatusFor(code) {
  if (code === "SITE_STATE_LIMIT_EXCEEDED") return 413;
  if (
    code === "SITE_STATE_PLAN_STALE" ||
    code === "SITE_STATE_TARGET_IS_LIVE" ||
    code === "SITE_STATE_REVISION_CONFLICT" ||
    code === "SITE_STATE_APPLY_INCOMPLETE" ||
    code === "SITE_STATE_TRANSLATION_REFUSED"
  ) {
    return 409;
  }
  return 422;
}
