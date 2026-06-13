import { createServer } from "node:http";
import { existsSync, readFileSync, statSync, watch } from "node:fs";
import { join, normalize, sep } from "node:path";

import {
  LIVERELOAD_PATH,
  contentTypeFor,
  injectLivereload,
  readLocalTemplates,
} from "./local-theme.mjs";

/**
 * Standalone dev sunucusu (#119 Faz 3d). Her sayfa isteğinde local tema dosyalarını
 * okuyup platformun `/api/dev/render`'ına yollar, dönen HTML'e livereload script'i
 * enjekte eder. `fs.watch` ile dosya değişince SSE üzerinden tarayıcıyı yeniler.
 *
 * Asset'ler genelde `{% render 'asset/x.css' %}` ile HTML'e GÖMÜLÜ gelir (ayrı
 * istek yok); doğrudan `/asset/*` referansları için diskten statik servis edilir.
 * Görsel/JS uzak (Directus/CDN) → local servise gerek yok.
 */
export function startDevServer({ dir, url, token, port, onError }) {
  const base = url.replace(/\/+$/, "");
  const clients = new Set();

  async function renderPath(pathname) {
    const templates = readLocalTemplates(dir);
    const res = await fetch(`${base}/api/dev/render`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ path: pathname, templates }),
    });
    const text = await res.text();
    if (!res.ok) {
      let message = text;
      try {
        message = JSON.parse(text).error ?? text;
      } catch {
        /* ham metin */
      }
      return { status: res.status, html: errorHtml(res.status, message) };
    }
    try {
      return { status: 200, html: JSON.parse(text).html ?? "" };
    } catch {
      return { status: 200, html: text };
    }
  }

  const server = createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);

      // Livereload SSE kanalı.
      if (pathname === LIVERELOAD_PATH) {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
        });
        res.write("retry: 1000\n\n");
        clients.add(res);
        req.on("close", () => clients.delete(res));
        return;
      }

      // Doğrudan /asset/* referansı → diskten servis et (varsa).
      const assetFile = safeAssetFile(dir, pathname);
      if (assetFile) {
        res.writeHead(200, { "content-type": contentTypeFor(assetFile), "cache-control": "no-store" });
        res.end(readFileSync(assetFile));
        return;
      }

      // Sayfa → platforma render ettir.
      const { status, html } = await renderPath(pathname);
      res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(injectLivereload(html));
    } catch (err) {
      res.writeHead(502, { "content-type": "text/html; charset=utf-8" });
      res.end(injectLivereload(errorHtml(502, err?.message ?? String(err))));
    }
  });

  if (onError) server.on("error", onError);

  const watcher = startWatch(dir, () => {
    for (const client of clients) client.write("data: reload\n\n");
  });

  server.listen(port);

  return {
    server,
    close() {
      try {
        watcher?.close();
      } catch {
        /* yoksay */
      }
      for (const client of clients) client.end();
      server.close();
    },
  };
}

/**
 * `dir`'i izle; recursive desteklenmiyorsa (eski Node/Linux) recursive'siz dener.
 * Debounce'lu `onChange` çağırır. İzlenemezse null (livereload pasif).
 */
function startWatch(dir, onChange) {
  let timer = null;
  const fire = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(onChange, 120);
  };
  try {
    return watch(dir, { recursive: true }, fire);
  } catch {
    try {
      return watch(dir, fire);
    } catch {
      return null;
    }
  }
}

/** `/asset/*` yolunu disk dosyasına eşle (path-traversal korumalı); yoksa null. */
function safeAssetFile(dir, pathname) {
  if (!pathname.startsWith("/asset/")) return null;
  const root = normalize(dir);
  const full = normalize(join(dir, pathname.replace(/^\/+/, "")));
  if (full !== root && !full.startsWith(root + sep)) return null;
  try {
    if (existsSync(full) && statSync(full).isFile()) return full;
  } catch {
    /* yoksay */
  }
  return null;
}

function escapeHtml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function errorHtml(status, message) {
  return (
    `<!doctype html><html lang="tr"><head><meta charset="utf-8">` +
    `<title>blocofy dev — ${status}</title></head>` +
    `<body style="font-family:system-ui,sans-serif;padding:2rem;max-width:48rem;margin:0 auto">` +
    `<h1 style="color:#b91c1c">Render hatası (${status})</h1>` +
    `<pre style="white-space:pre-wrap;background:#f4f4f5;padding:1rem;border-radius:.5rem;color:#333">${escapeHtml(message)}</pre>` +
    `<p style="color:#666">Tema dosyasını düzelt — kaydedince bu sayfa otomatik yenilenir.</p>` +
    `</body></html>`
  );
}
