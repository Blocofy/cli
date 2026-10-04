import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { fetchWithRetry } from "./http.mjs";
import { CliRefusal } from "./media-uses.mjs";

/**
 * Theme work sessions ("çalışma") — the v1 client and the project's saved work handle.
 *
 *   POST /api/v1/theme-work                     (themes:write, Idempotency-Key required) → 201 { work } | 200 { work, replayed }
 *   GET  /api/v1/theme-work/{handle}            (themes:read)                            → { work }
 *   POST /api/v1/theme-work/{handle}/resume     (themes:read, { require_fresh? })         → { work }
 *   POST /api/v1/theme-work/{handle}/cancel     (themes:write, { expected_state_version }) → { work }
 *
 * Authentication is the v1 API key (`blcf_live_…`, Bearer) — the same pair `site plan` and `pages media-uses` use.
 * The dev token (`bcf_…`) has no theme-work endpoint: the work is bound to the credential that started it (here the
 * API key), and only that credential (or the site owner, from the panel) can continue it.
 *
 * A work is always named by its exact handle (`wk_…`), never "the latest". The project remembers the handle it
 * started or resumed last in `.blocofy/local.json` (git-ignored, per user, no secret: the handle alone grants nothing)
 * so the CLI can name it in hints; every command still takes the handle explicitly.
 *
 * Retries (lib/http.mjs: network errors, 429/502/503/504): the start carries the Idempotency-Key, so a resend returns
 * the SAME work (`replayed`), never a second one; get and resume are reads; cancel is a compare-and-set on
 * `state_version` (a resend after a lost answer meets `work_state_conflict` with the work already cancelled).
 */

export const WORK_HANDLE_RE = /^wk_[a-z2-7]{26}$/;
export const WORK_KEY_RE = /^[A-Za-z0-9._:-]{8,120}$/;
export const WORK_INTENT_MAX = 120;
export const DEFAULT_WORK_INTENT = "CLI ile tema çalışması";

export const isWorkHandle = (v) => typeof v === "string" && WORK_HANDLE_RE.test(v);
export const newWorkKey = () => `cli-work-${randomUUID()}`;

const base = (apiUrl) => String(apiUrl).replace(/\/+$/, "");

async function readJsonOrThrow(res) {
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (res.ok) {
    if (json === null || typeof json !== "object") throw new Error(`HTTP ${res.status}: empty or non-JSON response`);
    return json;
  }
  if (res.status >= 400 && res.status < 500) {
    const error = json?.error && typeof json.error === "object" ? json.error : { code: `http_${res.status}`, message: text.slice(0, 200) || `HTTP ${res.status}` };
    throw new CliRefusal(res.status, error);
  }
  const detail = json?.error?.message ?? (text ? text.slice(0, 200) : "");
  const code = typeof json?.error?.code === "string" ? json.error.code : undefined;
  throw Object.assign(new Error(`HTTP ${res.status}${detail ? `: ${detail}` : ""}`), {
    status: res.status,
    ...(code ? { code, error: json.error } : {}),
    retryAfter: res.headers.get("retry-after"),
  });
}

async function request(method, url, { apiKey, body, headers = {}, onRetry = null }) {
  const h = { authorization: `Bearer ${apiKey}`, accept: "application/json", ...headers };
  if (body !== undefined) h["content-type"] = "application/json";
  const res = await fetchWithRetry(url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }, { onRetry });
  return readJsonOrThrow(res);
}

const workUrl = (apiUrl, handle, tail = "") => `${base(apiUrl)}/api/v1/theme-work/${encodeURIComponent(handle)}${tail}`;

/** Start a work from the site's CURRENT live theme. The same key again returns the same work (`replayed: true`). */
export function startWork({ apiUrl, apiKey, intent, idempotencyKey, onRetry = null }) {
  return request("POST", `${base(apiUrl)}/api/v1/theme-work`, { apiKey, body: { intent }, headers: { "idempotency-key": idempotencyKey }, onRetry });
}

export function getWork({ apiUrl, apiKey, handle, onRetry = null }) {
  return request("GET", workUrl(apiUrl, handle), { apiKey, onRetry });
}

export function resumeWork({ apiUrl, apiKey, handle, requireFresh = false, onRetry = null }) {
  return request("POST", workUrl(apiUrl, handle, "/resume"), { apiKey, body: requireFresh ? { require_fresh: true } : {}, onRetry });
}

export function cancelWork({ apiUrl, apiKey, handle, expectedStateVersion, onRetry = null }) {
  return request("POST", workUrl(apiUrl, handle, "/cancel"), { apiKey, body: { expected_state_version: expectedStateVersion }, onRetry });
}

// ── messages ────────────────────────────────────────────────────────────────────────────────────────────────

