/**
 * #925 — translation packages (`blocofy-translation/1`) for `blocofy translations export|import`:
 *   GET  /api/v1/translations/export   (read scopes of the kinds)  → one window of a package (JSON, `next_cursor`)
 *   POST /api/v1/translations/import   (write scopes of the kinds) → an import report (≤ 500 units, or one group ≤ 5,000)
 *
 * The package rules (`readTranslationPackage`, `chunkPackage`) and the XLIFF 1.2 dialect (`toXliff`, `fromXliff`) are
 * ports of the platform's (multisite-cms `packages/cms/src/i18n/translation-package.ts` and `translation-xliff.ts`).
 * `toXliff` is byte-identical. The platform reads XLIFF with a linear pre-scan and then fast-xml-parser; the CLI has no
 * dependencies, so the SAME pre-scan is followed by a small well-formedness parser of its own. Both are pinned by the
 * shared fixtures `test/fixtures/translation-xliff-vector.{package.json,xlf,cases.json}`.
 *
 * Retries (lib/http.mjs): an export window is a read. An import converges when resent: a text already written answers
 * `unchanged`, so a replay never writes twice. A wet import with `publish` is the exception and is sent once: a resend
 * cannot see what the first call published (`ImportOutcomeUnknown`).
 */
import { fetchWithRetry } from "./http.mjs";
import { CliRefusal } from "./media-uses.mjs";

export const TRANSLATION_FORMAT = "blocofy-translation/1";
export const TRANSLATION_KINDS = ["page", "media", "entry", "navigation", "settings", "theme", "option"];
export const TRANSLATION_UNIT_TYPES = ["text", "richtext", "html", "url", "slug"];
export const TRANSLATION_STATES = ["missing", "stale", "translated"];
export const TRANSLATION_ONLY = ["all", "missing", "stale", "pending"];
export const IMPORT_UNIT_STATES = ["applied", "unchanged", "skipped_empty", "source_changed", "target_changed", "invalid", "blocked"];
export const EXPORT_MAX_LIMIT = 5000;
export const IMPORT_MAX_UNITS = 500;
/** One group may be sent whole up to this many units (the importer's page stamp needs the whole page). */
export const IMPORT_MAX_GROUP_UNITS = 5000;
/** The v1 import route refuses a JSON body longer than this many characters (413). */
export const MAX_IMPORT_BODY_CHARS = 8_000_000;
/** The converter's own bound on an XLIFF text (the platform's `XLIFF_MAX_CHARS`). */
export const XLIFF_MAX_CHARS = 8_000_000;
export const XLIFF_NAMESPACE = "urn:oasis:names:tc:xliff:document:1.2";
export const BLOCOFY_XLIFF_NAMESPACE = "https://blocofy.com/ns/translation/1";

export class XliffError extends Error {
  constructor(message) {
    super(message);
    this.name = "XliffError";
  }
}

// ── package: ids, reading, chunking (translation-package.ts) ────────────────────────────────────────────────

const SEGMENT = /^[A-Za-z0-9_-]+$/;
const CANONICAL_INT = /^(0|[1-9]\d*)$/;
const ITEM_PATH = /^(0|[1-9]\d*)(\.(0|[1-9]\d*))*$/;
const MAX_ID_LENGTH = 600;
const MAX_OPTION_VALUE = 200;
const PAGE_UNIT_FIELDS = ["title", "seo_title", "seo_description", "slug"];

const isIdSegment = (value) => typeof value === "string" && SEGMENT.test(value);
const dotted = (value) => value.split(".").every(isIdSegment);

function parseEntryId(text) {
  if (!CANONICAL_INT.test(text) || text === "0") return null;
  const n = Number(text);
  return Number.isSafeInteger(n) ? n : null;
}
function parseItemPath(text) {
  if (!ITEM_PATH.test(text)) return null;
  const path = text.split(".").map(Number);
  return path.every(Number.isSafeInteger) ? path : null;
}

function unitIdOf(p) {
  const seg = (value) => {
    if (!isIdSegment(value)) throw new Error(`Not an id segment: ${JSON.stringify(value)}`);
    return value;
  };
  const path = (value) => {
    if (!dotted(value)) throw new Error(`Not an id path: ${JSON.stringify(value)}`);
    return value;
  };
  switch (p.kind) {
    case "page":
      return "node" in p ? `page:${seg(p.handle)}:${seg(p.node)}.${seg(p.setting)}` : `page:${seg(p.handle)}:@${p.page}`;
    case "media":
      return `media:${seg(p.handle)}:${path(p.path)}:${p.facet}`;
    case "entry": {
      if (parseEntryId(String(p.entryId)) === null) throw new Error(`Not an entry id: ${p.entryId}`);
      const field = p.field === "@title" || p.field === "@slug" ? p.field : seg(p.field);
      return `entry:${seg(p.collection)}:${p.entryId}:${field}`;
    }
    case "navigation": {
      const text = p.itemPath.join(".");
      if (parseItemPath(text) === null) throw new Error(`Not a menu item path: ${text}`);
      return `nav:${seg(p.handle)}:${text}:${p.part}`;
    }
    case "settings":
      return `settings:${seg(p.field)}`;
    case "theme":
      return `theme:${path(p.path)}`;
    case "option":
      return `option:${seg(p.collection)}:${seg(p.field)}:${p.value}`;
  }
  throw new Error(`Unknown kind: ${p.kind}`);
}

