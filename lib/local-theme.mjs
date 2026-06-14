import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";

/**
 * Reading local theme files + livereload helpers. `readLocalTemplates` mirrors the
 * platform's own theme loader exactly: files whose top-level directory is one of
 * THEME_DIRS, keyed by relative path with the `.liquid` extension stripped.
 */

export const THEME_DIRS = new Set(["layout", "section", "block", "partial", "asset", "template"]);
const LIQUID_KINDS = new Set(["layout", "section", "block", "partial", "template"]);

/**
 * Stripped key → on-disk path: re-adds `.liquid` for Liquid kinds, leaves assets
 * raw. Used by `pull` when writing to disk (the inverse of readLocalTemplates).
 */
export function localPathFor(key) {
  const top = key.split("/")[0] ?? "";
  return LIQUID_KINDS.has(top) && !key.endsWith(".liquid") ? `${key}.liquid` : key;
}

/** Turn a theme directory into a `{ path: content }` map (sent to dev-render). */
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

/** Inject the livereload script into rendered HTML (before </body>). */
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

/** Content-type from a file extension (for static asset serving). */
export function contentTypeFor(p) {
  return CONTENT_TYPES[extname(p).toLowerCase()] ?? "application/octet-stream";
}
