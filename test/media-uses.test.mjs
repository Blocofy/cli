import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import { CliRefusal, decidePageMediaUses, fetchPageMediaUses } from "../lib/media-uses.mjs";

/**
 * D3 / CLI 0.8.0 — v1 `pages/{id}/media-uses` istemcisi (L1–L4) ve `pages media-decide` akışı (L12).
 * Plan: multisite-cms docs/architecture/plans/2026-09-16-d3-page-media-use-public-surfaces.md §4.5–4.7.
 * Sahte v1 sunucusu her isteği (method, url, headers, body) kaydeder; yanıt şekli
 * apps/admin/test/fixtures/page-media-uses-response.schema.json ile birebir.
 */

const root = fileURLToPath(new URL("..", import.meta.url));
const BIN = join(root, "bin", "blocofy.mjs");
const KEY = "blcf_live_testkey0123456789abcdef";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const USE = {
  key: "hero.image::target",
  path: "sections.hero.image",
  facet: "target",
  kind: "image",
  support: "supported",
  unsupported_reason: null,
  editable: true,
  decision: "inherit",
  alt: null,
  caption: null,
  decorative: false,
  target_asset: null,
  source_asset: "asset_1",
  witness: { target: null, source: "w_src_1" },
  source: { kind: "published", id: 7, hash: "h1" },
  stale: false,
  blocks: false,
  reasons: [],
};
const VIEW = {
  page: { id: "pg_1" },
  applicable: true,
  revision: { id: 41, version: 3 },
  locale: "en",
  source_locale: "tr",
  lineage: "ln_1",
  source_basis: { kind: "published", id: 7, hash: "h1" },
  uses: [USE],
  counts: { total: 1, blocked: 0 },
};
const DECISIONS = [
  { path: "sections.hero.image", facet: "target", decision: "localize", target_asset: "asset_9", idempotency_key: "k-1" },
  { path: "sections.hero.image", facet: "alt", decision: "override", alt: "Hero", idempotency_key: "k-2" },
];
const CONFLICT = {
  error: {
    code: "conflict",
    message: "Taslak sürümü değişti.",
    details: { code: "revision_conflict", current_revision_id: 42, current_version: 1 },
  },
};

/** Sahte v1: `route(rec)` → `{status, body}`; `reqs` sırayla kayıt. */
async function fakeV1(route) {
  const reqs = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const rec = { method: req.method, url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null };
    reqs.push(rec);
    const out = route(rec, reqs.length);
    res.writeHead(out.status, { "content-type": "application/json" });
    res.end(JSON.stringify(out.body));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    apiUrl: `http://127.0.0.1:${server.address().port}`,
    reqs,
    close: () => new Promise((r) => server.close(r)),
  };
}

let home;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "blocofy-mu-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function runCli(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      env: { PATH: process.env.PATH, HOME: home, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.stdin.end();
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function decisionsFile(decisions) {
  const file = join(home, "decisions.json");
  writeFileSync(file, JSON.stringify({ decisions }));
  return file;
}

test("[L1] fetchPageMediaUses: GET /api/v1/pages/pg_1/media-uses, Bearer <apiKey>, JSON", async () => {
  const s = await fakeV1(() => ({ status: 200, body: VIEW }));
  try {
    const view = await fetchPageMediaUses({ apiUrl: `${s.apiUrl}/`, apiKey: KEY, page: "pg_1" });
    assert.deepEqual(view, VIEW);
    assert.equal(s.reqs.length, 1);
    assert.equal(s.reqs[0].method, "GET");
    assert.equal(s.reqs[0].url, "/api/v1/pages/pg_1/media-uses");
    assert.equal(s.reqs[0].headers.authorization, `Bearer ${KEY}`);
    assert.match(s.reqs[0].headers.accept, /application\/json/);
    assert.equal(s.reqs[0].body, null);
  } finally {
    await s.close();
  }
});

test("[L2] decidePageMediaUses: POST gövdesi {expected_revision_id, expected_version, decisions} birebir", async () => {
  const s = await fakeV1(() => ({ status: 200, body: { ...VIEW, applied: [], written: true } }));
  try {
    const out = await decidePageMediaUses({
      apiUrl: s.apiUrl,
      apiKey: KEY,
      page: "pg_1",
      expectedRevisionId: 41,
      expectedVersion: 3,
      decisions: DECISIONS,
    });
    assert.equal(out.written, true);
    assert.equal(s.reqs.length, 1);
    assert.equal(s.reqs[0].method, "POST");
    assert.equal(s.reqs[0].url, "/api/v1/pages/pg_1/media-uses");
    assert.equal(s.reqs[0].headers.authorization, `Bearer ${KEY}`);
    assert.match(s.reqs[0].headers["content-type"], /application\/json/);
    assert.deepEqual(s.reqs[0].body, { expected_revision_id: 41, expected_version: 3, decisions: DECISIONS });
    assert.deepEqual(Object.keys(s.reqs[0].body), ["expected_revision_id", "expected_version", "decisions"]);
  } finally {
    await s.close();
  }
});

