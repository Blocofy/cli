/**
 * Local draft browsing (theme dev, contract 2): navigation-link mapping on the HTML the platform returns.
 *
 * A narrow HTML start-tag tokenizer (no dependency) finds the navigation surfaces — `a[href]`, `area[href]`,
 * `form[action]`, `button[formaction]`, `input[formaction]`, `meta[http-equiv=refresh]` content URL and
 * `link[rel~=alternate][href]` — and classifies each URL:
 *   - its origin is one of the site's `internalOrigins` (also a protocol-relative `//host/…`) → rewritten to the
 *     local origin, path + query + hash kept;
 *   - `javascript:` / `data:` / `vbscript:`, userinfo (`https://u@host`), a malformed URL or a character reference
 *     this tokenizer does not know → the attribute is removed and `data-blocofy-blocked="<attribute>"` is left;
 *   - anything else (relative, external, `mailto:`…) → unchanged.
 * Assets (img/src, srcset, script src, stylesheets, iframes) and `link[rel=canonical]` (public identity, PM decision 5)
 * are never touched. This mapping is navigation convenience only: side-effect containment is the CSP response header
 * set by the dev server, not this rewrite.
 */

const RAW_TEXT = new Set(["script", "style", "xmp", "iframe", "noembed", "noframes", "noscript", "textarea", "title"]);
const BLOCKED_SCHEMES = new Set(["javascript:", "data:", "vbscript:"]);
const isWs = (c) => c === " " || c === "\t" || c === "\n" || c === "\f" || c === "\r";
const isAlpha = (c) => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z");

/**
 * Parse the start (or end) tag whose name begins at `p`. Returns { name, attrs, end } or null at EOF (an unfinished tag
 * is not emitted by a browser either). Each attribute: { name, raw, start, end } — `raw` is the undecoded value,
 * `start..end` the whole attribute (name through value) in `html`.
 */
function parseTag(html, p) {
  const n = html.length;
  let j = p;
  while (j < n && !isWs(html[j]) && html[j] !== "/" && html[j] !== ">") j++;
  const name = html.slice(p, j).toLowerCase();
  const attrs = [];
  for (;;) {
    while (j < n && (isWs(html[j]) || html[j] === "/")) j++;
    if (j >= n) return null;
    if (html[j] === ">") return { name, attrs, end: j + 1 };
    const start = j;
    j++; // the first character of a name may be "=" (spec: part of the name)
    while (j < n && !isWs(html[j]) && html[j] !== "/" && html[j] !== ">" && html[j] !== "=") j++;
    const attrName = html.slice(start, j).toLowerCase();
    let k = j;
    while (k < n && isWs(html[k])) k++;
    if (html[k] !== "=") {
      attrs.push({ name: attrName, raw: "", start, end: j });
      continue;
    }
    k++;
    while (k < n && isWs(html[k])) k++;
    if (k >= n) return null;
    const q = html[k];
    if (q === '"' || q === "'") {
      const close = html.indexOf(q, k + 1);
      if (close < 0) return null;
      attrs.push({ name: attrName, raw: html.slice(k + 1, close), start, end: close + 1 });
      j = close + 1;
    } else if (q === ">") {
      attrs.push({ name: attrName, raw: "", start, end: k });
      j = k;
    } else {
      let e = k;
      while (e < n && !isWs(html[e]) && html[e] !== ">") e++;
      attrs.push({ name: attrName, raw: html.slice(k, e), start, end: e });
      j = e;
    }
  }
}

/** Index of the `</name` end tag (followed by whitespace, "/" or ">") from `from`, case-insensitive; else EOF. */
function rawTextEnd(html, from, name) {
  let i = from;
  for (;;) {
    const lt = html.indexOf("</", i);
    if (lt < 0) return html.length;
    const after = html[lt + 2 + name.length];
    if (
      html.slice(lt + 2, lt + 2 + name.length).toLowerCase() === name &&
      (after === undefined || isWs(after) || after === "/" || after === ">")
    ) {
      return lt;
    }
    i = lt + 2;
  }
}

/**
 * Every start tag in `html`, in document order: { name, attrs, start, end }. Comments, doctype/bogus comments, end
 * tags and the content of raw-text/RCDATA elements (script, style, textarea, title, noscript, iframe, xmp, noembed,
 * noframes) are skipped; `<template>` content is markup and is scanned.
 */
