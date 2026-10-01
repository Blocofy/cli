import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import { chunkPackage, exportAllTranslations, fitChunksToBodyCap, fromXliff, readPackageFile, readTranslationPackage, toXliff, XLIFF_MAX_CHARS, XliffError } from "../lib/translations.mjs";

/**
 * #925 — `blocofy translations export|import`. The XLIFF fixtures are the platform's
 * (multisite-cms packages/cms/test/fixtures/translation-xliff-vector.{package.json,xlf,cases.json}, copied byte for byte):
 * the CLI's converter must write and read the vector byte-exactly and agree with the platform on every dialect case.
 * The X-numbered tests mirror the platform's own suite (packages/cms/test/translation-xliff.test.ts).
 */
const root = fileURLToPath(new URL("..", import.meta.url));
const fixture = (name) => readFileSync(join(root, "test", "fixtures", name), "utf8");
const VECTOR = JSON.parse(fixture("translation-xliff-vector.package.json"));
const VECTOR_XLF = fixture("translation-xliff-vector.xlf");
const CASES = JSON.parse(fixture("translation-xliff-vector.cases.json"));
const inEnvelope = (body) => CASES.envelope.replace("{{FILE_EXTRA}}", "").replace("{{BODY}}", body);

const wrap = (body, fileExtra = "") => `<?xml version="1.0" encoding="UTF-8"?>
<xliff version="1.2" xmlns="urn:oasis:names:tc:xliff:document:1.2" xmlns:bf="https://blocofy.com/ns/translation/1">
  <file original="blocofy" datatype="plaintext" source-language="tr-TR" target-language="en-US"${fileExtra}>
    <body>${body}</body>
  </file>
</xliff>
`;
const unit = (source, target = "y") => `<trans-unit id="settings:a"><source>${source}</source><target>${target}</target></trans-unit>`;

function refused(xml, name, pattern) {
  let thrown;
  try {
    fromXliff(xml);
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof XliffError, `${name}: should throw an XliffError (got ${thrown})`);
  if (pattern) assert.match(thrown.message, pattern, name);
}

// ── the shared vector and cases ─────────────────────────────────────────────────────────────────────────────

test("[T1] the shared vector: toXliff is byte-exact and fromXliff reads it back", () => {
  assert.equal(toXliff(VECTOR), VECTOR_XLF);
  assert.deepEqual(fromXliff(VECTOR_XLF), VECTOR);
  const empty = { ...VECTOR, units: [], next_cursor: null, by: "ai" };
  assert.deepEqual(fromXliff(toXliff(empty)), empty);
  assert.ok(!toXliff(empty).includes("bf:next-cursor"));
});

test("[T1b] the shared dialect cases: accepted texts decode exactly, refused ones and documents throw XliffError", () => {
  assert.ok(CASES.accept.length > 0 && CASES.reject.length > 0 && CASES.documents.length > 0);
  for (const c of CASES.accept) {
    const pkg = fromXliff(inEnvelope(c.body));
    assert.equal(pkg.units[0].source, c.source, c.name);
    assert.equal(pkg.units[0].target, c.target, c.name);
  }
  for (const c of CASES.reject) refused(inEnvelope(c.body), c.name);
  for (const c of CASES.documents) refused(c.xml, c.name);
});

// ── the platform's XLIFF suite, ported ──────────────────────────────────────────────────────────────────────

test("[T2] strict: DOCTYPE, CDATA, inline and unknown elements, two files, bad ids and versions are refused", () => {
  const bad = [
    `<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "b">]>${wrap("")}`,
    wrap(`<trans-unit id="settings:a"><source><![CDATA[x]]></source></trans-unit>`),
    wrap(`<trans-unit id="settings:a"><source>x</source><target>a <g id="1">b</g></target></trans-unit>`),
    wrap(`<trans-unit id="settings:a"><source>x</source><alt-trans><target>y</target></alt-trans></trans-unit>`),
    wrap(`<trans-unit id="settings:a"><source>x</source><target>y</target><target>z</target></trans-unit>`),
    wrap(`<trans-unit><source>x</source></trans-unit>`),
    wrap(`<trans-unit id="x:y"><source>x</source></trans-unit>`),
    wrap("", ` bf:format="other/1"`),
    wrap("").replace("</file>", `</file><file original="b" source-language="tr-TR" target-language="en-US"><body></body></file>`),
    wrap("").replace('version="1.2"', 'version="2.0"'),
    "<xliff><file>",
    "",
  ];
  for (const xml of bad) refused(xml, xml.slice(0, 120));
});

test("[T3] a literal CRLF is a newline; &#13; stays a CR", () => {
  const xml = wrap(`<trans-unit id="settings:a"><source>a\nb&#13;c</source><target>y</target></trans-unit>`).replace(/\n/g, "\r\n");
  assert.equal(fromXliff(xml).units[0].source, "a\nb\rc");
});

test("[X3] a translator's tool: missing bf attributes are derived from the id; unknown states read by target", () => {
  const pkg = fromXliff(
    wrap(`
      <trans-unit id="settings:site_name"><source>Altın</source><target state="final">Golden</target></trans-unit>
      <trans-unit id="entry:haberler:9:ozet" datatype="html"><source>a</source><target state="signed-off"></target></trans-unit>`),
  );
  assert.deepEqual(pkg.units, [
    { id: "settings:site_name", kind: "settings", group: "settings", context: "", type: "text", source: "Altın", source_hash: "", target: "Golden", target_hash: "", state: "translated" },
    { id: "entry:haberler:9:ozet", kind: "entry", group: "entry:haberler:9", context: "", type: "html", source: "a", source_hash: "", target: "", target_hash: "", state: "missing" },
  ]);
  assert.equal(pkg.format, "blocofy-translation/1");
  assert.equal(pkg.by, "human");
  assert.equal(pkg.exported_at, "");
});

test("[X5] XML-unsafe characters are refused on the way out; an astral character round-trips", () => {
  assert.throws(() => toXliff({ ...VECTOR, units: [{ ...VECTOR.units[2], target: "a\u0001b" }] }), XliffError);
  assert.throws(() => toXliff({ ...VECTOR, units: [{ ...VECTOR.units[2], target: "a\ud800b" }] }), XliffError);
  assert.throws(() => toXliff({ ...VECTOR, next_cursor: "a\u0000b" }), XliffError);
  const astral = { ...VECTOR, units: [{ ...VECTOR.units[2], target: "\u{1F600}" }] };
  assert.deepEqual(fromXliff(toXliff(astral)), astral);
});

test("[X6] a header and comments are ignored", () => {
  const xml = wrap(`<!-- note --><trans-unit id="settings:a"><source>x</source><target>y</target></trans-unit>`).replace("<body>", '<header><tool tool-id="t"/></header><body>');
  assert.deepEqual(fromXliff(xml).units.map((u) => u.target), ["y"]);
});