test("[L3] 409 → CliRefusal{status:409, error}; komut exit 2 ve stderr {error} JSON", async () => {
  const s = await fakeV1(() => ({ status: 409, body: CONFLICT }));
  try {
    await assert.rejects(
      decidePageMediaUses({ apiUrl: s.apiUrl, apiKey: KEY, page: "pg_1", expectedRevisionId: 41, expectedVersion: 3, decisions: DECISIONS }),
      (e) => e instanceof CliRefusal && e.status === 409 && JSON.stringify(e.error) === JSON.stringify(CONFLICT.error),
    );
    const r = await runCli(
      ["pages", "media-decide", "pg_1", "--decisions", decisionsFile(DECISIONS), "--expected-revision-id", "41", "--expected-version", "3"],
      { BLOCOFY_API_KEY: KEY, BLOCOFY_API_URL: s.apiUrl },
    );
    assert.equal(r.code, 2, r.stderr);
    assert.deepEqual(JSON.parse(r.stderr), CONFLICT);
    assert.equal(s.reqs.length, 2); // lib + CLI: beklenenler verildi → GET yok, tek POST
    assert.equal(s.reqs[1].method, "POST");
  } finally {
    await s.close();
  }
});

test("[L3b] 404 not_found → exit 2, stderr {error}", async () => {
  const notFound = { error: { code: "not_found", message: "Sayfa bulunamadı." } };
  const s = await fakeV1(() => ({ status: 404, body: notFound }));
  try {
    const r = await runCli(["pages", "media-uses", "pg_x"], { BLOCOFY_API_KEY: KEY, BLOCOFY_API_URL: s.apiUrl });
    assert.equal(r.code, 2, r.stderr);
    assert.deepEqual(JSON.parse(r.stderr), notFound);
  } finally {
    await s.close();
  }
});

test("[L4] 5xx → retry YOK (tek istek); lib düz hata, komut exit 1", async () => {
  const s = await fakeV1(() => ({ status: 503, body: { error: { code: "resource_busy", message: "busy" } } }));
  try {
    await assert.rejects(
      decidePageMediaUses({ apiUrl: s.apiUrl, apiKey: KEY, page: "pg_1", expectedRevisionId: 41, expectedVersion: 3, decisions: DECISIONS }),
      (e) => !(e instanceof CliRefusal) && /503/.test(e.message),
    );
    assert.equal(s.reqs.length, 1, "lib retried a 5xx");
    const r = await runCli(
      ["pages", "media-decide", "pg_1", "--decisions", decisionsFile(DECISIONS), "--expected-revision-id", "41", "--expected-version", "3"],
      { BLOCOFY_API_KEY: KEY, BLOCOFY_API_URL: s.apiUrl },
    );
    assert.equal(r.code, 1, r.stderr);
    assert.equal(s.reqs.length, 2, "CLI retried a 5xx");
    assert.match(r.stderr, /503/);
  } finally {
    await s.close();
  }
});

test("[L12] media-decide: beklenenler yoksa önce GET → revision{id,version}; idempotency_key yoksa uuid; written:false mesajı", async () => {
  const s = await fakeV1((rec) => {
    if (rec.method === "GET") return { status: 200, body: { ...VIEW, revision: { id: 58, version: 12 } } };
    return { status: 200, body: { ...VIEW, revision: { id: 58, version: 12 }, applied: [], written: false } };
  });
  try {
    const file = decisionsFile([{ path: "sections.hero.image", facet: "target", decision: "localize", target_asset: "asset_9" }, DECISIONS[1]]);
    const r = await runCli(["pages", "media-decide", "pg_1", "--decisions", file], { BLOCOFY_API_KEY: KEY, BLOCOFY_API_URL: s.apiUrl });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(s.reqs.length, 2);
    assert.equal(s.reqs[0].method, "GET");
    assert.equal(s.reqs[0].url, "/api/v1/pages/pg_1/media-uses");
    assert.equal(s.reqs[1].method, "POST");
    const body = s.reqs[1].body;
    assert.equal(body.expected_revision_id, 58);
    assert.equal(body.expected_version, 12);
    assert.equal(body.decisions.length, 2);
    assert.match(body.decisions[0].idempotency_key, UUID_RE);
    assert.equal(body.decisions[1].idempotency_key, "k-2"); // verilen anahtar korunur
    assert.equal(body.decisions[0].target_asset, "asset_9");
    assert.match(r.stdout, /No changes/);
  } finally {
    await s.close();
  }
});

