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

/** y/N yanıtını yorumla (yes/y → onay). */
export function isAffirmative(answer) {
  const a = String(answer ?? "").trim().toLowerCase();
  return a === "y" || a === "yes";
}