function parseUnitId(id) {
  if (typeof id !== "string" || id.length === 0 || id.length > MAX_ID_LENGTH) return null;
  const colon = id.indexOf(":");
  if (colon < 0) return null;
  const prefix = id.slice(0, colon);
  const rest = id.slice(colon + 1);
  switch (prefix) {
    case "page": {
      const i = rest.indexOf(":");
      if (i < 0) return null;
      const handle = rest.slice(0, i);
      const field = rest.slice(i + 1);
      if (!isIdSegment(handle)) return null;
      if (field.startsWith("@")) {
        const name = field.slice(1);
        return PAGE_UNIT_FIELDS.includes(name) ? { kind: "page", handle, page: name } : null;
      }
      const dot = field.lastIndexOf(".");
      if (dot <= 0) return null;
      const node = field.slice(0, dot);
      const setting = field.slice(dot + 1);
      return isIdSegment(node) && isIdSegment(setting) ? { kind: "page", handle, node, setting } : null;
    }
    case "media": {
      const i = rest.indexOf(":");
      const j = rest.lastIndexOf(":");
      if (i < 0 || j <= i) return null;
      const handle = rest.slice(0, i);
      const path = rest.slice(i + 1, j);
      const facet = rest.slice(j + 1);
      if (!isIdSegment(handle) || !dotted(path) || (facet !== "alt" && facet !== "caption")) return null;
      return { kind: "media", handle, path, facet };
    }
    case "entry": {
      const parts = rest.split(":");
      if (parts.length !== 3) return null;
      const [collection, idText, field] = parts;
      const entryId = parseEntryId(idText);
      if (!isIdSegment(collection) || entryId === null) return null;
      if (!(field === "@title" || field === "@slug" || isIdSegment(field))) return null;
      return { kind: "entry", collection, entryId, field };
    }
    case "nav": {
      const parts = rest.split(":");
      if (parts.length !== 3) return null;
      const [handle, pathText, part] = parts;
      const itemPath = parseItemPath(pathText);
      if (!isIdSegment(handle) || itemPath === null || (part !== "label" && part !== "url")) return null;
      return { kind: "navigation", handle, itemPath, part };
    }
    case "settings":
      return isIdSegment(rest) ? { kind: "settings", field: rest } : null;
    case "theme":
      return rest.length > 0 && dotted(rest) ? { kind: "theme", path: rest } : null;
    case "option": {
      const i = rest.indexOf(":");
      const j = i < 0 ? -1 : rest.indexOf(":", i + 1);
      if (i < 0 || j < 0) return null;
      const collection = rest.slice(0, i);
      const field = rest.slice(i + 1, j);
      const value = rest.slice(j + 1);
      if (!isIdSegment(collection) || !isIdSegment(field) || value.length === 0 || value.length > MAX_OPTION_VALUE) return null;
      return { kind: "option", collection, field, value };
    }
    default:
      return null;
  }
}

function groupKeyOf(p) {
  switch (p.kind) {
    case "page":
    case "media":
      return `page:${p.handle}`;
    case "entry":
      return `entry:${p.collection}:${p.entryId}`;
    case "navigation":
      return `nav:${p.handle}`;
    case "settings":
      return "settings";
    case "theme":
      return "theme";
    case "option":
      return `option:${p.collection}`;
  }
  return "";
}

const isRecord = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const optionalText = (v) => (v === undefined || v === null ? "" : typeof v === "string" ? v : null);
const refuseRead = (message) => ({ ok: false, message });

/**
 * The platform's structural read of a package: only `id`, `target` and `source_hash` are required per unit; `kind`
 * and `group` are derived from the id (a disagreeing declaration is refused). `{ ok, pkg }` or `{ ok: false, message }`.
 */
export function readTranslationPackage(raw) {
  if (!isRecord(raw)) return refuseRead("A translation package must be an object.");
  if (raw.format !== TRANSLATION_FORMAT) return refuseRead(`The package format must be "${TRANSLATION_FORMAT}".`);
  if (typeof raw.target_locale !== "string" || raw.target_locale.trim() === "") return refuseRead("target_locale is required.");
  if (typeof raw.source_locale !== "string" || raw.source_locale.trim() === "") return refuseRead("source_locale is required.");
  const exportedAt = optionalText(raw.exported_at);
  if (exportedAt === null) return refuseRead("exported_at must be text.");
  const by = raw.by === undefined || raw.by === null ? "human" : raw.by;
  if (by !== "human" && by !== "ai") return refuseRead("by must be 'human' or 'ai'.");
  const nextCursor = raw.next_cursor === undefined || raw.next_cursor === null ? null : raw.next_cursor;
  if (nextCursor !== null && typeof nextCursor !== "string") return refuseRead("next_cursor must be text or null.");
  if (!Array.isArray(raw.units)) return refuseRead("units must be an array.");

  const seen = new Set();
  const units = [];
  for (let i = 0; i < raw.units.length; i += 1) {
    const u = raw.units[i];
    const at = `units[${i}]`;
    if (!isRecord(u)) return refuseRead(`${at} must be an object.`);
    if (typeof u.id !== "string" || u.id === "") return refuseRead(`${at}.id is required.`);
    const parsed = parseUnitId(u.id);
    if (parsed === null) return refuseRead(`${at}.id is not recognised: ${u.id}`);
    const canonicalId = unitIdOf(parsed);
    if (seen.has(canonicalId)) return refuseRead(`${at}.id appears twice: ${u.id}`);
    seen.add(canonicalId);
    if (typeof u.target !== "string") return refuseRead(`${at}.target must be text.`);
    if (typeof u.source_hash !== "string") return refuseRead(`${at}.source_hash is required.`);
    if (u.kind !== undefined && u.kind !== null && u.kind !== parsed.kind) return refuseRead(`${at}.kind is invalid: the id says "${parsed.kind}".`);
    const group = groupKeyOf(parsed);
    if (u.group !== undefined && u.group !== null && u.group !== "" && u.group !== group) return refuseRead(`${at}.group does not match the id (it should be ${group}).`);
    const type = u.type === undefined || u.type === null ? "text" : u.type;
    if (!TRANSLATION_UNIT_TYPES.includes(type)) return refuseRead(`${at}.type is invalid.`);
    const state = u.state === undefined || u.state === null ? (u.target.trim() ? "translated" : "missing") : u.state;
    if (!TRANSLATION_STATES.includes(state)) return refuseRead(`${at}.state is invalid.`);
    const groupText = optionalText(u.group);
    const context = optionalText(u.context);
    const source = optionalText(u.source);
    const targetHash = optionalText(u.target_hash);
    if (groupText === null || context === null || source === null || targetHash === null) return refuseRead(`${at} fields must be text.`);
    units.push({ id: canonicalId, kind: parsed.kind, group, context, type, source, source_hash: u.source_hash, target: u.target, target_hash: targetHash, state });
  }
  return {
    ok: true,
    pkg: { format: TRANSLATION_FORMAT, source_locale: raw.source_locale, target_locale: raw.target_locale, exported_at: exportedAt, by, units, next_cursor: nextCursor },
  };
}

/**
 * The platform's `chunkPackage`: empty targets dropped (counted); consecutive units of one group (derived from the
 * id) stay in one call; a group above `max` but within 5,000 units is a call of its own; only a larger group is sliced
 * into calls of `max` (its key is listed in `splitGroups`: such a page cannot be stamped translated by one call).
 */
/** The group a unit belongs to, DERIVED from its id (a package without group fields must not split a page or entry). */
function groupOf(u) {
  const parsed = parseUnitId(u.id);
  return parsed ? groupKeyOf(parsed) : u.group;
}

