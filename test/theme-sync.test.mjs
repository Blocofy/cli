import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { localPathFor } from "../lib/local-theme.mjs";
import {
  fetchDevSession,
  fetchSiteStatus,
  fetchWithRetry,
  publishInstance,
  pullTheme,
  pushTheme,
} from "../lib/theme-sync.mjs";

// Zero backoff keeps retry tests instant; onRetry records each notice.
const noWait = { backoff: [0, 0] };

test("fetchWithRetry: network throw twice → succeeds on 3rd attempt (2 retries)", async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  const retries = [];
  globalThis.fetch = async () => {
    calls += 1;
    if (calls < 3) throw new TypeError("fetch failed");
    return new Response("ok", { status: 200 });
  };
  after(() => {
    globalThis.fetch = realFetch;
  });

  const res = await fetchWithRetry("http://x", {}, { ...noWait, onRetry: (i) => retries.push(i) });
  assert.equal(res.status, 200);
  assert.equal(calls, 3);
  assert.equal(retries.length, 2);
  assert.deepEqual(retries.map((r) => r.attempt), [1, 2]);
});

test("fetchWithRetry: persistent network error → throws after retries exhausted", async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw new TypeError("fetch failed");
  };
  after(() => {
    globalThis.fetch = realFetch;
  });

  await assert.rejects(fetchWithRetry("http://x", {}, noWait), /fetch failed/);
  assert.equal(calls, 3); // initial + 2 retries
});

test("fetchWithRetry: 422 (permanent 4xx) → returned immediately, NO retry", async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  const retries = [];
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: "Unprocessable" }), { status: 422 });
  };
  after(() => {
    globalThis.fetch = realFetch;
  });

  const res = await fetchWithRetry("http://x", {}, { ...noWait, onRetry: (i) => retries.push(i) });
  assert.equal(res.status, 422);
  assert.equal(calls, 1);
  assert.equal(retries.length, 0);
});

test("fetchWithRetry: 503 then 200 → retries once on transient 5xx", async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return calls === 1
      ? new Response("busy", { status: 503 })
      : new Response("ok", { status: 200 });
  };
  after(() => {
    globalThis.fetch = realFetch;
  });

  const res = await fetchWithRetry("http://x", {}, noWait);
  assert.equal(res.status, 200);
  assert.equal(calls, 2);
});

test("pushTheme: retries a transient 503 then succeeds; onRetry fired", async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  const retries = [];
  globalThis.fetch = async () => {
    calls += 1;
    return calls === 1
      ? new Response("busy", { status: 503 })
      : new Response(JSON.stringify({ ok: true, created: 1, updated: 0 }), { status: 200 });
  };
  const dir = mkdtempSync(join(tmpdir(), "blocofy-retry-"));
  mkdirSync(join(dir, "section"), { recursive: true });
  writeFileSync(join(dir, "section", "Hero.liquid"), "H");
  after(() => {
    globalThis.fetch = realFetch;
    rmSync(dir, { recursive: true, force: true });
  });

  const result = await pushTheme({
    dir,
    url: "http://localhost:1",
    token: "bcf_t",
    onRetry: (i) => retries.push(i),
  });
  assert.equal(result.created, 1);
  assert.equal(calls, 2);
  assert.equal(retries.length, 1);
});

test("publishInstance: POST /api/dev/publish {instanceId} → result (Bearer)", async () => {
  let seen = null;
  const fake = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      seen = { method: req.method, auth: req.headers.authorization, url: req.url, body: JSON.parse(body || "{}") };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, published: 20, cloned: true }));
    });
  });
  fake.listen(0);
  await once(fake, "listening");
  after(() => fake.close());

  const r = await publishInstance({ url: `http://localhost:${fake.address().port}`, token: "bcf_t", instanceId: 20 });
  assert.equal(r.published, 20);
  assert.equal(r.cloned, true);
  assert.equal(seen.method, "POST");
  assert.ok(seen.url.endsWith("/api/dev/publish"));
  assert.equal(seen.auth, "Bearer bcf_t");
  assert.equal(seen.body.instanceId, 20);
});

test("publishInstance: sunucu 409 → throw (error metni)", async () => {
  const fake = createServer((req, res) => {
    res.writeHead(409, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Yayınlanacak temada sayfa yok." }));
  });
  fake.listen(0);
  await once(fake, "listening");
  after(() => fake.close());
  await assert.rejects(
    publishInstance({ url: `http://localhost:${fake.address().port}`, token: "bcf_t", instanceId: 20 }),
    /sayfa yok/,
  );
});

test("fetchSiteStatus: GET /api/dev/site → health JSON", async () => {
  const fake = createServer((req, res) => {
    assert.equal(req.method, "GET");
    assert.ok(req.url.endsWith("/api/dev/site"));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        site: { id: 14, slug: "testsite" }, health: "ok", pages_on_live: 12,
        live_theme_instance: { id: 19, name: "Canlı", template_count: 5 }, drafts: [],
      }),
    );
  });
  fake.listen(0);
  await once(fake, "listening");
  after(() => fake.close());
  const s = await fetchSiteStatus({ url: `http://localhost:${fake.address().port}`, token: "bcf_t" });
  assert.equal(s.health, "ok");
  assert.equal(s.pages_on_live, 12);
  assert.equal(s.live_theme_instance.id, 19);
});

