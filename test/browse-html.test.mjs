import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyNavigationUrl, decodeAttr, parseRefresh, rewriteNavigation, startTags } from "../lib/browse-html.mjs";

const LOCAL = "http://127.0.0.1:3030";
const ORIGINS = ["https://www.acme.com", "https://acme.myblocofy.com"];
const rw = (html, pagePath = "/blog/x?y=1") =>
  rewriteNavigation(html, { pageUrl: `${LOCAL}${pagePath}`, internalOrigins: ORIGINS, localOrigin: LOCAL }).html;

test("link mapping table: a[href]", () => {
  const cases = [
    // [input href, expected output tag]
    ["/about", '<a href="/about">'], // relative: untouched
    ["about?x=1#h", '<a href="about?x=1#h">'],
    ["#top", '<a href="#top">'],
    ["https://www.acme.com/en/blog?page=2#c", `<a href="${LOCAL}/en/blog?page=2#c">`], // internal → local, query+hash kept
    ["https://acme.myblocofy.com/", `<a href="${LOCAL}/">`], // second internal origin
    ["HTTPS://WWW.ACME.COM/Up", `<a href="${LOCAL}/Up">`], // scheme/host case-insensitive, path case kept
    ["https://www.acme.com:443/p", `<a href="${LOCAL}/p">`], // default port is the same origin
    ["//www.acme.com/p?q#h", `<a href="${LOCAL}/p?q#h">`], // protocol-relative internal → local
    ["https://www.acme.com:8443/p", '<a href="https://www.acme.com:8443/p">'], // other port: not the origin
    ["http://www.acme.com/p", '<a href="http://www.acme.com/p">'], // http is not the https origin (exact match)
    ["https://example.org/x", '<a href="https://example.org/x">'], // external: untouched
    ["//example.org/x", '<a href="//example.org/x">'], // protocol-relative external: untouched
    ["https://other.myblocofy.com/x", '<a href="https://other.myblocofy.com/x">'], // foreign tenant: untouched
    ["https://www.acme.com.evil.com/x", '<a href="https://www.acme.com.evil.com/x">'], // suffix trick: untouched
    ["mailto:a@acme.com", '<a href="mailto:a@acme.com">'],
    ["tel:+90", '<a href="tel:+90">'],
    ["javascript:alert(1)", '<a data-blocofy-blocked="href">'],
    ["JaVaScRiPt:alert(1)", '<a data-blocofy-blocked="href">'],
    [" \tjava\nscript:alert(1)", '<a data-blocofy-blocked="href">'],
    ["javascript&colon;alert(1)", '<a data-blocofy-blocked="href">'], // named reference decoded first
    ["&#106;avascript:alert(1)", '<a data-blocofy-blocked="href">'], // numeric reference decoded first
    ["data:text/html,<b>x</b>", '<a data-blocofy-blocked="href">'],
    ["vbscript:x", '<a data-blocofy-blocked="href">'],
    ["https://user:pw@www.acme.com/x", '<a data-blocofy-blocked="href">'], // userinfo
    ["https://user@example.org/x", '<a data-blocofy-blocked="href">'],
    ["http://[::1", '<a data-blocofy-blocked="href">'], // malformed
    ["https://exa mple.com/", '<a data-blocofy-blocked="href">'], // malformed host
    ["/x&notin;", '<a data-blocofy-blocked="href">'], // a reference this tokenizer cannot decode: fail-closed
    ["https&#58;//www.acme.com/q?a=1&amp;b=2", `<a href="${LOCAL}/q?a=1&amp;b=2">`], // decoded, re-escaped on output
    ["/q?a=1&b=2&copy=3", '<a href="/q?a=1&b=2&copy=3">'], // not references
  ];
  for (const [href, expected] of cases) {
    const html = `<a href="${href}">x</a>`;
    assert.equal(rw(html), `${expected}x</a>`, href);
  }
});