export function chunkPackage(pkg, max = IMPORT_MAX_UNITS) {
  if (!Number.isInteger(max) || max < 1) throw new RangeError(`chunkPackage: max must be a positive integer (got ${max})`);
  const filled = pkg.units.filter((u) => u.target.trim() !== "");
  const chunks = [];
  const splitGroups = [];
  let current = [];
  const flush = () => {
    if (current.length > 0) chunks.push({ ...pkg, units: current, next_cursor: null });
    current = [];
  };
  let i = 0;
  while (i < filled.length) {
    const group = groupOf(filled[i]);
    let j = i;
    while (j < filled.length && groupOf(filled[j]) === group) j += 1;
    const run = filled.slice(i, j);
    if (run.length > IMPORT_MAX_GROUP_UNITS) {
      flush();
      splitGroups.push(group);
      for (let k = 0; k < run.length; k += max) chunks.push({ ...pkg, units: run.slice(k, k + max), next_cursor: null });
    } else {
      if (current.length + run.length > max) flush();
      current.push(...run);
    }
    i = j;
  }
  flush();
  return { chunks, skippedEmpty: pkg.units.length - filled.length, splitGroups };
}

/** Room for the import body's other fields (`{"package":…,"dry_run":false,"publish":false,"on_source_change":"apply"}`). */
const BODY_OVERHEAD = 100;

/**
 * The import route refuses a JSON body over `cap` characters (413). A chunk over it is re-split at group boundaries
 * (a group is never split here); a single group over the cap cannot be sent and is refused before any request.
 */
export function fitChunksToBodyCap(chunks, cap = MAX_IMPORT_BODY_CHARS) {
  const size = (units) => JSON.stringify({ ...chunks[0], units }).length + BODY_OVERHEAD;
  const out = [];
  for (const chunk of chunks) {
    if (size(chunk.units) <= cap) {
      out.push(chunk);
      continue;
    }
    const runs = [];
    for (const unit of chunk.units) {
      const last = runs[runs.length - 1];
      const group = groupOf(unit);
      if (last && last.group === group) last.units.push(unit);
      else runs.push({ group, units: [unit] });
    }
    let current = [];
    for (const run of runs) {
      if (size(run.units) > cap) {
        throw new Error(`The texts of group "${run.group}" do not fit in one import call (at most ${cap.toLocaleString("en-US")} characters).`);
      }
      if (current.length > 0 && size([...current, ...run.units]) > cap) {
        out.push({ ...chunk, units: current });
        current = [];
      }
      current.push(...run.units);
    }
    if (current.length > 0) out.push({ ...chunk, units: current });
  }
  return out;
}

/** A package file: XLIFF by extension (.xlf/.xliff) or a leading `<`, JSON otherwise. Throws with a readable message. */
export function readPackageFile(text, fileName = "") {
  const xliff = /\.(xlf|xliff)$/i.test(fileName) || text.trimStart().startsWith("<");
  if (xliff) return fromXliff(text);
  let raw;
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new Error(`The file is not valid JSON (${error?.message ?? error}).`);
  }
  const read = readTranslationPackage(raw);
  if (!read.ok) throw new Error(read.message);
  return read.pkg;
}

// ── XLIFF 1.2: writing (translation-xliff.ts, byte-identical) ───────────────────────────────────────────────

const STATE_TO_XLIFF = { missing: "new", stale: "needs-review-translation", translated: "translated" };

function stateFromXliff(value, target) {
  if (value === "new") return "missing";
  if (value === "needs-review-translation") return "stale";
  return target.trim() === "" ? "missing" : "translated";
}

/** XML 1.0 `Char` production. */
function isXmlChar(code) {
  return code === 0x9 || code === 0xa || code === 0xd || (code >= 0x20 && code <= 0xd7ff) || (code >= 0xe000 && code <= 0xfffd) || (code >= 0x10000 && code <= 0x10ffff);
}

function escapeXml(text, attribute) {
  let out = "";
  for (const ch of text) {
    switch (ch) {
      case "&": out += "&amp;"; continue;
      case "<": out += "&lt;"; continue;
      case ">": out += "&gt;"; continue;
      case '"': out += "&quot;"; continue;
      case "'": out += "&apos;"; continue;
      case "\t": out += "&#9;"; continue;
      case "\r": out += "&#13;"; continue;
      case "\n": out += attribute ? "&#10;" : "\n"; continue;
    }
    if (!isXmlChar(ch.codePointAt(0))) {
      throw new XliffError("A text contains a character XLIFF cannot carry; export this package as JSON.");
    }
    out += ch;
  }
  return out;
}

const attrs = (list) => list.map(([k, v]) => `${k}="${escapeXml(v, true)}"`).join(" ");