test("[X9] the errors name the problem", () => {
  const message = (body) => {
    try {
      fromXliff(inEnvelope(body));
    } catch (error) {
      return error.message;
    }
    return "";
  };
  const one = (s) => `<trans-unit id="settings:a"><source>${s}</source></trans-unit>`;
  assert.ok(message(one("A & B")).includes('"&"'));
  assert.ok(message(one("A & B")).includes("line 4"));
  assert.ok(message(one("a&nbsp;b")).includes("&nbsp;"));
  assert.ok(message(one("&#0;")).includes("&#0;"));
});

test("[X10/X11] DOCTYPE, entity declarations, processing instructions and an entity bomb are refused; a comment that mentions them is not", () => {
  assert.throws(() => fromXliff(`<!DOCTYPE xliff SYSTEM "http://x/y.dtd">${wrap("")}`), /DOCTYPE/);
  assert.throws(() => fromXliff(`<?xml version="1.0"?><!ENTITY a "b">${wrap("")}`), /ENTITY/);
  assert.throws(() => fromXliff(wrap(`<?xml-stylesheet href="a.css"?>`)), /processing instruction/);
  assert.throws(() => fromXliff(`<?xml version="1.0"?><?php echo 1;?>${wrap("")}`), /processing instruction/);
  assert.deepEqual(fromXliff(wrap(`<!-- <!DOCTYPE x> <?pi?> &nbsp; & -->`)).units, []);
  const bomb = `<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;">]>${wrap(`<trans-unit id="settings:a"><source>&lol2;</source></trans-unit>`)}`;
  assert.throws(() => fromXliff(bomb), XliffError);
});

test("[X12] the input is bounded before it is parsed", () => {
  refused(wrap(`<trans-unit id="settings:a"><source>${"a".repeat(XLIFF_MAX_CHARS)}</source></trans-unit>`), "huge", /too large/);
});

test("[X13] unknown bf attributes are refused; other attributes a tool adds are tolerated", () => {
  refused(wrap("", ` bf:extra="1"`), "bf:extra on file", /bf:extra/);
  refused(wrap(`<trans-unit id="settings:a" bf:nope="1"><source>x</source></trans-unit>`), "bf:nope on a unit", /bf:nope/);
  const tolerated = fromXliff(wrap(`<trans-unit id="settings:a" approved="yes" xml:space="preserve" maxwidth="9"><source xml:lang="tr">x</source><target xml:lang="en">y</target></trans-unit>`));
  assert.equal(tolerated.units[0].source, "x");
  assert.equal(tolerated.units[0].target, "y");
});

test("[X14] namespaces: the XLIFF and bf namespaces must be the right ones", () => {
  refused(wrap("").replace("urn:oasis:names:tc:xliff:document:1.2", "urn:other"), "other default namespace");
  refused(wrap("").replace(' xmlns="urn:oasis:names:tc:xliff:document:1.2"', ""), "no default namespace");
  refused(wrap("").replace("https://blocofy.com/ns/translation/1", "https://evil.example/ns"), "other bf namespace");
  refused(wrap("", ` bf:by="ai"`).replace(' xmlns:bf="https://blocofy.com/ns/translation/1"', ""), "unbound bf");
});

test("[X15] the result passes the package reader: kind and group come from the id, a disagreeing declaration is refused", () => {
  const pkg = fromXliff(VECTOR_XLF);
  const read = readTranslationPackage(JSON.parse(JSON.stringify(pkg)));
  assert.ok(read.ok);
  assert.deepEqual(read.pkg, pkg);
  refused(wrap(`<trans-unit id="settings:a" bf:kind="page"><source>x</source></trans-unit>`), "wrong kind", /kind/);
  refused(wrap(`<trans-unit id="settings:a" bf:group="theme"><source>x</source></trans-unit>`), "wrong group", /group/);
  refused(wrap(`<trans-unit id="settings:a"><source>x</source></trans-unit><trans-unit id="settings:a"><source>x</source></trans-unit>`), "duplicate id");
  refused(wrap("", ` bf:by="robot"`), "bad by", /by/);
});

test("[X16/X27] whitespace inside text is kept; attribute whitespace normalises; an escaped newline in an id survives", () => {
  const u = fromXliff(wrap(`<trans-unit id="settings:a"><source>  a  </source><target> </target></trans-unit>`)).units[0];
  assert.equal(u.source, "  a  ");
  assert.equal(u.target, " ");
  assert.equal(u.state, "missing");
  const multiline = wrap(`<trans-unit id="option:c:f:a&#10;b" resname="a\nb" bf:group="option:c"><source>x</source></trans-unit>`);
  assert.equal(fromXliff(multiline).units[0].id, "option:c:f:a\nb");
  assert.equal(fromXliff(wrap(unit("x"), ` bf:next-cursor="a\nb\tc&#10;d"`)).next_cursor, "a b c\nd");
});

test("[X18/X19] attribute-hidden comment openers, prototype-named elements and deep nesting are refused; odd attribute names pollute nothing", () => {
  refused(wrap(`<trans-unit id="settings:a" foo="<!--"><source>a&copy;b &#0;</source><target bar="-->">y</target></trans-unit>`), "attribute comment bypass");
  refused(`<?xml version="1.0" encoding="<!--"?><!DOCTYPE xliff [<!ENTITY e "x">]><!-- -->${wrap("")}`, "declaration bypass");
  refused(wrap(`<trans-unit id="settings:a" foo="a<b"><source>x</source></trans-unit>`), "less-than in an attribute value", /</);
  refused(wrap(`<__proto__><source>x</source></__proto__>`), "__proto__ element");
  refused(wrap(`<constructor/>`), "constructor element");
  refused(wrap(`${"<a>".repeat(200)}${"</a>".repeat(200)}`), "200-deep nesting", /nested|deep/i);
  const odd = fromXliff(wrap(`<trans-unit id="settings:a" __proto__="1" constructor="2"><source>x</source></trans-unit>`));
  assert.equal(odd.units[0].source, "x");
  assert.equal({}["1"], undefined);
  assert.equal(Object.getPrototypeOf(odd.units[0]), Object.prototype);
});

test("[X20] characters XML 1.0 forbids are refused when they are literal too", () => {
  for (const [name, ch] of [["NUL", "\u0000"], ["SOH", "\u0001"], ["U+FFFE", "￾"], ["U+FFFF", "￿"], ["lone high surrogate", "\ud800"], ["lone low surrogate", "\udc00"]]) {
    refused(wrap(unit(`a${ch}b`)), `raw ${name} in text`, /character/);
    refused(wrap(unit("x"), ` bf:next-cursor="a${ch}b"`), `raw ${name} in an attribute`, /character/);
  }
  refused(wrap(`<!-- a\u0000b -->`), "raw NUL in a comment", /character/);
  assert.equal(fromXliff(wrap(unit("a\u{1F600}b"))).units[0].source, "a\u{1F600}b");
});

