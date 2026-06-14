#!/usr/bin/env node
/**
 * Blocofy theme CLI. Develop your theme locally against live data with instant
 * preview, then publish.
 *
 * `blocofy login` stores your platform URL + dev token, then `blocofy theme dev`
 * starts a local server that proxies each request to the platform's
 * `/api/dev/render` endpoint (local theme files + live data) with file-watch
 * livereload. No monorepo required.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";

import { credentialsPath, loadCredentials, saveCredentials } from "../lib/credentials.mjs";
import { startDevServer } from "../lib/dev-server.mjs";
import { readLocalTemplates } from "../lib/local-theme.mjs";
import { fetchDevSession, pullTheme, pushTheme } from "../lib/theme-sync.mjs";
import { hyperlink, openUrl } from "../lib/term.mjs";
import { isValidToken, isValidUrl, normalizeUrl } from "../lib/validate.mjs";

const VERSION = "0.1.5";
const args = process.argv.slice(2);

/** Parse `--key value` and `--flag` (boolean) arguments. */
function parseFlags(rest) {
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = rest[i + 1];
    if (next && !next.startsWith("--")) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }
  return flags;
}

function printHelp() {
  console.log(`blocofy — Blocofy theme development CLI (v${VERSION})

Develop your theme locally against live data, preview it three ways, and publish.

Usage
  blocofy login [--url <url>] [--token <bcf_…>]
      Save your platform URL + dev token to ~/.blocofy/credentials.json.
      Get a token from the admin panel → Settings → Theme CLI tokens.

  blocofy theme dev [dir] [--port <n>] [--no-sync]
      Start a dev server and print 3 auto-reloading views — Local, live-domain
      Preview, and the theme Editor. Press l / p / e to open each, q to quit.
      Edit a file and save → every open view reloads. (dir defaults to cwd)
        --port <n>   local port (default 3030)
        --no-sync    local preview only (skip draft sync + remote views)

  blocofy theme pull [dir]
      Download the live theme to disk. (dir defaults to cwd)

  blocofy theme push [dir] [--draft]
      Write the local theme to the site (create/update; no delete).
        --draft      write to a draft theme — preview & publish it from the admin panel

  blocofy --version
  blocofy --help

Examples
  blocofy login --url https://store.myblocofy.com --token bcf_xxxxxxxx
  blocofy theme pull && blocofy theme dev
  blocofy theme push --draft

Auth: ~/.blocofy/credentials.json (from \`login\`), or BLOCOFY_URL + BLOCOFY_TOKEN env vars.
The CLI does not build assets — bring your own (npm/Vite/Tailwind); the platform serves
plain Liquid + static assets.`);
}

/** Geçerli yanıt alana kadar sor (max `tries`), HER yanıtı anında doğrula. */
async function promptValid(rl, question, normalize, valid, hint, tries = 3) {
  for (let i = 0; i < tries; i++) {
    const answer = normalize(await rl.question(question));
    if (valid(answer)) return answer;
    console.error(`  ✗ ${hint}`);
  }
  console.error("Too many invalid attempts.");
  process.exit(1);
}

async function login(rest) {
  const flags = parseFlags(rest);
  let url = typeof flags.url === "string" ? normalizeUrl(flags.url) : "";
  let token = typeof flags.token === "string" ? flags.token.trim() : "";

  // Flag ile verildiyse anında doğrula (prompt'a düşmeden).
  if (url && !isValidUrl(url)) {
    console.error("Invalid --url — must be a valid http(s):// URL.");
    process.exit(1);
  }
  if (token && !isValidToken(token)) {
    console.error("Invalid --token — must start with bcf_.");
    process.exit(1);
  }

  if (!url || !token) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      // URL'i token'dan ÖNCE iste ve ANINDA doğrula (şema yoksa https:// eklenir);
      // geçersizse aynı anda tekrar sorar — token'a geçip sonra hata vermez.
      if (!url) {
        url = await promptValid(
          rl,
          "Platform/site URL (e.g. https://store.myblocofy.com): ",
          normalizeUrl,
          isValidUrl,
          "Enter a valid URL, e.g. https://store.myblocofy.com",
        );
      }
      if (!token) {
        token = await promptValid(
          rl,
          "Dev token (bcf_…): ",
          (s) => s.trim(),
          isValidToken,
          "Token must start with bcf_ — get one from the admin panel: Settings → Theme CLI tokens.",
        );
      }
    } finally {
      rl.close();
    }
  }

  saveCredentials({ url, token });
  console.log(`✓ Saved credentials → ${credentialsPath()}`);
  console.log(`Next: cd into your theme directory, then run  blocofy theme dev`);
}