export function toXliff(pkg) {
  const fileAttrs = [
    ["original", "blocofy"],
    ["datatype", "plaintext"],
    ["source-language", pkg.source_locale],
    ["target-language", pkg.target_locale],
    ["bf:format", pkg.format],
    ["bf:exported-at", pkg.exported_at],
    ["bf:by", pkg.by],
    ...(pkg.next_cursor !== null ? [["bf:next-cursor", pkg.next_cursor]] : []),
  ];
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<xliff version="1.2" xmlns="${XLIFF_NAMESPACE}" xmlns:bf="${BLOCOFY_XLIFF_NAMESPACE}">`,
    `  <file ${attrs(fileAttrs)}>`,
    "    <body>",
  ];
  for (const u of pkg.units) {
    const unitAttrs = [
      ["id", u.id],
      ["resname", u.id],
      ...(u.type === "richtext" || u.type === "html" ? [["datatype", "html"]] : []),
      ["bf:kind", u.kind],
      ["bf:group", u.group],
      ["bf:type", u.type],
      ["bf:source-hash", u.source_hash],
      ["bf:target-hash", u.target_hash],
    ];
    lines.push(
      `      <trans-unit ${attrs(unitAttrs)}>`,
      `        <source>${escapeXml(u.source, false)}</source>`,
      `        <target state="${STATE_TO_XLIFF[u.state]}">${escapeXml(u.target, false)}</target>`,
      `        <note>${escapeXml(u.context, false)}</note>`,
      "      </trans-unit>",
    );
  }
  lines.push("    </body>", "  </file>", "</xliff>");
  return `${lines.join("\n")}\n`;
}

// ── XLIFF 1.2: reading ──────────────────────────────────────────────────────────────────────────────────────

const lineOf = (xml, index) => {
  let line = 1;
  for (let i = xml.indexOf("\n"); i >= 0 && i < index; i = xml.indexOf("\n", i + 1)) line += 1;
  return line;
};

const CHAR_REF = /&(?:#([0-9]+)|#x([0-9a-fA-F]+)|(?:amp|lt|gt|quot|apos));/y;
const NAMED_REF = /&([A-Za-z][A-Za-z0-9]*);/y;
const DECLARATION =
  /^xml[ \t\n]+version[ \t\n]*=[ \t\n]*(["'])([^"']*)\1(?:[ \t\n]+encoding[ \t\n]*=[ \t\n]*(["'])([^"']*)\3)?(?:[ \t\n]+standalone[ \t\n]*=[ \t\n]*(["'])(?:yes|no)\5)?[ \t\n]*$/;

const MAX_DEPTH = 32;
const MAX_ATTRIBUTES_PER_TAG = 64;
const MAX_DECLARATION_LENGTH = 200;
const MAX_TAG_OUTSIDE_VALUES = 1024;
const MAX_TAG_WHITESPACE_RUN = 64;
const tooMuchWhitespace = (line) => new XliffError(`Too much whitespace inside a tag (at most ${MAX_TAG_WHITESPACE_RUN} characters in a row; line ${line}).`);
const tagTooLong = (line) => new XliffError(`A tag is too long outside its quoted attribute values (at most 1,024 characters; line ${line}).`);
const isBlank = (code) => code === 0x20 || code === 0x9 || code === 0xa || code === 0xd;
const codePointLabel = (code) => `U+${code.toString(16).toUpperCase().padStart(4, "0")}`;

function checkReference(xml, i) {
  CHAR_REF.lastIndex = i;
  const ref = CHAR_REF.exec(xml);
  if (ref) {
    const digits = ref[1] ?? ref[2];
    if (digits !== undefined) {
      const significant = digits.replace(/^0+/, "");
      const code = significant.length > 7 ? -1 : significant === "" ? 0 : parseInt(significant, ref[1] !== undefined ? 10 : 16);
      if (!isXmlChar(code)) {
        throw new XliffError(`The XLIFF file has a character reference XML cannot carry: ${ref[0].slice(0, 24)} (line ${lineOf(xml, i)}).`);
      }
    }
    return i + ref[0].length;
  }
  NAMED_REF.lastIndex = i;
  const named = NAMED_REF.exec(xml);
  if (named) {
    throw new XliffError(
      `Named HTML character references such as "${named[0].slice(0, 24)}" are not supported (line ${lineOf(xml, i)}); write the character itself or use a numeric reference (e.g. &#160;).`,
    );
  }
  throw new XliffError(`A bare "&" is not valid (line ${lineOf(xml, i)}); write "&amp;".`);
}

function checkDeclaration(xml, start, end) {
  if (end - start > MAX_DECLARATION_LENGTH) throw new XliffError(`The XML declaration (<?xml ...?>) is too long (line ${lineOf(xml, start)}).`);
  const body = xml.slice(start + 2, end);
  if (/[ \t\n\r]{65}/.test(body)) throw tooMuchWhitespace(lineOf(xml, start));
  const m = DECLARATION.exec(body);
  if (!m) throw new XliffError(`The XML declaration (<?xml ...?>) cannot be read (line ${lineOf(xml, start)}).`);
  if (m[2] !== "1.0") throw new XliffError("Only XML 1.0 is supported.");
  if (m[4] !== undefined && m[4].toLowerCase() !== "utf-8") throw new XliffError("An XLIFF file can only be UTF-8.");
}

/**
 * The platform's pre-scan, verbatim: ONE linear pass that refuses everything the dialect does not have (unclosed
 * constructs, DOCTYPE / entity declarations, CDATA, any processing instruction but one leading XML declaration,
 * `<` inside an attribute value, characters XML 1.0 cannot carry, bare `&` and named entities, `]]>` in text) and
 * bounds depth, attribute count and the whitespace inside a tag.
 */
