import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { localPathFor, readLocalTemplates } from "./local-theme.mjs";

/**
 * `blocofy theme pull/push` (#119 Faz 3e). Platformun `/api/dev/theme` endpoint'iyle
 * konuşur (token Bearer). pull = GET → diske yaz (.liquid re-map); push = readLocalTemplates
 * → POST (create/update; v1 silme yok).
 */

async function errorText(res) {
  const text = await res.text();
  try {
    return JSON.parse(text).error ?? text;
  } catch {
    return text;
  }
}

/** Canlı temayı diske indir. `{path: content}` (stripped) → `.liquid`'li disk dosyaları. */
export async function pullTheme({ dir, url, token }) {
  const base = url.replace(/\/+$/, "");
  const res = await fetch(`${base}/api/dev/theme`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(await errorText(res));
  const { files } = await res.json();
  let count = 0;
  for (const [key, content] of Object.entries(files ?? {})) {
    const full = join(dir, localPathFor(key));
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, typeof content === "string" ? content : "");
    count += 1;
  }
  return { count };
}

/** Local temayı canlı siteye yaz (create/update; v1 silme yok). */
export async function pushTheme({ dir, url, token }) {
  const base = url.replace(/\/+$/, "");
  const files = readLocalTemplates(dir);
  const res = await fetch(`${base}/api/dev/theme`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ files }),
  });
  if (!res.ok) throw new Error(await errorText(res));
  return res.json();
}
