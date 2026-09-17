import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * CF-T3 (contract C4, CLI half) — the page revision CAS + plan matrix. A stateful fake `/api/dev/content` implements
 * the platform contract: every page has a fingerprint that moves whenever the test (or an applied push) changes it;
 * a pull stamps it into the file as `base_revision`; a push is judged against it; `plan_hash` binds a push to its
 * dry run; `force` needs a reason.
 */

const BIN = fileURLToPath(new URL("../bin/blocofy.mjs", import.meta.url));
const TOKEN = "bcf_" + "c".repeat(30);
const DIRS = [];

function tmp(prefix = "bcli-cas-") {
  const d = mkdtempSync(join(tmpdir(), prefix));
  DIRS.push(d);
  return d;
}
test.after(() => {
  for (const d of DIRS) rmSync(d, { recursive: true, force: true });
});

function run(args, url, { env = {} } = {}) {
  return new Promise((resolveRun) => {
    const home = tmp("bcli-home-");
    const { BLOCOFY_URL: _u, BLOCOFY_TOKEN: _t, BLOCOFY_CONTEXT: _c, ...clean } = process.env;
    const started = Date.now();
    const child = spawn(process.execPath, [BIN, ...args], { env: { ...clean, HOME: home, BLOCOFY_URL: url, BLOCOFY_TOKEN: TOKEN, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status) => resolveRun({ status, stdout, stderr, ms: Date.now() - started }));
  });
}

const stable = (v) =>
  Array.isArray(v) ? `[${v.map(stable).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}` : JSON.stringify(v) ?? "null";
const sha = (s) => createHash("sha256").update(s).digest("hex");

/** Fake platform. `pages`: [{ path, locale, slug, title, data, rev }]. */
async function fakePlatform({ cas = true, pages: initial } = {}) {
  const pages = (initial ?? [
    { path: "pages/en-US/index.json", locale: "en-US", slug: "/", title: "Home", rev: 1 },
    { path: "pages/en-US/routes/about/index.json", locale: "en-US", slug: "/about", title: "About", rev: 1 },
  ]).map((p) => ({ data: { version: 2, sections: [] }, ...p }));
  const state = {
    pages,
    posts: [],
    /** Status codes to answer before handling, per kind: { dry: [429, ...], real: [503, ...] }. */
    fail: { dry: [], real: [] },
    retryAfter: "0",
    /** Runs once right after a successful dry run (simulates a concurrent editor between plan and push). */
    afterDryRun: null,
    url: null,
  };
  const revisionOf = (p) => `r1_${sha(`${p.path}:${p.rev}`).slice(0, 32)}`;
  const fileOf = (p) =>
    JSON.stringify({ format_version: 2, ...(cas ? { base_revision: revisionOf(p) } : {}), slug: p.slug, title: p.title, status: "published", seo_title: null, seo_description: null, og_image: null, canonical_url: null, locale: p.locale, template: null, data: p.data }, null, 2) + "\n";
  const json = (res, status, body, headers = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  };

  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/api/dev/whoami") return json(res, 200, { site: { id: "s1", slug: "site", name: "Site" }, liveThemeId: null });
    if (url.pathname !== "/api/dev/content") return json(res, 404, { error: "not_found" });
    const base = { protocol_version: 2, page_layout_version: 2, default_locale: "en-US", supported_locales: ["en-US"], diagnostics: [] };
    if (req.method === "GET") {
      if (url.searchParams.get("scope") === "capabilities") return json(res, 200, { ...base, ...(cas ? { page_revision_cas: 1, plan_hash: 1 } : {}), files: {} });
      return json(res, 200, { ...base, files: Object.fromEntries(state.pages.map((p) => [p.path, fileOf(p)])) });
    }
    const body = JSON.parse(raw);
    const kind = body.dry_run ? "dry" : "real";
    state.posts.push({ kind, key: req.headers["x-idempotency-key"] ?? null, raw, body });
    const injected = state.fail[kind].shift();
    if (injected) return json(res, injected, { error: "busy" }, { "retry-after": state.retryAfter });

    if (!cas) {
      const rows = Object.keys(body.files).map((path) => {
        const p = state.pages.find((x) => x.path === path);
        return { path, locale: p.locale, slug: p.slug, action: "publish", ...(body.dry_run ? {} : { outcome: "published" }) };
      });
      return json(res, 200, { ok: true, protocol_version: 2, dry_run: Boolean(body.dry_run), pagesUpdated: body.dry_run ? 0 : rows.length, pagesSkipped: 0, pages: rows, diagnostics: [] });
    }

    const force = body.force === true;
    if (force && (typeof body.force_reason !== "string" || body.force_reason.trim() === "" || body.force_reason.length > 500)) {
      const message = "force requires a force_reason of 1-500 characters; no pages were changed.";
      return json(res, 422, { ok: false, protocol_version: 2, code: "PAGES_FORCE_REASON_REQUIRED", error: message, diagnostics: [{ level: "error", code: "PAGES_FORCE_REASON_REQUIRED", message }] });
    }
    const diagnostics = [];
    const rows = [];
    const forced = [];
    for (const [path, content] of Object.entries(body.files).sort()) {
      const p = state.pages.find((x) => x.path === path);
      const file = JSON.parse(content);
      const at = { path, locale: p.locale, slug: p.slug };
      const current = revisionOf(p);
      const fileBase = typeof file.base_revision === "string" ? file.base_revision : null;
      const docEqual = stable(file.data) === stable(p.data);
      const changed = [...(docEqual ? [] : ["document"]), ...(file.title !== p.title ? ["title"] : [])].sort();
      let conflict = false;
      let isForced = false;
      if (fileBase === null) {
        if (!force) {
          diagnostics.push({ level: "error", code: "PAGES_BASE_REVISION_REQUIRED", message: "this file has no base_revision", ...at, current_revision: current });
          continue;
        }
        isForced = true;
      } else if (fileBase !== current) {
        if (changed.length === 0) {
          rows.push({ ...at, action: "unchanged", page_id: `p${p.rev}x`, target: "live", changed_fields: [], base_revision: fileBase, current_revision: current, conflict: false, translation: { key_present: false }, media: { blockers: 0 } });
          continue;
        }
        if (!force) {
          diagnostics.push({ level: "error", code: "PAGES_REVISION_CONFLICT", message: "the page changed on the server since this file was pulled", ...at, base_revision: fileBase, current_revision: current });
          continue;
        }
        isForced = true;
        conflict = true;
      }
      if (isForced) {
        forced.push(path);
        diagnostics.push({ level: "warning", code: "PAGES_FORCED", message: "forced", ...at, current_revision: current });
      }
      rows.push({ ...at, action: changed.length ? "publish" : "unchanged", page_id: "pabc", target: "live", changed_fields: changed, base_revision: fileBase, current_revision: current, conflict, translation: { key_present: false }, media: { blockers: 0 } });
    }
    const errors = diagnostics.filter((d) => d.level === "error");
    if (errors.length) {
      const first = errors.find((d) => d.code === "PAGES_REVISION_CONFLICT") ?? errors[0];
      return json(res, first.code === "PAGES_REVISION_CONFLICT" ? 409 : 422, { ok: false, protocol_version: 2, code: first.code, error: `${errors.length} page file problem(s); no pages were changed.`, diagnostics });
    }
    const plan_hash = sha(stable({ pages: rows.map(({ current_revision: _c, ...r }) => r), revs: rows.map((r) => r.current_revision), diagnostics: diagnostics.map((d) => d.code) }));
    if (body.dry_run) {
      const out = { ok: true, protocol_version: 2, dry_run: true, pagesUpdated: 0, pagesSkipped: 0, pages: rows, diagnostics, plan_hash, forced: state.forcedShape === "objects" ? forced.map((path) => ({ path })) : forced };
      json(res, 200, out);
      if (state.afterDryRun) {
        const fn = state.afterDryRun;
        state.afterDryRun = null;
        fn(state);
      }
      return;
    }
    if (body.expected_plan_hash !== undefined && body.expected_plan_hash !== plan_hash) {
      const message = "the push no longer matches the plan you reviewed";
      return json(res, 409, { ok: false, protocol_version: 2, code: "PAGES_PLAN_STALE", error: message, diagnostics: [{ level: "error", code: "PAGES_PLAN_STALE", message }] });
    }
    state.applied = (state.applied ?? 0) + 1;
    for (const r of rows) {
      if (r.action === "unchanged") r.outcome = "unchanged";
      else {
        const p = state.pages.find((x) => x.path === r.path);
        const file = JSON.parse(body.files[r.path]);
        p.data = file.data;
        p.title = file.title;
        p.rev += 1;
        r.outcome = "published";
      }
    }
    return json(res, 200, { ok: true, protocol_version: 2, dry_run: false, pagesUpdated: rows.filter((r) => r.outcome === "published").length, pagesSkipped: rows.filter((r) => r.outcome === "unchanged").length, pages: rows, diagnostics, plan_hash, forced: state.forcedShape === "objects" ? forced.map((path) => ({ path, base_revision: null, current_revision: "r1_x" })) : forced });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  state.url = `http://127.0.0.1:${server.address().port}`;
  state.close = () => server.close();
  state.bump = (path) => {
    state.pages.find((x) => x.path === path).rev += 1;
  };
  return state;
}

/** Pull into a fresh bound directory, then edit a page title locally. */
async function pulledProject(fake, edits = { "pages/en-US/index.json": "Home v2" }) {
  const dir = tmp();
  const r = await run(["pages", "pull", dir], fake.url);
  assert.equal(r.status, 0, r.stderr);
  for (const [rel, title] of Object.entries(edits)) {
    const p = join(dir, ...rel.split("/"));
    const j = JSON.parse(readFileSync(p, "utf8"));
    j.title = title;
    writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
  }
  return dir;
}

test("row 1: pages pull writes base_revision byte-for-byte as the server sent it", async () => {
  const fake = await fakePlatform();
  try {
    const dir = tmp();
    const r = await run(["pages", "pull", dir], fake.url);
    assert.equal(r.status, 0, r.stderr);
    const bytes = readFileSync(join(dir, "pages", "en-US", "index.json"), "utf8");
    const res = await fetch(`${fake.url}/api/dev/content?scope=pages`, { headers: { authorization: `Bearer ${TOKEN}` } });
    const served = (await res.json()).files["pages/en-US/index.json"];
    assert.equal(bytes, served);
    assert.match(JSON.parse(bytes).base_revision, /^r1_[0-9a-f]{32}$/);
  } finally {
    fake.close();
  }
});

test("row 2: a fresh push dry-runs, prints the plan, then pushes with expected_plan_hash and one idempotency key", async () => {
  const fake = await fakePlatform();
  try {
    const dir = await pulledProject(fake);
    const r = await run(["pages", "push", dir], fake.url);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(fake.posts.map((p) => p.kind), ["dry", "real"]);
    const [dry, real] = fake.posts;
    assert.equal(dry.body.dry_run, true);
    assert.equal(real.body.expected_plan_hash.length, 64);
    assert.match(real.key, /^cli-[0-9a-f-]{36}$/);
    assert.equal("force" in real.body, false);
    assert.match(r.stderr, /Operation: pages push · live 1 · draft 0 · unchanged 1/);
    assert.equal((r.stderr.match(/^Target:/gm) ?? []).length, 1, "the target block is printed once");
    assert.match(r.stdout, /publish\s+live\s+en-US\s+pages\/en-US\/index\.json\s+title/);
    assert.match(r.stdout, /Totals: live 1 · draft 0 · unchanged 1 · conflicts 0/);
    assert.equal(fake.applied, 1);
  } finally {
    fake.close();
  }
});

test("row 3: a stale file — the dry run shows the conflict (base vs current + fix), exit 2, only the dry run was sent", async () => {
  const fake = await fakePlatform();
  try {
    const dir = await pulledProject(fake);
    fake.bump("pages/en-US/index.json");
    for (const args of [["pages", "push", dir, "--dry-run"], ["pages", "push", dir]]) {
      fake.posts.length = 0;
      const r = await run(args, fake.url);
      assert.equal(r.status, 2, r.stderr);
      assert.deepEqual(fake.posts.map((p) => p.kind), ["dry"]);
      assert.match(r.stderr, /PAGES_REVISION_CONFLICT/);
      assert.match(r.stderr, /base_revision r1_[0-9a-f]{32} → current r1_[0-9a-f]{32}/);
      assert.match(r.stderr, /blocofy pages pull/);
      assert.match(r.stderr, /--force --reason <text>/);
    }
    assert.equal(fake.applied, undefined);
  } finally {
    fake.close();
  }
});

test("row 4: a pre-CAS file without base_revision is refused by the dry run (PAGES_BASE_REVISION_REQUIRED), exit 2, no real push", async () => {
  const fake = await fakePlatform();
  try {
    const dir = await pulledProject(fake);
    const p = join(dir, "pages", "en-US", "index.json");
    const j = JSON.parse(readFileSync(p, "utf8"));
    delete j.base_revision;
    writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
    const r = await run(["pages", "push", dir], fake.url);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /PAGES_BASE_REVISION_REQUIRED/);
    assert.deepEqual(fake.posts.map((x) => x.kind), ["dry"]);
    assert.equal(fake.applied, undefined);
  } finally {
    fake.close();
  }
});