test("[X21/X22] the XML declaration and declarations, unclosed constructs", () => {
  refused(wrap("").replace('encoding="UTF-8"', 'encoding="ISO-8859-9"'), "ISO-8859-9", /UTF-8/);
  refused(wrap("").replace('version="1.0"', 'version="1.1"'), "XML 1.1", /1\.0/);
  assert.deepEqual(fromXliff(wrap("").replace('encoding="UTF-8"', 'encoding="utf-8"')).units, []);
  assert.deepEqual(fromXliff(wrap("").replace(' encoding="UTF-8"', "")).units, []);
  assert.deepEqual(fromXliff(wrap("").replace('<?xml version="1.0" encoding="UTF-8"?>\n', "")).units, []);
  refused(wrap("").replace("<xliff", '<?xml version="1.0"?><xliff'), "a second declaration", /processing instruction/);
  refused(wrap("").replace("<xliff", '<!-- c --><?xml version="1.0"?><xliff'), "a declaration after a comment", /processing instruction/);
  refused(wrap("").replace("?>", "<!--"), "unclosed declaration");
  const noDecl = wrap("").replace('<?xml version="1.0" encoding="UTF-8"?>\n', "");
  refused(`<!ELEMENT xliff ANY>${noDecl}`, "ELEMENT", /ELEMENT/);
  refused(`<!ATTLIST xliff a CDATA #IMPLIED>${noDecl}`, "ATTLIST", /ATTLIST/);
  refused(`<!NOTATION n SYSTEM "x">${noDecl}`, "NOTATION", /NOTATION/);
  refused(wrap(unit("x") + "<?pi never closed"), "unclosed PI", /processing instruction/);
  refused(wrap(unit("x") + "<!-- never closed"), "unclosed comment", /comment/);
  refused(wrap(unit("<![CDATA[never closed")), "unclosed CDATA", /CDATA/);
  refused(wrap(unit("a]]>b")), "closing CDATA marker in text", /\]\]>/);
});