const STATE_LABEL = {
  open: "açık (üzerinde çalışılabilir)",
  sealed: "incelemede (şu an değiştirilemez)",
  publishing: "yayınlanıyor",
  published: "yayınlandı",
  cancelled: "iptal edildi",
  archived: "arşivlendi",
  failed: "kapandı",
};
export const stateLabel = (state) => STATE_LABEL[state] ?? String(state ?? "?");

const STALE_LABEL = {
  live_theme_changed: "canlı tema değişti",
  theme_version_changed: "temanın sürümü değişti",
  live_source_advanced: "canlı temanın dosyaları değişti",
  live_settings_changed: "canlı temanın ayarları değişti",
};
export const staleLabel = (reason) => STALE_LABEL[reason] ?? String(reason);

/** The stale note (plain Turkish), or null when the work is up to date / unknown. */
export function staleLines(work) {
  if (work?.stale !== true) return null;
  const reasons = Array.isArray(work.stale_reasons) && work.stale_reasons.length ? ` (${work.stale_reasons.map(staleLabel).join(", ")})` : "";
  return [
    `Not: Site bu çalışma başladıktan sonra değişti${reasons}. Çalışman güncel değil; hiçbir şeyin üzerine yazılmadı.`,
    "  Yayına almadan önce çalışmanın güncellenmesi gerekecek; değişiklikleri panelde gözden geçir.",
  ];
}

/** Human summary of a work (stdout). */
export function workLines(work) {
  const lines = [
    `Çalışma: ${work.id}${work.intent ? ` — ${work.intent}` : ""}`,
    `  Durum:  ${stateLabel(work.state)} (state_version ${work.state_version})`,
    `  Tema:   ${work.theme ?? "(silinmiş)"}${work.sandbox ? " · yapay zekâ taslağı" : ""}`,
  ];
  if (work.base?.theme) lines.push(`  Başlangıç: canlı tema ${work.base.theme}${work.base.theme_version ? ` (sürüm ${work.base.theme_version})` : ""}`);
  return lines;
}

const NOTHING = "Hiçbir şey yazılmadı.";

/**
 * A theme-work refusal in words: `{ lines, message, details }` — `lines` the plain Turkish explanation (stderr, human
 * mode; first line non-technical), `message`/`details` the technical `error [code]` line and `--json` envelope.
 * `op`: "start" | "status" | "resume" | "cancel" | "push". Returns null for a code it does not know (the caller prints
 * the server's own envelope then).
 */