function refuseUnsupportedMarkup(xml) {
  const n = xml.length;

  for (let k = 0; k < n; k += 1) {
    const c = xml.charCodeAt(k);
    if ((c >= 0x20 && c <= 0xd7ff) || c === 0x9 || c === 0xa || c === 0xd || (c >= 0xe000 && c <= 0xfffd)) continue;
    if (c >= 0xd800 && c <= 0xdbff) {
      const low = xml.charCodeAt(k + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        k += 1;
        continue;
      }
    }
    throw new XliffError(`The XLIFF file has a character XML cannot carry (${codePointLabel(c)}, line ${lineOf(xml, k)}).`);
  }

  let i = 0;
  let depth = 0;
  let started = false;
  let declared = false;
  while (i < n) {
    const c = xml.charCodeAt(i);
    if (c === 0x3c /* < */) {
      const next = xml.charCodeAt(i + 1);
      if (next === 0x21 /* ! */) {
        if (xml.startsWith("<!--", i)) {
          const end = xml.indexOf("-->", i + 4);
          if (end < 0) throw new XliffError(`Unclosed comment (<!--) (line ${lineOf(xml, i)}).`);
          const inner = xml.indexOf("--", i + 4);
          if (inner < end || (end > i + 4 && xml.charCodeAt(end - 1) === 0x2d)) {
            throw new XliffError(`A comment cannot contain "--" (line ${lineOf(xml, i)}).`);
          }
          started = true;
          i = end + 3;
          continue;
        }
        if (xml.startsWith("<![CDATA[", i)) throw new XliffError(`CDATA is not supported; escape the text instead (line ${lineOf(xml, i)}).`);
        const word = /^<!([A-Za-z]+)/.exec(xml.slice(i, i + 16))?.[1]?.toUpperCase();
        if (word === "DOCTYPE" || word === "ENTITY" || word === "ELEMENT" || word === "ATTLIST" || word === "NOTATION") {
          throw new XliffError(`An XLIFF file cannot contain a ${word} declaration (line ${lineOf(xml, i)}).`);
        }
        throw new XliffError(`The XLIFF file has an unsupported construct (line ${lineOf(xml, i)}).`);
      }
      if (next === 0x3f /* ? */) {
        const end = xml.indexOf("?>", i + 2);
        if (end < 0) throw new XliffError(`Unclosed processing instruction (line ${lineOf(xml, i)}).`);
        const isDeclaration = xml.startsWith("xml", i + 2) && /[ \t\n]/.test(xml.charAt(i + 5));
        if (!isDeclaration || started || declared) {
          throw new XliffError(`An XLIFF file cannot contain a processing instruction (line ${lineOf(xml, i)}).`);
        }
        checkDeclaration(xml, i, end);
        declared = true;
        i = end + 2;
        continue;
      }
      started = true;
      const closing = next === 0x2f; /* / */
      let attributes = 0;
      let outside = 0;
      let blanks = 0;
      let j = i + 1;
      for (;;) {
        if (j >= n) throw new XliffError(`Unclosed tag (line ${lineOf(xml, i)}).`);
        const t = xml.charCodeAt(j);
        if (t === 0x3e /* > */) break;
        if (t === 0x3c) throw new XliffError(`"<" cannot be used inside a tag (line ${lineOf(xml, j)}).`);
        if (t === 0x22 || t === 0x27) {
          const end = xml.indexOf(t === 0x22 ? '"' : "'", j + 1);
          if (end < 0) throw new XliffError(`Unclosed attribute value (line ${lineOf(xml, j)}).`);
          attributes += 1;
          if (attributes > MAX_ATTRIBUTES_PER_TAG) throw new XliffError(`Too many attributes on one tag (line ${lineOf(xml, i)}).`);
          for (let k = j + 1; k < end; k += 1) {
            const v = xml.charCodeAt(k);
            if (v === 0x3c) throw new XliffError(`"<" cannot be used in an attribute value; write "&lt;" (line ${lineOf(xml, k)}).`);
            if (v === 0x26) k = checkReference(xml, k) - 1;
          }
          j = end + 1;
          blanks = 0;
          const after = xml.charCodeAt(j);
          if (!isBlank(after) && after !== 0x3e && after !== 0x2f) throw new XliffError(`Attributes must be separated by whitespace (line ${lineOf(xml, j)}).`);
          continue;
        }
        outside += 1;
        if (outside > MAX_TAG_OUTSIDE_VALUES) throw tagTooLong(lineOf(xml, i));
        if (isBlank(t)) {
          blanks += 1;
          if (blanks > MAX_TAG_WHITESPACE_RUN) throw tooMuchWhitespace(lineOf(xml, i));
        } else {
          blanks = 0;
          if (t === 0x3d /* = */) {
            let q = j + 1;
            while (q < n && q <= j + MAX_TAG_WHITESPACE_RUN && isBlank(xml.charCodeAt(q))) q += 1;
            const quote = xml.charCodeAt(q);
            if (quote !== 0x22 && quote !== 0x27) throw new XliffError(`"=" must be followed by a quoted attribute value (line ${lineOf(xml, j)}).`);
          }
        }
        j += 1;
      }
      if (closing) depth -= 1;
      else if (xml.charCodeAt(j - 1) !== 0x2f) depth += 1;
      if (depth > MAX_DEPTH) throw new XliffError(`Elements are nested too deep (line ${lineOf(xml, i)}).`);
      i = j + 1;
      continue;
    }
    if (c === 0x26 /* & */) {
      i = checkReference(xml, i);
      started = true;
      continue;
    }
    if (c === 0x5d /* ] */ && xml.startsWith("]]>", i)) throw new XliffError(`Text cannot contain "]]>" (line ${lineOf(xml, i)}).`);
    if (c !== 0x20 && c !== 0x9 && c !== 0xa && c !== 0xd) started = true;
    i += 1;
  }
}

/** Decode what the pre-scan let through: numeric references and the five XML entities, in ONE pass. */
function decodeReferences(text) {
  if (!text.includes("&")) return text;
  return text.replace(/&(?:#([0-9]+)|#x([0-9a-fA-F]+)|(amp|lt|gt|quot|apos));/g, (_m, dec, hex, name) => {
    if (name !== undefined) return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[name];
    return String.fromCodePoint(parseInt(dec ?? hex, dec !== undefined ? 10 : 16));
  });
}

const NAME_START = ":A-Za-z_\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD";
const NAME = new RegExp(`[${NAME_START}][${NAME_START}\\-.\\d\\u00B7\\u0300-\\u036F\\u203F-\\u2040]*`, "y");

/**
 * Well-formedness after the pre-scan (the platform runs fast-xml-parser's validator here): one root element, names
 * that are XML names, quoted and unique attributes, matching end tags without attributes, nothing but whitespace and
 * comments outside the root, the XML declaration only at the very start. Linear: every step moves forward. Returns
 * the root as `{ name, attrs: Map, elements: [], text: [] }` (text pieces with comments dropped).
 */
function parseElements(xml) {
  const n = xml.length;
  let i = 0;
  const fail = (what) => {
    throw new XliffError(`The XLIFF file is not well-formed XML (${what}, line ${lineOf(xml, Math.min(i, n))}).`);
  };
  const readName = () => {
    NAME.lastIndex = i;
    const m = NAME.exec(xml);
    if (!m) fail("invalid name");
    i += m[0].length;
    return m[0];
  };
  const skipBlanks = () => {
    while (i < n && isBlank(xml.charCodeAt(i))) i += 1;
  };
  const stack = [];
  let root = null;
  while (i < n) {
    const lt = xml.indexOf("<", i);
    const end = lt < 0 ? n : lt;
    if (end > i) {
      const text = xml.slice(i, end);
      if (stack.length > 0) stack[stack.length - 1].text.push(text);
      else if (/[^ \t\n\r]/.test(text)) fail("text outside the root element");
      i = end;
      if (lt < 0) break;
    }
    if (xml.startsWith("<!--", i)) {
      i = xml.indexOf("-->", i + 4) + 3;
      continue;
    }
    if (xml.startsWith("<?", i)) {
      if (i !== 0) fail("the XML declaration can only be at the very start");
      i = xml.indexOf("?>", i + 2) + 2;
      continue;
    }
    if (xml.charCodeAt(i + 1) === 0x2f /* / */) {
      i += 2;
      const name = readName();
      skipBlanks();
      if (xml[i] !== ">") fail("malformed end tag");
      i += 1;
      const open = stack.pop();
      if (!open || open.name !== name) fail(`unexpected </${name}>`);
      continue;
    }
    i += 1;
    const name = readName();
    if (stack.length === 0 && root !== null) fail("more than one root element");
    const element = { name, attrs: new Map(), elements: [], text: [] };
    let selfClosing = false;
    for (;;) {
      const before = i;
      skipBlanks();
      if (xml[i] === ">") {
        i += 1;
        break;
      }
      if (xml[i] === "/") {
        if (xml[i + 1] !== ">") fail("malformed tag");
        i += 2;
        selfClosing = true;
        break;
      }
      if (i === before) fail("no whitespace between attributes");
      const key = readName();
      skipBlanks();
      if (xml[i] !== "=") fail(`attribute "${key}" has no value`);
      i += 1;
      skipBlanks();
      const quote = xml[i];
      if (quote !== '"' && quote !== "'") fail("unquoted attribute value");
      const close = xml.indexOf(quote, i + 1);
      if (close < 0) fail("unclosed attribute value");
      if (element.attrs.has(key)) fail(`attribute "${key}" given twice`);
      element.attrs.set(key, xml.slice(i + 1, close));
      i = close + 1;
    }
    if (stack.length > 0) stack[stack.length - 1].elements.push(element);
    else root = element;
    if (!selfClosing) stack.push(element);
  }
  if (stack.length > 0) fail(`<${stack[stack.length - 1].name}> is not closed`);
  if (root === null) fail("no root element");
  return root;
}

