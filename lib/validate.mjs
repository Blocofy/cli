/**
 * Login girdisi doğrulama (saf → test edilebilir). URL şema yoksa https:// eklenir
 * (bare domain'e izin), sondaki `/` atılır; token `bcf_` ile başlamalı.
 */

export function normalizeUrl(raw) {
  let u = (raw || "").trim().replace(/\/+$/, "");
  if (u && !/^https?:\/\//i.test(u)) u = `https://${u}`;
  return u;
}

export function isValidUrl(u) {
  return /^https?:\/\/.+/i.test(u);
}

/** A theme dev token: `bcf_` (legacy) or `bcf2_` (profiled, ADR-0014 §3.2: needs CLI >= 0.16.0). */
export const DEV_TOKEN_PREFIXES = ["bcf_", "bcf2_"];

export function isValidToken(t) {
  return typeof t === "string" && DEV_TOKEN_PREFIXES.some((p) => t.startsWith(p)) && t.length >= 24;
}
