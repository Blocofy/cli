/**
 * `theme dev` kullanıcı-yönelik mesajları (saf → test edilebilir). Düzlem uyarısı:
 * CLI yalnız tema KODUNU taşır; editörde yapılan içerik/ayar bulutta yaşar.
 */

import { THEME_DIRS } from "./local-theme.mjs";

/**
 * Senkron kapsamı (#119 CLI bulgu #2) — geliştiriciye AÇIKÇA hangi dizinlerin
 * platforma taşındığını (tema kodu) ve hangilerinin taşınMADIĞINI (editör/bulut
 * içeriği) söyler; "config/pages senkronlanıyor sandım" kafa karışıklığını önler.
 * 2 satırlık dizi döner (saf → test edilebilir).
 */
export function syncScopeNote() {
  const synced = [...THEME_DIRS].sort().map((d) => `${d}/`).join(" ");
  return [
    `Synced (theme code):  ${synced} config/settings_schema.json`,
    `Not synced (cloud):   pages/ (other config/ files) — edit these in the admin editor`,
  ];
}

/**
 * Kalıcı durum satırı (#119 CLI bulgu #3) — yerel dosyaların hangi taslak temaya
 * gittiğini ve canlı temanın hangi instance olduğunu gösterir. Oturum yoksa null
 * (local-only mod). `liveThemeId` yoksa "(none)".
 */
export function statusLine(session) {
  if (!session) return null;
  const draft = session.draftInstanceId != null ? session.draftInstanceId : "—";
  const live = session.liveThemeId != null ? session.liveThemeId : "(none)";
  return `Local files → Draft theme ${draft}    ·    Live theme → ${live}`;
}

/**
 * Geçici ağ hatasında yeniden-deneme bildirimi (saf → test edilebilir). `push`
 * (ve `theme dev` taslak senkronu) sessizce retry ETMESİN; stderr'e kısa bir satır
 * yazılır. `onRetry({ attempt, retries, reason })` payload'ından string üretir.
 */
export function retryNotice({ attempt, retries, reason, waitMs }) {
  const why = reason ? ` (${reason})` : "";
  const what = typeof reason === "string" && reason.startsWith("HTTP ") ? "Server temporarily unavailable" : "Network error";
  const wait = Number.isFinite(waitMs) ? ` in ${Math.round(waitMs / 100) / 10}s` : "";
  return `${what}${why} — retrying${wait} (${attempt}/${retries})…`;
}

/**
 * Dev oturumuna göre "düzlem" uyarısı döndürür (string), oturum yoksa null.
 * - GitHub bağlı → repo@branch + `git pull` ipucu.
 * - Bağlı değil → içerik/ayar bulutta kalır + repo bağla ipucu.
 * - Eski platform (githubConnected undefined) → ipuçsuz nötr uyarı.
 */
export function githubNote(session) {
  if (!session) return null;
  if (session.githubConnected === true) {
    return `GitHub: ${session.githubRepo}@${session.githubBranch} — editor edits auto-commit there; run 'git pull' to sync them here.`;
  }
  return (
    "Content & settings edited in the admin editor stay server-side — they won't appear in these local files." +
    (session.githubConnected === false ? " Connect a GitHub repo for two-way sync." : "")
  );
}

/**
 * CF-T9 — `blocofy status` health advice (pure). Never an imperative one-line fix: making another theme live
 * replaces what every visitor sees, so the advice names the themes involved, the missing pages, why it happens,
 * and SAFE next steps (preview first); `theme publish` is only mentioned as a separate, deliberate decision.
 * Returns stderr lines ([] when healthy). Tolerates older servers without pages_by_instance/orphan_missing_slugs.
 */
export function healthAdvice(s) {
  if (!s || (s.health !== "pages_split" && s.health !== "live_instance_empty")) return [];
  const liveId = s.live_theme_instance?.id ?? null;
  const names = new Map((Array.isArray(s.drafts) ? s.drafts : []).map((d) => [String(d.id), d.name]));
  const holders = (Array.isArray(s.pages_by_instance) ? s.pages_by_instance : [])
    .filter((p) => p && p.theme_instance != null && String(p.theme_instance) !== String(liveId) && p.count > 0)
    .map((p) => ({ id: p.theme_instance, name: names.get(String(p.theme_instance)) ?? null, count: p.count }));
  const label = (h) => `${h.id}${h.name ? ` "${h.name}"` : ""} (${h.count} published page${h.count === 1 ? "" : "s"})`;
  const missing = Array.isArray(s.orphan_missing_slugs) ? s.orphan_missing_slugs : [];
  const handle = holders.length === 1 ? String(holders[0].id) : "<handle>";

  const out = [];
  if (s.health === "live_instance_empty") {
    out.push("  ⚠ The live theme has no published pages, so visitors get \"page not found\".");
  } else {
    out.push(`  ⚠ ${missing.length || s.orphaned_pages || "Some"} published page(s) cannot be reached by visitors.`);
    if (missing.length) out.push(`    Missing on the live theme: ${missing.join(", ")}`);
  }
  if (holders.length) {
    out.push(`    Published pages are held by ${holders.length === 1 ? "a theme that is" : "themes that are"} not live: ${holders.map(label).join(", ")}`);
  } else {
    out.push("    Published pages are held by a theme that is not live (this server does not say which; see the panel's theme library).");
  }
  out.push("    Why: pages belong to a theme. Pages published on a theme that is not live are not shown on the site.");
  out.push("    Safe next steps:");
  out.push(`      1. Preview that theme without changing the site:  blocofy theme pull <empty-dir> --instance ${handle}`);
  out.push("         or in the panel: Theme → Theme library → \"Open in editor\".");
  out.push("      2. Then decide: recreate the missing pages on the live theme, or make that theme live.");
  out.push(`    Note: \`blocofy theme publish --instance ${handle}\` REPLACES the live theme for every visitor — a separate, deliberate decision.`);
  return out;
}