export function startTags(html) {
  const tags = [];
  const n = html.length;
  let i = 0;
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt < 0) break;
    const next = html[lt + 1];
    if (html.startsWith("<!--", lt)) {
      const body = lt + 4;
      if (html[body] === ">") {
        i = body + 1;
        continue;
      }
      if (html.startsWith("->", body)) {
        i = body + 2;
        continue;
      }
      const a = html.indexOf("-->", body);
      const b = html.indexOf("--!>", body);
      const ends = [a < 0 ? Infinity : a + 3, b < 0 ? Infinity : b + 4];
      const end = Math.min(...ends);
      if (end === Infinity) break;
      i = end;
      continue;
    }
    if (next === "!" || next === "?") {
      const gt = html.indexOf(">", lt + 2);
      if (gt < 0) break;
      i = gt + 1;
      continue;
    }
    if (next === "/") {
      if (isAlpha(html[lt + 2] ?? "")) {
        const endTag = parseTag(html, lt + 2);
        if (!endTag) break;
        i = endTag.end;
        continue;
      }
      const gt = html.indexOf(">", lt + 2);
      if (gt < 0) break;
      i = gt + 1;
      continue;
    }
    if (isAlpha(next ?? "")) {
      const tag = parseTag(html, lt + 1);
      if (!tag) break;
      tags.push({ ...tag, start: lt });
      i = tag.end;
      if (tag.name === "plaintext") break;
      if (RAW_TEXT.has(tag.name)) i = rawTextEnd(html, i, tag.name);
      continue;
    }
    i = lt + 1;
  }
  return tags;
}

// Character references that can change how a URL is classified (ASCII punctuation, tab/newline) + the common ones.
// A named reference not listed here makes the value "malformed" (fail-closed), never silently literal.
const NAMED = {
  amp: "&", AMP: "&", lt: "<", LT: "<", gt: ">", GT: ">", quot: '"', QUOT: '"', apos: "'",
  colon: ":", sol: "/", bsol: "\\", period: ".", quest: "?", num: "#", commat: "@", percnt: "%",
  equals: "=", excl: "!", dollar: "$", lpar: "(", rpar: ")", ast: "*", midast: "*", plus: "+",
  comma: ",", semi: ";", lsqb: "[", lbrack: "[", rsqb: "]", rbrack: "]", lowbar: "_", UnderBar: "_",
  grave: "`", DiacriticalGrave: "`", lcub: "{", lbrace: "{", rcub: "}", rbrace: "}", verbar: "|",
  vert: "|", VerticalLine: "|", Hat: "^", Tab: "\t", NewLine: "\n", nbsp: " ",
};
// Legacy names a browser also decodes without ";" (in an attribute only when not followed by [A-Za-z0-9=]).
const LEGACY = new Set(["amp", "AMP", "lt", "LT", "gt", "GT", "quot", "QUOT", "nbsp"]);