/** An element the platform's parser reads as a plain string: no attributes and no child elements. */
const isPlain = (el) => el.attrs.size === 0 && el.elements.length === 0;
/** An attribute value as XML normalises it (a literal tab/newline is a space), references decoded. */
const attr = (el, name) => {
  const v = el.attrs.get(name);
  return typeof v === "string" ? decodeReferences(v.replace(/[\t\n\r]/g, " ")) : undefined;
};
const usesBf = (el) => [...el.attrs.keys()].some((k) => k.startsWith("bf:"));
const childrenNamed = (el, name) => el.elements.filter((c) => c.name === name);

const FILE_BF_ATTRS = ["bf:format", "bf:exported-at", "bf:by", "bf:next-cursor"];
const UNIT_BF_ATTRS = ["bf:kind", "bf:group", "bf:type", "bf:source-hash", "bf:target-hash"];

function checkAttributes(el, allowedBf, where) {
  for (const key of el.attrs.keys()) {
    if (key.startsWith("bf:") && !allowedBf.includes(key)) throw new XliffError(`Unknown attribute in <${where}>: ${key}.`);
  }
  const bound = attr(el, "xmlns:bf");
  if (bound !== undefined && bound !== BLOCOFY_XLIFF_NAMESPACE) throw new XliffError(`The "bf" prefix cannot be bound to another namespace in <${where}>.`);
  const defaults = attr(el, "xmlns");
  if (defaults !== undefined && defaults !== XLIFF_NAMESPACE) throw new XliffError(`The default namespace cannot be changed in <${where}>.`);
}

function assertKnown(el, allowedChildren, allowedBf, where) {
  for (const child of el.elements) {
    if (!allowedChildren.includes(child.name)) throw new XliffError(`Unsupported element in <${where}>: <${child.name}>.`);
  }
  checkAttributes(el, allowedBf, where);
  if (el.text.join("").trim() !== "") throw new XliffError(`Unexpected text in <${where}>.`);
}

/** The text of the one `<where>` among `list` ("" when absent). */
function textOf(list, where) {
  if (list.length === 0) return "";
  if (list.length > 1) throw new XliffError(`<${where}> appears more than once in a unit.`);
  const el = list[0];
  checkAttributes(el, [], where);
  if (el.elements.length > 0) {
    throw new XliffError(`Inline elements are not supported in <${where}> (<${el.elements[0].name}>); write the text as plain or escaped HTML.`);
  }
  return decodeReferences(el.text.join(""));
}

const UNBOUND_BF = `The "bf" prefix cannot be used without being bound to the namespace "${BLOCOFY_XLIFF_NAMESPACE}".`;

export function fromXliff(input) {
  if (typeof input !== "string" || input.trim() === "") throw new XliffError("The XLIFF file is empty.");
  if (input.length > XLIFF_MAX_CHARS) throw new XliffError("The XLIFF file is too large; split it into smaller files.");
  // XML end-of-line handling (XML 1.0 §2.11): a literal CR / CRLF is a newline. An escaped `&#13;` stays a CR.
  const xml = input.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  refuseUnsupportedMarkup(xml);
  const root = parseElements(xml);
  if (root.name !== "xliff" || isPlain(root)) throw new XliffError("The root element must be <xliff>.");
  if (attr(root, "version") !== "1.2") throw new XliffError("Only XLIFF 1.2 is supported.");
  if (attr(root, "xmlns") !== XLIFF_NAMESPACE) throw new XliffError(`<xliff> must declare the namespace "${XLIFF_NAMESPACE}".`);
  const bfNamespace = attr(root, "xmlns:bf");
  if (bfNamespace !== undefined && bfNamespace !== BLOCOFY_XLIFF_NAMESPACE) throw new XliffError(`The "bf" prefix must be bound to the namespace "${BLOCOFY_XLIFF_NAMESPACE}".`);
  assertKnown(root, ["file"], [], "xliff");
  const files = childrenNamed(root, "file");
  if (files.length !== 1 || isPlain(files[0])) throw new XliffError("An XLIFF file must contain exactly one <file>.");
  const file = files[0];
  assertKnown(file, ["header", "body"], FILE_BF_ATTRS, "file");
  if (bfNamespace === undefined && usesBf(file)) throw new XliffError(UNBOUND_BF);
  const sourceLocale = attr(file, "source-language");
  const targetLocale = attr(file, "target-language");
  if (!sourceLocale || !targetLocale) throw new XliffError("<file> must carry source-language and target-language.");

  const bodies = childrenNamed(file, "body");
  if (bodies.length > 1) throw new XliffError("<body> cannot be read.");
  const body = bodies[0];
  let rawUnits = [];
  if (body !== undefined && !(isPlain(body) && body.text.join("").trim() === "")) {
    if (isPlain(body)) throw new XliffError("<body> cannot be read.");
    assertKnown(body, ["trans-unit"], [], "body");
    rawUnits = body.elements;
  }

  const units = rawUnits.map((raw, index) => {
    if (isPlain(raw)) throw new XliffError(`<trans-unit> number ${index + 1} cannot be read.`);
    assertKnown(raw, ["source", "target", "note"], UNIT_BF_ATTRS, "trans-unit");
    if (bfNamespace === undefined && usesBf(raw)) throw new XliffError(UNBOUND_BF);
    const id = attr(raw, "id");
    if (!id) throw new XliffError(`<trans-unit> number ${index + 1} has no id.`);
    const targets = childrenNamed(raw, "target");
    const target = textOf(targets, "target");
    const notes = childrenNamed(raw, "note");
    return {
      id,
      kind: attr(raw, "bf:kind"),
      group: attr(raw, "bf:group"),
      context: notes.length > 0 ? textOf([notes[0]], "note") : "",
      type: attr(raw, "bf:type") ?? (attr(raw, "datatype") === "html" ? "html" : "text"),
      source: textOf(childrenNamed(raw, "source"), "source"),
      source_hash: attr(raw, "bf:source-hash") ?? "",
      target,
      target_hash: attr(raw, "bf:target-hash") ?? "",
      state: stateFromXliff(targets.length === 1 && !isPlain(targets[0]) ? attr(targets[0], "state") : undefined, target),
    };
  });

  const read = readTranslationPackage({
    format: attr(file, "bf:format") ?? TRANSLATION_FORMAT,
    source_locale: sourceLocale,
    target_locale: targetLocale,
    exported_at: attr(file, "bf:exported-at"),
    by: attr(file, "bf:by"),
    next_cursor: attr(file, "bf:next-cursor"),
    units,
  });
  if (!read.ok) throw new XliffError(read.message);
  return read.pkg;
}