test("row 5: multi-page push with one stale page → nothing is pushed", async () => {
  const fake = await fakePlatform();
  try {
    const dir = await pulledProject(fake, { "pages/en-US/index.json": "Home v2", "pages/en-US/routes/about/index.json": "About v2" });
    fake.bump("pages/en-US/routes/about/index.json");
    const r = await run(["pages", "push", dir], fake.url);
    assert.equal(r.status, 2, r.stderr);
    assert.deepEqual(fake.posts.map((x) => x.kind), ["dry"]);
    assert.match(r.stderr, /pages\/en-US\/routes\/about\/index\.json/);
    assert.equal(fake.pages[0].title, "Home", "the fresh page was not written either");
  } finally {
    fake.close();
  }
});

test("row 6: a 503 on the real push is retried with the identical key and body; final success", async () => {
  const fake = await fakePlatform();
  try {
    const dir = await pulledProject(fake);
    fake.fail.real = [503];
    const r = await run(["pages", "push", dir], fake.url);
    assert.equal(r.status, 0, r.stderr);
    const real = fake.posts.filter((p) => p.kind === "real");
    assert.equal(real.length, 2);
    assert.equal(real[0].key, real[1].key);
    assert.equal(real[0].raw, real[1].raw);
    assert.equal(fake.applied, 1);
    assert.match(r.stderr, /retrying/);
  } finally {
    fake.close();
  }
});

