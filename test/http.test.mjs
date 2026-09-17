import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";

import { DEFAULT_BACKOFF_MS, MAX_RETRY_WAIT_MS, fetchWithRetry, parseRetryAfter } from "../lib/http.mjs";

/** CF-T3 (contract C4) — the one retry contract. Waits are recorded through an injected sleep (no real delay). */

function recorder() {
  const waits = [];
  const notices = [];
  return { waits, notices, sleep: async (ms) => waits.push(ms), onRetry: (i) => notices.push(i) };
}

/** Local server: `route(n, req, raw)` → { status, headers?, body? } | "reset". Records every request. */
async function fake(route) {
  const reqs = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    reqs.push({ method: req.method, url: req.url, headers: req.headers, body: raw });
    const out = route(reqs.length, req, raw);
    if (out === "reset") {
      req.socket.destroy();
      return;
    }
    res.writeHead(out.status, out.headers ?? {});
    res.end(out.body ?? "");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { url: `http://127.0.0.1:${server.address().port}/x`, reqs, close: () => new Promise((r) => server.close(r)) };
}

test("429 + Retry-After: 1 then 200 → one retry after exactly 1000 ms (injected clock)", async () => {
  const s = await fake((n) => (n === 1 ? { status: 429, headers: { "retry-after": "1" } } : { status: 200, body: "ok" }));
  const r = recorder();
  try {
    const res = await fetchWithRetry(s.url, {}, r);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "ok");
    assert.deepEqual(r.waits, [1000]);
    assert.deepEqual(r.notices.map((i) => [i.attempt, i.retries, i.reason, i.waitMs]), [[1, 3, "HTTP 429", 1000]]);
  } finally {
    await s.close();
  }
});

test("429 + Retry-After: 1 honoured in real time (bounded)", async () => {
  const s = await fake((n) => (n === 1 ? { status: 429, headers: { "retry-after": "1" } } : { status: 200 }));
  try {
    const t0 = Date.now();
    const res = await fetchWithRetry(s.url, {});
    const elapsed = Date.now() - t0;
    assert.equal(res.status, 200);
    assert.ok(elapsed >= 950 && elapsed < 5000, `waited ${elapsed} ms`);
  } finally {
    await s.close();
  }
});

test("503 then 200 → retried with the default first backoff (300 ms)", async () => {
  const s = await fake((n) => ({ status: n === 1 ? 503 : 200 }));
  const r = recorder();
  try {
    assert.equal((await fetchWithRetry(s.url, {}, r)).status, 200);
    assert.deepEqual(r.waits, [300]);
    assert.equal(s.reqs.length, 2);
  } finally {
    await s.close();
  }
});

test("502 and 504 are retried; 500, 501, 505 and 4xx are returned as-is (no retry)", async () => {
  for (const status of [502, 504]) {
    const s = await fake((n) => ({ status: n === 1 ? status : 200 }));
    const r = recorder();
    assert.equal((await fetchWithRetry(s.url, {}, r)).status, 200, `status ${status}`);
    assert.equal(s.reqs.length, 2);
    await s.close();
  }
  for (const status of [500, 501, 505, 400, 401, 404, 409, 422]) {
    const s = await fake(() => ({ status }));
    const r = recorder();
    assert.equal((await fetchWithRetry(s.url, {}, r)).status, status);
    assert.equal(s.reqs.length, 1, `status ${status} must not be retried`);
    assert.deepEqual(r.waits, []);
    await s.close();
  }
});

test("4 consecutive 503 → 4 attempts (3 retries, 300/900/2000 ms), the last response returned; identical key + body each time", async () => {
  const s = await fake(() => ({ status: 503 }));
  const r = recorder();
  const init = { method: "POST", headers: { "content-type": "application/json", "x-idempotency-key": "cli-k1" }, body: JSON.stringify({ a: 1 }) };
  try {
    const res = await fetchWithRetry(s.url, init, r);
    assert.equal(res.status, 503);
    assert.equal(s.reqs.length, 4);
    assert.deepEqual(r.waits, DEFAULT_BACKOFF_MS);
    assert.deepEqual(r.notices.map((i) => i.attempt), [1, 2, 3]);
    assert.ok(s.reqs.every((q) => q.method === "POST" && q.headers["x-idempotency-key"] === "cli-k1" && q.body === '{"a":1}'));
  } finally {
    await s.close();
  }
});

test("network reset then success → retried once (network error reason reported)", async () => {
  const s = await fake((n) => (n === 1 ? "reset" : { status: 200, body: "ok" }));
  const r = recorder();
  try {
    const res = await fetchWithRetry(s.url, { method: "POST", headers: { "x-idempotency-key": "k" }, body: "b" }, r);
    assert.equal(res.status, 200);
    assert.equal(s.reqs.length, 2);
    assert.equal(s.reqs[1].body, "b");
    assert.equal(r.notices.length, 1);
    assert.doesNotMatch(r.notices[0].reason, /^HTTP /);
  } finally {
    await s.close();
  }
});

test("persistent network error → throws after 4 attempts", async () => {
  let calls = 0;
  const r = recorder();
  await assert.rejects(
    fetchWithRetry("http://x", {}, { ...r, fetchImpl: async () => { calls += 1; throw new TypeError("fetch failed"); } }),
    /fetch failed/,
  );
  assert.equal(calls, 4);
  assert.deepEqual(r.waits, DEFAULT_BACKOFF_MS);
});

test("Retry-After as an HTTP-date is honoured relative to the injected clock; capped at 30 s", async () => {
  const now = Date.parse("2026-09-17T12:00:00Z");
  const s = await fake((n) => (n === 1 ? { status: 503, headers: { "retry-after": "Thu, 17 Sep 2026 12:00:05 GMT" } } : n === 2 ? { status: 429, headers: { "retry-after": "120" } } : { status: 200 }));
  const r = recorder();
  try {
    assert.equal((await fetchWithRetry(s.url, {}, { ...r, now: () => now })).status, 200);
    assert.deepEqual(r.waits, [5000, MAX_RETRY_WAIT_MS]);
  } finally {
    await s.close();
  }
});

test("parseRetryAfter: seconds, HTTP-date, past date → 0, garbage/absent → null (backoff used)", () => {
  const now = Date.parse("2026-09-17T12:00:00Z");
  assert.equal(parseRetryAfter("0", now), 0);
  assert.equal(parseRetryAfter("7", now), 7000);
  assert.equal(parseRetryAfter("3600", now), 30000);
  assert.equal(parseRetryAfter("Thu, 17 Sep 2026 12:00:02 GMT", now), 2000);
  assert.equal(parseRetryAfter("Thu, 17 Sep 2026 11:00:00 GMT", now), 0);
  assert.equal(parseRetryAfter("soon", now), null);
  assert.equal(parseRetryAfter("-1", now), null);
  assert.equal(parseRetryAfter(null, now), null);
});
