import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";

/**
 * Local tema dosyalarını okuma + livereload — `@blocofy/cms`'in zero-dep aynası
 * (standalone CLI cms'i bundle edemez). `readLocalTemplates`, cms'teki
 * `loadLocalTemplates` (templates.ts) ile BİREBİR aynı eşlemeyi yapar:
 * üst-dizini THEME_DIRS olan dosyalar, key = göreli yol, `.liquid` strip'li.
 */

const THEME_DIRS = new Set(["layout", "section", "block", "partial", "asset", "template"]);
const LIQUID_KINDS = new Set(["layout", "section", "block", "partial", "template"]);

/**
 * Stripped key → disk yolu (cms `repoPathFor`'un aynası): liquid kind'lara `.liquid`
 * ekler, asset'i ham bırakır. `pull` diske yazarken kullanır (readLocalTemplates tersi).
 */
export function localPathFor(key) {
  const top = key.split("/")[0] ?? "";
  return LIQUID_KINDS.has(top) && !key.endsWith(".liquid") ? `${key}.liquid` : key;
}

/** Tema dizinini `{path: content}` haritasına çevir (dev-render'a gönderilir). */
export function readLocalTemplates(dir) {
  const out = {};
  const walk = (current) => {
    for (const name of readdirSync(current)) {
      const full = join(current, name);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      const rel = relative(dir, full).split(sep).join("/");
      const top = rel.split("/")[0] ?? "";
      if (!THEME_DIRS.has(top)) continue;
      out[rel.endsWith(".liquid") ? rel.slice(0, -7) : rel] = readFileSync(full, "utf8");
    }
  };
  walk(dir);
  return out;
}

const LIVERELOAD_PATH = "/__blocofy_livereload";

const LIVERELOAD_SNIPPET = `<script>
(function(){try{var es=new EventSource(${JSON.stringify(LIVERELOAD_PATH)});es.onmessage=function(e){if(e.data==="reload")location.reload();};}catch(_){}})();
</script>`;

export { LIVERELOAD_PATH };

/** Render edilen HTML'e livereload script'ini ekle (</body>'den önce). */
export function injectLivereload(html) {
  if (typeof html !== "string") return html;
  return html.includes("</body>")
    ? html.replace("</body>", LIVERELOAD_SNIPPET + "</body>")
    : html + LIVERELOAD_SNIPPET;
}

const CONTENT_TYPES = {
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain",
  ".map": "application/json",
};

/** Uzantıdan content-type (statik asset servisi için). */
export function contentTypeFor(p) {
  return CONTENT_TYPES[extname(p).toLowerCase()] ?? "application/octet-stream";
}