test("fetchDevSession: GET /api/dev/session → session JSON (Bearer)", async () => {
  const fake = createServer((req, res) => {
    assert.equal(req.method, "GET");
    assert.equal(req.headers.authorization, "Bearer bcf_t");
    assert.ok(req.url.endsWith("/api/dev/session"));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        draftInstanceId: 77,
        previewUrl: "https://testsite.myblocofy.com/?preview=TOK",
        editorUrl: "https://app.blocofy.com/editor/5?instance=77",
        site: { id: 14, slug: "testsite" },
      }),
    );
  });
  fake.listen(0);
  await once(fake, "listening");
  after(() => fake.close());

  const s = await fetchDevSession({
    url: `http://localhost:${fake.address().port}`,
    token: "bcf_t",
  });
  assert.equal(s.draftInstanceId, 77);
  assert.equal(s.previewUrl, "https://testsite.myblocofy.com/?preview=TOK");
  assert.equal(s.editorUrl, "https://app.blocofy.com/editor/5?instance=77");
});

test("localPathFor: adds .liquid for Liquid kinds, leaves assets raw", () => {
  assert.equal(localPathFor("section/Hero"), "section/Hero.liquid");
  assert.equal(localPathFor("layout/theme"), "layout/theme.liquid");
  assert.equal(localPathFor("asset/theme.css"), "asset/theme.css");
  assert.equal(localPathFor("section/Hero.liquid"), "section/Hero.liquid"); // no double extension
});

test("pullTheme: GET /api/dev/theme → writes to disk with .liquid re-added", async () => {
  const fake = createServer((req, res) => {
    assert.equal(req.method, "GET");
    assert.equal(req.headers.authorization, "Bearer bcf_t");
    assert.ok(req.url.endsWith("/api/dev/theme"));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ files: { "section/Hero": "H", "asset/theme.css": ".x{}" } }));
  });
  fake.listen(0);
  await once(fake, "listening");
  const dir = mkdtempSync(join(tmpdir(), "blocofy-pull-"));
  after(() => {
    fake.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const { count } = await pullTheme({
    dir,
    url: `http://localhost:${fake.address().port}`,
    token: "bcf_t",
  });
  assert.equal(count, 2);
  assert.equal(readFileSync(join(dir, "section", "Hero.liquid"), "utf8"), "H");
  assert.equal(readFileSync(join(dir, "asset", "theme.css"), "utf8"), ".x{}");
});

test("pushTheme: readLocalTemplates → POST {files} (stripped keys); returns result", async () => {
  let received = null;
  const fake = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      assert.equal(req.method, "POST");
      assert.equal(req.headers.authorization, "Bearer bcf_t");
      received = JSON.parse(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, created: 1, updated: 0, skippedDeletes: 2 }));
    });
  });
  fake.listen(0);
  await once(fake, "listening");
  const dir = mkdtempSync(join(tmpdir(), "blocofy-push-"));
  mkdirSync(join(dir, "section"), { recursive: true });
  writeFileSync(join(dir, "section", "Hero.liquid"), "H");
  after(() => {
    fake.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const result = await pushTheme({
    dir,
    url: `http://localhost:${fake.address().port}`,
    token: "bcf_t",
  });
  assert.deepEqual(result, { ok: true, created: 1, updated: 0, skippedDeletes: 2 });
  assert.equal(received.files["section/Hero"], "H"); // stripped key sent
});

test("pullTheme --instance → GET ?instance=<handle>", async () => {
  let seenUrl = null;
  const server = createServer((req, res) => {
    seenUrl = req.url;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ files: {} }));
  });
  server.listen(0);
  await once(server, "listening");
  try {
    const url = `http://localhost:${server.address().port}`;
    await pullTheme({ dir: mkdtempSync(join(tmpdir(), "p-")), url, token: "bcf_t", instance: "t7k2p9" });
    assert.match(seenUrl, /\/api\/dev\/theme\?instance=t7k2p9/);
  } finally {
    server.close();
  }
});

test("pushTheme --instance → POST body.instance", async () => {
  let body = null;
  const server = createServer((req, res) => {
    let b = "";
    req.on("data", (d) => (b += d));
    req.on("end", () => {
      body = JSON.parse(b || "{}");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, instanceId: "t7k2p9", created: 0, updated: 0 }));
    });
  });
  server.listen(0);
  await once(server, "listening");
  const dir = mkdtempSync(join(tmpdir(), "u-"));
  mkdirSync(join(dir, "layout"), { recursive: true });
  writeFileSync(join(dir, "layout", "theme.liquid"), "<html></html>");
  try {
    const url = `http://localhost:${server.address().port}`;
    await pushTheme({ dir, url, token: "bcf_t", instance: "t7k2p9" });
    assert.equal(body.instance, "t7k2p9");
  } finally {
    server.close();
  }
});

test("pushTheme --draft: sends body.draft true; returns draft result", async () => {
  let received = null;
  const fake = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      received = JSON.parse(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, draft: true, instanceId: 77, created: 2, updated: 0, skippedDeletes: 0 }));
    });
  });
  fake.listen(0);
  await once(fake, "listening");
  const dir = mkdtempSync(join(tmpdir(), "blocofy-draft-"));
  mkdirSync(join(dir, "section"), { recursive: true });
  writeFileSync(join(dir, "section", "Hero.liquid"), "H");
  after(() => {
    fake.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const result = await pushTheme({
    dir,
    url: `http://localhost:${fake.address().port}`,
    token: "bcf_t",
    draft: true,
  });
  assert.equal(received.draft, true);
  assert.equal(result.instanceId, 77);
});
