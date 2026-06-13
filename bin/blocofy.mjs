#!/usr/bin/env node
/**
 * Blocofy tema CLI (#119). Shopify CLI modeli: local tema + canlı veri instant
 * preview, sonra yayına alma.
 *
 * İki mod:
 *  - Standalone (Faz 3d): `blocofy login` ile platform URL + dev token kaydet →
 *    `blocofy theme dev` kendi http sunucusunu açar, her isteği platformun
 *    `/api/dev/render`'ına proxy'ler (local tema + canlı veri), fs.watch ile
 *    livereload. Monorepo GEREKMEZ → external müşteri `npx @blocofy/cli` ile.
 *  - Monorepo (Faz 2 v1): login yoksa, monorepo içindeyse renderer'ı THEME_DEV_DIR
 *    ile spawn eder (fallback).
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

import { credentialsPath, loadCredentials, saveCredentials } from "../lib/credentials.mjs";
import { startDevServer } from "../lib/dev-server.mjs";
import { pullTheme, pushTheme } from "../lib/theme-sync.mjs";

const VERSION = "0.1.0";
const args = process.argv.slice(2);

/** `--key value` ve `--flag` (boolean) ayrıştırıcı. */
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

function findMonorepoRoot(start) {
  let dir = start;
  for (let i = 0; i < 8; i++) {
    if (existsSync(resolve(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function printHelp() {
  console.log(`blocofy — Blocofy tema geliştirme CLI (v${VERSION})

Kullanım:
  blocofy login [--url <url>] [--token <bcf_…>]
                            Platform URL + dev token kaydet (~/.blocofy/credentials.json).
                            Token: admin → Ayarlar → Tema CLI token'ları.
  blocofy theme dev [dir]   Local tema dev sunucusu — local tema + canlı veri instant
                            preview. Giriş yapıldıysa standalone (monorepo gerekmez);
                            yoksa monorepo içinde renderer'ı sarar. dir varsayılan: cwd.
                            --port <n> (varsayılan 3030), --standalone, --monorepo
  blocofy theme pull [dir]  Canlı temayı diske indir (giriş gerekli). dir varsayılan: cwd.
  blocofy theme push [dir]  Local temayı canlı siteye yaz (create/update; v1 silme yok).
  blocofy --version
  blocofy --help

Yakında (#119): blocofy init, blocofy check.
Not: CLI build ALMAZ — asset'leri kendi araçlarınla (npm/Vite/Tailwind) üretirsin;
platform Liquid + statik asset olarak kalır.`);
}

async function login(rest) {
  const flags = parseFlags(rest);
  let url = typeof flags.url === "string" ? flags.url : "";
  let token = typeof flags.token === "string" ? flags.token : "";

  if (!url || !token) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      if (!url) url = (await rl.question("Platform/site URL (örn. https://magaza.myblocofy.com): ")).trim();
      if (!token) token = (await rl.question("Dev token (bcf_…): ")).trim();
    } finally {
      rl.close();
    }
  }

  url = url.replace(/\/+$/, "");
  if (!/^https?:\/\//.test(url)) {
    console.error("Geçersiz URL — http(s):// ile başlamalı.");
    process.exit(1);
  }
  if (!token.startsWith("bcf_")) {
    console.error("Geçersiz token — bcf_ ile başlamalı (admin → Ayarlar → Tema CLI token'ları).");
    process.exit(1);
  }

  saveCredentials({ url, token });
  console.log(`Giriş kaydedildi: ${credentialsPath()}`);
  console.log(`Artık tema dizininde: blocofy theme dev`);
}

/** Giriş bilgisi (URL+token) çöz ya da hata ver. pull/push standalone gerektirir. */
function requireCreds() {
  const creds = loadCredentials();
  if (!creds || !creds.url || !creds.token) {
    console.error("Giriş gerekli: `blocofy login` (ya da BLOCOFY_URL + BLOCOFY_TOKEN).");
    process.exit(1);
  }
  return creds;
}

async function themePull(rest) {
  const positional = rest.filter((a) => !a.startsWith("--"));
  const dir = resolve(positional[0] ?? process.cwd());
  const creds = requireCreds();
  const { count } = await pullTheme({ dir, url: creds.url, token: creds.token });
  console.log(`${count} tema dosyası indirildi → ${dir}`);
}

async function themePush(rest) {
  const positional = rest.filter((a) => !a.startsWith("--"));
  const dir = resolve(positional[0] ?? process.cwd());
  if (!existsSync(dir)) {
    console.error(`Tema dizini yok: ${dir}`);
    process.exit(1);
  }
  const creds = requireCreds();
  const result = await pushTheme({ dir, url: creds.url, token: creds.token });
  const extra = result.skippedDeletes
    ? `, ${result.skippedDeletes} uzak dosya yerelde yok (v1: silinmedi)`
    : "";
  console.log(`Push: ${result.created} yeni, ${result.updated} güncellendi${extra}.`);
}

function themeDev(rest) {
  const flags = parseFlags(rest);
  const positional = rest.filter((a) => !a.startsWith("--"));
  const themeDir = resolve(positional[0] ?? process.cwd());

  if (!existsSync(themeDir)) {
    console.error(`Tema dizini yok: ${themeDir}`);
    process.exit(1);
  }

  const creds = flags.monorepo ? null : loadCredentials();
  const canStandalone = Boolean(creds && creds.url && creds.token);

  // Standalone: giriş yapıldıysa (ya da --standalone zorlanırsa).
  if (canStandalone || flags.standalone) {
    if (!canStandalone) {
      console.error("Standalone için giriş gerekli: `blocofy login` (ya da BLOCOFY_URL + BLOCOFY_TOKEN).");
      process.exit(1);
    }
    const port = Number(flags.port) || 3030;
    console.log(`blocofy theme dev (standalone)`);
    console.log(`  tema dizini : ${themeDir}`);
    console.log(`  platform    : ${creds.url}`);
    console.log(`  token       : ${creds.token.slice(0, 8)}… (${creds.source})`);
    console.log(`  önizleme    : http://localhost:${port}`);
    console.log(`  → tema dosyasını düzenle, kaydet = tarayıcı otomatik yenilenir (livereload)`);

    if (flags.dry) {
      console.log("(--dry: sunucu başlatılmadı)");
      return;
    }

    const handle = startDevServer({
      dir: themeDir,
      url: creds.url,
      token: creds.token,
      port,
      onError: (err) => {
        if (err && err.code === "EADDRINUSE") {
          console.error(`Port ${port} kullanımda. Farklı port: blocofy theme dev --port <n>`);
        } else {
          console.error(`Sunucu hatası: ${err?.message ?? err}`);
        }
        process.exit(1);
      },
    });
    const shutdown = () => {
      handle.close();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    return;
  }

  // Monorepo fallback (Faz 2 v1): renderer'ı THEME_DEV_DIR ile spawn et.
  const root = findMonorepoRoot(dirname(fileURLToPath(import.meta.url)));
  if (!root) {
    console.error(
      "Ne giriş yapıldı ne de monorepo bulundu.\n" +
        "External kullanım için: `blocofy login` (admin'den dev token al).\n" +
        "Monorepo içinde çalışıyorsan pnpm-workspace.yaml görünür bir dizinden çalıştır.",
    );
    process.exit(1);
  }

  console.log(`blocofy theme dev (monorepo)`);
  console.log(`  tema dizini : ${themeDir}`);
  console.log(`  renderer    : ${root} (THEME_DEV_DIR ile)`);
  console.log(`  önizleme    : http://<slug>.localhost:3003  (örn. test-cafe.localhost)`);
  console.log(`  → tema dosyasını düzenle, tarayıcıyı yenile = instant preview (gerçek içerikle)`);

  if (flags.dry) {
    console.log("(--dry: renderer başlatılmadı)");
    return;
  }

  const child = spawn("pnpm", ["--filter", "renderer", "dev"], {
    cwd: root,
    env: { ...process.env, THEME_DEV_DIR: themeDir },
    stdio: "inherit",
  });
  child.on("exit", (code) => process.exit(code ?? 0));
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
  themeDev(rest.slice(1));
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
  console.error(`Bilinmeyen komut: ${args.join(" ")}\n`);
  printHelp();
  process.exit(1);
}