test("quotes, case and unquoted values are tokenised like a browser", () => {
  assert.equal(rw("<A HREF='https://www.acme.com/a'>x</A>"), `<A href="${LOCAL}/a">x</A>`);
  assert.equal(rw("<a href=https://www.acme.com/a class=c>x</a>"), `<a href="${LOCAL}/a" class=c>x</a>`);
  assert.equal(rw('<a class="x>y" href = "https://www.acme.com/b">'), `<a class="x>y" href="${LOCAL}/b">`);
  assert.equal(rw('<a/href="https://www.acme.com/c">'), `<a/href="${LOCAL}/c">`);
  // The FIRST duplicate wins in a browser; editing it removes the inert later one (never promoted).
  assert.equal(rw('<a href="javascript:x" href="https://evil.example">'), '<a data-blocofy-blocked="href" >');
  assert.equal(rw('<a href="/ok" href="javascript:x">'), '<a href="/ok" href="javascript:x">');
  // A `"` inside a rewritten value is escaped.
  assert.equal(rw(`<a href='https://www.acme.com/a"b'>`), `<a href="${LOCAL}/a%22b">`);
});

test("comments, raw-text elements and end tags are not rewritten; template content is markup", () => {
  const untouched = [
    '<!-- <a href="https://www.acme.com/x"> -->',
    '<script>var s = \'<a href="https://www.acme.com/x">\';</script>',
    '<SCRIPT type="module">document.write("<a href=\\"https://www.acme.com/x\\">")</SCRIPT >',
    '<style>/* <a href="https://www.acme.com/x"> */</style>',
    '<textarea><a href="https://www.acme.com/x"></textarea>',
    '<title><a href="https://www.acme.com/x"></title>',
    '<noscript><a href="https://www.acme.com/x"></noscript>',
    '<!doctype html><a href="https://www.acme.com/x"', // unfinished tag: a browser does not emit it either
    '</a href="https://www.acme.com/x">',
    '<!-- unterminated <a href="https://www.acme.com/x">',
  ];
  for (const html of untouched) assert.equal(rw(html), html, html);
  // `<!-->` closes the comment at once (abrupt closing), so the next tag is live markup.
  assert.equal(rw('<!--><a href="javascript:x">'), '<!--><a data-blocofy-blocked="href">');
  // After a raw-text element ends, scanning resumes.
  assert.equal(
    rw('<script>"</scripty>"</script><a href="https://www.acme.com/z">'),
    `<script>"</scripty>"</script><a href="${LOCAL}/z">`,
  );
  // Comment ending variants.
  assert.equal(rw('<!-- x --!><a href="https://www.acme.com/k">'), `<!-- x --!><a href="${LOCAL}/k">`);
  assert.equal(rw('<template><a href="https://www.acme.com/t">t</a></template>'), `<template><a href="${LOCAL}/t">t</a></template>`);
});

