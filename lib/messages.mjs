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
    `Synced (theme code):  ${synced}`,
    `Not synced (cloud):   config/ pages/ — edit these in the admin editor`,
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
