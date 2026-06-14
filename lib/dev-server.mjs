import { createServer } from "node:http";
import { existsSync, readFileSync, statSync, watch } from "node:fs";
import { join, normalize, sep } from "node:path";

import {
  LIVERELOAD_PATH,
  contentTypeFor,
  injectLivereload,
  readLocalTemplates,
} from "./local-theme.mjs";
import { pushTheme } from "./theme-sync.mjs";

/**
 * Standalone dev server. For each page request it reads the local theme files and
 * posts them to the platform's `/api/dev/render` endpoint, then injects a livereload
 * script into the returned HTML. `fs.watch` reloads the browser over SSE on change.
 *
 * Assets are usually inlined into the HTML via `{% render 'asset/x.css' %}` (no
 * separate request); direct `/asset/*` references are served from disk. Images/JS
 * are remote (Directus/CDN), so no local serving is needed for them.
 */
export function startDevServer({ dir, url, token, port, syncDraft = false, onError }) {
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
        /* raw text */
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

      // Livereload SSE channel.
      if (pathname === LIVERELOAD_PATH) {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          // Cross-origin iframe'ler (canlı-domain önizleme + editör) subscribe edebilsin.
          "access-control-allow-origin": "*",
        });
        res.write("retry: 1000\n\n");
        clients.add(res);
        req.on("close", () => clients.delete(res));
        return;
      }

      // Direct /asset/* reference → serve from disk (if present).
      const assetFile = safeAssetFile(dir, pathname);
      if (assetFile) {
        res.writeHead(200, { "content-type": contentTypeFor(assetFile), "cache-control": "no-store" });
        res.end(readFileSync(assetFile));
        return;
      }

      // Page → render on the platform.
      const { status, html } = await renderPath(pathname);
      res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(injectLivereload(html));
    } catch (err) {
      res.writeHead(502, { "content-type": "text/html; charset=utf-8" });
      res.end(injectLivereload(errorHtml(502, err?.message ?? String(err))));
    }
  });

  if (onError) server.on("error", onError);

  const broadcast = () => {
    for (const client of clients) client.write("data: reload\n\n");
  };
  // Değişimde: önce taslağa senkronla (canlı-domain önizleme + editör güncel olsun),
  // SONRA reload yayınla → tüm görünümler en güncel taslağı çeker.
  const watcher = startWatch(dir, async () => {
    if (syncDraft) {
      try {
        await pushTheme({ dir, url, token, draft: true });
      } catch {
        /* senkron hatası reload'u engellemesin */
      }
    }
    broadcast();
  });

  // Açılışta taslağı bir kez doldur → uzak görünümler hemen güncel local'i gösterir.
  if (syncDraft) {
    void pushTheme({ dir, url, token, draft: true }).catch(() => {});
  }

  server.listen(port);

  return {
    server,
    close() {
      try {
        watcher?.close();
      } catch {
        /* ignore */
      }
      for (const client of clients) client.end();
      server.close();
    },
  };
}

/**
 * Watch `dir`; if recursive watching is unsupported (older Node/Linux), fall back to
 * a non-recursive watch. Calls `onChange` debounced. Returns null if unwatchable
 * (livereload disabled).
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

/** Map a `/asset/*` path to a disk file (path-traversal safe); null if missing. */
function safeAssetFile(dir, pathname) {
  if (!pathname.startsWith("/asset/")) return null;
  const root = normalize(dir);
  const full = normalize(join(dir, pathname.replace(/^\/+/, "")));
  if (full !== root && !full.startsWith(root + sep)) return null;
  try {
    if (existsSync(full) && statSync(full).isFile()) return full;
  } catch {
    /* ignore */
  }
  return null;
}

function escapeHtml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function errorHtml(status, message) {
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<title>blocofy dev — ${status}</title></head>` +
    `<body style="font-family:system-ui,sans-serif;padding:2rem;max-width:48rem;margin:0 auto">` +
    `<h1 style="color:#b91c1c">Render error (${status})</h1>` +
    `<pre style="white-space:pre-wrap;background:#f4f4f5;padding:1rem;border-radius:.5rem;color:#333">${escapeHtml(message)}</pre>` +
    `<p style="color:#666">Fix the theme file — this page reloads automatically when you save.</p>` +
    `</body></html>`
  );
}
