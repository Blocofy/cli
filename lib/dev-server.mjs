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
import { rewriteNavigation } from "./browse-html.mjs";
import { DRAFT_TARGET_AMBIGUOUS, draftSyncErrorLine, pushTheme } from "./theme-sync.mjs";

/**
 * The dev server proxies page renders with the developer's bearer, so it answers only this machine:
 * it binds IPv4 loopback, and every request must name it (Host + optional Origin) before any branch runs.
 * There is no LAN option on purpose — exposing it needs its own auth/threat model.
 */
const DEV_SERVER_HOST = "127.0.0.1";
const ALLOWED_METHODS = "GET, HEAD";

/** Why `req` is refused (status + short reason; never echoes request data or the credential), or null. */
function refusal(req, port) {
  if (req.method !== "GET" && req.method !== "HEAD") return { status: 405, reason: "Method not allowed." };
  // Origin-form only: an absolute request target (proxy style) could name another authority.
  if (typeof req.url !== "string" || !req.url.startsWith("/")) return { status: 400, reason: "Bad request target." };
  const ownHosts = new Set([`${DEV_SERVER_HOST}:${port}`, `localhost:${port}`]);
  const ownOrigins = new Set([...ownHosts].map((host) => `http://${host}`));
  // rawHeaders keeps duplicates that req.headers would silently collapse.
  const headerValues = (name) => {
    const values = [];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      if (req.rawHeaders[i].toLowerCase() === name) values.push(req.rawHeaders[i + 1].trim().toLowerCase());
    }
    return values;
  };
  // Exactly one Host, and it is this server: a DNS-rebinding page arrives with its own host name.
  // X-Forwarded-Host / Forwarded / Referer are never read.
  const hosts = headerValues("host");
  if (hosts.length !== 1 || !ownHosts.has(hosts[0])) {
    return { status: 403, reason: `This dev server only answers http://${DEV_SERVER_HOST}:${port}.` };
  }
  // A browser that sends Origin must be on this server's own origin (cross-origin pages and `null` refused).
  const origins = headerValues("origin");
  if (origins.length > 1 || (origins.length === 1 && !ownOrigins.has(origins[0]))) {
    return { status: 403, reason: `Cross-origin requests are not served; open http://${DEV_SERVER_HOST}:${port}.` };
  }
  return null;
}

/**
 * Local draft browsing (contract 2) response headers on every HTML answer of this server. The CSP is an HTTP header,
 * not a `<meta>`, so a theme cannot remove it (a theme's own meta CSP still applies too — the stricter wins):
 *   - `form-action 'self'`: every form submission (action, formaction, formtarget/new window) can only go to this
 *     server, which answers 405 for anything but GET/HEAD; a GET form becomes a local read-only page request;
 *   - `connect-src 'self'`: fetch / XHR / sendBeacon / WebSocket / EventSource / `<a ping>` to the live site or a third
 *     party are blocked (the livereload EventSource is same-origin and keeps working);
 *   - `base-uri 'none'`: a theme `<base href>` cannot re-target relative links to the live site.
 * script/style/img/frame/font sources are deliberately NOT restricted: theme menus, sliders and embeds keep working.
 */
export const BROWSE_CSP = "form-action 'self'; connect-src 'self'; base-uri 'none'";
const HTML_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "content-security-policy": BROWSE_CSP,
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

/** The browse contract version this CLI speaks (platform `POST /api/dev/render` with `mode: "browse"`). */
export const BROWSE_CONTRACT = 2;

const isLocalDevHost = (hostname) =>
  hostname === "localhost" || hostname.endsWith(".localhost") || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);

/** An internal origin: canonical `https://host[:port]`, or `http://` only for a local development host (fixture stack). */
function validOrigin(value) {
  if (typeof value !== "string") return false;
  try {
    const u = new URL(value);
    if (u.origin !== value) return false;
    return u.protocol === "https:" || (u.protocol === "http:" && isLocalDevHost(u.hostname));
  } catch {
    return false;
  }
}

/**
 * Strict contract-2 check of a `/api/dev/render` browse answer. → { ok: true, status, html, internalOrigins, diagnosis }
 * or { ok: false, why }. An old platform's `{ html }` (or any other shape) is never served as a browsable draft.
 */
