import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkPages, pullContent, pushContent, readContentFiles } from "../lib/content-sync.mjs";
import { PagesCliError } from "../lib/page-files.mjs";

function tmp() {
  return mkdtempSync(join(tmpdir(), "bcli-content-"));
}

/** Every file under a directory with its bytes — the "nothing changed" oracle. */
function snapshot(dir) {
  const out = {};
  const walk = (abs, rel) => {
    for (const name of readdirSync(abs).sort()) {
      const p = join(abs, name);
      const r = rel ? `${rel}/${name}` : name;
      try {
        if (readdirSync(p)) walk(p, r);
      } catch {
        out[r] = readFileSync(p, "utf8");
      }
    }
  };
  if (existsSync(dir)) walk(dir, "");
  return out;
}

const v2 = (locale, slug, extra = {}) => JSON.stringify({ format_version: 2, slug, title: slug, locale, data: { version: 2, sections: [] }, ...extra }, null, 2) + "\n";
const legacy = (slug, extra = {}) => JSON.stringify({ slug, title: slug, data: { version: 2, sections: [] }, ...extra }, null, 2) + "\n";

function put(dir, rel, content) {
  const p = join(dir, ...rel.split("/"));
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, content);
}

/** A fake `/api/dev/content`; records calls. */
function fakeServer({ protocol = 2, files = {}, diagnostics = [], post = null } = {}) {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : null });
    if ((init.method ?? "GET") === "GET") {
      const scope = new URL(String(url)).searchParams.get("scope");
      const envelope = protocol === 2
        ? { protocol_version: 2, page_layout_version: 2, default_locale: "tr-TR", supported_locales: ["tr-TR", "en-US"], files: scope === "capabilities" ? {} : files, diagnostics }
        : { files };
      return new Response(JSON.stringify(envelope), { status: 200 });
    }
    const [status, body] = post ?? [200, { ok: true, protocol_version: 2, dry_run: false, pagesUpdated: 0, pagesSkipped: 0, pages: [], diagnostics: [] }];
    return new Response(JSON.stringify(body), { status });
  };
  return { calls, restore: () => (globalThis.fetch = orig) };
}

const creds = { url: "https://x.test", token: "bcf_t" };

test("settings scope: config/settings.json döner", () => {
  const dir = tmp();
  mkdirSync(join(dir, "config"));
  writeFileSync(join(dir, "config", "settings.json"), '{"theme":{}}');
  assert.deepEqual(Object.keys(readContentFiles(dir, "settings")), ["config/settings.json"]);
  rmSync(dir, { recursive: true, force: true });
});

test("pages scope: pages/**/*.json recursive in lexical order, non-json ignored", () => {
  const dir = tmp();
  put(dir, "pages/tr-TR/routes/b/index.json", "{}");
  put(dir, "pages/en-US/index.json", "{}");
  put(dir, "pages/README.md", "x");
  assert.deepEqual(Object.keys(readContentFiles(dir, "pages")), ["pages/en-US/index.json", "pages/tr-TR/routes/b/index.json"]);
  rmSync(dir, { recursive: true, force: true });
});

test("dizin yoksa boş harita", () => {
  const dir = tmp();
  assert.deepEqual(readContentFiles(dir, "pages"), {});
  assert.deepEqual(readContentFiles(dir, "settings"), {});
  rmSync(dir, { recursive: true, force: true });
});