test("[L12b] media-decide --json: yanıt gövdesi stdout'a JSON; written:true", async () => {
  const out = { ...VIEW, applied: [{ index: 0, path: "sections.hero.image", facet: "target", decision: "localize", replayed: false }], written: true };
  const s = await fakeV1(() => ({ status: 200, body: out }));
  try {
    const r = await runCli(
      ["pages", "media-decide", "pg_1", "--decisions", decisionsFile(DECISIONS), "--expected-revision-id", "41", "--expected-version", "3", "--json"],
      { BLOCOFY_API_KEY: KEY, BLOCOFY_API_URL: s.apiUrl },
    );
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), out);
    assert.equal(s.reqs.length, 1);
  } finally {
    await s.close();
  }
});

test("[L12c] media-decide: GET applicable:false → exit 1, POST yapılmaz", async () => {
  const s = await fakeV1(() => ({ status: 200, body: { page: { id: "pg_1" }, applicable: false, reason: "source_locale" } }));
  try {
    const r = await runCli(["pages", "media-decide", "pg_1", "--decisions", decisionsFile(DECISIONS)], { BLOCOFY_API_KEY: KEY, BLOCOFY_API_URL: s.apiUrl });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /source_locale/);
    assert.equal(s.reqs.length, 1);
  } finally {
    await s.close();
  }
});

test("pages media-uses --json: GET yanıtı birebir stdout; insan modu sayımları basar", async () => {
  const s = await fakeV1(() => ({ status: 200, body: VIEW }));
  try {
    const j = await runCli(["pages", "media-uses", "pg_1", "--json"], { BLOCOFY_API_KEY: KEY, BLOCOFY_API_URL: s.apiUrl });
    assert.equal(j.code, 0, j.stderr);
    assert.deepEqual(JSON.parse(j.stdout), VIEW);
    const h = await runCli(["pages", "media-uses", "pg_1"], { BLOCOFY_API_KEY: KEY, BLOCOFY_API_URL: s.apiUrl });
    assert.equal(h.code, 0, h.stderr);
    assert.match(h.stdout, /pg_1/);
    assert.match(h.stdout, /sections\.hero\.image/);
    assert.match(h.stdout, /1 use/);
    assert.equal(s.reqs.length, 2);
  } finally {
    await s.close();
  }
});

test("pages media-uses: not-applicable yanıtı exit 0 + reason", async () => {
  const s = await fakeV1(() => ({ status: 200, body: { page: { id: "pg_1" }, applicable: false, reason: "single_locale" } }));
  try {
    const r = await runCli(["pages", "media-uses", "pg_1"], { BLOCOFY_API_KEY: KEY, BLOCOFY_API_URL: s.apiUrl });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /single_locale/);
  } finally {
    await s.close();
  }
});

test("v1 kimlik: yalnız dev {url,token} varsa exit 1 ve istek yok; bcf_ anahtar v1'e kabul edilmez", async () => {
  const s = await fakeV1(() => ({ status: 200, body: VIEW }));
  try {
    writeFileSync(join(home, ".blocofy-legacy.json"), "");
    const noKey = await runCli(["pages", "media-uses", "pg_1"], { BLOCOFY_URL: s.apiUrl, BLOCOFY_TOKEN: "bcf_devtoken_0123456789abcdef" });
    assert.equal(noKey.code, 1);
    assert.match(noKey.stderr, /login --api-key/);
    const devKey = await runCli(["pages", "media-uses", "pg_1"], { BLOCOFY_API_KEY: "bcf_devtoken_0123456789abcdef", BLOCOFY_API_URL: s.apiUrl });
    assert.equal(devKey.code, 1);
    assert.match(devKey.stderr, /blcf_live_/);
    assert.equal(s.reqs.length, 0);
  } finally {
    await s.close();
  }
});

test("usage: media-decide --decisions yok / dosya şekli bozuk / beklenenlerin yalnız biri → exit 1, istek yok", async () => {
  const s = await fakeV1(() => ({ status: 200, body: VIEW }));
  try {
    const env = { BLOCOFY_API_KEY: KEY, BLOCOFY_API_URL: s.apiUrl };
    const a = await runCli(["pages", "media-decide", "pg_1"], env);
    assert.equal(a.code, 1);
    assert.match(a.stderr, /--decisions/);
    const bad = join(home, "bad.json");
    writeFileSync(bad, JSON.stringify({ decisions: [] }));
    const b = await runCli(["pages", "media-decide", "pg_1", "--decisions", bad], env);
    assert.equal(b.code, 1);
    const c = await runCli(["pages", "media-decide", "pg_1", "--decisions", decisionsFile(DECISIONS), "--expected-version", "3"], env);
    assert.equal(c.code, 1);
    assert.match(c.stderr, /--expected-revision-id/);
    const d = await runCli(["pages", "media-decide"], env);
    assert.equal(d.code, 1);
    assert.equal(s.reqs.length, 0);
  } finally {
    await s.close();
  }
});

after(() => {
  /* geçici dizinler afterEach'te silinir */
});