test("row 7: 429 + Retry-After is honoured on the dry run and on the push", async () => {
  const fake = await fakePlatform();
  try {
    const dir = await pulledProject(fake);
    fake.fail.dry = [429];
    fake.fail.real = [429];
    fake.retryAfter = "1";
    const r = await run(["pages", "push", dir], fake.url);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(fake.posts.map((p) => p.kind), ["dry", "dry", "real", "real"]);
    assert.equal((r.stderr.match(/HTTP 429\) — retrying in 1s/g) ?? []).length, 2, r.stderr);
    assert.ok(r.ms >= 1900, `waited ${r.ms}ms`);
  } finally {
    fake.close();
  }
});

test("row 8: a 503 on the dry run is retried; the push then succeeds", async () => {
  const fake = await fakePlatform();
  try {
    const dir = await pulledProject(fake);
    fake.fail.dry = [503, 503];
    const r = await run(["pages", "push", dir], fake.url);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(fake.posts.map((p) => p.kind), ["dry", "dry", "dry", "real"]);
    assert.equal(fake.applied, 1);
  } finally {
    fake.close();
  }
});

test("row 9: the site changes between the dry run and the push → PAGES_PLAN_STALE, exit 2, nothing applied", async () => {
  const fake = await fakePlatform();
  try {
    const dir = await pulledProject(fake);
    // The file's base still matches (another page moved), but the plan the user saw is no longer the plan.
    fake.afterDryRun = (s) => {
      s.pages[0].rev += 1;
      s.pages[0].title = "Home v2";
    };
    const r = await run(["pages", "push", dir], fake.url);
    assert.equal(r.status, 2, r.stderr);
    assert.deepEqual(fake.posts.map((p) => p.kind), ["dry", "real"]);
    assert.match(r.stderr, /PAGES_PLAN_STALE/);
    assert.match(r.stderr, /site changed between the plan and the push/);
    assert.equal(fake.applied, undefined);
  } finally {
    fake.close();
  }
});