test("[X23/X24] references in attribute values are checked like text; leading zeros are fine; a comment inside text is dropped", () => {
  refused(wrap(unit("x"), ` bf:next-cursor="a &copy; b"`), "named entity in an attribute", /&copy;/);
  refused(wrap(unit("x"), ` bf:next-cursor="a & b"`), "bare ampersand in an attribute", /"&"/);
  refused(wrap(unit("x"), ` bf:next-cursor="&#0;"`), "NUL reference in an attribute", /&#0;/);
  assert.equal(fromXliff(wrap(unit("&#x0000041;&#0000066;"))).units[0].source, "AB");
  refused(wrap(unit(`&#${"0".repeat(20)}1234567890;`)), "a reference too long to be a character", /&#/);
  assert.equal(fromXliff(wrap(unit("a<!--x-->b"))).units[0].source, "ab");
});

test("[X25] bf attributes and namespace bindings are checked on source, target and note as well", () => {
  refused(wrap(`<trans-unit id="settings:a"><source bf:x="1">a</source></trans-unit>`), "bf on source", /bf:x/);
  refused(wrap(`<trans-unit id="settings:a"><source>a</source><target bf:state="1">b</target></trans-unit>`), "bf on target", /bf:state/);
  refused(wrap(`<trans-unit id="settings:a"><source>a</source><note bf:x="1">c</note></trans-unit>`), "bf on note", /bf:x/);
  refused(wrap(`<trans-unit id="settings:a"><source xmlns:bf="https://evil.example/ns">a</source></trans-unit>`), "bf rebound on source", /namespace/);
  refused(wrap(`<trans-unit id="settings:a" xmlns:bf="urn:other" bf:kind="settings"><source>a</source></trans-unit>`), "bf rebound on a unit", /namespace/);
  refused(wrap(`<trans-unit id="settings:a"><source xmlns="urn:other">a</source></trans-unit>`), "default namespace rebound", /namespace/);
  assert.equal(fromXliff(wrap(`<trans-unit id="settings:a"><source xmlns:bf="https://blocofy.com/ns/translation/1">a</source></trans-unit>`)).units[0].source, "a");
});

test("[X26] structural refusals name the problem", () => {
  refused(`<?xml version="1.0"?><root><file/></root>`, "non-xliff root", /<xliff>/);
  refused(wrap("").replace("<file ", "stray text <file "), "stray text in xliff", /Unexpected text/);
  refused(wrap(`stray <trans-unit id="settings:a"><source>x</source></trans-unit>`), "stray text in body", /Unexpected text/);
  refused(wrap(`<trans-unit id="settings:a">stray<source>x</source></trans-unit>`), "stray text in a unit", /Unexpected text/);
  refused(wrap("").replace(' xmlns:bf="https://blocofy.com/ns/translation/1"', "").replace("source-language", 'bf:by="ai" source-language'), "unbound bf prefix", /without being bound/);
  refused(wrap("just text"), "body that is not a node", /<body>/);
  refused(wrap(`<trans-unit id="settings:a"><source>a <g id="1">b</g></source></trans-unit>`), "inline element in source", /Inline element/);
  refused(wrap(`<trans-unit id="settings:a"><source>a</source><note>c <x/> d</note></trans-unit>`), "inline element in note", /Inline element/);
  refused(wrap("").replace("<body>", "<bogus/><body>"), "unknown child of file", /<bogus>/);
  refused(wrap(`<group id="g"/>`), "unknown child of body", /<group>/);
  refused(wrap("").replace("<file ", "<bogus/><file "), "unknown child of xliff", /<bogus>/);
  refused(wrap(`<trans-unit id=""><source>x</source></trans-unit>`), "empty id", /id/);
  refused(wrap("").replace('source-language="tr-TR"', ""), "missing source-language", /source-language/);
});

test("[X28/X31] tag caps and strict comment / attribute syntax", () => {
  const at = (ws) => wrap(`<trans-unit id="settings:a"${ws}><source>x</source><target>y</target></trans-unit>`);
  assert.equal(fromXliff(at(" ".repeat(64))).units.length, 1);
  for (const ws of [" ", "\t", "\n", "\r\n"]) refused(at(ws.repeat(65)), `65 × ${JSON.stringify(ws)}`, /whitespace/);
  refused(wrap(`<trans-unit id="settings:a"><source>x</source${" ".repeat(65)}></trans-unit>`), "run in an end tag", /whitespace/);
  refused(wrap("").replace('<?xml version="1.0"', `<?xml version="1.0"${" ".repeat(65)}`), "run in the declaration", /whitespace/);
  assert.equal(fromXliff(wrap(`<trans-unit id="settings:a" x="${"v".repeat(5000)}"><source>x</source></trans-unit>`)).units.length, 1);
  const many = Array.from({ length: 30 }, (_, k) => `${"n".repeat(40)}${k}="1"`).join(" ");
  refused(wrap(`<trans-unit id="settings:a" ${many}><source>x</source></trans-unit>`), "too much outside quotes", /1,024/);
  refused(wrap(`<!-- a -- b -->${unit("x")}`), "double hyphen in a comment", /--/);
  refused(wrap(`<!-- a --->${unit("x")}`), "comment ending in --->", /--/);
  assert.equal(fromXliff(wrap(`<!--- a -->${unit("x")}`)).units.length, 1);
  assert.equal(fromXliff(wrap(`<!---->${unit("x")}`)).units.length, 1);
  refused(wrap(`<trans-unit id="settings:a"=====><source>x</source></trans-unit>`), "stray =", /whitespace/);
  refused(wrap(`<trans-unit id=settings:a><source>x</source></trans-unit>`), "unquoted value", /=/);
  refused(wrap(`<trans-unit id="settings:a"x="1"><source>x</source></trans-unit>`), "no space between attributes", /whitespace/);
  assert.equal(fromXliff(wrap(`<trans-unit id = "settings:a" ><source>x</source></trans-unit>`)).units.length, 1);
});

test("[X32] well-formedness: mismatched, unclosed, extra and misplaced markup is refused", () => {
  const u = `<trans-unit id="settings:a"><source>x</source></trans-unit>`;
  const bad = [
    ["mismatched tags", wrap(`<trans-unit id="settings:a"><source>x</target></trans-unit>`)],
    ["unclosed element", wrap(u).replace("</body>", "")],
    ["extra closing tag", wrap(u).replace("</xliff>", "</xliff></xliff>")],
    ["two roots", wrap(u) + wrap(u).replace(/^<\?xml[^>]*>\n/, "")],
    ["text after the root", wrap(u) + "junk"],
    ["text before the root", "junk" + wrap(u)],
    ["duplicate attribute", wrap(`<trans-unit id="settings:a" id="settings:b"><source>x</source></trans-unit>`)],
    ["attribute without a value", wrap(`<trans-unit id="settings:a" translate><source>x</source></trans-unit>`)],
    ["element name starting with a digit", wrap(`<1a></1a>`)],
    ["space after <", wrap(`< trans-unit id="settings:a"></trans-unit>`)],
    ["end tag with an attribute", wrap(`<trans-unit id="settings:a"><source>x</source></trans-unit x="1">`)],
  ];
  for (const [name, xml] of bad) refused(xml, name);
});

test("[X17] adversarial inputs of about 1M characters are refused quickly", () => {
  const head = wrap("").split("<body>")[0] + "<body>";
  const inputs = [
    ["run of unclosed comment openers", "<!--".repeat(250_000)],
    ["one long unclosed comment", `${head}<!-- ${"a".repeat(1_000_000)}`],
    ["deeply nested tags", `${head}${"<a>".repeat(333_333)}`],
    ["huge attribute count", `${head}<trans-unit ${'x="1" '.repeat(160_000)}>`],
    ["run of processing instructions", `${head}${"<?".repeat(500_000)}`],
    ["run of bare ampersands", `${head}${"&".repeat(1_000_000)}`],
    ["one endless numeric reference", `${head}<trans-unit id="settings:a"><source>&#${"0".repeat(1_000_000)}</source>`],
    ["run of unterminated tags", `${head}${"</a".repeat(333_333)}`],
    ["run of open quotes", `${head}<trans-unit id="${'"'.repeat(1_000_000)}`],
    ["whitespace in a tag", wrap(`<trans-unit id="settings:a"${" ".repeat(1_000_000)}><source>x</source></trans-unit>`)],
  ];
  for (const [name, xml] of inputs) {
    const started = performance.now();
    refused(xml, name);
    const ms = performance.now() - started;
    assert.ok(ms < 2000, `${name} took ${ms} ms`);
  }
});

test("[X30] an accepted document of about 1M characters parses quickly", () => {
  const one = (i) => `<trans-unit id="settings:f${i}"><source>x &amp; y</source><target>y</target></trans-unit>`;
  const count = Math.floor(1_000_000 / one(100000).length);
  const started = performance.now();
  assert.equal(fromXliff(wrap(Array.from({ length: count }, (_, i) => one(i)).join(""))).units.length, count);
  const ms = performance.now() - started;
  assert.ok(ms < 3000, `took ${ms} ms`);
});

// ── the package: reading, chunking ──────────────────────────────────────────────────────────────────────────

test("[P1] readTranslationPackage completes a hand-built package and canonicalises ids", () => {
  const read = readTranslationPackage({
    format: "blocofy-translation/1",
    source_locale: "tr-TR",
    target_locale: "en-US",
    units: [{ id: "entry:haberler:9:@title", target: "News", source_hash: "h" }],
  });
  assert.ok(read.ok, read.message);
  assert.deepEqual(read.pkg, {
    format: "blocofy-translation/1",
    source_locale: "tr-TR",
    target_locale: "en-US",
    exported_at: "",
    by: "human",
    units: [{ id: "entry:haberler:9:@title", kind: "entry", group: "entry:haberler:9", context: "", type: "text", source: "", source_hash: "h", target: "News", target_hash: "", state: "translated" }],
    next_cursor: null,
  });
  for (const [raw, pattern] of [
    [null, /object/],
    [{ ...VECTOR, format: "x/1" }, /format/],
    [{ ...VECTOR, target_locale: " " }, /target_locale/],
    [{ ...VECTOR, units: [{ id: "entry:haberler:01:x", target: "", source_hash: "" }] }, /not recognised/],
    [{ ...VECTOR, units: [VECTOR.units[0], VECTOR.units[0]] }, /twice/],
    [{ ...VECTOR, units: [{ ...VECTOR.units[0], kind: "entry" }] }, /kind/],
    [{ ...VECTOR, units: [{ ...VECTOR.units[0], type: "markdown" }] }, /type/],
    [{ ...VECTOR, units: [{ ...VECTOR.units[0], target: 1 }] }, /target/],
  ]) {
    const result = readTranslationPackage(raw);
    assert.equal(result.ok, false);
    assert.match(result.message, pattern);
  }
});

test("[P2] readPackageFile reads JSON and XLIFF (by extension or a leading <) and refuses what is not a package", () => {
  assert.deepEqual(readPackageFile(JSON.stringify(VECTOR), "en.json"), VECTOR);
  assert.deepEqual(readPackageFile(VECTOR_XLF, "en.xlf"), VECTOR);
  assert.deepEqual(readPackageFile(VECTOR_XLF, "en.txt"), VECTOR);
  assert.throws(() => readPackageFile("{", "en.json"), /JSON/);
  assert.throws(() => readPackageFile(JSON.stringify({ hello: 1 }), "en.json"), /format/);
  assert.throws(() => readPackageFile("<xliff>", "en.xlf"), XliffError);
  // M7: a JSON package saved with a UTF-8 byte order mark (common on Windows) is read.
  assert.deepEqual(readPackageFile(`\uFEFF${JSON.stringify(VECTOR)}`, "en.json"), VECTOR);
});

const u = (id, target = "T") => ({ id, kind: "settings", group: "", context: "", type: "text", source: "s", source_hash: "h", target, target_hash: "", state: "missing" });

test("[T4] chunking drops empty targets and keeps groups (derived from the id) together", () => {
  const pkg = { ...VECTOR, units: [u("entry:a:1:x"), u("entry:a:1:y", " "), u("entry:a:2:x"), u("entry:a:2:y"), u("entry:a:3:x")] };
  const { chunks, skippedEmpty, splitGroups } = chunkPackage(pkg, 3);
  assert.equal(skippedEmpty, 1);
  assert.deepEqual(splitGroups, []);
  assert.deepEqual(chunks.map((c) => c.units.map((x) => x.id)), [["entry:a:1:x", "entry:a:2:x", "entry:a:2:y"], ["entry:a:3:x"]]);
  assert.ok(chunks.every((c) => c.next_cursor === null && c.target_locale === "en-US"));
});

test("[T4b] a group above the call size but within 5,000 is never split; only a larger one is sliced and named", () => {
  const page = (n, handle) => Array.from({ length: n }, (_, i) => u(`page:${handle}:n${i}.heading`));
  const whole = chunkPackage({ ...VECTOR, units: [u("settings:a"), ...page(7, "p1"), u("settings:b")] }, 3);
  assert.deepEqual(whole.chunks.map((c) => c.units.length), [1, 7, 1]);
  assert.deepEqual(whole.splitGroups, []);
  const big = chunkPackage({ ...VECTOR, units: page(5001, "p2") }, 500);
  assert.deepEqual(big.chunks.map((c) => c.units.length), [500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 1]);
  assert.deepEqual(big.splitGroups, ["page:p2"]);
  assert.throws(() => chunkPackage(VECTOR, 0), RangeError);
});

test("[T4c] chunks over the 8M-character body cap are re-split at group boundaries; a single group over it is refused", () => {
  const long = (id, n) => ({ ...u(id), target: "x".repeat(n) });
  const pkg = { ...VECTOR, units: [long("entry:a:1:x", 40), long("entry:a:2:x", 40), long("entry:a:3:x", 40)] };
  const { chunks } = chunkPackage(pkg);
  assert.equal(chunks.length, 1);
  const body = (chunk) => JSON.stringify({ package: chunk, dry_run: false, publish: false, on_source_change: "apply" }).length;
  const fitted = fitChunksToBodyCap(chunks, body(chunks[0]) - 1);
  assert.ok(fitted.length >= 2);
  assert.deepEqual(fitted.flatMap((c) => c.units.map((x) => x.id)), ["entry:a:1:x", "entry:a:2:x", "entry:a:3:x"]);
  assert.deepEqual(fitChunksToBodyCap(chunks, 8_000_000), chunks);
  const oneGroup = chunkPackage({ ...VECTOR, units: [long("entry:a:1:x", 40), long("entry:a:1:y", 40)] }).chunks;
  assert.throws(() => fitChunksToBodyCap(oneGroup, 100), /entry:a:1/);
});

// ── the commands, against a fake v1 ─────────────────────────────────────────────────────────────────────────

const BIN = join(root, "bin", "blocofy.mjs");
const KEY = "blcf_live_testkey0123456789abcdef";

/** Fake v1: `route(rec, n)` → `{ status, body }`; every request but the identity ping is recorded in `reqs`. */
async function fakeV1(route) {
  const reqs = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    if (req.url === "/api/v1/ping") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, site: { id: "s1", slug: "site", name: "Site" } }));
      return;
    }
    const rec = { method: req.method, url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null };
    reqs.push(rec);
    const out = route(rec, reqs.length);
    if (out.destroy) {
      req.socket.destroy();
      return;
    }
    res.writeHead(out.status, { "content-type": "application/json", ...(out.headers ?? {}) });
    res.end(JSON.stringify(out.body));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { apiUrl: `http://127.0.0.1:${server.address().port}`, reqs, close: () => new Promise((r) => server.close(r)) };
}

