import { createServer } from "node:http";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, normalize, sep } from "node:path";

import {
  LIVERELOAD_PATH,
  THEME_DIRS,
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
export function startDevServer({ dir, url, token, port, syncDraft = false, onError, onReload, onRetry, onWarn }) {
  const base = url.replace(/\/+$/, "");
  const clients = new Set();

  // Taslak instance handle'ı: `pushTheme({draft:true})` yanıtından gelir (ek istek YOK). Render
  // istekleri bunu taşıyınca platform CANLI sayfa belgeleri yerine TASLAĞIN sayfa belgelerini
  // çözer — `theme dev`'in yerel görünümü nihayet üzerinde çalışılan şeyi gösterir.
  let draftInstance = null;
  // Kanonik yazma yolu ham control-plane JSON'u döndürür ve `instanceId` içermeyebilir. O durumda
  // sessizce canlıya dönmek, bu onarımın kapattığı arıza sınıfının aynısı olurdu — bir kez uyar.
  let warnedNoHandle = false;
  const noteHandle = (pushed) => {
    if (pushed?.instanceId) {
      draftInstance = pushed.instanceId;
      return;
    }
    if (!warnedNoHandle) {
      warnedNoHandle = true;
      onWarn?.(
        "the server did not return a draft theme handle — local preview will render LIVE page content, not your draft.",
      );
    }
  };

  // Açılıştaki push'u BİR promise olarak tut: ilk render isteği bunu bekler, yoksa ilk sayfa
  // yüklemesi canlı içerikle gelir ve geliştirici "taslağım görünmüyor" sanır.
  const draftReady = syncDraft
    ? pushTheme({ dir, url, token, draft: true, onRetry })
        .then(noteHandle)
        .catch(() => {})
    : Promise.resolve();

  async function renderPath(pathname) {
    // Açılış push'u bitene kadar bekle — yalnız ilk istekte gerçekten bekler, sonra çözülmüş promise.
    if (!draftInstance) await draftReady;
    const templates = readLocalTemplates(dir);
    const res = await fetch(`${base}/api/dev/render`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      // `preview` BİLİNÇLE gönderilmez: sunucuda preview yalnız tazelik değil — önizleme bandı,
      // editör bridge'i ve blok işaretleyicileri de ona bağlı. `theme dev`'in vaadi prod paritesi.
      body: JSON.stringify({
        path: pathname,
        templates,
        ...(draftInstance ? { instance: draftInstance } : {}),
      }),
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
  // SONRA reload yayınla → tüm görünümler en güncel taslağı çeker. `onReload` log için:
  // hangi dosya, senkron oldu mu, kaç görünüm bağlı (clients.size = açık EventSource'lar).
  const watcher = startWatch(dir, async (file) => {
    let error = null;
    if (syncDraft) {
      try {
        // BİLİNÇLE key'siz (0.5.0): dev sync her kayıtta koşar — kanonik mühür (key'li dal) kayıt
        // başına revizyon+deployment üretirdi (retention yok) ve taslak önizlemeye katkısı sıfır.
        // Key'siz istek sunucuda legacy draft yazımıdır; kanonik mühür bilinçli `theme push` işidir.
        noteHandle(await pushTheme({ dir, url, token, draft: true, onRetry }));
      } catch (err) {
        error = err?.message ?? String(err); // senkron hatası reload'u engellemesin
      }
    }
    broadcast();
    onReload?.({ file, synced: syncDraft && !error, clients: clients.size, error });
  });

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
 * Recursively snapshot theme-file mtimes → Map(relPath → mtimeMs). Only descends
 * into THEME_DIRS at the top level, so node_modules / .git / build tooling don't
 * bloat the scan. Used by the polling watcher.
 */
function snapshot(dir) {
  const map = new Map();
  const walk = (current, rel) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!rel && !THEME_DIRS.has(entry.name)) continue; // top level: theme dirs only
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full, childRel);
      } else {
        try {
          map.set(childRel, statSync(full).mtimeMs);
        } catch {
          /* dosya kayboldu (atomik kaydetme yarış) — sonraki tarama yakalar */
        }
      }
    }
  };
  walk(dir, "");
  return map;
}

/**
 * Watch `dir` by polling theme-file mtimes (default 300ms). fs.watch yerine polling:
 * editörün kaydetme şekli (yerinde/atomik), dosya sistemi ve `recursive` desteği
 * olmayan Node build'lerinden bağımsız çalışır — kaybolan event yok. Değişen/eklenen/
 * silinen ilk dosyanın yolunu `onChange`'e geçirir (debounce'lu). `.close()` döner.
 */
function startWatch(dir, onChange, intervalMs = 300) {
  let prev = snapshot(dir);
  let timer = null;
  let lastFile = null;
  const fire = (file) => {
    if (file) lastFile = file;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => onChange(lastFile), 80);
  };
  const tick = () => {
    const cur = snapshot(dir);
    let changed = null;
    for (const [key, mtime] of cur) {
      const before = prev.get(key);
      if (before === undefined || before !== mtime) {
        changed = key;
        break;
      }
    }
    if (!changed) {
      for (const key of prev.keys()) {
        if (!cur.has(key)) {
          changed = key;
          break;
        }
      }
    }
    prev = cur;
    if (changed) fire(changed);
  };
  const interval = setInterval(tick, intervalMs);
  if (interval.unref) interval.unref();
  return {
    close() {
      clearInterval(interval);
      if (timer) clearTimeout(timer);
    },
  };
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