test("navigation surfaces: area, form action, formaction, meta refresh, link alternate; canonical + assets untouched", () => {
  const I = "https://www.acme.com";
  assert.equal(rw(`<area href="${I}/m">`), `<area href="${LOCAL}/m">`);
  assert.equal(rw(`<form action="${I}/search" method="get">`), `<form action="${LOCAL}/search" method="get">`);
  assert.equal(rw(`<form method="post" action="${I}/api/forms/x/submit">`), `<form method="post" action="${LOCAL}/api/forms/x/submit">`);
  assert.equal(rw('<form action="javascript:void 0">'), '<form data-blocofy-blocked="action">');
  assert.equal(rw('<form action="https://hooks.example/x">'), '<form action="https://hooks.example/x">'); // CSP blocks submit
  assert.equal(rw(`<button formaction="${I}/b" formtarget="_blank">`), `<button formaction="${LOCAL}/b" formtarget="_blank">`);
  assert.equal(rw(`<input type=submit formaction=${I}/i>`), `<input type=submit formaction="${LOCAL}/i">`);
  assert.equal(rw('<input formaction="data:x">'), '<input data-blocofy-blocked="formaction">');
  assert.equal(rw(`<meta http-equiv="Refresh" content="0; URL='${I}/r?a=1#h'">`), `<meta http-equiv="Refresh" content="0;url=${LOCAL}/r?a=1#h">`);
  assert.equal(rw(`<meta content="5;url=${I}/r" http-equiv=refresh>`), `<meta content="5;url=${LOCAL}/r" http-equiv=refresh>`);
  assert.equal(rw('<meta http-equiv="refresh" content="0;url=javascript:x">'), '<meta http-equiv="refresh" data-blocofy-blocked="content">');
  assert.equal(rw('<meta http-equiv="refresh" content="30">'), '<meta http-equiv="refresh" content="30">');
  assert.equal(rw('<meta http-equiv="refresh" content="0;url=/local">'), '<meta http-equiv="refresh" content="0;url=/local">');
  assert.equal(rw(`<meta name="x" content="0;url=${I}/r">`), `<meta name="x" content="0;url=${I}/r">`);
  assert.equal(rw(`<link rel="alternate" hreflang="en" href="${I}/en">`), `<link rel="alternate" hreflang="en" href="${LOCAL}/en">`);
  assert.equal(rw(`<link rel="Alternate" type="application/rss+xml" href="${I}/feed">`), `<link rel="Alternate" type="application/rss+xml" href="${LOCAL}/feed">`);
  // Untouched: canonical (public identity, PM decision 5), alternate stylesheet and every asset surface.
  const kept = [
    `<link rel="canonical" href="${I}/x">`,
    `<link rel="alternate stylesheet" href="${I}/a.css">`,
    `<link rel="stylesheet" href="${I}/s.css">`,
    `<link rel="icon" href="${I}/f.ico">`,
    `<img src="${I}/cdn/a.jpg" srcset="${I}/cdn/a.jpg 1x, ${I}/cdn/b.jpg 2x">`,
    `<script src="${I}/app.js"></script>`,
    `<iframe src="${I}/embed"></iframe>`,
    `<video poster="${I}/p.jpg"></video>`,
    `<meta property="og:url" content="${I}/x">`,
    `<div data-href="${I}/x">`,
  ];
  for (const html of kept) assert.equal(rw(html), html, html);
});

test("svg a[xlink:href] is a navigation surface", () => {
  assert.equal(rw('<svg><a xlink:href="https://www.acme.com/s">s</a></svg>'), `<svg><a xlink:href="${LOCAL}/s">s</a></svg>`);
});

test("counts and no-op identity", () => {
  const html = '<p>hi</p><a href="/x">x</a>';
  const r = rewriteNavigation(html, { pageUrl: `${LOCAL}/`, internalOrigins: ORIGINS, localOrigin: LOCAL });
  assert.equal(r.html, html);
  assert.equal(r.rewritten, 0);
  const r2 = rewriteNavigation('<a href="https://www.acme.com/">a</a><a href="javascript:x">b</a>', {
    pageUrl: `${LOCAL}/`,
    internalOrigins: ORIGINS,
    localOrigin: LOCAL,
  });
  assert.equal(r2.rewritten, 1);
  assert.equal(r2.blocked, 1);
});

test("helpers: startTags, decodeAttr, parseRefresh, classifyNavigationUrl", () => {
  assert.deepEqual(
    startTags('<a b="1" c=2 d>x<!-- <e> --><script><f></script><g>').map((t) => t.name),
    ["a", "script", "g"],
  );
  assert.deepEqual(decodeAttr("a&amp;b&lt;&#x3a;&#58;&colon;"), { text: "a&b<:::", unknown: false });
  assert.equal(decodeAttr("x&bogus;").unknown, true);
  assert.deepEqual(parseRefresh("3"), { delay: "3", url: null });
  assert.deepEqual(parseRefresh(" 0 , url = '/a b' "), { delay: "0", url: "/a b" });
  assert.equal(parseRefresh("soon"), null);
  const ctx = { pageUrl: `${LOCAL}/`, internal: new Set(ORIGINS), localOrigin: LOCAL };
  assert.deepEqual(classifyNavigationUrl("/x", ctx), { action: "keep" });
  assert.deepEqual(classifyNavigationUrl("https://www.acme.com/x", ctx), { action: "rewrite", value: `${LOCAL}/x` });
  assert.equal(classifyNavigationUrl("javascript:x", ctx).reason, "javascript");
});