/** Decode an attribute value's character references. { text, unknown } — `unknown` = a reference we cannot decode. */
export function decodeAttr(raw) {
  let unknown = false;
  const text = raw.replace(/&(#[xX][0-9a-fA-F]+;?|#[0-9]+;?|[A-Za-z][A-Za-z0-9]*;?)/g, (whole, ref, offset) => {
    if (ref[0] === "#") {
      const hex = ref[1] === "x" || ref[1] === "X";
      const digits = ref.slice(hex ? 2 : 1).replace(/;$/, "");
      const cp = parseInt(digits, hex ? 16 : 10);
      if (!cp || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return "�";
      return String.fromCodePoint(cp);
    }
    if (ref.endsWith(";")) {
      const name = ref.slice(0, -1);
      if (Object.hasOwn(NAMED, name)) return NAMED[name];
      unknown = true;
      return whole;
    }
    const nextChar = raw[offset + whole.length] ?? "";
    if (LEGACY.has(ref) && !/[A-Za-z0-9=]/.test(nextChar)) return NAMED[ref];
    return whole; // `?a=1&b=2`: not a reference
  });
  return { text, unknown };
}

const escapeAttr = (value) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

/**
 * Classify one navigation URL. → { action: "keep" } | { action: "rewrite", value } | { action: "block", reason }.
 * `pageUrl` is the local page URL (http); a protocol-relative value is also resolved over https so `//host/x` of an
 * internal https origin is recognised.
 */
export function classifyNavigationUrl(raw, { pageUrl, internal, localOrigin }) {
  const { text, unknown } = decodeAttr(raw);
  if (unknown) return { action: "block", reason: "malformed" };
  let viaHttp;
  let viaHttps;
  try {
    viaHttp = new URL(text, pageUrl);
    const httpsBase = new URL(pageUrl);
    httpsBase.protocol = "https:";
    viaHttps = new URL(text, httpsBase);
  } catch {
    return { action: "block", reason: "malformed" };
  }
  if (BLOCKED_SCHEMES.has(viaHttp.protocol)) return { action: "block", reason: viaHttp.protocol.slice(0, -1) };
  if (viaHttp.username || viaHttp.password) return { action: "block", reason: "userinfo" };
  const hit = internal.has(viaHttp.origin) ? viaHttp : internal.has(viaHttps.origin) ? viaHttps : null;
  if (hit) return { action: "rewrite", value: `${localOrigin}${hit.pathname}${hit.search}${hit.hash}` };
  return { action: "keep" };
}

/** `<delay>[;,] url=<url>` → { delay, url } (HTML "shared declarative refresh steps"); url null when absent/invalid. */
export function parseRefresh(content) {
  let i = 0;
  const s = content;
  while (i < s.length && isWs(s[i])) i++;
  const delayStart = i;
  while (i < s.length && /[0-9.]/.test(s[i])) i++;
  if (i === delayStart) return null;
  const delay = s.slice(delayStart, i);
  if (i >= s.length) return { delay, url: null };
  if (!isWs(s[i]) && s[i] !== ";" && s[i] !== ",") return null;
  while (i < s.length && isWs(s[i])) i++;
  if (s[i] === ";" || s[i] === ",") i++;
  while (i < s.length && isWs(s[i])) i++;
  if (i >= s.length) return { delay, url: null };
  if (s.slice(i, i + 3).toLowerCase() === "url") {
    let j = i + 3;
    while (j < s.length && isWs(s[j])) j++;
    if (s[j] === "=") {
      j++;
      while (j < s.length && isWs(s[j])) j++;
      i = j;
    }
  }
  let url = s.slice(i);
  if (url[0] === '"' || url[0] === "'") {
    const close = url.indexOf(url[0], 1);
    url = close < 0 ? url.slice(1) : url.slice(1, close);
  }
  return { delay, url };
}

const relTokens = (attr) => (attr ? decodeAttr(attr.raw).text.toLowerCase().split(/[\t\n\f\r ]+/).filter(Boolean) : []);

/** Which attribute of this tag is a navigation URL (null when the tag is not a navigation surface). */
function navigationAttribute(name, first) {
  switch (name) {
    case "a":
      return first.has("href") ? "href" : first.has("xlink:href") ? "xlink:href" : null;
    case "area":
      return "href";
    case "form":
      return "action";
    case "button":
    case "input":
      return "formaction";
    case "link": {
      const rel = relTokens(first.get("rel"));
      // canonical = public identity (PM decision 5): kept at the site's authority. `alternate stylesheet` is an asset.
      if (!rel.includes("alternate") || rel.includes("canonical") || rel.includes("stylesheet")) return null;
      return "href";
    }
    case "meta":
      return decodeAttr(first.get("http-equiv")?.raw ?? "").text.trim().toLowerCase() === "refresh" ? "content" : null;
    default:
      return null;
  }
}

/**
 * Rewrite the navigation surfaces of `html` (see the module comment). Returns { html, rewritten, blocked }.
 * `internalOrigins` must already be validated origins; `localOrigin` is `http://127.0.0.1:<port>`.
 */
export function rewriteNavigation(html, { pageUrl, internalOrigins, localOrigin }) {
  const internal = new Set(internalOrigins);
  const ctx = { pageUrl, internal, localOrigin };
  const edits = [];
  let rewritten = 0;
  let blocked = 0;
  for (const tag of startTags(html)) {
    // A browser keeps the FIRST of duplicate attributes; later ones are inert — and removed when the first is edited,
    // so an edit never promotes an ignored duplicate.
    const first = new Map();
    for (const attr of tag.attrs) if (!first.has(attr.name)) first.set(attr.name, attr);
    const attrName = navigationAttribute(tag.name, first);
    const attr = attrName && first.get(attrName);
    if (!attr || attr.raw === "") continue;

    let result;
    let refresh = null;
    if (tag.name === "meta") {
      const content = decodeAttr(attr.raw);
      refresh = parseRefresh(content.text);
      if (!refresh || refresh.url === null) continue;
      // The URL was already decoded with the content attribute; re-escape `&` so it is not decoded twice.
      result = content.unknown
        ? { action: "block", reason: "malformed" }
        : classifyNavigationUrl(refresh.url.replace(/&/g, "&amp;"), ctx);
    } else {
      result = classifyNavigationUrl(attr.raw, ctx);
    }
    if (result.action === "keep") continue;

    const dropDuplicates = () => {
      for (const other of tag.attrs) if (other !== attr && other.name === attr.name) edits.push({ start: other.start, end: other.end, text: "" });
    };
    if (result.action === "block") {
      blocked++;
      edits.push({ start: attr.start, end: attr.end, text: `data-blocofy-blocked="${escapeAttr(attrName)}"` });
    } else {
      rewritten++;
      const value = refresh ? `${refresh.delay};url=${result.value}` : result.value;
      edits.push({ start: attr.start, end: attr.end, text: `${attrName}="${escapeAttr(value)}"` });
    }
    dropDuplicates();
  }
  if (edits.length === 0) return { html, rewritten, blocked };
  edits.sort((x, y) => y.start - x.start);
  let out = html;
  for (const edit of edits) out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  return { html: out, rewritten, blocked };
}
