/**
 * `theme dev` kullanıcı-yönelik mesajları (saf → test edilebilir). Düzlem uyarısı:
 * CLI yalnız tema KODUNU taşır; editörde yapılan içerik/ayar bulutta yaşar.
 */

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
