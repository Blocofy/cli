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

import { parseArgs } from "../lib/args.mjs";
import { pullContent, pushContent } from "../lib/content-sync.mjs";
import { credentialsPath, loadCredentials, saveCredentials } from "../lib/credentials.mjs";
import { startDevServer } from "../lib/dev-server.mjs";
import { readLocalTemplates } from "../lib/local-theme.mjs";
import { githubNote, statusLine, syncScopeNote } from "../lib/messages.mjs";
import { fetchDevSession, fetchSiteStatus, fetchWhoami, publishInstance, pullTheme, pushTheme } from "../lib/theme-sync.mjs";
import { isAffirmative, livePushDecision } from "../lib/confirm.mjs";
import { hyperlink, openUrl } from "../lib/term.mjs";
import { isValidToken, isValidUrl, normalizeUrl } from "../lib/validate.mjs";

const VERSION = "0.1.14";
const args = process.argv.slice(2);

/** Human label for a resolved site: "Name (slug)" or just the slug. */
function siteLabel(site) {
  if (!site) return "";
  return site.name ? `${site.name} (${site.slug})` : site.slug;
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
      Edit a file and save → every open view reloads. Saves sync to a DRAFT theme
      only (never the live site). (dir defaults to cwd)
        --port <n>   local port (default 3030)
        --no-sync    local preview only (skip draft sync + remote views)

  blocofy theme pull [dir] [--draft]
      Download the live theme to disk. (dir defaults to cwd)
        --draft      pull the draft theme (what 'theme dev' syncs into) instead of live

  blocofy theme push [dir] [--draft] [--yes]
      Write the local theme to the LIVE site IMMEDIATELY (create/update; no delete,
      no preview). Asks for confirmation first; non-interactive shells must pass --yes.
        --draft      write to a draft theme instead — preview & publish it from the
                     admin panel (recommended; never touches the live site)
        --yes        confirm the live push without prompting (for CI / agents)

  blocofy theme publish [--instance <id>]
      Publish a draft theme to the LIVE site. With no flag, publishes the draft that
      'theme dev' / 'theme push --draft' writes into. The server refuses to publish a
      theme that has no pages (it would 404) — so publishing is always safe.
        --instance <id>   publish a specific theme instance

  blocofy status
      Show the live theme, page distribution per instance, drafts, and a health flag
      (ok / live_instance_empty / pages_split). Run before/after publishing.

  blocofy pages pull [dir] / pages push [dir]
      pull: download published pages → pages/<slug>.json.
      push: write pages/*.json to the site. Updates EXISTING pages only —
            never creates or deletes a page; unchanged pages are skipped.

  blocofy settings pull [dir] / settings push [dir]
      Download / upload config/settings.json (theme tokens/settings + color schemes).

  blocofy --version
  blocofy --help

Examples
  blocofy login --url https://store.myblocofy.com --token bcf_xxxxxxxx
  blocofy theme pull && blocofy theme dev
  blocofy theme push --draft && blocofy theme publish
  blocofy status

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
  const { flags } = parseArgs(rest);
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

  // Token'ın GERÇEK site'ını göster — site sunucuda TOKEN'dan çözülür, URL kozmetik.
  // Yanlış tenant'ın token'ıyla login olduysan ("klarosa URL + ksc token") hemen
  // görürsün. whoami yoksa/erişilemezse sessiz geç.
  try {
    const who = await fetchWhoami({ url, token });
    if (who?.site) console.log(`  Site: ${siteLabel(who.site)} — your theme commands target this tenant.`);
  } catch {
    /* best-effort */
  }
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
  const { flags, positionals } = parseArgs(rest);
  const dir = resolve(positionals[0] ?? process.cwd());
  const creds = requireCreds();
  const draft = Boolean(flags.draft);
  const { count } = await pullTheme({ dir, url: creds.url, token: creds.token, draft });
  console.log(`Downloaded ${count} ${draft ? "draft" : "live"} theme files → ${dir}`);
}