export function validateBrowseResponse(httpStatus, body, sentInstance) {
  if (httpStatus !== 200 && httpStatus !== 404) return { ok: false, why: `HTTP ${httpStatus}` };
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, why: "JSON nesnesi değil" };
  if (body.contract !== BROWSE_CONTRACT) return { ok: false, why: `contract ${JSON.stringify(body.contract ?? null)}` };
  if (body.status !== httpStatus) return { ok: false, why: "status HTTP durumuyla eşleşmiyor" };
  if (!body.target || typeof body.target !== "object" || body.target.instance !== sentInstance) {
    return { ok: false, why: "target.instance gönderilen taslakla eşleşmiyor" };
  }
  if (typeof body.html !== "string") return { ok: false, why: "html dizgi değil" };
  if (!Array.isArray(body.internalOrigins) || !body.internalOrigins.every(validOrigin)) {
    return { ok: false, why: "internalOrigins geçersiz" };
  }
  const d = body.diagnosis;
  const diagnosis =
    d && typeof d === "object" && typeof d.code === "string"
      ? { code: d.code.slice(0, 64), location: typeof d.location === "string" ? d.location.slice(0, 2048) : null }
      : null;
  return { ok: true, status: httpStatus, html: body.html, internalOrigins: body.internalOrigins, diagnosis };
}

/**
 * Standalone dev server — local draft browsing. For each page request it reads the local theme files and posts them
 * with the draft theme handle to the platform's `/api/dev/render` (`mode: "browse"`), validates the contract-2 answer,
 * maps the site's own links to this local origin, and injects a livereload script. `fs.watch` reloads the browser over
 * SSE on change.
 *
 * No draft handle → no render request at all (a local terminal error page; never the live theme). The handle is
 * `instance` (theme dev --instance, or the saved theme work) or the one the startup draft sync returns.
 *
 * Assets are usually inlined into the HTML via `{% render 'asset/x.css' %}` (no separate request); direct `/asset/*`
 * references are served from disk. Images come from the site's system host (`/cdn`), not through this server.
 */
