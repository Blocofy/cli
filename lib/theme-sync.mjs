import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { localPathFor, readLocalTemplates } from "./local-theme.mjs";

/**
 * `blocofy theme pull/push`. Talks to the platform's `/api/dev/theme` endpoint
 * (Bearer token). pull = GET → write to disk (re-adding `.liquid`); push =
 * readLocalTemplates → POST (create/update; no delete).
 */

async function errorText(res) {
  const text = await res.text();
  try {
    return JSON.parse(text).error ?? text;
  } catch {
    return text;
  }
}

/** Download the live theme to disk. `{ path: content }` (stripped) → `.liquid` files. */
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

/** Write the local theme to the live site (create/update; no delete). */
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