/** Resolve credentials (URL + token) or exit with guidance. */
function requireCreds() {
  const creds = loadCredentials();
  if (!creds || !creds.url || !creds.token) {
    console.error("Login required: run `blocofy login` (or set BLOCOFY_URL + BLOCOFY_TOKEN).");
    process.exit(1);
  }
  return creds;
}

async function themePull(rest) {
  const positional = rest.filter((a) => !a.startsWith("--"));
  const dir = resolve(positional[0] ?? process.cwd());
  const creds = requireCreds();
  const { count } = await pullTheme({ dir, url: creds.url, token: creds.token });
  console.log(`Downloaded ${count} theme files → ${dir}`);
}

async function themePush(rest) {
  const flags = parseFlags(rest);
  const positional = rest.filter((a) => !a.startsWith("--"));
  const dir = resolve(positional[0] ?? process.cwd());
  if (!existsSync(dir)) {
    console.error(`Theme directory not found: ${dir}`);
    process.exit(1);
  }
  const creds = requireCreds();
  const draft = Boolean(flags.draft);
  const result = await pushTheme({ dir, url: creds.url, token: creds.token, draft });
  if (result.draft) {
    console.log(`Pushed to draft theme #${result.instanceId} (${result.created} created, ${result.updated} updated).`);
    console.log(`Preview & publish it in the admin panel: Theme → Theme library → "Open in editor".`);
  } else {
    const extra = result.skippedDeletes
      ? `, ${result.skippedDeletes} remote file(s) absent locally (not deleted)`
      : "";
    console.log(`Push: ${result.created} created, ${result.updated} updated${extra}.`);
  }
}

