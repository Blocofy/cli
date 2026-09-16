import { createHash } from "node:crypto";

/**
 * PS-19 — page file layout, mirrored from the platform (Blocofy/blocofy `packages/cms/src/page-files/path-codec.ts`).
 * The platform is the authority; this copy lets `pages check` and `pages migrate-layout` judge files offline.
 * `test/fixtures/page-path-vectors.json` is byte-identical on both sides and is the drift oracle.
 *
 *   pages/<locale>/index.json                      slug "/"
 *   pages/<locale>/routes/<seg>/…/index.json       any other slug ("/index" included)
 *   pages/<locale>/hashed/<sha256 hex>/index.json  a slug over the segment/depth/path limits
 *
 * Segments: safe bytes [a-z0-9-_.] stay readable; everything else (uppercase included) becomes `~hh` (lowercase
 * hex per UTF-8 byte); `~` itself is `~7e`; a leading/trailing dot and the first byte of a Windows reserved name
 * are escaped. Nothing is normalised: a non-canonical slug or locale is refused.
 */

export const PAGE_FILE_FORMAT_VERSION = 2;
export const PAGE_SEGMENT_MAX_BYTES = 100;
export const PAGE_ROUTE_DEPTH_MAX = 16;
export const PAGE_PATH_MAX_BYTES = 200;
export const PAGE_SLUG_MAX_BYTES = 2048;

export class PageFileError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PageFileError";
    this.code = code;
  }
}

const utf8 = new TextEncoder();
const utf8Strict = new TextDecoder("utf-8", { fatal: true });

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const CONTROL = /[\x00-\x1f\x7f-\x9f]/;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const LOCALE_CODE_PATTERN = /^[A-Za-z]{2,3}(-[A-Za-z]{4})?(-([A-Za-z]{2}|[0-9]{3}))?$/;

/** `en-us` → `en-US`; null for anything outside the platform's accepted shapes (mirror of locale-route-key.ts). */
export function canonicalizeLocaleCode(code) {
  if (typeof code !== "string") return null;
  const trimmed = code.trim();
  if (!LOCALE_CODE_PATTERN.test(trimmed)) return null;
  return trimmed
    .split("-")
    .map((part, index) => {
      if (index === 0) return part.toLowerCase();
      if (part.length === 4) return part[0].toUpperCase() + part.slice(1).toLowerCase();
      return part.toUpperCase();
    })
    .join("-");
}

export function checkPageSlug(slug) {
  if (typeof slug !== "string") return "slug must be a string";
  if (slug === "/") return null;
  if (!slug.startsWith("/")) return "slug must start with /";
  if (slug.endsWith("/")) return "slug must not end with /";
  if (LONE_SURROGATE.test(slug)) return "slug is not well-formed Unicode";
  if (utf8.encode(slug).length > PAGE_SLUG_MAX_BYTES) return `slug is longer than ${PAGE_SLUG_MAX_BYTES} bytes`;
  if (slug.normalize("NFC") !== slug) return "slug is not in Unicode NFC form";
  if (CONTROL.test(slug)) return "slug contains a control character";
  if (slug.includes("\\")) return "slug contains a backslash";
  if (slug.includes("?") || slug.includes("#")) return "slug contains a query or fragment";
  if (/%(2f|5c)/i.test(slug)) return "slug contains an encoded slash or backslash";
  for (const segment of slug.slice(1).split("/")) {
    if (segment === "") return "slug contains an empty segment";
    const dotted = segment.replace(/%2e/gi, ".");
    if (dotted === "." || dotted === "..") return "slug contains a . or .. segment";
  }
  return null;
}

const isSafeByte = (b) => (b >= 0x61 && b <= 0x7a) || (b >= 0x30 && b <= 0x39) || b === 0x2d || b === 0x5f || b === 0x2e;

export function encodeSegment(segment) {
  const bytes = utf8.encode(segment);
  const reserved = WINDOWS_RESERVED.test(segment.split(".")[0] ?? "");
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    const edgeDot = b === 0x2e && (i === 0 || i === bytes.length - 1);
    if (!isSafeByte(b) || edgeDot || (reserved && i === 0)) out += "~" + b.toString(16).padStart(2, "0");
    else out += String.fromCharCode(b);
  }
  return out;
}

export function decodeSegment(encoded) {
  const bytes = [];
  for (let i = 0; i < encoded.length; i++) {
    const c = encoded.charCodeAt(i);
    if (c === 0x7e) {
      const pair = encoded.slice(i + 1, i + 3);
      if (!/^[0-9a-f]{2}$/.test(pair)) return null;
      bytes.push(parseInt(pair, 16));
      i += 2;
    } else if (isSafeByte(c)) {
      bytes.push(c);
    } else {
      return null;
    }
  }
  let decoded;
  try {
    decoded = utf8Strict.decode(new Uint8Array(bytes));
  } catch {
    return null;
  }
  return encodeSegment(decoded) === encoded ? decoded : null;
}