test("row 10: --force requires --reason (exit 1, nothing sent); with a reason it sends force fields, shows FORCE and lists forced pages", async () => {
  const fake = await fakePlatform();
  try {
    const dir = await pulledProject(fake);
    fake.bump("pages/en-US/index.json");
    const noReason = await run(["pages", "push", dir, "--force"], fake.url);
    assert.equal(noReason.status, 1, noReason.stderr);
    assert.match(noReason.stderr, /--reason/);
    const tooLong = await run(["pages", "push", dir, "--force", "--reason", "x".repeat(501)], fake.url);
    assert.equal(tooLong.status, 1, tooLong.stderr);
    const reasonOnly = await run(["pages", "push", dir, "--reason", "why"], fake.url);
    assert.equal(reasonOnly.status, 1, reasonOnly.stderr);
    assert.equal(fake.posts.length, 0, "a usage error sends nothing");

    const r = await run(["pages", "push", dir, "--force", "--reason", "editor change is obsolete"], fake.url);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(fake.posts.map((p) => p.kind), ["dry", "real"]);
    for (const p of fake.posts) {
      assert.equal(p.body.force, true);
      assert.equal(p.body.force_reason, "editor change is obsolete");
    }
    assert.match(r.stderr, /Operation: pages push · FORCE · live 1 · draft 0 · unchanged 1/);
    assert.match(r.stdout, /Forced:\n\s+pages\/en-US\/index\.json/);
    assert.match(r.stdout, /\[conflict\]/);
    assert.equal(fake.pages[0].title, "Home v2");
  } finally {
    fake.close();
  }
});