// ── v1 client ───────────────────────────────────────────────────────────────────────────────────────────────

/**
 * `once`: send exactly one attempt. A 5xx or a lost connection throws `ImportOutcomeUnknown` (the server may have done
 * part of the work); a 429 throws `ImportNotApplied` (the call was refused before any work).
 */
async function requestJson(url, init, onRetry, once = false) {
  let res;
  try {
    res = await fetchWithRetry(url, init, { onRetry, retries: once ? 0 : undefined });
  } catch (error) {
    if (once) throw new ImportOutcomeUnknown(error?.name === "TimeoutError" ? "timeout" : error?.message ?? String(error));
    throw error;
  }
  if (once && res.status === 429) {
    await res.arrayBuffer().catch(() => {});
    throw new ImportNotApplied(`HTTP ${res.status}`);
  }
  if (once && res.status >= 500) {
    await res.arrayBuffer().catch(() => {});
    throw new ImportOutcomeUnknown(`HTTP ${res.status}`);
  }
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (res.ok) {
    if (json === null) throw new Error(`HTTP ${res.status}: empty or non-JSON response`);
    return json;
  }
  if (res.status >= 400 && res.status < 500) {
    const error = json?.error && typeof json.error === "object" ? json.error : { code: `http_${res.status}`, message: text.slice(0, 200) || `HTTP ${res.status}` };
    throw new CliRefusal(res.status, error);
  }
  const detail = json?.error?.message ?? (text ? text.slice(0, 200) : "");
  throw Object.assign(new Error(`HTTP ${res.status}${detail ? `: ${detail}` : ""}`), { status: res.status });
}

const base = (apiUrl) => String(apiUrl).replace(/\/+$/, "");

/** Append every `skipped` list of one export window to the running report (by section and reason). */
function mergeSkips(into, skipped) {
  for (const section of ["groups", "texts", "kinds"]) {
    const byReason = isRecord(skipped?.[section]) ? skipped[section] : {};
    for (const [reason, list] of Object.entries(byReason)) {
      if (!Array.isArray(list) || list.length === 0) continue;
      (into[section][reason] ??= []).push(...list);
    }
  }
  return into;
}

/**
 * Every window of the export for one language, merged into one package (`next_cursor: null`), plus the merged
 * `skipped` report. A window may hold zero units and still carry a cursor: the loop follows the cursor until it is
 * null (the JSON answer carries it in the body; `x-next-cursor` / `x-skipped` are the XLIFF answer's headers).
 */
export async function exportAllTranslations({ apiUrl, apiKey, locale, only = "all", onRetry = null, onPage = null, maxWindows = 1000 }) {
  const units = [];
  const skipped = { groups: {}, texts: {}, kinds: {} };
  const seen = new Set();
  let first = null;
  let cursor = null;
  for (let page = 1; ; page += 1) {
    if (page > maxWindows) throw new Error(`The export was stopped after ${maxWindows} windows without reaching the end.`);
    const query = new URLSearchParams({ target_locale: locale, format: "json" });
    if (only !== "all") query.set("only", only);
    if (cursor) query.set("cursor", cursor);
    query.set("limit", String(EXPORT_MAX_LIMIT));
    const data = await requestJson(`${base(apiUrl)}/api/v1/translations/export?${query}`, { method: "GET", headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" } }, onRetry);
    if (!isRecord(data) || data.format !== TRANSLATION_FORMAT || !Array.isArray(data.units)) throw new Error("The server's answer is not a translation package.");
    first ??= data;
    units.push(...data.units);
    mergeSkips(skipped, data.skipped);
    onPage?.({ page, units: units.length });
    const next = typeof data.next_cursor === "string" && data.next_cursor !== "" ? data.next_cursor : null;
    if (next === null) break;
    // A cursor seen before (twice in a row, or in a cycle) would page forever.
    if (seen.has(next)) throw new Error("The server returned a cursor it had already returned; the export was stopped.");
    seen.add(next);
    cursor = next;
  }
  const pkg = { format: TRANSLATION_FORMAT, source_locale: first.source_locale, target_locale: first.target_locale, exported_at: first.exported_at, by: first.by, units, next_cursor: null };
  return { pkg, skipped };
}

/**
 * A wet import with `publish` got no definite answer (a 5xx or a lost connection) and was NOT resent:
 * a resend cannot see what the first call already published (its units would answer `unchanged` and nothing would
 * count as published), so the outcome is reported as unknown instead.
 */
export class ImportOutcomeUnknown extends Error {
  constructor(reason) {
    super(`The import call got no definite answer (${reason}).`);
    this.name = "ImportOutcomeUnknown";
    this.reason = reason;
  }
}

/** A wet import with `publish` was refused with 429 before any work and was NOT resent (see `ImportOutcomeUnknown`). */
export class ImportNotApplied extends Error {
  constructor(reason) {
    super(`The import call was refused before it was applied (${reason}).`);
    this.name = "ImportNotApplied";
    this.reason = reason;
  }
}

/**
 * POST one chunk. Dry runs and imports without `publish` are retried (lib/http.mjs): a resent write converges (a text
 * already written answers `unchanged`). A wet import WITH `publish` is sent exactly once (`ImportOutcomeUnknown`).
 */
export function importTranslationChunk({ apiUrl, apiKey, chunk, dryRun, publish, onSourceChange = "skip", onRetry = null }) {
  return requestJson(
    `${base(apiUrl)}/api/v1/translations/import`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ package: chunk, dry_run: dryRun, publish, on_source_change: onSourceChange }),
    },
    onRetry,
    !dryRun && publish === true,
  );
}

// ── customer copy ───────────────────────────────────────────────────────────────────────────────────────────