export function startDevServer({ dir, url, token, port, syncDraft = false, instance = null, onError, onReload, onRetry, onWarn, onSyncRefused }) {
  const base = url.replace(/\/+$/, "");
  // `token` is the credential or (a CLI login, ADR-0014 §5.4) an async getter that renews it; asked per request.
  const bearer = async () => (typeof token === "function" ? await token() : token);
  const clients = new Set();

  // The draft the local view shows. `--instance` (or the saved theme work) is fixed for the session; otherwise the
  // handle comes from the draft sync answer (`pushTheme({draft:true})`, no extra request).
  let draftInstance = instance ? String(instance) : null;
  // Why there is no handle (shown on the local error page; no render is requested without one).
  let noHandleReason = syncDraft
    ? "Taslak senkronu henüz bitmedi."
    : "--no-sync ile --instance <taslak-handle> verilmedi; yerel önizleme canlı temayı göstermez.";
  let warnedNoHandle = false;
  const noteHandle = (pushed) => {
    if (instance) return;
    if (pushed?.instanceId) {
      draftInstance = String(pushed.instanceId);
      return;
    }
    noHandleReason = "Platform taslak senkronundan sonra bir taslak tema handle'ı döndürmedi.";
    if (!warnedNoHandle) {
      warnedNoHandle = true;
      onWarn?.(
        "the server did not return a draft theme handle — the local view cannot show your draft (it never falls back to live); pass --instance <draft-handle>.",
      );
    }
  };

  // Açılıştaki push'u BİR promise olarak tut: ilk render isteği bunu bekler, yoksa ilk sayfa
  // yüklemesi senkron bitmeden gelir ve geliştirici "taslağım görünmüyor" sanır.
  // #989: `instance` (theme dev --instance) syncs into that draft; otherwise the platform picks the CLI draft and
  // refuses (409 draft_target_ambiguous) when it cannot prove which one that is. A refusal is final for the session:
  // `onSyncRefused` is told once (the caller exits) — the sync is never retried in a loop.
  const syncTarget = instance ? { instance, draft: true } : { draft: true };
  let refused = false;
  // Final for the session (the caller exits): the platform cannot pick the draft, or the named instance is live.
  const refusedBy = (err) => {
    if (err?.code !== DRAFT_TARGET_AMBIGUOUS && err?.code !== "draft_target_is_live") return false;
    if (!refused) {
      refused = true;
      onSyncRefused?.(err);
    }
    return true;
  };
  const draftReady = syncDraft
    ? bearer()
        .then((t) => pushTheme({ dir, url, token: t, ...syncTarget, onRetry }))
        .then(noteHandle)
        .catch((err) => {
          // #989 re-review P3: a startup sync failure is said, in one line — never swallowed.
          if (!refusedBy(err)) {
            const line = draftSyncErrorLine(err);
            noHandleReason = line;
            onWarn?.(line);
          }
        })
    : Promise.resolve();

  /** One page through the browse contract. → { status, html } (html is complete; livereload not yet injected). */
  async function renderPage(pathname, search, localOrigin) {
    // Açılış push'u bitene kadar bekle — yalnız ilk istekte gerçekten bekler, sonra çözülmüş promise.
    await draftReady;
    if (!draftInstance) {
      return {
        status: 503,
        html: localPage({
          title: "Tema hedefi hazırlanamadı",
          lines: [
            "Yerel önizleme yalnız bir taslak temayı gösterir. Hangi taslağın gösterileceği belirlenemediği için platformdan sayfa istenmedi; canlı siteye de geçilmedi.",
          ],
          detail: noHandleReason,
          hint: "Terminaldeki mesaja bakın. Bir taslak seçmek için: blocofy theme dev --instance <taslak-handle> (handle'lar: blocofy status).",
        }),
      };
    }
    const sent = draftInstance;
    const templates = readLocalTemplates(dir);
    const res = await fetch(`${base}/api/dev/render`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${await bearer()}` },
      body: JSON.stringify({
        mode: "browse",
        path: pathname,
        templates,
        instance: sent,
        ...(search ? { search } : {}),
        localOrigin,
      }),
    });
    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    if (res.status !== 200 && res.status !== 404) return { status: res.status, html: refusalPage(res.status, body, text) };
    const checked = validateBrowseResponse(res.status, body, sent);
    if (!checked.ok) {
      // A 404 with a typed error body (e.g. instance_not_found) is a refusal, not a contract-2 page.
      if (res.status === 404 && body?.error) return { status: 404, html: refusalPage(404, body, text) };
      return {
        status: 502,
        html: localPage({
          title: "Platform sürümü yerel taslak gezinmeyi desteklemiyor",
          lines: [
            `Platformun yanıtı yerel taslak gezinme sözleşmesine (contract ${BROWSE_CONTRACT}) uymuyor; bu yanıt taslağınız diye gösterilmedi.`,
            "Platform güncellenene kadar bu CLI sürümüyle yerel önizleme kullanılamaz.",
          ],
          detail: `Uyumsuzluk: ${checked.why}`,
        }),
      };
    }
    const pageUrl = `${localOrigin}${pathname}${search}`;
    let html = rewriteNavigation(checked.html, { pageUrl, internalOrigins: checked.internalOrigins, localOrigin }).html;
    if (checked.status === 404) html = injectBeforeBodyEnd(html, notFoundNote(checked.diagnosis));
    return { status: checked.status, html };
  }

  const server = createServer(async (req, res) => {
    // Before every branch: no SSE subscription, disk read or authenticated render for a refused request.
    const refused = refusal(req, server.address()?.port);
    if (refused) {
      if (refused.status === 405) {
        // Forms (POST/PUT/…) end here: CSP `form-action 'self'` keeps every submission on this server.
        res.writeHead(405, { ...HTML_HEADERS, allow: ALLOWED_METHODS });
        res.end(formsNotSentPage());
        return;
      }
      res.writeHead(refused.status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      res.end(`${refused.reason}\n`);
      return;
    }
    const head = req.method === "HEAD";
    try {
      // Origin-form request target (checked above): parse it as a path of this origin, never as an authority.
      const target = new URL(`http://localhost${req.url}`);
      const pathname = decodeURIComponent(target.pathname);

      // Livereload SSE channel — same-origin only (no CORS header): cross-origin views no longer subscribe.
      if (pathname === LIVERELOAD_PATH) {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache, no-transform",
          ...(head ? {} : { connection: "keep-alive" }),
        });
        if (head) return void res.end();
        res.write("retry: 1000\n\n");
        clients.add(res);
        req.on("close", () => clients.delete(res));
        return;
      }

      // Direct /asset/* reference → serve from disk (if present).
      const assetFile = safeAssetFile(dir, pathname);
      if (assetFile) {
        res.writeHead(200, { "content-type": contentTypeFor(assetFile), "cache-control": "no-store" });
        res.end(head ? undefined : readFileSync(assetFile));
        return;
      }

      // HEAD never spends an authenticated render: headers only.
      if (head) {
        res.writeHead(200, HTML_HEADERS);
        res.end();
        return;
      }

      // Page → render the draft on the platform. The raw (still percent-encoded) path and query go as they are: the
      // platform decodes once. The hash never reaches a server.
      const localOrigin = `http://${DEV_SERVER_HOST}:${server.address().port}`;
      const { status, html } = await renderPage(target.pathname, target.search, localOrigin);
      res.writeHead(status, HTML_HEADERS);
      res.end(injectLivereload(html));
    } catch (err) {
      res.writeHead(502, HTML_HEADERS);
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
    if (syncDraft && !refused) {
      try {
        // BİLİNÇLE key'siz (0.5.0): dev sync her kayıtta koşar — kanonik mühür (key'li dal) kayıt
        // başına revizyon+deployment üretirdi (retention yok) ve taslak önizlemeye katkısı sıfır.
        // Key'siz istek sunucuda legacy draft yazımıdır; kanonik mühür bilinçli `theme push` işidir.
        noteHandle(await pushTheme({ dir, url, token: await bearer(), ...syncTarget, onRetry }));
      } catch (err) {
        if (refusedBy(err)) return;
        error = draftSyncErrorLine(err); // senkron hatası reload'u engellemesin
      }
    }
    broadcast();
    onReload?.({ file, synced: syncDraft && !error, clients: clients.size, error });
  });

  server.listen(port, DEV_SERVER_HOST);

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
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function injectBeforeBodyEnd(html, snippet) {
  const at = html.lastIndexOf("</body>");
  return at < 0 ? html + snippet : html.slice(0, at) + snippet + html.slice(at);
}

