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

export function isValidToken(t) {
  return typeof t === "string" && t.startsWith("bcf_") && t.length >= 12;
}