async function themeDev(rest) {
  const flags = parseFlags(rest);
  const positional = rest.filter((a) => !a.startsWith("--"));
  const themeDir = resolve(positional[0] ?? process.cwd());

  if (!existsSync(themeDir)) {
    console.error(`Theme directory not found: ${themeDir}`);
    process.exit(1);
  }

  const creds = requireCreds();
  const port = Number(flags.port) || 3030;

  // Dev session: live-domain preview + theme editor URLs (+ a draft to sync into).
  // Graceful: if the platform can't provide one, fall back to local-only preview.
  let session = null;
  if (!flags["no-sync"]) {
    try {
      session = await fetchDevSession({ url: creds.url, token: creds.token });
    } catch (error) {
      console.warn(
        `Warning: dev session unavailable (${error?.message ?? error}). ` +
          `Local preview only — live-domain/editor views + draft sync disabled.`,
      );
    }
  }

  const localUrl = `http://localhost:${port}`;
  const previewUrl = session ? `${session.previewUrl}&hr=${port}` : null;
  const editorUrl = session ? `${session.editorUrl}&hr=${port}` : null;

  console.log(`\nblocofy theme dev — ${creds.url} (token ${creds.token.slice(0, 8)}…)\n`);
  console.log(`  (l) Local      ${hyperlink(localUrl)}`);
  if (previewUrl) console.log(`  (p) Preview    ${hyperlink(previewUrl)}`);
  if (editorUrl) console.log(`  (e) Editor     ${hyperlink(editorUrl)}`);
  const keys = ["l local", previewUrl && "p preview", editorUrl && "e editor", "q quit"]
    .filter(Boolean)
    .join("   ");
  console.log(`\n  Press:  ${keys}`);
  console.log(`  Edit a theme file and save — every open view reloads automatically.\n`);

  // Tanılama: kaç tema dosyası izleniyor? Boşsa hot-reload mümkün değil — yanlış
  // dizinde ya da `theme pull` yapılmamış demektir; sebebini açıkça söyle.
  const localFiles = readLocalTemplates(themeDir);
  const fileCount = Object.keys(localFiles).length;
  if (fileCount === 0) {
    console.warn(
      `  ⚠ No theme files found under ${themeDir}\n` +
        `    Expected top-level folders: layout/ section/ partial/ asset/ block/ template/\n` +
        `    Run this from your theme root, or fetch it first:  blocofy theme pull\n`,
    );
  } else {
    console.log(`  Watching ${themeDir} — ${fileCount} theme files\n`);
  }

  if (flags.dry) {
    console.log("(--dry: server not started)");
    return;
  }

  const handle = startDevServer({
    dir: themeDir,
    url: creds.url,
    token: creds.token,
    port,
    syncDraft: Boolean(session),
    // Her kaydetmede ne olduğunu bas — "reloaded" = watch tetiklendi; "0 views"
    // = hiçbir tarayıcı sekmesi bağlı değil (yanlış görünüme bakıyorsun); sync
    // hatası = draft güncellenemedi (preview/editör eski kalır, local yine yenilenir).
    onReload: ({ file, synced, clients, error }) => {
      const what = file || "change";
      if (error) {
        console.error(`  ↻ ${what} — draft sync failed: ${error} (local view still reloaded)`);
        return;
      }
      const views = clients ? `${clients} view${clients === 1 ? "" : "s"}` : "no views connected";
      console.log(`  ↻ ${what} → ${synced ? "synced + " : ""}reloaded (${views})`);
    },
    onError: (err) => {
      if (err && err.code === "EADDRINUSE") {
        console.error(`Port ${port} is in use. Try a different port: blocofy theme dev --port <n>`);
      } else {
        console.error(`Server error: ${err?.message ?? err}`);
      }
      process.exit(1);
    },
  });
  const shutdown = () => {
    if (process.stdin.isTTY) {
      try {
        process.stdin.setRawMode(false);
      } catch {
        /* yoksay */
      }
    }
    handle.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Klavye kısayolları (TTY): l/p/e ilgili görünümü tarayıcıda açar, q/Ctrl-C çıkar.
  // Raw mode'da SIGINT gelmez → Ctrl-C'yi () elle yakala.
  if (process.stdin.isTTY) {
    try {
      process.stdin.setRawMode(true);
    } catch {
      return; // raw mode yoksa kısayolsuz devam (sunucu çalışmaya devam eder)
    }
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (key) => {
      const k = key.toLowerCase();
      if (key === "" || k === "q") shutdown();
      else if (k === "l") openUrl(localUrl);
      else if (k === "p" && previewUrl) openUrl(previewUrl);
      else if (k === "e" && editorUrl) openUrl(editorUrl);
    });
  }
}

const [first, ...rest] = args;

if (first === "--version" || first === "-v") {
  console.log(VERSION);
} else if (!first || first === "--help" || first === "-h" || first === "help") {
  printHelp();
} else if (first === "login") {
  login(rest).catch((error) => {
    console.error(error?.message ?? error);
    process.exit(1);
  });
} else if (first === "theme" && rest[0] === "dev") {
  themeDev(rest.slice(1)).catch((error) => {
    console.error(error?.message ?? error);
    process.exit(1);
  });
} else if (first === "theme" && rest[0] === "pull") {
  themePull(rest.slice(1)).catch((error) => {
    console.error(error?.message ?? error);
    process.exit(1);
  });
} else if (first === "theme" && rest[0] === "push") {
  themePush(rest.slice(1)).catch((error) => {
    console.error(error?.message ?? error);
    process.exit(1);
  });
} else {
  console.error(`Unknown command: ${args.join(" ")}\n`);
  printHelp();
  process.exit(1);
}