/** A local page of this CLI (not the theme): title, paragraphs, an optional detail block, hint and back link. */
function localPage({ title, lines = [], detail = null, hint = null, back = null }) {
  return (
    `<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="robots" content="noindex">` +
    `<title>blocofy theme dev — ${escapeHtml(title)}</title></head>` +
    `<body style="font-family:system-ui,sans-serif;padding:2rem;max-width:48rem;margin:0 auto;color:#18181b">` +
    `<h1 style="color:#b91c1c;font-size:1.5rem">${escapeHtml(title)}</h1>` +
    lines.map((line) => `<p>${escapeHtml(line)}</p>`).join("") +
    (detail ? `<pre style="white-space:pre-wrap;background:#f4f4f5;padding:1rem;border-radius:.5rem;color:#333">${escapeHtml(detail)}</pre>` : "") +
    (hint ? `<p style="color:#52525b">${escapeHtml(hint)}</p>` : "") +
    (back ? `<p><a href="/" onclick="history.back();return false">${escapeHtml(back)}</a></p>` : "") +
    `</body></html>`
  );
}

/** The platform refused the browse request: its error code (new `{error:{code,message}}` or legacy shape), status kept. */
function refusalPage(status, body, text) {
  const error = body?.error;
  const code = typeof error?.code === "string" ? error.code : typeof body?.code === "string" ? body.code : null;
  const message =
    typeof error?.message === "string" ? error.message : typeof error === "string" ? error : body ? "" : text.slice(0, 500);
  return localPage({
    title: "Platform bu sayfayı göstermeyi reddetti",
    lines: [`HTTP ${status}${code ? ` · ${code}` : ""}`, ...(message ? [message] : [])],
    hint:
      code === "instance_is_live" || code === "instance_not_found" || code === "instance_required"
        ? "Yerel önizleme yalnız bu sitenin bir taslak temasını gösterir; canlı temaya geçilmez. Bir taslak seçin: blocofy theme dev --instance <taslak-handle> (handle'lar: blocofy status)."
        : "Bu sayfa kaydettiğinizde kendiliğinden yenilenir.",
  });
}

/** A small CLI note on a 404 (the theme's own 404 HTML is otherwise left as is). */
function notFoundNote(diagnosis) {
  const parts = ["blocofy theme dev: 404"];
  if (diagnosis?.code) parts.push(diagnosis.code);
  if (diagnosis?.location) parts.push(`canlı sitede yönlendirilirdi: ${diagnosis.location} (yerel önizlemede yönlendirme uygulanmaz)`);
  return (
    `<blocofy-dev-note role="note" style="all:initial;position:fixed;bottom:8px;right:8px;z-index:2147483647;` +
    `font:12px/1.4 system-ui,sans-serif;background:#18181b;color:#fafafa;padding:6px 10px;border-radius:6px;max-width:90vw">` +
    `${escapeHtml(parts.join(" · "))}</blocofy-dev-note>`
  );
}

/** The 405 answer for a form submission (any non-GET/HEAD request). */
function formsNotSentPage() {
  return localPage({
    title: "Yerel önizlemede formlar gönderilmez",
    lines: [
      "Bu yerel sunucu yalnız sayfa gösterir (GET/HEAD). Bu form gönderimi canlı siteye ya da başka bir adrese iletilmedi.",
    ],
    back: "Forma geri dön",
  });
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