const EXPORT_SKIPPED_GROUPS = {
  source_not_published: (n) => `${n} page(s) or record(s) left out: not published in the source language.`,
  duplicate_source: (n) => `${n} translation group(s) left out: more than one version in the default language; resolve the duplicate first.`,
  ambiguous_target: (n) => `${n} translation group(s) left out: more than one version in the target language; resolve the duplicate first.`,
  target_unlinked: (n) => `${n} page(s) or record(s) left out: an unlinked version with the same URL exists in the target language; link the two first.`,
  target_structure_differs: (n) => `${n} menu(s) differ in structure in the target language: their texts are in the package but are not written on import.`,
  schema_unavailable: (n) => `${n} group(s) left out: the theme files could not be read; export again shortly.`,
  source_gone: (n) => `${n} source(s) left out: deleted or changed during the export.`,
};
const EXPORT_SKIPPED_TEXTS = {
  unaddressable_name: (n) => `${n} text(s) left out: their field name contains ":" or ".".`,
  duplicate_node_id: (n) => `${n} text(s) left out: their sections share an id.`,
  empty_node_id: (n) => `${n} text(s) left out: their sections have no id.`,
  target_not_text: (n) => `${n} field(s) left out: bound to a dynamic source in the target language.`,
  unknown_schema: (n) => `${n} field(s) left out: their section schema could not be read.`,
  empty_value: (n) => `${n} option(s) left out: the option value is empty.`,
};
const KIND_LABELS = { page: "Page", entry: "Record", navigation: "Menu", settings: "Site settings", theme: "Theme", option: "Option" };

/** The merged export `skipped` report as lines (one per reason). */
export function exportSkipLines(skipped) {
  const lines = [];
  for (const [reason, list] of Object.entries(skipped.groups)) lines.push(EXPORT_SKIPPED_GROUPS[reason]?.(list.length) ?? `${list.length} item(s) left out (${reason}).`);
  for (const [reason, list] of Object.entries(skipped.texts)) {
    const count = list.reduce((sum, t) => sum + (Number.isFinite(t?.count) ? t.count : 1), 0);
    lines.push(EXPORT_SKIPPED_TEXTS[reason]?.(count) ?? `${count} text(s) left out (${reason}).`);
  }
  for (const list of Object.values(skipped.kinds)) {
    for (const k of list) lines.push(`${KIND_LABELS[k?.kind] ?? "Some"} texts were left out this time: the theme files could not be read. Export again shortly.`);
  }
  return lines;
}

const PUBLISH_SKIPPED = {
  target_archived: (n) => `${n} record(s) not published: archived (the translation was saved).`,
  target_gone: (n) => `${n} record(s) not published: no longer found.`,
};
const NOTE_RESULTS = new Set(["source_changed", "target_changed", "blocked"]);
const addOnce = (list, value) => (typeof value === "string" && value !== "" && !list.includes(value) ? [...list, value] : list);

export function emptyImportTally() {
  return {
    counts: Object.fromEntries(IMPORT_UNIT_STATES.map((state) => [state, 0])),
    created: 0,
    stamped: 0,
    published: 0,
    publishBlocked: 0,
    publishSkipped: {},
    notes: [],
    hints: [],
    cacheDegraded: false,
    cacheHints: [],
  };
}

/** One chunk's import report folded into the run's tally (the panel's `addReport`). Pure. */
export function addImportReport(tally, report) {
  const counts = { ...tally.counts };
  let notes = tally.notes;
  for (const unit of Array.isArray(report?.units) ? report.units : []) {
    if (Object.hasOwn(counts, unit.result)) counts[unit.result] += 1;
    if (NOTE_RESULTS.has(unit.result)) notes = addOnce(notes, unit.message);
  }
  let { created, stamped, hints } = tally;
  const publishSkipped = { ...tally.publishSkipped };
  for (const group of Array.isArray(report?.groups) ? report.groups : []) {
    if (group.created) created += 1;
    if (group.stamped === true && !group.updated) stamped += 1;
    if (group.publish_reason) publishSkipped[group.publish_reason] = (publishSkipped[group.publish_reason] ?? 0) + 1;
    else notes = addOnce(notes, group.message);
    hints = addOnce(hints, group.details?.hint);
  }
  const cache = report?.cache;
  const degraded = isRecord(cache) && cache.ok === false;
  return {
    counts,
    created,
    stamped,
    published: tally.published + (report?.publication?.published ?? 0),
    publishBlocked: tally.publishBlocked + (report?.publication?.blocked ?? 0),
    publishSkipped,
    notes,
    hints,
    cacheDegraded: tally.cacheDegraded || degraded,
    cacheHints: degraded ? addOnce(tally.cacheHints, [cache.code, cache.reason].filter(Boolean).join(": ")) : tally.cacheHints,
  };
}

/** The summary of a whole import run (dry or wet), as lines. The counts use the report's state names. */
export function importSummaryLines(tally, { dryRun, publish, locale, splitGroups = [] }) {
  const parts = IMPORT_UNIT_STATES.filter((state) => tally.counts[state] > 0).map((state) => `${tally.counts[state]} ${state}`);
  const lines = [`${dryRun ? "Dry run" : "Imported"} ${locale}: ${parts.length > 0 ? parts.join(", ") : "nothing to do"}`];
  if (tally.created > 0) lines.push(`${dryRun ? "Would create" : "Created"} ${tally.created} new page(s), record(s) or menu(s) in ${locale}.`);
  if (tally.stamped > 0) lines.push(`${dryRun ? "Would mark" : "Marked"} ${tally.stamped} page(s) as translated.`);
  if (!dryRun && publish) {
    lines.push(`Published ${tally.published} page(s) and record(s).${tally.publishBlocked > 0 ? ` ${tally.publishBlocked} could not be published and stay drafts.` : ""}`);
  }
  for (const [reason, count] of Object.entries(tally.publishSkipped)) {
    lines.push(PUBLISH_SKIPPED[reason]?.(count) ?? `${count} page(s) or record(s) not published (the translation was saved).`);
  }
  if (!dryRun && !publish && tally.counts.applied > 0) {
    lines.push("Page content and new pages and records were written as drafts; publish them with --publish or from the admin panel.");
  }
  if (splitGroups.length > 0) {
    lines.push(`${splitGroups.length} page(s) or record(s) hold more than 5,000 texts and ${dryRun ? "would be" : "were"} sent in several calls, so they are not marked translated.`);
  }
  if (tally.cacheDegraded) lines.push("The translations were saved, but the site cache could not be refreshed; visitors may see the change only after a few minutes.");
  if (tally.notes.length > 0) {
    lines.push("Notes:");
    for (const note of tally.notes) lines.push(`  - ${note}`);
  }
  const technical = [...tally.hints, ...tally.cacheHints];
  if (technical.length > 0) {
    lines.push("Details:");
    for (const hint of technical) lines.push(`  ${hint}`);
  }
  return lines;
}
