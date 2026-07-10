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

/** Backoff delays (ms) between attempts — index 0 = after the first failure. */
const RETRY_BACKOFF_MS = [300, 900];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * fetch wrapper that retries ONLY on transient failures: a thrown fetch (network
 * error / connection reset) or a 5xx / 429 response. Permanent 4xx (401/403/422 …)
 * fail immediately — no retry. Max 2 retries with a short backoff (300ms, 900ms).
 *
 * Safe because every endpoint here is idempotent: theme push is a file upsert
 * (create/update, no delete), pull/whoami/session/site are reads, publish sets a
 * pointer. Re-sending the same request cannot double-apply anything.
 *
 * `onRetry({ attempt, retries, reason })` is called before each wait so callers can
 * surface a "Network error, retrying…" line (not silent).
 */
export async function fetchWithRetry(input, init, { retries = 2, onRetry, backoff = RETRY_BACKOFF_MS } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    let res;
    try {
      res = await fetch(input, init);
    } catch (err) {
      // Thrown fetch = network-level failure (DNS, reset, "fetch failed"). Transient.
      lastErr = err;
      if (attempt === retries) throw err;
      onRetry?.({ attempt: attempt + 1, retries, reason: err?.message ?? String(err) });
      await sleep(backoff[attempt] ?? 0);
      continue;
    }
    // 5xx / 429 = transient server-side; retry. Other statuses (incl. 4xx) return as-is.
    if ((res.status >= 500 || res.status === 429) && attempt < retries) {
      onRetry?.({ attempt: attempt + 1, retries, reason: `HTTP ${res.status}` });
      await sleep(backoff[attempt] ?? 0);
      continue;
    }
    return res;
  }
  // Unreachable (loop returns or throws), but keeps the type honest.
  throw lastErr;
}

/**
 * Download a theme to disk. `{ path: content }` (stripped) → `.liquid` files.
 * With `draft`, pulls the "CLI Draft" instance (what `theme dev` syncs into)
 * instead of the live theme — symmetric with `push --draft`.
 */
export async function pullTheme({ dir, url, token, draft = false, instance = null }) {
  const base = url.replace(/\/+$/, "");
  const query = instance ? `?instance=${encodeURIComponent(instance)}` : draft ? "?draft=1" : "";
  const res = await fetch(`${base}/api/dev/theme${query}`, {
    headers: { authorization: `Bearer ${token}` },
  });
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

/**
 * Token'ın GERÇEK site'ını çözer (`GET /api/dev/whoami`). Site sunucuda TOKEN'dan
 * çözülür — login URL'i kozmetik. CLI bunu `login`'de (doğrula+göster) ve `push`
 * öncesi (hedef tenant'ı yaz) çağırır; yanlış-tenant'a yazımı görünür kılar.
 * `{ site: { id, slug, name }, liveThemeId }`.
 */
export async function fetchWhoami({ url, token }) {
  const base = url.replace(/\/+$/, "");
  const res = await fetch(`${base}/api/dev/whoami`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(await errorText(res));
  return res.json();
}

/**
 * Dev session bilgisi (#119 `theme dev`): platform draft instance'ı hazırlar ve
 * 3 görünümün URL'lerini döner — `{ draftInstanceId, previewUrl, editorUrl, site }`.
 */
export async function fetchDevSession({ url, token }) {
  const base = url.replace(/\/+$/, "");
  const res = await fetch(`${base}/api/dev/session`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(await errorText(res));
  return res.json();
}

/**
 * Write the local theme to the site (create/update; no delete). With `draft`,
 * writes to a draft theme instance instead of the live theme — preview & publish
 * it from the admin panel without affecting the live site.
 */
export async function pushTheme({ dir, url, token, draft = false, instance = null, onRetry = null }) {
  const base = url.replace(/\/+$/, "");
  const files = readLocalTemplates(dir);
  const payload = instance ? { files, instance } : { files, draft };
  const res = await fetchWithRetry(
    `${base}/api/dev/theme`,
    {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
    },
    { onRetry },
  );
  if (!res.ok) throw new Error(await errorText(res));
  return res.json();
}

/**
 * Bir taslak tema instance'ını CANLIYA al (`POST /api/dev/publish`). Sunucu guard'ı
 * içi-sayfasız bir instance'ı reddeder ya da canlının sayfalarını klonlar (#431) —
 * yayın sonrası site asla 404'e düşmez. `{ ok, published, cloned }` döner.
 */
export async function publishInstance({ url, token, instanceId }) {
  const base = url.replace(/\/+$/, "");
  const res = await fetch(`${base}/api/dev/publish`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ instanceId }),
  });
  if (!res.ok) throw new Error(await errorText(res));
  return res.json();
}

/**
 * Site sağlık/durum özeti (`GET /api/dev/site`) — `blocofy status`. Canlı tema instance'ı,
 * instance-başına sayfa dağılımı, taslaklar ve health döner.
 */
export async function fetchSiteStatus({ url, token }) {
  const base = url.replace(/\/+$/, "");
  const res = await fetch(`${base}/api/dev/site`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(await errorText(res));
  return res.json();
}