async function themePush(rest) {
  const { flags, positionals } = parseArgs(rest);
  const dir = resolve(positionals[0] ?? process.cwd());
  if (!existsSync(dir)) {
    console.error(`Theme directory not found: ${dir}`);
    process.exit(1);
  }
  const creds = requireCreds();
  const draft = Boolean(flags.draft);

  // Hedef tenant'ı çöz ve GÖSTER — site sunucuda TOKEN'dan çözülür (URL kozmetik),
  // yanlış-tenant'a yazımı görünür kılar ("klarosa sandım, ksc'ye yazdım"). whoami
  // yoksa/erişilemezse sessiz geç; etiketi confirmation mesajlarında da kullan.
  let site = null;
  try {
    site = (await fetchWhoami({ url: creds.url, token: creds.token })).site;
  } catch {
    /* best-effort */
  }
  const target = site ? siteLabel(site) : creds.url;
  if (site) {
    console.log(`→ ${draft ? "Pushing to a draft" : "Pushing to the LIVE theme"} of ${target}`);
  }

  // Canlı push (flag'siz) ANINDA canlı temayı değiştirir (önizleme yok). Agent/CI
  // kazara canlıya basmasın diye açık onay şart (#431 L2).
  const decision = livePushDecision({
    draft,
    yes: Boolean(flags.yes),
    confirm: Boolean(flags.confirm),
    isTTY: Boolean(process.stdin.isTTY),
  });
  if (decision.mustAbort) {
    console.error(`⚠ 'theme push' writes to the LIVE theme of ${target} immediately (no preview).`);
    console.error(`  Non-interactive shell: pass --yes to confirm, or use --draft for a safe draft.`);
    process.exit(1);
  }
  if (decision.needsPrompt) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    let answer;
    try {
      answer = await rl.question(`⚠ Push to the LIVE theme of ${target}? Immediate, no preview. [y/N] `);
    } finally {
      rl.close();
    }
    if (!isAffirmative(answer)) {
      console.error("Aborted. Use `--draft` to push to a draft, or `--yes` to confirm the live push.");
      process.exit(1);
    }
  }

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

async function contentPush(scope, rest) {
  const { positionals } = parseArgs(rest);
  const dir = resolve(positionals[0] ?? process.cwd());
  if (!existsSync(dir)) {
    console.error(`Directory not found: ${dir}`);
    process.exit(1);
  }
  const creds = requireCreds();
  const result = await pushContent({ dir, url: creds.url, token: creds.token, scope });
  if (scope === "settings") {
    console.log(
      `Settings push: ${result.settingsUpdated ? "theme settings updated" : "theme settings unchanged"}, ` +
        `${result.schemesUpserted} color scheme(s) upserted (${result.fileCount} file).`,
    );
  } else {
    console.log(
      `Pages push: ${result.pagesUpdated} updated, ${result.pagesSkipped} skipped ` +
        `(only existing pages are updated — none created or deleted).`,
    );
  }
}

async function contentPull(scope, rest) {
  const { positionals } = parseArgs(rest);
  const dir = resolve(positionals[0] ?? process.cwd());
  const creds = requireCreds();
  const { count } = await pullContent({ dir, url: creds.url, token: creds.token, scope });
  console.log(`Downloaded ${count} ${scope === "settings" ? "settings" : "page"} file(s) → ${dir}`);
}

