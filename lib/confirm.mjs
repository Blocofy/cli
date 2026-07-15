/**
 * Canlı `theme push` onay kararı (#431 L2). `theme push` (flag'siz) site'in CANLI
 * temasına ANINDA yazar (önizleme yok) — bir agent/CI kazara canlı temayı bozabilir.
 * Bu yüzden canlı push açık onay ister:
 *   - `--draft`  → onay gerekmez (zaten canlıya yazmaz, taslağa yazar).
 *   - `--yes` / `--confirm` → açık onay (CI/agent için).
 *   - interaktif TTY → y/N sorulur.
 *   - non-TTY (script/agent) + onay yok → ABORT (sessizce canlıya basılmaz).
 *
 * Saf karar (yan etkisiz, test edilebilir): { autoApproved, needsPrompt, mustAbort }.
 */
export function livePushDecision({ draft, yes, confirm, isTTY }) {
  if (draft || yes || confirm) return { autoApproved: true, needsPrompt: false, mustAbort: false };
  if (!isTTY) return { autoApproved: false, needsPrompt: false, mustAbort: true };
  return { autoApproved: false, needsPrompt: true, mustAbort: false };
}

/**
 * `theme push` hedefini seç (saf, yan etkisiz). Yeni varsayılan: DRAFT (güvenli).
 * `--live` eski "anında canlı" davranışını açıkça geri getirir.
 *   - `instance` verilmişse → { mode: "instance", instance } (açık-hedef; `--live`
 *     olsa bile instance KAZANIR — kullanıcı belirli bir temayı adresledi).
 *   - `--live` (instance yok) → { mode: "live" } (onay gerektiren tek yol).
 *   - aksi halde → { mode: "draft" } (varsayılan; açık `--draft` dahil).
 *   - `--live` + `--draft` birlikte → draft (güvenli olan kazanır).
 */
export function resolvePushMode({ live, draft, instance } = {}) {
  if (instance) return { mode: "instance", instance };
  if (draft) return { mode: "draft" };
  if (live) return { mode: "live" };
  return { mode: "draft" };
}

/** y/N yanıtını yorumla (yes/y → onay). */
export function isAffirmative(answer) {
  const a = String(answer ?? "").trim().toLowerCase();
  return a === "y" || a === "yes";
}
