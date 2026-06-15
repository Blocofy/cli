import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

/**
 * `blocofy pages pull/push` + `settings pull/push` (#119). CLI'nın yerel içerik
 * dosyalarını (`pages/<slug>.json` + `config/settings.json`) platformun
 * `/api/dev/content` endpoint'iyle çeker/gönderir. Tema KODU `theme pull/push`'a
 * gider; bu yalnız içerik+ayar. Güvenlik platformda: push yalnız mevcut sayfayı
 * günceller, yeni oluşturmaz, silmez.
 */

async function errorText(res) {
  const text = await res.text();
  try {
    return JSON.parse(text).error ?? text;
  } catch {
    return text;
  }
}

/** scope "pages" → pages dizinindeki tüm .json (recursive); "settings" → config/settings.json. `{path: content}`. */
export function readContentFiles(dir, scope) {
  const out = {};
  if (scope === "settings") {
    const p = join(dir, "config", "settings.json");
    if (existsSync(p)) out["config/settings.json"] = readFileSync(p, "utf8");
    return out;
  }
  // pages
  const pagesDir = join(dir, "pages");
  if (!existsSync(pagesDir)) return out;
  const walk = (current) => {
    for (const name of readdirSync(current)) {
      const full = join(current, name);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!name.endsWith(".json")) continue;
      const key = "pages/" + relative(pagesDir, full).split(sep).join("/");
      out[key] = readFileSync(full, "utf8");
    }
  };
  walk(pagesDir);
  return out;
}

/** Yerel içeriği push'la. Yanıt: platform sonucu + gönderilen dosya sayısı. */
export async function pushContent({ dir, url, token, scope }) {
  const files = readContentFiles(dir, scope);
  const base = url.replace(/\/+$/, "");
  const res = await fetch(`${base}/api/dev/content`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ files }),
  });
  if (!res.ok) throw new Error(await errorText(res));
  return { ...(await res.json()), fileCount: Object.keys(files).length };
}

/** Site içeriğini diske çek (pull). scope "pages" | "settings" | "all". Yazılan dosya sayısı. */
export async function pullContent({ dir, url, token, scope }) {
  const base = url.replace(/\/+$/, "");
  const res = await fetch(`${base}/api/dev/content?scope=${encodeURIComponent(scope)}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(await errorText(res));
  const { files } = await res.json();
  let count = 0;
  for (const [path, content] of Object.entries(files ?? {})) {
    const full = join(dir, ...path.split("/"));
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, typeof content === "string" ? content : "");
    count += 1;
  }
  return { count };
}