async function themeDev(rest) {
  const { flags, positionals } = parseArgs(rest);
  const themeDir = resolve(positionals[0] ?? process.cwd());

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

  // Çözülen site'ı göster (session TOKEN'dan çözer) → hangi tenant'ı düzenlediğin belli olsun.
  const siteLine = session?.site ? `${siteLabel(session.site)} · ` : "";
  console.log(`\nblocofy theme dev — ${siteLine}${creds.url} (token ${creds.token.slice(0, 8)}…)\n`);
  console.log(`  (l) Local      ${hyperlink(localUrl)}`);
  if (previewUrl) console.log(`  (p) Preview    ${hyperlink(previewUrl)}`);
  if (editorUrl) console.log(`  (e) Editor     ${hyperlink(editorUrl)}`);

  // Kalıcı durum satırı (#119 CLI bulgu #3): yerel hangi taslağa gidiyor + canlı tema.
  const status = statusLine(session);
  if (status) console.log(`\n  ${status}`);

  const keys = ["l local", previewUrl && "p preview", editorUrl && "e editor", "q quit"]
    .filter(Boolean)
    .join("   ");
  console.log(`\n  Press:  ${keys}`);
  console.log(`  Edit a theme file and save — every open view reloads automatically.\n`);

  // Senkron kapsamı (#119 CLI bulgu #2): hangi dizinler taşınıyor / taşınmıyor —
  // "config/pages senkronlanıyor sandım" karışıklığını açıkça önler.
  for (const line of syncScopeNote()) console.log(`  ${line}`);
  console.log("");

  // Düzlem uyarısı: CLI yalnız tema KODUNU taşır; editörde yapılan içerik/ayar
  // bulutta yaşar (githubNote → lib/messages.mjs, oturum durumuna göre uyarlanır).
  const note = githubNote(session);
  if (note) {
    console.log(`  ℹ ${note}\n`);
  }

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

async function themePublish(rest) {
  const { flags } = parseArgs(rest);
  const creds = requireCreds();
  let instanceId = Number(flags.instance);
  if (!Number.isInteger(instanceId) || instanceId <= 0) {
    // Belirtilmediyse: `theme dev` / `theme push --draft`'ın yazdığı taslağı yayınla.
    const session = await fetchDevSession({ url: creds.url, token: creds.token });
    instanceId = session.draftInstanceId;
  }
  const result = await publishInstance({ url: creds.url, token: creds.token, instanceId });
  console.log(
    `✓ Theme #${result.published} is now LIVE${result.cloned ? " (pages cloned from the previous live theme)" : ""}.`,
  );
}

async function status() {
  const creds = requireCreds();
  const s = await fetchSiteStatus({ url: creds.url, token: creds.token });
  const live = s.live_theme_instance;
  console.log(`\nSite: ${s.site.slug} (id ${s.site.id})`);
  console.log(
    live
      ? `Live theme: #${live.id}${live.name ? ` ${live.name}` : ""} — ${live.template_count} files, ${s.pages_on_live} pages`
      : `Live theme: none`,
  );
  console.log(`Health: ${s.health}`);
  if (s.health === "live_instance_empty") {
    console.error(
      `  ⚠ The live theme has no pages — the site will 404. Publish a theme with content:  blocofy theme publish`,
    );
  } else if (s.health === "pages_split") {
    console.warn(`  ⚠ ${s.orphaned_pages} page(s) live on a non-live instance (orphan).`);
  }
  if (Array.isArray(s.drafts) && s.drafts.length > 0) {
    console.log(`Drafts: ${s.drafts.map((d) => `#${d.id}${d.name ? ` ${d.name}` : ""}`).join(", ")}`);
  }
  console.log("");
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
} else if (first === "theme" && rest[0] === "publish") {
  themePublish(rest.slice(1)).catch((error) => {
    console.error(error?.message ?? error);
    process.exit(1);
  });
} else if (first === "status") {
  status().catch((error) => {
    console.error(error?.message ?? error);
    process.exit(1);
  });
} else if (first === "pages" && rest[0] === "pull") {
  contentPull("pages", rest.slice(1)).catch((error) => {
    console.error(error?.message ?? error);
    process.exit(1);
  });
} else if (first === "pages" && rest[0] === "push") {
  contentPush("pages", rest.slice(1)).catch((error) => {
    console.error(error?.message ?? error);
    process.exit(1);
  });
} else if (first === "settings" && rest[0] === "pull") {
  contentPull("settings", rest.slice(1)).catch((error) => {
    console.error(error?.message ?? error);
    process.exit(1);
  });
} else if (first === "settings" && rest[0] === "push") {
  contentPush("settings", rest.slice(1)).catch((error) => {
    console.error(error?.message ?? error);
    process.exit(1);
  });
} else {
  console.error(`Unknown command: ${args.join(" ")}\n`);
  printHelp();
  process.exit(1);
}
