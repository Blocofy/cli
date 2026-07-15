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
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";

import { parseArgs } from "../lib/args.mjs";
import { pullContent, pushContent } from "../lib/content-sync.mjs";
import { credentialsPath, loadCredentials, saveCredentials } from "../lib/credentials.mjs";
import { startDevServer } from "../lib/dev-server.mjs";
import { readLocalTemplates } from "../lib/local-theme.mjs";
import { githubNote, retryNotice, statusLine, syncScopeNote } from "../lib/messages.mjs";
import { fetchDevSession, fetchSiteStatus, fetchWhoami, publishInstance, pullTheme, pushTheme, renameInstance } from "../lib/theme-sync.mjs";
import { isAffirmative, livePushDecision, resolvePushMode } from "../lib/confirm.mjs";
import { hyperlink, openUrl } from "../lib/term.mjs";
import { isValidToken, isValidUrl, normalizeUrl } from "../lib/validate.mjs";

const VERSION = createRequire(import.meta.url)("../package.json").version;
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

  blocofy theme dev [dir] [--port <n>] [--no-sync] [--name <name>]
      Start a dev server and print 3 auto-reloading views — Local, live-domain
      Preview, and the theme Editor. Press l / p / e to open each, q to quit.
      Edit a file and save → every open view reloads. Saves sync to a DRAFT theme
      only (never the live site). (dir defaults to cwd)
        --port <n>   local port (default 3030)
        --no-sync    local preview only (skip draft sync + remote views)
        --name <name>  name the draft when it is first created (ignored if it already exists)

  blocofy theme pull [dir] [--draft] [--instance <handle>]
      Download the live theme to disk. (dir defaults to cwd)
        --draft      pull the draft theme (what 'theme dev' syncs into) instead of live
        --instance <handle>  pull a specific theme by its handle (from the admin
                             panel theme card, or \`blocofy status\`)

  blocofy theme push [dir] [--live] [--yes] [--instance <handle>]
      By DEFAULT writes to a DRAFT theme (create/update; no delete) — preview & publish
      it from the admin panel, never touching the live site. Publish it with
      'blocofy theme publish'.
        --live       write to the LIVE site IMMEDIATELY (no preview). Asks for
                     confirmation first; non-interactive shells must add --yes.
        --draft      explicit draft (same as the default; safe)
        --yes        confirm a --live push without prompting (for CI / agents)
        --instance <handle>  push to a specific theme by its handle (safe targeted
                             write — no live-confirmation prompt)
        --name <name>  name the NEW draft (draft mode only; ignored on --live/--instance)

  blocofy theme rename <handle> <new name>
      Rename a theme (the name is just a label). Works on any of your themes,
      including the live one. Handle comes from the panel theme card or 'blocofy status'.

  blocofy theme publish [--instance <handle>]
      Publish a draft theme to the LIVE site. With no flag, publishes the draft that
      'theme dev' / 'theme push --draft' writes into. The server refuses to publish a
      theme that has no pages (it would 404) — so publishing is always safe.
        --instance <handle>  publish a specific theme (handle from the panel / status)

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
  blocofy theme push && blocofy theme publish
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
  const instance = typeof flags.instance === "string" ? flags.instance : null;
  const { count } = await pullTheme({ dir, url: creds.url, token: creds.token, draft, instance });
  const what = instance ? `instance ${instance}` : draft ? "draft" : "live";
  console.log(`Downloaded ${count} ${what} theme files → ${dir}`);
}

async function themePush(rest) {
  const { flags, positionals } = parseArgs(rest);
  const dir = resolve(positionals[0] ?? process.cwd());
  if (!existsSync(dir)) {
    console.error(`Theme directory not found: ${dir}`);
    process.exit(1);
  }
  const creds = requireCreds();
  const instanceFlag = typeof flags.instance === "string" ? flags.instance : null;
  const name = typeof flags.name === "string" ? flags.name : null;

  // Yeni varsayılan hedef: DRAFT (güvenli). `--live` eski anında-canlı davranışını
  // açıkça geri getirir; `--instance` belirli bir temayı adresler. Sadece "live"
  // modu canlıya yazar ve onay gerektirir.
  const { mode, instance } = resolvePushMode({
    live: Boolean(flags.live),
    draft: Boolean(flags.draft),
    instance: instanceFlag,
  });

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
  if (mode === "instance") {
    console.log(`→ Pushing to theme ${instance}${site ? ` of ${target}` : ""}`);
  } else if (mode === "live") {
    console.log(`→ Pushing to the LIVE theme of ${target}`);
  } else {
    console.log(`→ Pushing to a draft${site ? ` of ${target}` : ""}`);
  }

  // Canlı push (`--live`) ANINDA canlı temayı değiştirir (önizleme yok). Agent/CI
  // kazara canlıya basmasın diye açık onay şart (#431 L2). Draft/instance modu
  // güvenli → otomatik onay (prompt yok).
  const decision = livePushDecision({
    draft: mode !== "live",
    yes: Boolean(flags.yes),
    confirm: Boolean(flags.confirm),
    isTTY: Boolean(process.stdin.isTTY),
  });
  if (decision.mustAbort) {
    console.error(`⚠ 'theme push --live' writes to the LIVE theme of ${target} immediately (no preview).`);
    console.error(`  Non-interactive shell: pass --live --yes to confirm, or omit --live to push to a safe draft.`);
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
      console.error("Aborted. Omit `--live` to push to a safe draft, or pass `--live --yes` to confirm.");
      process.exit(1);
    }
  }

  // `--name` yalnızca YENİ taslak yaratırken (draft modu) anlamlı — canlıya/mevcut
  // instance'a yazarken ad kaydedilmez, sessizce kaybolmasın diye açıkça uyar.
  if (name && mode !== "draft") {
    console.error("Note: --name yalnız yeni taslak yaratırken (varsayılan push) geçerli, yok sayıldı.");
  }

  const result = await pushTheme({
    dir,
    url: creds.url,
    token: creds.token,
    draft: mode === "draft",
    instance: mode === "instance" ? instance : null,
    name: mode === "draft" ? name : null,
    onRetry: (info) => console.error(retryNotice(info)),
  });

  // Sunucu canlı-yazımı bildirdiyse (yeni alan; eski sunucuda yok) belirgin uyar.
  if (result.warning === "live_write" && result.message) {
    console.error(`\n⚠ ${result.message}\n`);
  }

  if (result.instanceId) {
    console.log(`Pushed to theme ${result.instanceId} (${result.created} created, ${result.updated} updated).`);
    if (mode === "draft") {
      console.log(`Preview & publish it in the admin panel: Theme → Theme library → "Open in editor".`);
      console.log(`Publish it live with:  blocofy theme publish`);
    } else {
      console.log(`Preview & publish it in the admin panel: Theme → Theme library → "Open in editor".`);
    }
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
      const name = typeof flags.name === "string" ? flags.name : null;
      session = await fetchDevSession({ url: creds.url, token: creds.token, name });
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
    onRetry: (info) => console.error(`  ${retryNotice(info)}`),
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
  let instance = typeof flags.instance === "string" ? flags.instance : null;
  if (!instance) {
    // Belirtilmediyse: `theme dev` / `theme push --draft`'ın yazdığı taslağı yayınla.
    const session = await fetchDevSession({ url: creds.url, token: creds.token });
    instance = session.draftInstanceId;
  }
  const result = await publishInstance({ url: creds.url, token: creds.token, instanceId: instance });
  console.log(
    `✓ Theme ${result.published} is now LIVE${result.cloned ? " (pages cloned from the previous live theme)" : ""}.`,
  );
}

async function themeRename(rest) {
  const { flags, positionals } = parseArgs(rest);
  const handle = positionals[0];
  const name = positionals.slice(1).join(" ") || (typeof flags.name === "string" ? flags.name : null);
  if (!handle || !name) {
    console.error("Usage: blocofy theme rename <handle> <new name>");
    console.error("  Rename a theme (handle from the panel theme card or `blocofy status`).");
    process.exit(1);
  }
  const creds = requireCreds();
  const result = await renameInstance({ url: creds.url, token: creds.token, instance: handle, name });
  console.log(`✓ Renamed to "${result.name}" (${result.id}).`);
}

async function status() {
  const creds = requireCreds();
  const s = await fetchSiteStatus({ url: creds.url, token: creds.token });
  const live = s.live_theme_instance;
  console.log(`\nSite: ${s.site.slug}${s.url ? ` · ${s.url}` : ""}`);
  console.log(
    live
      ? `Live theme: ${live.id}${live.name ? ` ${live.name}` : ""} — ${live.template_count} files, ${s.pages_on_live} pages`
      : `Live theme: none`,
  );
  console.log(`Health: ${s.health}`);
  // orphan_missing_slugs yeni sunucu alanı (PR #661). Eski/deploy-edilmemiş sunucuda
  // yok → null; o durumda eski (yumuşatılmış) sayaç satırına düş.
  const missing = Array.isArray(s.orphan_missing_slugs) ? s.orphan_missing_slugs : null;
  if (s.health === "live_instance_empty") {
    console.error(
      `  ⚠ The live theme has no pages — the site will 404. Publish a theme with content:  blocofy theme publish`,
    );
  } else if (s.health === "pages_split") {
    if (missing && missing.length) {
      console.warn(
        `  ⚠ These pages are published only on a non-live theme, so visitors can't reach them (404 risk): ` +
          `${missing.join(", ")}\n` +
          `  Fix: publish the theme that has them —  blocofy theme publish`,
      );
    } else {
      console.warn(`  ⚠ ${s.orphaned_pages} page(s) published on a non-live theme.`);
    }
  }
  if (Array.isArray(s.drafts) && s.drafts.length > 0) {
    console.log(`Drafts: ${s.drafts.map((d) => `${d.id}${d.name ? ` ${d.name}` : ""}`).join(", ")}`);
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
} else if (first === "theme" && rest[0] === "rename") {
  themeRename(rest.slice(1)).catch((error) => {
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
