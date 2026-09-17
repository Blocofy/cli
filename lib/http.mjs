/**
 * CF-T3 (contract C4, CLI half) — the ONE retry policy for every CLI request that is safe to resend.
 *
 * Retried: a thrown fetch (network error, connection reset, per-attempt timeout) and HTTP 429 / 502 / 503 / 504.
 * NOT retried: 500 and every other status (a 500 may mean the server applied part of the work; a 4xx is a refusal).
 * At most 3 retries (4 attempts). Wait before retry n: the response's `Retry-After` (delta-seconds or HTTP-date,
 * capped at 30 s) when present, else 300 ms / 900 ms / 2000 ms. The SAME request is resent: the caller's `init`
 * (method, headers incl. `x-idempotency-key`, body string) is reused unchanged, so a replay converges on the
 * server's idempotency handling instead of applying a second, different mutation.
 *
 * Callers only route requests here that are safe to replay: reads, upserts, pointer sets, and mutations carrying
 * an idempotency key. `onRetry({ attempt, retries, reason, waitMs })` fires before every wait (never silent).
 */

export const RETRY_STATUSES = new Set([429, 502, 503, 504]);
export const DEFAULT_RETRIES = 3;
export const DEFAULT_BACKOFF_MS = [300, 900, 2000];
export const MAX_RETRY_WAIT_MS = 30000;

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** `Retry-After` → milliseconds (capped), or null when absent/unparseable. */
export function parseRetryAfter(value, nowMs = Date.now()) {
  if (typeof value !== "string" || value.trim() === "") return null;
  const v = value.trim();
  let ms;
  if (/^\d+$/.test(v)) ms = Number(v) * 1000;
  else if (/[A-Za-z]/.test(v)) {
    const at = Date.parse(v);
    if (Number.isNaN(at)) return null;
    ms = at - nowMs;
  } else return null;
  return Math.min(Math.max(ms, 0), MAX_RETRY_WAIT_MS);
}

/**
 * `fetch` with the retry contract above. Options: `retries`, `backoff` (ms per retry index), `onRetry`,
 * `fetchImpl` (default: the global fetch at call time), `sleep(ms)`, `now()`, `timeoutMs` (per attempt).
 */
export async function fetchWithRetry(input, init = {}, { retries = DEFAULT_RETRIES, backoff = DEFAULT_BACKOFF_MS, onRetry, fetchImpl, sleep = realSleep, now = Date.now, timeoutMs } = {}) {
  const doFetch = fetchImpl ?? globalThis.fetch;
  for (let attempt = 0; ; attempt += 1) {
    const attemptInit = timeoutMs ? { ...init, signal: AbortSignal.timeout(timeoutMs) } : init;
    let res;
    try {
      res = await doFetch(input, attemptInit);
    } catch (error) {
      if (attempt >= retries) throw error;
      const waitMs = backoff[attempt] ?? backoff[backoff.length - 1] ?? 0;
      onRetry?.({ attempt: attempt + 1, retries, reason: error?.name === "TimeoutError" ? "timeout" : error?.message ?? String(error), waitMs });
      await sleep(waitMs);
      continue;
    }
    if (!RETRY_STATUSES.has(res.status) || attempt >= retries) return res;
    const waitMs = parseRetryAfter(res.headers.get("retry-after"), now()) ?? backoff[attempt] ?? backoff[backoff.length - 1] ?? 0;
    await res.arrayBuffer().catch(() => {}); // release the connection before resending
    onRetry?.({ attempt: attempt + 1, retries, reason: `HTTP ${res.status}`, waitMs });
    await sleep(waitMs);
  }
}