let home;
let project;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "blocofy-tr-"));
  project = join(home, "project");
  mkdirSync(join(project, ".blocofy"), { recursive: true });
  writeFileSync(join(project, ".blocofy", "project.json"), JSON.stringify({ schema_version: 1, site_id: "s1", site_slug: "site", platform_origin: null }));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function runCli(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { cwd: project, env: { PATH: process.env.PATH, HOME: home, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.stdin.end();
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
const envFor = (s) => ({ BLOCOFY_API_URL: s.apiUrl, BLOCOFY_API_KEY: KEY });
const NO_SKIPS = { groups: {}, texts: {}, kinds: {} };

const report = (results, extra = {}) => ({
  source_locale: "tr-TR",
  target_locale: "en-US",
  dry_run: true,
  units: results.map((result, i) => ({ id: `u${i}`, result })),
  groups: [{ group: "settings", kind: "settings", created: false, updated: true, published: false }],
  counts: {},
  ...extra,
});

test("[T5] export follows every cursor (an empty window included) into one file, as JSON and as XLIFF", async () => {
  const windows = [
    { units: VECTOR.units.slice(0, 2), next_cursor: "page:p1j4vv@t1@en-US", skipped: { groups: { source_not_published: [{ key: "page:p9" }] }, texts: {}, kinds: {} } },
    { units: [], next_cursor: "end:page@t1@en-US", skipped: NO_SKIPS },
    { units: VECTOR.units.slice(2), next_cursor: null, skipped: { groups: {}, texts: { unaddressable_name: [{ group: "page:p1j4vv", count: 2 }] }, kinds: {} } },
  ];
  const s = await fakeV1((rec, n) => ({ status: 200, body: { ...VECTOR, ...windows[(n - 1) % 3] } }));
  try {
    const out = join(home, "en.json");
    const res = await runCli(["translations", "export", "--locale", "en-US", "--only", "pending", "--out", out], envFor(s));
    assert.equal(res.code, 0, res.stderr);
    assert.deepEqual(JSON.parse(readFileSync(out, "utf8")), { ...VECTOR, next_cursor: null });
    assert.equal(s.reqs.length, 3);
    assert.equal(s.reqs[0].method, "GET");
    assert.equal(s.reqs[0].headers.authorization, `Bearer ${KEY}`);
    assert.equal(s.reqs[0].url, "/api/v1/translations/export?target_locale=en-US&format=json&only=pending&limit=5000");
    assert.equal(s.reqs[1].url, "/api/v1/translations/export?target_locale=en-US&format=json&only=pending&cursor=page%3Ap1j4vv%40t1%40en-US&limit=5000");
    assert.match(s.reqs[2].url, /cursor=end%3Apage%40t1%40en-US/);
    assert.match(res.stdout, /Exported 3 unit\(s\) for en-US to /);
    assert.match(res.stdout, /1 page\(s\) or record\(s\) left out: not published in the source language\./);
    assert.match(res.stdout, /2 text\(s\) left out: their field name contains ":" or "\."\./);

    const xlf = join(home, "en.xlf");
    const again = await runCli(["translations", "export", "--locale", "en-US", "--format", "xliff", "--out", xlf, "--json"], envFor(s));
    assert.equal(again.code, 0, again.stderr);
    assert.equal(readFileSync(xlf, "utf8"), toXliff({ ...VECTOR, next_cursor: null }));
    assert.equal(s.reqs[3].url, "/api/v1/translations/export?target_locale=en-US&format=json&limit=5000");
    const summary = JSON.parse(again.stdout.trim().split("\n").pop());
    assert.equal(summary.units, 3);
    assert.equal(summary.format, "xliff");
    assert.deepEqual(summary.skipped.groups.source_not_published, [{ key: "page:p9" }]);
  } finally {
    await s.close();
  }
});

test("[T5b] export usage errors and an XLIFF-unsafe text exit 1 and write no file", async () => {
  const s = await fakeV1(() => ({ status: 200, body: { ...VECTOR, units: [{ ...VECTOR.units[2], target: "a\u0001b" }], next_cursor: null, skipped: NO_SKIPS } }));
  try {
    const out = join(home, "x.xlf");
    for (const args of [["--out", out], ["--locale", "en-US"], ["--locale", "en-US", "--out", out, "--format", "csv"], ["--locale", "en-US", "--out", out, "--only", "new"], ["--locale", "en-US", "--out", out, "extra"]]) {
      const res = await runCli(["translations", "export", ...args], envFor(s));
      assert.equal(res.code, 1, args.join(" "));
      assert.match(res.stderr, /Usage: blocofy translations export/);
    }
    assert.equal(s.reqs.length, 0);
    const res = await runCli(["translations", "export", "--locale", "en-US", "--out", out, "--format", "xliff"], envFor(s));
    assert.equal(res.code, 1);
    assert.match(res.stderr, /as JSON/);
    assert.equal(existsSync(out), false);
  } finally {
    await s.close();
  }
});

test("[T6] import: JSON chunks, dry run and publish flags, on-source-change, per-state counts", async () => {
  const s = await fakeV1(() => ({ status: 200, body: report(["applied", "unchanged"]) }));
  try {
    const file = join(home, "en.xlf");
    writeFileSync(file, VECTOR_XLF);
    const dry = await runCli(["translations", "import", file, "--dry-run"], envFor(s));
    assert.equal(dry.code, 0, dry.stderr);
    assert.equal(s.reqs.length, 1);
    assert.equal(s.reqs[0].method, "POST");
    assert.equal(s.reqs[0].url, "/api/v1/translations/import");
    assert.equal(s.reqs[0].headers["content-type"], "application/json");
    assert.deepEqual(Object.keys(s.reqs[0].body).sort(), ["dry_run", "on_source_change", "package", "publish"]);
    assert.deepEqual(s.reqs[0].body.package.units.map((u) => u.id), [VECTOR.units[1].id, VECTOR.units[2].id]);
    assert.equal(s.reqs[0].body.package.next_cursor, null);
    assert.equal(s.reqs[0].body.dry_run, true);
    assert.equal(s.reqs[0].body.publish, false);
    assert.equal(s.reqs[0].body.on_source_change, "skip");
    assert.match(dry.stdout, /Dry run en-US: 1 applied, 1 unchanged, 1 skipped_empty\n/);

    const real = await runCli(["translations", "import", file, "--publish", "--on-source-change", "apply"], envFor(s));
    assert.equal(real.code, 0, real.stderr);
    assert.equal(s.reqs[1].body.dry_run, false);
    assert.equal(s.reqs[1].body.publish, true);
    assert.equal(s.reqs[1].body.on_source_change, "apply");
    assert.match(real.stdout, /Imported en-US: 1 applied, 1 unchanged, 1 skipped_empty\n/);

    const bad = await runCli(["translations", "import", file, "--on-source-change", "force"], envFor(s));
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /Usage: blocofy translations import/);
    const unknown = await runCli(["translations", "import", file, "--dryrun"], envFor(s));
    assert.equal(unknown.code, 1);
    assert.equal(s.reqs.length, 2);
  } finally {
    await s.close();
  }
});

test("[T6b] import prints publication, publish_reason, created and stamped groups, notes and a failed cache flush; --json carries them", async () => {
  const body = {
    ...report(["applied", "applied", "blocked"]),
    dry_run: false,
    units: [
      { id: "u0", result: "applied" },
      { id: "u1", result: "applied" },
      { id: "u2", result: "blocked", reason: "url_live", message: "A live page's URL changes only with publish." },
    ],
    groups: [
      { group: "page:p1j4vv", kind: "page", created: true, updated: true, published: false, blockers: [{ path: "a", locale: "en-US", reason: "x" }], message: "The page waits for a media decision and was not published." },
      { group: "entry:haberler:9", kind: "entry", created: false, updated: true, published: false, publish_reason: "target_archived" },
      { group: "page:p2", kind: "page", created: false, updated: false, published: false, stamped: true },
    ],
    publication: { published: 2, blocked: 1 },
    cache: { ok: false, code: "accelerator_degraded", reason: "flush_failed" },
  };
  const s = await fakeV1(() => ({ status: 200, body }));
  try {
    const file = join(home, "en.json");
    writeFileSync(file, JSON.stringify(VECTOR));
    const res = await runCli(["translations", "import", file, "--publish"], envFor(s));
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /Imported en-US: 2 applied, 1 skipped_empty, 1 blocked\n/);
    assert.match(res.stdout, /Created 1 new page\(s\), record\(s\) or menu\(s\) in en-US\./);
    assert.match(res.stdout, /Marked 1 page\(s\) as translated\./);
    assert.match(res.stdout, /Published 2 page\(s\) and record\(s\)\. 1 could not be published and stay drafts\./);
    assert.match(res.stdout, /1 record\(s\) not published: archived \(the translation was saved\)\./);
    assert.match(res.stdout, /site cache could not be refreshed/);
    assert.match(res.stdout, /accelerator_degraded: flush_failed/);
    assert.match(res.stdout, /- A live page's URL changes only with publish\./);
    assert.match(res.stdout, /- The page waits for a media decision and was not published\./);

    const json = await runCli(["translations", "import", file, "--publish", "--json"], envFor(s));
    assert.equal(json.code, 0, json.stderr);
    const out = JSON.parse(json.stdout.trim().split("\n").pop());
    assert.equal(out.dry_run, false);
    assert.equal(out.target_locale, "en-US");
    assert.deepEqual(out.counts, { applied: 2, unchanged: 0, skipped_empty: 1, source_changed: 0, target_changed: 0, invalid: 0, blocked: 1 });
    assert.deepEqual(out.publication, { published: 2, blocked: 1 });
    assert.deepEqual(out.publish_skipped, { target_archived: 1 });
    assert.equal(out.created, 1);
    assert.equal(out.stamped, 1);
    assert.deepEqual(out.cache, [{ ok: false, code: "accelerator_degraded", reason: "flush_failed" }]);
    assert.equal(out.chunks, 1);
  } finally {
    await s.close();
  }
});

test("[T7] a 422 refusal exits 2 with the server envelope last; an unreadable file exits 1 without a request", async () => {
  const s = await fakeV1(() => ({ status: 422, body: { error: { code: "validation_failed", message: "1 unit is invalid", details: { units: [{ id: "page:p1j4vv:hero1.body", result: "invalid", reason: "html_refused", message: "The HTML holds elements that are not allowed." }] } } } }));
  try {
    const file = join(home, "en.json");
    writeFileSync(file, JSON.stringify(VECTOR));
    const res = await runCli(["translations", "import", file], envFor(s));
    assert.equal(res.code, 2);
    assert.match(res.stderr, /page:p1j4vv:hero1\.body: The HTML holds elements that are not allowed\./);
    assert.equal(JSON.parse(res.stderr.trim().split("\n").pop()).error.code, "validation_failed");
    for (const [name, text] of [["bad.xlf", "<xliff>"], ["bad.json", "{"], ["other.json", JSON.stringify({ hello: 1 })]]) {
      const bad = join(home, name);
      writeFileSync(bad, text);
      const unreadable = await runCli(["translations", "import", bad], envFor(s));
      assert.equal(unreadable.code, 1, name);
      assert.match(unreadable.stderr, /Nothing was sent/);
    }
    const missing = await runCli(["translations", "import", join(home, "nope.json")], envFor(s));
    assert.equal(missing.code, 1);
    assert.equal(s.reqs.length, 1);
  } finally {
    await s.close();
  }
});

test("[T8] a package over 500 units is sent in chunks; a failure part-way says what was already written", async () => {
  const units = Array.from({ length: 600 }, (_, i) => ({ id: `entry:haberler:${i + 1}:baslik`, target: `T${i}`, source_hash: "h" }));
  const pkg = { format: "blocofy-translation/1", source_locale: "tr-TR", target_locale: "en-US", units };
  const s = await fakeV1((rec, n) => (n === 2 ? { status: 500, body: { error: { code: "internal", message: "boom" } } } : { status: 200, body: report(rec.body.package.units.map(() => "applied")) }));
  try {
    const file = join(home, "big.json");
    writeFileSync(file, JSON.stringify(pkg));
    const res = await runCli(["translations", "import", file], envFor(s));
    assert.equal(res.code, 1);
    assert.deepEqual(s.reqs.map((r) => r.body.package.units.length), [500, 100]);
    assert.match(res.stderr, /Import stopped after 1 of 2 chunks/);
  } finally {
    await s.close();
  }
});

test("[T9] a file whose every target is empty sends nothing", async () => {
  const s = await fakeV1(() => ({ status: 200, body: report([]) }));
  try {
    const file = join(home, "empty.json");
    writeFileSync(file, JSON.stringify({ ...VECTOR, units: VECTOR.units.map((x) => ({ ...x, target: "" })) }));
    const res = await runCli(["translations", "import", file], envFor(s));
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /nothing to import/);
    assert.equal(s.reqs.length, 0);
  } finally {
    await s.close();
  }
});

test("[T10] a wet --publish import is never resent after a retryable failure; other imports still are", async () => {
  const unavailable = { status: 503, headers: { "retry-after": "0" }, body: { error: { code: "unavailable", message: "try later" } } };
  const s = await fakeV1(() => unavailable);
  try {
    const file = join(home, "en.json");
    writeFileSync(file, JSON.stringify(VECTOR));
    const publishing = await runCli(["translations", "import", file, "--publish"], envFor(s));
    assert.equal(s.reqs.length, 1, "a publishing import is sent once");
    assert.equal(publishing.code, 1);
    assert.match(publishing.stderr, /chunk 1 of 1/);
    assert.match(publishing.stderr, /may or may not have been applied and published/);
    assert.match(publishing.stderr, /running the same command again is safe/i);
    assert.match(publishing.stderr, /unchanged/);
    assert.doesNotMatch(publishing.stderr, /retrying/);

    const wet = await runCli(["translations", "import", file], envFor(s));
    assert.equal(s.reqs.length, 1 + 4, "a non-publishing import is retried (1 + 3 retries)");
    assert.equal(wet.code, 1);
    assert.match(wet.stderr, /retrying/);
    const dry = await runCli(["translations", "import", file, "--dry-run", "--publish"], envFor(s));
    assert.equal(s.reqs.length, 5 + 4, "a dry run is retried even with --publish");
    assert.equal(dry.code, 1);
  } finally {
    await s.close();
  }
  const dropped = await fakeV1(() => ({ destroy: true }));
  try {
    const file = join(home, "en.json");
    const res = await runCli(["translations", "import", file, "--publish", "--json"], envFor(dropped));
    assert.equal(dropped.reqs.length, 1, "a lost connection is not resent either");
    assert.equal(res.code, 1);
    const envelope = JSON.parse(res.stderr.trim().split("\n").pop());
    assert.equal(envelope.error.code, "TRANSLATIONS_IMPORT_OUTCOME_UNKNOWN");
    assert.equal(envelope.error.details.chunk, 1);
    assert.equal(envelope.error.details.chunks, 1);
  } finally {
    await dropped.close();
  }
});

// ── fix round 2 ─────────────────────────────────────────────────────────────────────────────────────────────

const entryUnits = (n, text = (i) => `T${i}`) => Array.from({ length: n }, (_, i) => ({ id: `entry:haberler:${i + 1}:baslik`, target: text(i), source_hash: "h" }));
const pkgOf = (units) => ({ format: "blocofy-translation/1", source_locale: "tr-TR", target_locale: "en-US", units });

test("[R1] a run that stops part-way still reports what the earlier chunks did (publication, cache), human and --json", async () => {
  const first = {
    ...report(Array(500).fill("applied")),
    dry_run: false,
    groups: [{ group: "entry:haberler:1", kind: "entry", created: true, updated: true, published: true }],
    publication: { published: 40, blocked: 3 },
    cache: { ok: false, code: "accelerator_degraded", reason: "flush_failed" },
  };
  const refusal = { status: 422, body: { error: { code: "validation_failed", message: "1 unit is invalid", details: { units: [{ id: "entry:haberler:501:baslik", result: "invalid", message: "bad" }] } } } };
  const s = await fakeV1((rec, n) => (n % 2 === 1 ? { status: 200, body: first } : refusal));
  try {
    const file = join(home, "big.json");
    writeFileSync(file, JSON.stringify(pkgOf(entryUnits(600))));
    const res = await runCli(["translations", "import", file, "--publish"], envFor(s));
    assert.equal(res.code, 2);
    assert.match(res.stdout, /Imported en-US: 500 applied/);
    assert.match(res.stdout, /Published 40 page\(s\) and record\(s\)\. 3 could not be published and stay drafts\./);
    assert.match(res.stdout, /site cache could not be refreshed/);
    assert.match(res.stdout, /accelerator_degraded: flush_failed/);
    assert.match(res.stderr, /Import stopped after 1 of 2 chunks/);

    const json = await runCli(["translations", "import", file, "--publish", "--json"], envFor(s));
    assert.equal(json.code, 2);
    const partial = JSON.parse(json.stdout.trim().split("\n").pop());
    assert.equal(partial.stopped, true);
    assert.equal(partial.chunks_done, 1);
    assert.equal(partial.chunks, 2);
    assert.equal(partial.counts.applied, 500);
    assert.deepEqual(partial.publication, { published: 40, blocked: 3 });
    assert.deepEqual(partial.cache, [{ ok: false, code: "accelerator_degraded", reason: "flush_failed" }]);
    assert.equal(JSON.parse(json.stderr.trim().split("\n").pop()).error.code, "validation_failed");
  } finally {
    await s.close();
  }
});

test("[R2] export never overwrites an existing --out file unless --force; the write goes through a temp file", async () => {
  const s = await fakeV1(() => ({ status: 200, body: { ...VECTOR, next_cursor: null, skipped: NO_SKIPS } }));
  try {
    const out = join(home, "en.json");
    writeFileSync(out, "translated by hand");
    const refused = await runCli(["translations", "export", "--locale", "en-US", "--out", out], envFor(s));
    assert.notEqual(refused.code, 0);
    assert.match(refused.stderr, /already exists/);
    assert.match(refused.stderr, /--force/);
    assert.equal(readFileSync(out, "utf8"), "translated by hand");
    assert.equal(s.reqs.length, 0, "refused before any request");
    const forced = await runCli(["translations", "export", "--locale", "en-US", "--out", out, "--force"], envFor(s));
    assert.equal(forced.code, 0, forced.stderr);
    assert.deepEqual(JSON.parse(readFileSync(out, "utf8")), { ...VECTOR, next_cursor: null });
    const { readdirSync } = await import("node:fs");
    assert.deepEqual(readdirSync(home).filter((f) => f.includes("blocofy-tmp")), []);
  } finally {
    await s.close();
  }
});

test("[R3a] import re-splits a chunk over the 8M-character body cap before sending", async () => {
  const s = await fakeV1((rec) => ({ status: 200, body: report(rec.body.package.units.map(() => "applied")) }));
  try {
    const file = join(home, "large.json");
    writeFileSync(file, JSON.stringify(pkgOf(entryUnits(3, () => "x".repeat(3_000_000)))));
    const res = await runCli(["translations", "import", file, "--dry-run"], envFor(s));
    assert.equal(res.code, 0, res.stderr);
    assert.deepEqual(s.reqs.map((r) => r.body.package.units.length), [2, 1]);
    for (const r of s.reqs) assert.ok(JSON.stringify(r.body).length <= 8_000_000);
  } finally {
    await s.close();
  }
});

test("[R3b] export stops when the server repeats a cursor (twice in a row, or in a cycle), and after 1,000 windows at most", async () => {
  const window = (next_cursor) => ({ status: 200, body: { ...VECTOR, units: [], next_cursor, skipped: NO_SKIPS } });
  const same = await fakeV1(() => window("A"));
  try {
    const res = await runCli(["translations", "export", "--locale", "en-US", "--out", join(home, "a.json")], envFor(same));
    assert.equal(res.code, 1);
    assert.match(res.stderr, /returned a cursor it had already returned/);
    assert.equal(same.reqs.length, 2);
  } finally {
    await same.close();
  }
  const cycle = await fakeV1((rec, n) => window(["A", "B"][(n - 1) % 2]));
  try {
    const res = await runCli(["translations", "export", "--locale", "en-US", "--out", join(home, "b.json")], envFor(cycle));
    assert.equal(res.code, 1);
    assert.match(res.stderr, /returned a cursor it had already returned/);
    assert.equal(cycle.reqs.length, 3);
    assert.equal(existsSync(join(home, "b.json")), false);
  } finally {
    await cycle.close();
  }
  const endless = await fakeV1((rec, n) => window(`C${n}`));
  try {
    await assert.rejects(exportAllTranslations({ apiUrl: endless.apiUrl, apiKey: KEY, locale: "en-US", maxWindows: 5 }), /more than 5 windows/);
    assert.equal(endless.reqs.length, 5);
  } finally {
    await endless.close();
  }
});

test("[R3c] an exported XLIFF file over 8M characters is written with a warning that it cannot be imported back", async () => {
  const huge = { ...VECTOR.units[2], source: "s".repeat(XLIFF_MAX_CHARS) };
  const s = await fakeV1(() => ({ status: 200, body: { ...VECTOR, units: [huge], next_cursor: null, skipped: NO_SKIPS } }));
  try {
    const out = join(home, "huge.xlf");
    const res = await runCli(["translations", "export", "--locale", "en-US", "--out", out, "--format", "xliff"], envFor(s));
    assert.equal(res.code, 0, res.stderr);
    assert.ok(readFileSync(out, "utf8").length > XLIFF_MAX_CHARS);
    assert.match(res.stderr, /cannot be imported back/);
  } finally {
    await s.close();
  }
});

test("[R3d] a group over 5,000 units is sliced and the summary says it is not marked translated", async () => {
  const units = Array.from({ length: 5001 }, (_, i) => ({ id: `page:p1j4vv:n${i}.heading`, target: "T", source_hash: "h" }));
  const s = await fakeV1((rec) => ({ status: 200, body: report(rec.body.package.units.map(() => "applied")) }));
  try {
    const file = join(home, "page.json");
    writeFileSync(file, JSON.stringify(pkgOf(units)));
    const res = await runCli(["translations", "import", file, "--dry-run"], envFor(s));
    assert.equal(res.code, 0, res.stderr);
    assert.equal(s.reqs.length, 11);
    assert.match(res.stdout, /1 page\(s\) or record\(s\) hold more than 5,000 texts and would be sent in several calls, so they are not marked translated\./);
  } finally {
    await s.close();
  }
});

test("[R4] a publishing chunk answered 429 was not applied and says so; a 500 has an unknown outcome; neither is resent", async () => {
  const s = await fakeV1((rec, n) => (n === 1 ? { status: 429, headers: { "retry-after": "0" }, body: { error: { code: "rate_limited", message: "slow down" } } } : { status: 500, body: { error: { code: "internal", message: "boom" } } }));
  try {
    const file = join(home, "en.json");
    writeFileSync(file, JSON.stringify(VECTOR));
    const limited = await runCli(["translations", "import", file, "--publish"], envFor(s));
    assert.equal(s.reqs.length, 1);
    assert.notEqual(limited.code, 0);
    assert.match(limited.stderr, /chunk 1 of 1/);
    assert.match(limited.stderr, /was not applied/);
    assert.doesNotMatch(limited.stderr, /may or may not/);
    const failed = await runCli(["translations", "import", file, "--publish"], envFor(s));
    assert.equal(s.reqs.length, 2);
    assert.equal(failed.code, 1);
    assert.match(failed.stderr, /\(HTTP 500\).*may or may not have been applied and published/);
  } finally {
    await s.close();
  }
});

test("[R5] --json has one shape: an all-empty file reports the same keys as a normal run", async () => {
  const s = await fakeV1(() => ({ status: 200, body: report(["applied", "applied"]) }));
  try {
    const empty = join(home, "empty.json");
    writeFileSync(empty, JSON.stringify({ ...VECTOR, units: VECTOR.units.map((x) => ({ ...x, target: "" })) }));
    const full = join(home, "full.json");
    writeFileSync(full, JSON.stringify(VECTOR));
    const a = JSON.parse((await runCli(["translations", "import", empty, "--dry-run", "--json"], envFor(s))).stdout.trim().split("\n").pop());
    const b = JSON.parse((await runCli(["translations", "import", full, "--dry-run", "--json"], envFor(s))).stdout.trim().split("\n").pop());
    assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort());
    assert.equal(a.chunks, 0);
    assert.equal(a.counts.skipped_empty, 3);
    assert.deepEqual([a.created, a.stamped, a.notes, a.cache, a.split_groups], [0, 0, [], [], []]);
  } finally {
    await s.close();
  }
});