export function themeWorkRefusal(error, { op = "status", handle = null, startCommand = "blocofy theme work start" } = {}) {
  const e = error instanceof CliRefusal ? error.error ?? {} : error ?? {};
  const code = typeof e.code === "string" ? e.code : error?.code;
  const details = e.details && typeof e.details === "object" ? e.details : {};
  const serverMessage = typeof e.message === "string" ? e.message : "";
  const name = handle ? ` ${handle}` : "";
  const out = (lines, message) => ({ lines, message: serverMessage ? `${message} (${serverMessage})` : message, details });
  switch (code) {
    case "not_found":
      if (op === "start") {
        return out(["Bu platform tema çalışmalarını henüz desteklemiyor. " + NOTHING], "This platform has no theme work endpoint yet (404 on POST /api/v1/theme-work).");
      }
      if (details.reason === "target_deleted") {
        return out([`Çalışmanın${name} teması silinmiş; bu çalışmaya devam edilemez. ${NOTHING}`, `  Yeni bir çalışma başlat:  ${startCommand}`], "The work's theme was deleted (not_found, target_deleted).");
      }
      return out([`Çalışma bulunamadı${handle ? `: ${handle}` : ""}. Tanıtıcıyı (wk_…) kontrol et. ${NOTHING}`], "No such work on this site (not_found).");
    case "work_forbidden":
      return details.reason === "revoked"
        ? out([`Bu bağlantının çalışmaya erişimi iptal edilmiş. ${NOTHING}`, "  Çalışmaya panelden devam edebilir ya da yeni bir çalışma başlatabilirsin."], "This credential's access to the work was revoked (work_forbidden).")
        : out([`Bu çalışma başka bir bağlantıya ait (başka bir API anahtarı ya da yapay zekâ bağlantısı başlatmış). ${NOTHING}`, "  Kendi çalışmanı başlat ya da çalışmaya panelden devam et."], "The work belongs to another credential (work_forbidden).");
    case "work_state_conflict": {
      const now = typeof details.state === "string" ? ` Şu anki durumu: ${stateLabel(details.state)}.` : "";
      return out([`Çalışma bu işlem için uygun durumda değil ya da bu sırada değişti.${now} ${NOTHING}`, `  Güncel durumu gör:  blocofy theme work status${name}`], "The work is not in a state that allows this, or it changed meanwhile (work_state_conflict).");
    }
    case "work_stale":
      return out([`Site bu çalışma başladıktan sonra değişti; çalışma güncel değil. ${NOTHING}`, "  Hiçbir şeyin üzerine yazılmadı. Değişiklikleri panelde gözden geçir ya da yeni bir çalışma başlat."], "The live site changed since the work started (work_stale).");
    case "work_sealed":
      return out([`Çalışma incelemeye gönderildi; içeriği şu an değiştirilemez. ${NOTHING}`], "The work is sealed for review (work_sealed).");
    case "work_base_unavailable":
      return out([`Sitenin yayında bir teması yok; çalışma başlatılamadı. ${NOTHING}`, "  Önce panelden bir temayı yayına al."], "The site has no live theme to start from (work_base_unavailable).");
    case "quota_exceeded":
      return out([`Tema alanı bu çalışma için yetmiyor; çalışma başlatılamadı. ${NOTHING}`, "  Açık bir çalışmayı bitir ya da iptal et, veya planını yükselt: admin paneli → Ayarlar → Plan & faturalandırma."], "The plan's theme space cannot hold this work (quota_exceeded).");
    case "capacity_unavailable":
    case "resource_busy":
      return out([`${code === "resource_busy" ? "Site şu anda meşgul (başka bir yazım sürüyor)" : "Platform şu an alanı doğrulayamadı"}; işlem yapılamadı. ${NOTHING}`, "  Biraz sonra aynı komutu tekrar çalıştır."], `Transient refusal (${code}); try again later.`);
    case "idempotency_key_reuse":
      return out([`Bu işlem anahtarı daha önce başka bir istekle kullanılmış. ${NOTHING}`, "  Yeni bir anahtarla dene ya da --idempotency-key vermeden çalıştır (her başlatma yeni anahtar üretir)."], "The idempotency key was used with another request (idempotency_key_reuse).");
    case "idempotency_key_invalid":
    case "idempotency_key_required":
      return out([`İşlem anahtarı geçersiz (8-120 karakter: harf, rakam, . _ : -). ${NOTHING}`], `The idempotency key is ${code === "idempotency_key_required" ? "missing" : "malformed"} (${code}).`);
    case "validation_failed":
      return out([`İstek geçersiz${op === "start" ? " (çalışma açıklaması 1-120 karakter olmalı)" : ""}. ${NOTHING}`], "The request was refused as invalid (validation_failed).");
    case "forbidden_scope":
      return out([`API anahtarının bu işlem için yetkisi yok (${op === "status" || op === "resume" ? "themes:read" : "themes:write"} gerekir). ${NOTHING}`, "  Panelde Ayarlar → API anahtarları'ndan uygun yetkili bir anahtar oluştur."], "The API key lacks the scope for this operation (forbidden_scope).");
    case "invalid_key":
    case "key_expired":
      return out([`API anahtarı geçersiz ya da süresi dolmuş. ${NOTHING}`, "  Yeniden giriş yap:  blocofy login --api-key"], `The API key was refused (${code}).`);
    default:
      return null;
  }
}

// ── the project's saved work (.blocofy/local.json, git-ignored) ─────────────────────────────────────────────

const localPath = (root) => join(root, ".blocofy", "local.json");

function readLocal(root) {
  const p = localPath(root);
  if (!existsSync(p)) return {};
  try {
    const v = JSON.parse(readFileSync(p, "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/** The work this project saved, when it belongs to the project's bound site: `{ handle, theme, intent }` | null. */
export function readSavedWork(binding) {
  if (!binding?.root) return null;
  const w = readLocal(binding.root).theme_work;
  if (!w || typeof w !== "object" || !isWorkHandle(w.handle)) return null;
  if (w.site_id != null && String(w.site_id) !== String(binding.project?.site_id)) return null;
  return { handle: w.handle, theme: typeof w.theme === "string" ? w.theme : null, intent: typeof w.intent === "string" ? w.intent : null };
}

/**
 * Save (or, with `work: null`, forget) the project's work in `.blocofy/local.json`, keeping every other key (the
 * context choice). Same rules as the binding writer: never through a symlink, a temp file renamed into place.
 */
export function saveWork(binding, work) {
  if (!binding?.root) return false;
  const dir = join(binding.root, ".blocofy");
  const p = localPath(binding.root);
  for (const path of [dir, p]) {
    let st = null;
    try {
      st = lstatSync(path);
    } catch {
      st = null;
    }
    if (st?.isSymbolicLink()) return false;
  }
  if (!existsSync(dir)) return false;
  const local = readLocal(binding.root);
  if (work) {
    local.theme_work = { handle: work.id, theme: work.theme ?? null, intent: work.intent ?? null, site_id: binding.project?.site_id ?? null, saved_at: new Date().toISOString() };
  } else {
    delete local.theme_work;
  }
  const tmp = join(dir, `.local.json.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    writeFileSync(tmp, JSON.stringify(local, null, 2) + "\n", { flag: "wx", mode: 0o644 });
    renameSync(tmp, p);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
  return true;
}