test("reading pages never follows a symlinked file, a symlinked directory or a non-regular file", () => {
  const dir = tmp();
  const outside = tmp();
  writeFileSync(join(outside, "secret.json"), '{"secret":true}');
  mkdirSync(join(outside, "d"));
  put(dir, "pages/ok.json", "{}");
  symlinkSync(join(outside, "secret.json"), join(dir, "pages", "link.json"));
  symlinkSync(join(outside, "d"), join(dir, "pages", "linkdir"));
  execFileSync("mkfifo", [join(dir, "pages", "fifo.json")]);
  assert.throws(() => readContentFiles(dir, "pages"), (e) => {
    assert.ok(e instanceof PagesCliError);
    assert.deepEqual(e.diagnostics.map((d) => [d.path, d.code]), [
      ["pages/fifo.json", "PAGES_INVALID_PATH"],
      ["pages/link.json", "PAGES_PATH_ESCAPE"],
      ["pages/linkdir", "PAGES_PATH_ESCAPE"],
    ]);
    return true;
  });
  rmSync(dir, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

test("pull: canonical v2 files are written; Pastasel tr-TR / and en-US / stay apart", async () => {
  const dir = tmp();
  const server = fakeServer({ files: { "pages/tr-TR/index.json": v2("tr-TR", "/"), "pages/en-US/index.json": v2("en-US", "/") } });
  try {
    const { count, diagnostics } = await pullContent({ dir, ...creds, scope: "pages" });
    assert.equal(count, 2);
    assert.deepEqual(diagnostics, []);
    assert.equal(JSON.parse(readFileSync(join(dir, "pages", "en-US", "index.json"), "utf8")).locale, "en-US");
    assert.equal(JSON.parse(readFileSync(join(dir, "pages", "tr-TR", "index.json"), "utf8")).locale, "tr-TR");
    assert.deepEqual(readdirSync(dir).filter((n) => n.startsWith(".blocofy")), []);
  } finally {
    server.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pull from an old server (no protocol_version) → PAGES_SERVER_UPGRADE_REQUIRED, nothing written", async () => {
  const dir = tmp();
  const server = fakeServer({ protocol: 1, files: { "pages/index.json": legacy("/") } });
  try {
    await assert.rejects(pullContent({ dir, ...creds, scope: "pages" }), (e) => e.code === "PAGES_SERVER_UPGRADE_REQUIRED");
    assert.deepEqual(snapshot(dir), {});
  } finally {
    server.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("settings pull still works against an old server", async () => {
  const dir = tmp();
  const server = fakeServer({ protocol: 1, files: { "config/settings.json": '{"theme":{}}' } });
  try {
    const { count } = await pullContent({ dir, ...creds, scope: "settings" });
    assert.equal(count, 1);
  } finally {
    server.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const [label, path] of [
  ["..", "pages/../../escape.json"],
  ["absolute", "/tmp/escape.json"],
  ["windows backslash", "pages\\en-US\\index.json"],
  ["windows drive", "C:/pages/x.json"],
  ["non-canonical", "pages/about.json"],
]) {
  test(`pull refuses a server path (${label}) before writing anything`, async () => {
    const dir = tmp();
    put(dir, "pages/en-US/index.json", "ORIGINAL");
    const before = snapshot(dir);
    const server = fakeServer({ files: { "pages/en-US/index.json": v2("en-US", "/"), [path]: v2("en-US", "/x") } });
    try {
      await assert.rejects(pullContent({ dir, ...creds, scope: "pages" }), (e) => e instanceof PagesCliError);
      assert.deepEqual(snapshot(dir), before);
    } finally {
      server.restore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("pull refuses to write through a symlinked ancestor or onto a symlinked file", async () => {
  for (const shape of ["ancestor", "file"]) {
    const dir = tmp();
    const outside = tmp();
    mkdirSync(join(dir, "pages"));
    if (shape === "ancestor") symlinkSync(outside, join(dir, "pages", "en-US"));
    else {
      mkdirSync(join(dir, "pages", "en-US"));
      writeFileSync(join(outside, "target.json"), "OUTSIDE");
      symlinkSync(join(outside, "target.json"), join(dir, "pages", "en-US", "index.json"));
    }
    const server = fakeServer({ files: { "pages/en-US/index.json": v2("en-US", "/") } });
    try {
      await assert.rejects(pullContent({ dir, ...creds, scope: "pages" }), (e) => e.code === "PAGES_PATH_ESCAPE");
      assert.deepEqual(readdirSync(outside).map((n) => [n, readFileSync(join(outside, n), "utf8")]), shape === "file" ? [["target.json", "OUTSIDE"]] : []);
    } finally {
      server.restore();
      rmSync(dir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  }
});

test("a staging failure leaves the destination unchanged and removes the staging directory", async () => {
  const dir = tmp();
  put(dir, "pages/en-US/index.json", "ORIGINAL");
  const before = snapshot(dir);
  const server = fakeServer({ files: { "pages/en-US/index.json": v2("en-US", "/"), "pages/tr-TR/index.json": v2("tr-TR", "/") } });
  let calls = 0;
  const writeFile = (p, c) => {
    calls += 1;
    if (calls === 2) throw new Error("disk full");
    writeFileSync(p, c);
  };
  try {
    await assert.rejects(pullContent({ dir, ...creds, scope: "pages", writeFile }), (e) => e.code === "PAGES_WRITE_FAILED");
    assert.deepEqual(snapshot(dir), before);
  } finally {
    server.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pull reports a stale legacy file with its canonical replacement and does not touch it", async () => {
  const dir = tmp();
  put(dir, "pages/about.json", legacy("/about", { locale: "en-US" }));
  const server = fakeServer({ files: { "pages/en-US/routes/about/index.json": v2("en-US", "/about") } });
  try {
    const { diagnostics } = await pullContent({ dir, ...creds, scope: "pages" });
    assert.deepEqual(diagnostics.map((d) => [d.code, d.path]), [["PAGES_STALE_LEGACY_FILE", "pages/about.json"]]);
    assert.match(diagnostics[0].message, /pages\/en-US\/routes\/about\/index\.json/);
    assert.equal(readFileSync(join(dir, "pages", "about.json"), "utf8"), legacy("/about", { locale: "en-US" }));
  } finally {
    server.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("push --dry-run: capability probe, then protocol v2 dry_run body; local files untouched", async () => {
  const dir = tmp();
  put(dir, "pages/tr-TR/routes/b/index.json", v2("tr-TR", "/b"));
  put(dir, "pages/en-US/index.json", v2("en-US", "/"));
  const before = snapshot(dir);
  const server = fakeServer({ post: [200, { ok: true, protocol_version: 2, dry_run: true, pages: [], diagnostics: [] }] });
  try {
    const r = await pushContent({ dir, ...creds, scope: "pages", dryRun: true });
    assert.equal(r.dry_run, true);
    assert.deepEqual(server.calls.map((c) => c.method), ["GET", "POST"]);
    assert.match(server.calls[0].url, /scope=capabilities/);
    assert.equal(server.calls[1].body.protocol_version, 2);
    assert.equal(server.calls[1].body.dry_run, true);
    assert.deepEqual(Object.keys(server.calls[1].body.files), ["pages/en-US/index.json", "pages/tr-TR/routes/b/index.json"]);
    assert.deepEqual(snapshot(dir), before);
  } finally {
    server.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("new CLI + old server: push fails closed with no POST", async () => {
  const dir = tmp();
  put(dir, "pages/en-US/index.json", v2("en-US", "/"));
  const server = fakeServer({ protocol: 1 });
  try {
    await assert.rejects(pushContent({ dir, ...creds, scope: "pages" }), (e) => e.code === "PAGES_SERVER_UPGRADE_REQUIRED");
    assert.deepEqual(server.calls.map((c) => c.method), ["GET"]);
  } finally {
    server.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("push: a local error (mismatch, duplicate) stops before anything is sent", async () => {
  const dir = tmp();
  put(dir, "pages/en-US/routes/about/index.json", v2("tr-TR", "/about"));
  const server = fakeServer();
  try {
    await assert.rejects(pushContent({ dir, ...creds, scope: "pages" }), (e) => e.code === "PAGES_LOCALE_PATH_MISMATCH");
    assert.deepEqual(server.calls.map((c) => c.method), ["GET"]);
  } finally {
    server.restore();
    rmSync(dir, { recursive: true, force: true });
  }
  const dir2 = tmp();
  put(dir2, "pages/about.json", legacy("/about", { locale: "en-US", title: "Old" }));
  put(dir2, "pages/en-US/routes/about/index.json", v2("en-US", "/about"));
  const server2 = fakeServer();
  try {
    await assert.rejects(pushContent({ dir: dir2, ...creds, scope: "pages" }), (e) => {
      assert.equal(e.code, "PAGES_DUPLICATE_TARGET");
      assert.deepEqual(e.diagnostics.filter((d) => d.code === "PAGES_DUPLICATE_TARGET").map((d) => d.path), ["pages/about.json", "pages/en-US/routes/about/index.json"]);
      return true;
    });
    assert.equal(server2.calls.some((c) => c.method === "POST"), false);
  } finally {
    server2.restore();
    rmSync(dir2, { recursive: true, force: true });
  }
});

test("push: a server refusal surfaces its code, diagnostics and per-file report", async () => {
  const dir = tmp();
  put(dir, "pages/en-US/routes/missing/index.json", v2("en-US", "/missing"));
  const server = fakeServer({ post: [422, { ok: false, code: "PAGES_TARGET_NOT_FOUND", error: "no page", diagnostics: [{ level: "error", code: "PAGES_TARGET_NOT_FOUND", message: "no page", path: "pages/en-US/routes/missing/index.json" }] }] });
  try {
    await assert.rejects(pushContent({ dir, ...creds, scope: "pages" }), (e) => e.code === "PAGES_TARGET_NOT_FOUND" && e.status === 422 && e.diagnostics.length === 1);
  } finally {
    server.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("check offline: path/payload mismatch and legacy warning, no network", async () => {
  const dir = tmp();
  put(dir, "pages/en-US/routes/about/index.json", v2("tr-TR", "/about"));
  put(dir, "pages/contact.json", legacy("/contact"));
  const orig = globalThis.fetch;
  globalThis.fetch = async () => assert.fail("check offline must not call the network");
  try {
    const r = await checkPages({ dir });
    assert.equal(r.online, false);
    assert.deepEqual(r.diagnostics.map((d) => [d.level, d.code, d.path]), [
      ["warning", "PAGES_LEGACY_LAYOUT", "pages/contact.json"],
      ["error", "PAGES_LOCALE_PATH_MISMATCH", "pages/en-US/routes/about/index.json"],
    ]);
  } finally {
    globalThis.fetch = orig;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("check online: server dry-run findings are included", async () => {
  const dir = tmp();
  put(dir, "pages/en-US/routes/missing/index.json", v2("en-US", "/missing"));
  const server = fakeServer({ post: [422, { ok: false, code: "PAGES_TARGET_NOT_FOUND", error: "x", diagnostics: [{ level: "error", code: "PAGES_TARGET_NOT_FOUND", message: "no page", path: "pages/en-US/routes/missing/index.json" }] }] });
  try {
    const r = await checkPages({ dir, ...creds });
    assert.equal(r.online, true);
    assert.deepEqual(r.diagnostics.map((d) => d.code), ["PAGES_TARGET_NOT_FOUND"]);
    assert.equal(server.calls.at(-1).body.dry_run, true);
  } finally {
    server.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});
