import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";

import { CliRefusal, applySiteState, downloadAssetBytes, fetchSiteStateExport, planSiteState, publishSiteState, uploadMediaAsset } from "../lib/site-state-client.mjs";

const KEY = "blcf_live_testkey0123456789abcdef";

/** `route(rec)` → `{status, body}`; `reqs` records every request in order. */
async function fakeV1(route) {
  const reqs = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const rec = { method: req.method, url: req.url, headers: req.headers, raw };
    reqs.push(rec);
    const out = route(rec, reqs.length);
    res.writeHead(out.status, { "content-type": "application/json" });
    res.end(JSON.stringify(out.body));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { apiUrl: `http://127.0.0.1:${server.address().port}`, reqs, close: () => new Promise((r) => server.close(r)) };
}

test("fetchSiteStateExport: GET /api/v1/site-state, Bearer apiKey", async () => {
  const s = await fakeV1(() => ({ status: 200, body: { schema_version: 1, manifest: {}, files: {}, assets: [], diagnostics: [] } }));
  try {
    const out = await fetchSiteStateExport({ apiUrl: s.apiUrl, apiKey: KEY });
    assert.equal(out.schema_version, 1);
    assert.equal(s.reqs[0].method, "GET");
    assert.equal(s.reqs[0].url, "/api/v1/site-state");
    assert.equal(s.reqs[0].headers.authorization, `Bearer ${KEY}`);
  } finally {
    await s.close();
  }
});

test("planSiteState: POST /api/v1/site-state/plan with a JSON body", async () => {
  const s = await fakeV1(() => ({ status: 200, body: { plan_hash: "h1", status: "planned", steps: [], assets_missing: [], theme_source: null, preconditions: [], diagnostics: [] } }));
  try {
    const body = { manifest: { manifest_digest: "d1" }, files: {}, mode: "restore", target: { instance: "new" }, accept_live_effects: [] };
    const out = await planSiteState({ apiUrl: s.apiUrl, apiKey: KEY, body });
    assert.equal(out.plan_hash, "h1");
    assert.equal(s.reqs[0].method, "POST");
    assert.equal(s.reqs[0].url, "/api/v1/site-state/plan");
    assert.deepEqual(JSON.parse(s.reqs[0].raw.toString("utf8")), body);
  } finally {
    await s.close();
  }
});

test("applySiteState and publishSiteState hit their own paths", async () => {
  const s = await fakeV1((rec) => {
    if (rec.url === "/api/v1/site-state/apply") return { status: 200, body: { status: "draft_complete", applied: [], not_applied: [], report: [], theme_source: null } };
    return { status: 200, body: { status: "published", swapped: true, navigation: [], globals: false } };
  });
  try {
    await applySiteState({ apiUrl: s.apiUrl, apiKey: KEY, body: { expected_plan_hash: "h1" } });
    await publishSiteState({ apiUrl: s.apiUrl, apiKey: KEY, body: { expected_plan_hash: "h1" } });
    assert.deepEqual(s.reqs.map((r) => r.url), ["/api/v1/site-state/apply", "/api/v1/site-state/publish"]);
  } finally {
    await s.close();
  }
});

test("a 4xx is a CliRefusal carrying the server's error envelope", async () => {
  const s = await fakeV1(() => ({ status: 409, body: { error: { code: "conflict", message: "stale", details: { code: "SITE_STATE_PLAN_STALE" } } } }));
  try {
    await assert.rejects(planSiteState({ apiUrl: s.apiUrl, apiKey: KEY, body: {} }), (err) => {
      assert.ok(err instanceof CliRefusal);
      assert.equal(err.status, 409);
      assert.equal(err.error.details.code, "SITE_STATE_PLAN_STALE");
      return true;
    });
  } finally {
    await s.close();
  }
});

test("downloadAssetBytes: fetches raw bytes from an arbitrary URL, no auth header", async () => {
  const reqs = [];
  const server = createServer((req, res) => {
    reqs.push({ headers: req.headers });
    res.writeHead(200, { "content-type": "image/png" });
    res.end(Buffer.from([1, 2, 3, 4]));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const buf = await downloadAssetBytes({ url: `http://127.0.0.1:${server.address().port}/cdn/x.png` });
    assert.deepEqual(buf, Buffer.from([1, 2, 3, 4]));
    assert.equal(reqs[0].headers.authorization, undefined);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("downloadAssetBytes throws on a non-ok response", async () => {
  const server = createServer((req, res) => {
    res.writeHead(404);
    res.end("nope");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await assert.rejects(downloadAssetBytes({ url: `http://127.0.0.1:${server.address().port}/gone.png` }));
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("uploadMediaAsset: POST /api/v1/media as multipart, no content-type set by hand", async () => {
  const s = await fakeV1((rec) => {
    assert.match(rec.headers["content-type"], /^multipart\/form-data; boundary=/);
    assert.ok(rec.raw.includes("filename=\"pixel.png\""));
    return { status: 201, body: { file: { id: "f1" } } };
  });
  try {
    const out = await uploadMediaAsset({ apiUrl: s.apiUrl, apiKey: KEY, filename: "pixel.png", content: Buffer.from([1, 2, 3]), mime: "image/png" });
    assert.equal(out.file.id, "f1");
  } finally {
    await s.close();
  }
});
