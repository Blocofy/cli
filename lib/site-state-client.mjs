import { CliRefusal } from "./media-uses.mjs";
import { fetchWithRetry } from "./http.mjs";

/**
 * CF-T4 — the v1 `site-state` HTTP client: `GET /api/v1/site-state`, `POST …/plan`, `…/apply`, `…/publish`,
 * and `POST /api/v1/media` (asset upload, reused for `awaiting_assets`). Bearer `blcf_live_…` API key —
 * same authentication and error-envelope shape as `lib/media-uses.mjs`, whose `CliRefusal` this reuses so
 * `bin/blocofy.mjs`'s exit-code mapping (`error instanceof CliRefusal` → 2) needs no second branch.
 *
 * Retries (CF-T3, `lib/http.mjs`): every one of these calls is safe to resend blindly.
 *   - export/plan are reads.
 *   - apply and publish are idempotent BY DESIGN (contract §A3): every step re-reads before writing and
 *     no-ops when the target already matches, and "publishing the same state twice rewrites nothing".
 *   - a media upload has no idempotency key in this contract; a duplicate upload after a connection reset
 *     is at worst a second file with the SAME bytes, which the next plan's sha256 match treats identically
 *     to the first (harmless, unlike creating a second logical record).
 * A 4xx is a server refusal (`CliRefusal`, exit 2 — see `bin/blocofy.mjs`'s `exitCodeFor`). A final
 * 5xx/network failure after retries throws a plain `Error` with `.status` (exit 1).
 */

export { CliRefusal };

function url(apiUrl, path) {
  return `${String(apiUrl).replace(/\/+$/, "")}${path}`;
}

/** A response → its JSON body, or the standard refusal/error thrown (shared by every call below). */
async function readJsonOrThrow(res) {
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
  const detail = json?.error?.message ?? (text ? text.slice(0, 200) : "");
  throw Object.assign(new Error(`HTTP ${res.status}${detail ? `: ${detail}` : ""}`), { status: res.status });
}

async function requestJson(method, target, { apiKey, onRetry = null, body }) {
  const headers = { authorization: `Bearer ${apiKey}`, accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetchWithRetry(target, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }, { onRetry });
  return readJsonOrThrow(res);
}

/** `GET /api/v1/site-state` → `{schema_version, manifest, files, assets, diagnostics}`. */
export function fetchSiteStateExport({ apiUrl, apiKey, onRetry = null }) {
  return requestJson("GET", url(apiUrl, "/api/v1/site-state"), { apiKey, onRetry });
}

/** `POST /api/v1/site-state/plan` → the plan (read-only; no side effects). */
export function planSiteState({ apiUrl, apiKey, body, onRetry = null }) {
  return requestJson("POST", url(apiUrl, "/api/v1/site-state/plan"), { apiKey, onRetry, body });
}

/** `POST /api/v1/site-state/apply` → `{status, plan_hash, applied, not_applied, report, theme_source}`. */
export function applySiteState({ apiUrl, apiKey, body, onRetry = null }) {
  return requestJson("POST", url(apiUrl, "/api/v1/site-state/apply"), { apiKey, onRetry, body });
}

/** `POST /api/v1/site-state/publish` → `{status:"published", plan_hash, target_instance, swapped, navigation, globals}`. */
export function publishSiteState({ apiUrl, apiKey, body, onRetry = null }) {
  return requestJson("POST", url(apiUrl, "/api/v1/site-state/publish"), { apiKey, onRetry, body });
}

/** `POST /api/v1/media` (multipart `file` field) → `{file: {...}}`. Used to satisfy `assets_missing`. */
export async function uploadMediaAsset({ apiUrl, apiKey, filename, content, mime = "application/octet-stream", onRetry = null }) {
  const form = new FormData();
  form.set("file", new Blob([content], { type: mime }), filename);
  const res = await fetchWithRetry(
    url(apiUrl, "/api/v1/media"),
    { method: "POST", headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" }, body: form },
    { onRetry },
  );
  return readJsonOrThrow(res);
}
