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
import { pullTheme, pushTheme } from "../lib/theme-sync.mjs";

const VERSION = "0.1.0";
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

Usage:
  blocofy login [--url <url>] [--token <bcf_…>]
                            Save your platform URL + dev token (~/.blocofy/credentials.json).
                            Get a token from your admin panel: Settings → Theme CLI tokens.
  blocofy theme dev [dir]   Local dev server — local theme + live data with instant preview.
                            Edit a file and the browser reloads automatically. dir defaults to cwd.
                            --port <n> (default 3030)
  blocofy theme pull [dir]  Download the live theme to disk. dir defaults to cwd.
  blocofy theme push [dir]  Write the local theme to the live site (create/update; no delete).
  blocofy --version
  blocofy --help

The CLI does not build assets — generate them with your own tools (npm/Vite/Tailwind);
the platform serves plain Liquid + static assets.`);
}

async function login(rest) {
  const flags = parseFlags(rest);
  let url = typeof flags.url === "string" ? flags.url : "";
  let token = typeof flags.token === "string" ? flags.token : "";

  if (!url || !token) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      if (!url) url = (await rl.question("Platform/site URL (e.g. https://store.myblocofy.com): ")).trim();
      if (!token) token = (await rl.question("Dev token (bcf_…): ")).trim();
    } finally {
      rl.close();
    }
  }

  url = url.replace(/\/+$/, "");
  if (!/^https?:\/\//.test(url)) {
    console.error("Invalid URL — must start with http(s)://");
    process.exit(1);
  }
  if (!token.startsWith("bcf_")) {
    console.error("Invalid token — must start with bcf_ (admin panel: Settings → Theme CLI tokens).");
    process.exit(1);
  }

  saveCredentials({ url, token });
  console.log(`Saved credentials: ${credentialsPath()}`);
  console.log(`Now run, in your theme directory: blocofy theme dev`);
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
  const positional = rest.filter((a) => !a.startsWith("--"));
  const dir = resolve(positional[0] ?? process.cwd());
  if (!existsSync(dir)) {
    console.error(`Theme directory not found: ${dir}`);
    process.exit(1);
  }
  const creds = requireCreds();
  const result = await pushTheme({ dir, url: creds.url, token: creds.token });
  const extra = result.skippedDeletes
    ? `, ${result.skippedDeletes} remote file(s) absent locally (not deleted)`
    : "";
  console.log(`Push: ${result.created} created, ${result.updated} updated${extra}.`);
}

function themeDev(rest) {
  const flags = parseFlags(rest);
  const positional = rest.filter((a) => !a.startsWith("--"));
  const themeDir = resolve(positional[0] ?? process.cwd());

  if (!existsSync(themeDir)) {
    console.error(`Theme directory not found: ${themeDir}`);
    process.exit(1);
  }

  const creds = requireCreds();
  const port = Number(flags.port) || 3030;

  console.log(`blocofy theme dev`);
  console.log(`  theme dir : ${themeDir}`);
  console.log(`  platform  : ${creds.url}`);
  console.log(`  token     : ${creds.token.slice(0, 8)}… (${creds.source})`);
  console.log(`  preview   : http://localhost:${port}`);
  console.log(`  → edit a theme file and save = the browser reloads automatically (livereload)`);

  if (flags.dry) {
    console.log("(--dry: server not started)");
    return;
  }

  const handle = startDevServer({
    dir: themeDir,
    url: creds.url,
    token: creds.token,
    port,
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
    handle.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
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
  console.error(`Unknown command: ${args.join(" ")}\n`);
  printHelp();
  process.exit(1);
}