test("row 10b: forced pages reported as objects {path, base_revision, current_revision} are listed too", async () => {
  const fake = await fakePlatform();
  fake.forcedShape = "objects";
  try {
    const dir = await pulledProject(fake);
    fake.bump("pages/en-US/index.json");
    const r = await run(["pages", "push", dir, "--force", "--reason", "ok"], fake.url);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Forced:\n\s+pages\/en-US\/index\.json/);
  } finally {
    fake.close();
  }
});

test("--json: pages push prints the server result JSON on stdout; a refusal is the envelope on stderr", async () => {
  const fake = await fakePlatform();
  try {
    const dir = await pulledProject(fake);
    const dry = await run(["pages", "push", dir, "--dry-run", "--json"], fake.url);
    assert.equal(dry.status, 0, dry.stderr);
    const plan = JSON.parse(dry.stdout);
    assert.equal(plan.dry_run, true);
    assert.equal(plan.plan_hash.length, 64);
    const r = await run(["pages", "push", dir, "--json"], fake.url);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.dry_run, false);
    assert.equal(out.pages.find((p) => p.path === "pages/en-US/index.json").outcome, "published");

    const again = await pulledProject(fake, { "pages/en-US/index.json": "Home v3" });
    fake.bump("pages/en-US/index.json");
    const refused = await run(["pages", "push", again, "--json"], fake.url);
    assert.equal(refused.status, 2, refused.stderr);
    assert.equal(refused.stdout, "");
    const env = JSON.parse(refused.stderr.trim().split("\n").pop()).error;
    assert.equal(env.code, "PAGES_REVISION_CONFLICT");
    assert.equal(env.details.diagnostics[0].current_revision.length, 35);
  } finally {
    fake.close();
  }
});

test("old server (no page_revision_cas): push proceeds as before with one warning, no plan fields sent", async () => {
  const fake = await fakePlatform({ cas: false });
  try {
    const dir = await pulledProject(fake);
    const r = await run(["pages", "push", dir, "--force", "--reason", "x"], fake.url);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(fake.posts.map((p) => p.kind), ["real"]);
    const body = fake.posts[0].body;
    assert.equal("expected_plan_hash" in body, false);
    assert.equal("force" in body, false);
    assert.equal((r.stderr.match(/PAGES_REVISION_CAS_UNAVAILABLE/g) ?? []).length, 1, r.stderr);
    assert.match(r.stderr, /stale-file protection is not available on this server/);
    assert.equal((r.stderr.match(/^Target:/gm) ?? []).length, 1);
  } finally {
    fake.close();
  }
});

test("help explains base_revision, conflict recovery and --force --reason", async () => {
  const r = await run(["--help"], "http://127.0.0.1:9");
  assert.match(r.stdout, /base_revision/);
  assert.match(r.stdout, /--force --reason <text>/);
});
