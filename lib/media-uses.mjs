/**
 * v1 client for a page's localized-media decisions (D3, CLI 0.8.0):
 *   GET  /api/v1/pages/{id}/media-uses   (pages:read)   → PageMediaUsesView | PageMediaUsesNotApplicable
 *   POST /api/v1/pages/{id}/media-uses   (pages:write)  → DecidePageMediaUsesOutput
 *
 * Plan: multisite-cms docs/architecture/plans/2026-09-16-d3-page-media-use-public-surfaces.md §4.5–4.7.
 *
 * Authentication is a `blcf_live_…` API key (Bearer). The dev `bcf_…` token is NOT accepted for v1.
 *
 * NO RETRIES. A decision batch is applied atomically on the server but a lost response is only
 * safe to replay with the SAME idempotency keys, which is the caller's decision, not this
 * client's — so a 5xx/network failure surfaces once and the command exits 1. A 4xx is a server
 * REFUSAL (`CliRefusal`): the `{ error }` envelope is carried verbatim for the command to print
 * as JSON on stderr with exit code 2.
 */

export const API_KEY_PREFIX = "blcf_live_";
export const DEFAULT_API_URL = "https://app.blocofy.com";

/** v1 accepts ONLY a live API key. Never echo the key back in a message. */
export function isValidApiKey(key) {
  return typeof key === "string" && key.startsWith(API_KEY_PREFIX) && key.length > API_KEY_PREFIX.length;
}

/** A 4xx response from v1: `status` + the server's `error` object ({ code, message, details? }). */
export class CliRefusal extends Error {
  constructor(status, error) {
    super(`HTTP ${status} ${error?.code ?? ""}: ${error?.message ?? ""}`.trim());
    this.name = "CliRefusal";
    this.status = status;
    this.error = error;
  }
}

function mediaUsesUrl(apiUrl, page) {
  return `${String(apiUrl).replace(/\/+$/, "")}/api/v1/pages/${encodeURIComponent(page)}/media-uses`;
}

async function request(method, { apiUrl, apiKey, page }, body) {
  const headers = { authorization: `Bearer ${apiKey}`, accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(mediaUsesUrl(apiUrl, page), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (res.ok) {
    if (json === null) throw new Error(`HTTP ${res.status}: empty or non-JSON response`);
    return json;
  }
  if (res.status >= 400 && res.status < 500) {
    const error = json?.error && typeof json.error === "object" ? json.error : { code: `http_${res.status}`, message: text.slice(0, 200) || `HTTP ${res.status}` };
    throw new CliRefusal(res.status, error);
  }
  // 5xx (no retry) — the message never includes the request headers.
  const detail = json?.error?.message ?? (text ? text.slice(0, 200) : "");
  throw new Error(`HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
}

/** GET the page's media-use view (the newest draft's `revision{id,version}` is inside). */
export function fetchPageMediaUses({ apiUrl, apiKey, page }) {
  return request("GET", { apiUrl, apiKey, page });
}

/**
 * POST a decision batch. The body is exactly `{ expected_revision_id, expected_version, decisions }`
 * — items are sent as given (idempotency keys are the caller's responsibility).
 */
export function decidePageMediaUses({ apiUrl, apiKey, page, expectedRevisionId, expectedVersion, decisions }) {
  return request(
    "POST",
    { apiUrl, apiKey, page },
    { expected_revision_id: expectedRevisionId, expected_version: expectedVersion, decisions },
  );
}