export function pageFilePath(locale, slug) {
  if (typeof locale !== "string" || canonicalizeLocaleCode(locale) !== locale) {
    throw new PageFileError("PAGES_INVALID_LOCALE", `locale ${JSON.stringify(locale)} is not a canonical locale code`);
  }
  const reason = checkPageSlug(slug);
  if (reason) throw new PageFileError("PAGES_INVALID_SLUG", `${JSON.stringify(slug)}: ${reason}`);
  if (slug === "/") return `pages/${locale}/index.json`;
  const segments = slug.slice(1).split("/").map(encodeSegment);
  const path = `pages/${locale}/routes/${segments.join("/")}/index.json`;
  const tooLong =
    segments.length > PAGE_ROUTE_DEPTH_MAX || segments.some((s) => s.length > PAGE_SEGMENT_MAX_BYTES) || path.length > PAGE_PATH_MAX_BYTES;
  if (!tooLong) return path;
  return `pages/${locale}/hashed/${createHash("sha256").update(utf8.encode(slug)).digest("hex")}/index.json`;
}

/** The pre-PS-19 formula; only for recognising and migrating legacy files. */
export function legacyPageFilePath(slug) {
  const clean = slug.replace(/^\/+|\/+$/g, "").trim();
  return `pages/${clean || "index"}.json`;
}

export function checkRelativePagePath(path) {
  if (typeof path !== "string" || path === "") return { code: "PAGES_INVALID_PATH", reason: "empty path" };
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) return { code: "PAGES_PATH_ESCAPE", reason: "absolute path" };
  if (path.includes("\\")) return { code: "PAGES_PATH_ESCAPE", reason: "backslash in path" };
  const parts = path.split("/");
  if (parts.includes("..")) return { code: "PAGES_PATH_ESCAPE", reason: "'..' in path" };
  if (CONTROL.test(path) || LONE_SURROGATE.test(path)) return { code: "PAGES_INVALID_PATH", reason: "control character in path" };
  if (parts.some((p) => p === "" || p === ".")) return { code: "PAGES_INVALID_PATH", reason: "empty or '.' path segment" };
  if (parts[0] !== "pages" || parts.length < 2) return { code: "PAGES_INVALID_PATH", reason: "path must be under pages/" };
  if (!path.endsWith(".json")) return { code: "PAGES_INVALID_PATH", reason: "page files end in .json" };
  return null;
}

const invalid = (reason) => ({ kind: "invalid", code: "PAGES_INVALID_PATH", reason });

export function parsePageFilePath(path) {
  const unsafe = checkRelativePagePath(path);
  if (unsafe) return { kind: "invalid", ...unsafe };
  const parts = path.split("/");
  const folder = parts[1];
  const rest = parts.slice(2);
  const canonical = canonicalizeLocaleCode(folder);
  if (canonical === null || rest.length === 0) return { kind: "other" };
  const shaped = rest[0] === "index.json" || rest[0] === "routes" || rest[0] === "hashed";
  if (!shaped) return { kind: "other" };
  if (canonical !== folder) return invalid(`locale folder ${JSON.stringify(folder)} is not canonical (${canonical})`);
  if (rest[0] === "index.json") {
    return rest.length === 1 ? { kind: "canonical", locale: folder, slug: "/" } : invalid("unexpected path after index.json");
  }
  if (rest[rest.length - 1] !== "index.json") return invalid("canonical page files are named index.json");
  if (rest[0] === "hashed") {
    return rest.length === 3 && /^[0-9a-f]{64}$/.test(rest[1])
      ? { kind: "hashed", locale: folder, hash: rest[1] }
      : invalid("hashed page paths are hashed/<sha256 hex>/index.json");
  }
  const encoded = rest.slice(1, -1);
  if (encoded.length === 0) return invalid("routes/ needs at least one segment");
  const decoded = [];
  for (const segment of encoded) {
    const value = decodeSegment(segment);
    if (value === null) return invalid(`segment ${JSON.stringify(segment)} is not canonically encoded`);
    decoded.push(value);
  }
  const slug = "/" + decoded.join("/");
  if (checkPageSlug(slug) !== null) return invalid("path decodes to an invalid slug");
  if (pageFilePath(folder, slug) !== path) return invalid("path is not the canonical spelling of its slug");
  return { kind: "canonical", locale: folder, slug };
}

export function isCanonicalLayoutPath(path) {
  if (checkRelativePagePath(path)) return false;
  const parts = path.split("/");
  const rest = parts.slice(2);
  if (canonicalizeLocaleCode(parts[1] ?? "") === null || rest.length === 0) return false;
  return rest[0] === "index.json" || rest[0] === "routes" || rest[0] === "hashed";
}
