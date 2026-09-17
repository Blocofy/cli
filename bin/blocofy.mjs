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
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

import { parseArgs } from "../lib/args.mjs";
import { checkPages, migrateLayout, pullContent, pushContent } from "../lib/content-sync.mjs";
import { PagesCliError, formatDiagnostic } from "../lib/page-files.mjs";
import {
  CredentialsError,
  ENV_CONTEXT,
  credentialsPath,
  defaultSecretStoreName,
  envContext,
  loadStore,
  readSecrets,
  removeSecrets,
  saveStore,
  writeSecret,
} from "../lib/credentials.mjs";
import { printError, printTarget, printWarning, redact, registerSecret, targetData } from "../lib/output.mjs";
import {
  CONTEXT_NAME_RE,
  TargetError,
  compareOrigin,
  enforceBindingPolicy,
  findBinding,
  precheckContext,
  resolveContext,
  verifyApi,
  verifyDev,
  verifyTarget,
  writeBinding,
} from "../lib/target.mjs";
import { startDevServer } from "../lib/dev-server.mjs";
import { readLocalTemplates } from "../lib/local-theme.mjs";
import { CliRefusal, DEFAULT_API_URL, decidePageMediaUses, fetchPageMediaUses, isValidApiKey } from "../lib/media-uses.mjs";
import { githubNote, healthAdvice, retryNotice, statusLine, syncScopeNote } from "../lib/messages.mjs";
import { promptSecret } from "../lib/secret-prompt.mjs";
import { diffTheme, fetchCanonicalSupport, fetchDevSession, fetchSiteStatus, publishInstance, pullTheme, pushTheme, renameInstance } from "../lib/theme-sync.mjs";
import { isAffirmative, livePushDecision, resolvePushMode } from "../lib/confirm.mjs";
import { hyperlink, openUrl } from "../lib/term.mjs";
import { isValidToken, isValidUrl, normalizeUrl } from "../lib/validate.mjs";

const VERSION = createRequire(import.meta.url)("../package.json").version;
const args = process.argv.slice(2);

// 0.5.0 güvenlik sıkılaştırması: her komutun kabul ettiği bayraklar açık bir listedir. Bilinmeyen bir
// bayrak YAZIMSIZ çıkışla reddedilir (eskiden sonraki token'ı değer olarak yutup hedef dizini sessizce
// kaydırıyordu). `--confirm` ve `--dry` belgelenmemiş ama gerçek bayraklardır; `--dry` (theme dev'in
// sunucu-başlatmama kancası) `--dry-run`'dan (sunucu-tarafı doğrulama) FARKLIDIR, alias değildir.
// 0.8.0: `login --api-key` DEĞERSİZ bayraktır (parser'da boolean) — sır gizli prompt'tan ya da
// BLOCOFY_API_KEY'den gelir, argv'ye asla girmez. `pages media-uses` / `media-decide` v1 API komutlarıdır.
const KNOWN = {
  login: ["url", "token", "api-key", "api-url", "keychain"],
  pages: ["decisions", "expected-revision-id", "expected-version", "json"],
  themePull: ["draft", "instance"],
  themePush: ["diff", "draft", "instance", "name", "live", "yes", "confirm", "dry-run", "validate", "idempotency-key", "prune"],
  themeDev: ["port", "dry", "no-sync", "name"],
  themePublish: ["instance"],
  themeRename: ["name"],
  content: [],
  pagesPull: ["strict"],
  pagesPush: ["dry-run", "strict"],
  pagesCheck: ["strict"],
  pagesMigrate: ["dry-run", "write", "strict"],
};
// CF-T1/T2: every command accepts the global `--context <name>` and `--json` (machine-readable refusals).
function parseArgsOrExit(rest, known) {
  const parsed = parseArgs(rest, new Set([...known, "context", "json", "help", "version"]));
  if (parsed.unknownFlag) {
    printError({ code: "USAGE_UNKNOWN_FLAG", message: `Unknown flag ${parsed.unknownFlag}. Nothing was written. See \`blocofy --help\`.`, details: { flag: parsed.unknownFlag } }, { json: args.includes("--json") });
    process.exit(1);
  }
  if (parsed.flags.context !== undefined && (typeof parsed.flags.context !== "string" || !CONTEXT_NAME_RE.test(parsed.flags.context))) {
    console.error("--context needs a context name (letters, digits, . _ -). Nothing was written.");
    process.exit(1);
  }
  return parsed;
}

/** Human label for a resolved site: "Name (slug)" or just the slug. */
function siteLabel(site) {
  if (!site) return "";
  return site.name ? `${site.name} (${site.slug})` : site.slug;
}

function printHelp() {
  console.log(`blocofy — Blocofy theme development CLI (v${VERSION})

Develop your theme locally against live data, preview it three ways, and publish.

Usage
  blocofy login [--context <name>] [--url <url>] [--token <bcf_…>] [--keychain]
      Verify a dev token against its site (GET /api/dev/whoami) and save it as a named
      context (default name: the site's slug). Nothing is saved if verification fails.
      Get a token from the admin panel → Settings → Theme CLI tokens.
        --keychain   keep the secret in the macOS keychain (or BLOCOFY_SECRET_STORE=keychain);
                     default: ~/.blocofy/secrets.json (0600)

  blocofy login --api-key [--context <name>] [--api-url <url>]
      Verify a v1 API key (blcf_live_…, GET /api/v1/ping) and add it to a context. The key is
      read from a HIDDEN prompt — the flag takes no value. If the context already has a dev
      token for another site, nothing is saved (TARGET_CREDENTIAL_MISMATCH).
        --api-url <url>  API origin (default https://app.blocofy.com)
      Non-interactive shells: set BLOCOFY_API_KEY + BLOCOFY_API_URL instead.

  blocofy contexts [--json]          list saved contexts (never prints secrets)
  blocofy use <name>                 default context for read-only commands outside a project
  blocofy logout --context <name>    remove a context and its secrets
  blocofy link [dir] --context <name> [--adopt]
      Bind a project directory to the context's (verified) site: writes .blocofy/project.json
      (commit it), .blocofy/local.json (your context; git-ignored) and .blocofy/.gitignore.
      Refuses to rebind a directory bound to another site unless --adopt.
  blocofy target [dir] [--context <name>] [--json]
      Show which site a command in [dir] would hit (verified), without writing anything.

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
        --draft      pull the draft theme (what 'theme dev' syncs into) instead of live;
                     creates the draft if missing, so it needs a bound project
        --instance <handle>  pull a specific theme by its handle (from the admin
                             panel theme card, or \`blocofy status\`)

  blocofy theme push [dir] [--live] [--yes] [--instance <handle>] [--prune]
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
        --dry-run    validate on the server WITHOUT writing (auth + snapshot + Liquid check)
        --validate   alias for --dry-run (validate only, nothing written)
        --diff       show what a push WOULD change vs the target (read-only), then stop
        --idempotency-key <k>  attach an idempotency key so a retried push is not double-applied
        --prune      also REMOVE target files that no longer exist locally (lists them first;
                     on the live theme asks to confirm — non-interactive shells must add --yes)

  blocofy theme rename <handle> <new name>
      Rename a theme (the name is just a label). Works on any of your themes,
      including the live one. Handle comes from the panel theme card or 'blocofy status'.

  blocofy theme publish [--instance <handle>]
      Publish a draft theme to the LIVE site: it REPLACES the live theme for every visitor.
      With no flag, publishes the draft that 'theme dev' / 'theme push --draft' writes into.
      The server refuses to publish a theme that has no pages (it would 404); preview first.
        --instance <handle>  publish a specific theme (handle from the panel / status)

  blocofy status
      Show the live theme, page distribution per instance, drafts, and a health flag
      (ok / live_instance_empty / pages_split). For a problem it names the theme holding the
      pages, the missing pages, why, and safe preview-first next steps — never a one-line fix.

  blocofy pages pull [dir] [--strict]
      Download published pages, one folder per language:
        pages/<locale>/index.json                 the home page ("/")
        pages/<locale>/routes/<path>/index.json   every other page ("/about" → routes/about/index.json)
      Files from the old layout (pages/<slug>.json) are reported, never deleted or overwritten.
      If the site cannot export every published page, nothing is written, every reason is
      printed (PAGES_EXPORT_INCOMPLETE) and the exit code is 2 (--strict: warnings exit 1).

  blocofy pages push [dir] [--dry-run] [--strict]
      Write pages/**.json to the site. Updates EXISTING pages only — never creates or
      deletes a page; unchanged pages are skipped. Every file is checked first: if any
      file is invalid, two files point at the same page, or a folder's language does not
      match the file's "locale", NO page is changed. If publishing then stops unexpectedly
      (PAGES_APPLY_FAILED or another publish error), some pages may already be applied: the per-file
      result printed is authoritative, the exit code is non-zero, and running the push again is safe.
      --dry-run: check on the server, write nothing.
      Needs a platform that supports language folders (else PAGES_SERVER_UPGRADE_REQUIRED).

  blocofy pages check [dir] [--strict]
      Check page files. Offline: paths, JSON, layout, duplicates. Logged in: also the
      site's languages and the server-side dry run. Exit 1 on errors (--strict: warnings too).

  blocofy pages migrate-layout [dir] [--dry-run | --write] [--strict]
      Move old-layout files (pages/<slug>.json) to language folders. --dry-run (default)
      prints the plan; --write moves only proven files. Any ambiguity or conflict: nothing
      is moved, exit 1. Files without "locale" use the site's default language (login needed;
      with --write outside a bound project only an explicit --context/env credentials are used).

  blocofy pages media-uses <page-handle> [--json]
      List a page's localized-media decisions on its newest DRAFT (v1 API, pages:read).
      Prints the draft's revision id/version needed by media-decide. --json: raw response.

  blocofy pages media-decide <page-handle> --decisions <file.json>
                             [--expected-revision-id <n> --expected-version <n>] [--json]
      Apply one or more media decisions to the page's draft atomically (v1 API, pages:write).
      The file is { "decisions": [ { path, facet, decision, target_asset?, alt?, caption?,
      decorative?, idempotency_key?, witness? } ] } (max 20). Without the two --expected-*
      flags the CLI first GETs the draft and uses its current revision id/version; items
      without an idempotency_key get a random UUID.
      Transient failures (429/502/503/504, network) are retried: every item carries an
      idempotency key before the first attempt, so a retry replays the same batch.
      Exit codes: 0 applied (or "No changes" when every item was already recorded);
      1 usage/auth/network/5xx; 2 the server refused (4xx) — the {error} JSON
      is printed to stderr.

  blocofy settings pull [dir] / settings push [dir]
      Download / upload config/settings.json (theme tokens/settings + color schemes).

  blocofy --version
  blocofy --help

Examples
  blocofy login --url https://store.myblocofy.com --token bcf_xxxxxxxx     (context "store")
  blocofy theme pull store-theme --context store && cd store-theme && blocofy theme dev
  blocofy link ~/code/store-theme --context store     (an existing checkout)
  blocofy theme push && blocofy theme publish          (inside the bound project)
  blocofy target && blocofy status
  blocofy login --api-key --context store
  blocofy pages media-uses pg_abc123 --json
  blocofy pages media-decide pg_abc123 --decisions decisions.json

Targets (which site a command talks to)
  Every remote command verifies its site first and prints a Target block on stderr.
  The context is chosen in this order: --context → BLOCOFY_CONTEXT → env credentials
  (BLOCOFY_URL+BLOCOFY_TOKEN and/or BLOCOFY_API_URL+BLOCOFY_API_KEY) → .blocofy/local.json
  → the one saved context matching the project's site → (terminal) pick from the matches.
  Inside a bound project \`use\` is ignored. Commands that change a site (theme push/publish/
  rename/dev sync, pages push, settings push, pages media-decide) need a bound project;
  pulls into a new empty directory bind it. A wrong project/site pairing changes nothing.
  A binding made against an older server has no platform origin: it still matches the same site
  (one warning; run \`blocofy link --adopt\` to record it). A server that reports no origin cannot
  serve a binding that records one (TARGET_UNVERIFIED).
  Exit codes (every command): 0 ok · 1 usage/network/5xx/local check · 2 server refusal (HTTP 4xx)
  · 3 target/binding refusal.
  --json: every failure prints {"error":{"code","message","details"}} as the LAST stderr line; the
  target block ({"target":…}) and any warning lines are printed on stderr before it.
  Retries: network errors and HTTP 429/502/503/504 are retried up to 3 times (Retry-After honoured,
  max 30s per wait; else 0.3s/0.9s/2s), resending the identical request (pages push carries one
  x-idempotency-key per push). HTTP 500 is never retried. Each retry prints a notice on stderr.

Auth: ~/.blocofy/credentials.json (contexts, no secrets) + ~/.blocofy/secrets.json (0600) or the
macOS keychain. A pre-0.10 credentials file is migrated on first use (backup:
~/.blocofy/credentials.v1.bak.json — copy it back to roll back).
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

// ── contexts, login, binding (CF-T1/T2, contract C1/C2) ─────────────────────────────────────────────────────

const JSON_MODE = args.includes("--json");
/** CF-T3: every retried request (lib/http.mjs) announces itself on stderr — never silent. */
const onRetry = (info) => console.error(retryNotice(info));
const retry = { onRetry };

/**
 * CF-T9 — the one failure exit (contract C2). Exit codes: 0 ok · 1 usage/network/5xx/local validation · 2 server
 * refusal (HTTP 4xx) · 3 target/binding refusal. Human output goes first (page diagnostics, per-file results); the
 * shared, redacted `printError` line is always LAST on stderr — under --json it is the `{"error":{code,message,details}}`
 * envelope (the target block, a `{"target":…}` line, was printed before it).
 */
function exitCodeFor(error) {
  if (error instanceof TargetError || error instanceof CredentialsError) return error.exitCode ?? 1;
  if (error instanceof CliRefusal) return 2;
  const status = Number(error?.status);
  return status >= 400 && status < 500 ? 2 : 1;
}

function envelopeFor(error) {
  if (error instanceof CliRefusal) {
    const e = error.error ?? {};
    return { code: e.code ?? `http_${error.status}`, message: e.message ?? error.message, details: e.details ?? {} };
  }
  const status = Number.isFinite(Number(error?.status)) && error?.status != null ? Number(error.status) : null;
  const code = typeof error?.code === "string" && error.code ? error.code : status ? `HTTP_${status}` : error instanceof TypeError ? "NETWORK_ERROR" : "ERROR";
  const details = { ...(error?.details ?? {}) };
  if (status) details.status = status;
  if (error instanceof PagesCliError) {
    if (error.diagnostics?.length) details.diagnostics = error.diagnostics;
    if (Array.isArray(error.pages)) details.pages = error.pages;
  }
  return { code, message: error?.message || String(error), details };
}

function failAndExit(error) {
  const code = exitCodeFor(error);
  if (error instanceof PagesCliError && !JSON_MODE) {
    if (error.diagnostics?.length) reportPageDiagnostics(error.diagnostics);
  }
  if (error instanceof PagesCliError && Array.isArray(error.pages) && error.pages.length && !JSON_MODE) {
    console.error("Per-file result:");
    for (const p of error.pages) console.error(`  ${p.outcome ?? p.action}  ${p.path}`);
  }
  if (error instanceof CliRefusal && !JSON_MODE) {
    // Existing media-* contract: the server's {error} JSON verbatim on stderr.
    process.stderr.write(redact(JSON.stringify({ error: error.error })) + "\n");
  } else if (error instanceof PagesCliError && !JSON_MODE) {
    process.stderr.write(redact(`${error.diagnostics?.length ? "\n" : ""}error [${error.code}]:\n    ${error.message}`) + "\n");
  } else if (!JSON_MODE && !(error instanceof TargetError || error instanceof CredentialsError) && !(typeof error?.code === "string" && error.code)) {
    process.stderr.write(redact(error?.message || String(error)) + "\n");
  } else {
    printError(envelopeFor(error), { json: JSON_MODE });
  }
  process.exit(code);
}

function contextNameOrExit(name) {
  if (name === ENV_CONTEXT || !CONTEXT_NAME_RE.test(name)) {
    throw new TargetError("TARGET_CONTEXT_INVALID", `"${name}" cannot be used as a context name (letters, digits, . _ -; "env" is reserved).`, { context: name }, 1);
  }
  return name;
}

/**
 * A new pair may only join a context whose other pair is for the same site. `existing` is the stored context;
 * `identity` the freshly verified one. Checks the recorded site, else verifies the other pair live.
 */
async function assertPairFitsContext(name, existing, identity, otherKind) {
  if (!existing) return;
  const mismatch = (otherSite) => {
    const code = existing[otherKind] ? "TARGET_CREDENTIAL_MISMATCH" : "TARGET_SITE_MISMATCH";
    throw new TargetError(
      code,
      `Context "${name}" is for site ${otherSite.slug ?? otherSite.id}, but these credentials are for ${identity.site.slug ?? identity.site.id}. Nothing was saved. Use another --context name (or \`blocofy logout --context ${name}\` first).`,
      { context: name, context_site_id: otherSite.id, new_site_id: identity.site.id },
    );
  };
  if (existing.site) {
    const o = compareOrigin(existing.platform_origin, identity.platformOrigin);
    // "upgrade" (recorded null, server now reports one): this login records it.
    if (String(existing.site.id) !== String(identity.site.id) || o === "mismatch" || o === "unproven") mismatch(existing.site);
    return;
  }
  if (!existing[otherKind]) return;
  const secrets = readSecrets(name, existing);
  if (otherKind === "dev" && secrets.devToken) {
    registerSecret(secrets.devToken);
    const other = await verifyDev({ url: existing.dev.url, token: secrets.devToken, retry });
    if (String(other.site.id) !== String(identity.site.id) || other.platformOrigin !== identity.platformOrigin) mismatch(other.site);
  } else if (otherKind === "api" && secrets.apiKey) {
    registerSecret(secrets.apiKey);
    const other = await verifyApi({ url: existing.api.url, apiKey: secrets.apiKey, retry });
    if (String(other.site.id) !== String(identity.site.id) || other.platformOrigin !== identity.platformOrigin) mismatch(other.site);
  }
}

/** Save one verified pair into a context (secret first, then the context file). */
function saveVerifiedPair(name, kind, { url, secret, identity, storeName }) {
  const store = loadStore();
  const existing = store.contexts[name];
  writeSecret(name, kind, storeName, secret);
  if (existing?.[kind] && existing[kind].secret.store !== storeName) {
    try {
      removeSecrets(name, { [kind]: existing[kind] });
    } catch {
      /* the old copy stays in the other store; the context now points at the new one */
    }
  }
  const site = { id: identity.site.id, slug: identity.site.slug ?? existing?.site?.slug ?? null, name: identity.site.name ?? existing?.site?.name ?? null, domain: identity.site.domain ?? existing?.site?.domain ?? null };
  store.contexts[name] = {
    ...(existing ?? {}),
    platform_origin: identity.platformOrigin,
    site,
    [kind]: { url, secret: { store: storeName } },
    verified_at: new Date().toISOString(),
  };
  if (!store.current_context) store.current_context = name;
  saveStore(store);
}

/**
 * `blocofy login --api-key [--context <n>] [--api-url <url>]` — v1 API key login (0.8.0, D3 §4.7; CF-T1).
 * The key is NEVER taken from argv: a hidden prompt on a TTY, BLOCOFY_API_KEY otherwise. GET /api/v1/ping must
 * succeed before anything is saved. No message printed by this function ever contains the key.
 */
async function loginApiKey(flags, positionals) {
  if (positionals.length > 0 || flags.url !== undefined || flags.token !== undefined) {
    console.error("`login --api-key` takes no value and no --url/--token: the API key is read from a hidden prompt (or BLOCOFY_API_KEY). Nothing was written.");
    process.exit(1);
  }
  let apiUrl;
  if (typeof flags["api-url"] === "string") apiUrl = normalizeUrl(flags["api-url"]);
  else if (process.env.BLOCOFY_API_URL) apiUrl = normalizeUrl(process.env.BLOCOFY_API_URL);
  else apiUrl = DEFAULT_API_URL;
  if (!isValidUrl(apiUrl)) {
    console.error("Invalid --api-url — must be a valid http(s):// URL. Nothing was written.");
    process.exit(1);
  }

  let apiKey = null;
  if (process.stdin.isTTY) {
    apiKey = await promptSecret("API key (blcf_live_…, hidden): ");
    if (apiKey === null) {
      console.error("Cancelled. Nothing was written.");
      process.exit(1);
    }
    apiKey = apiKey.trim();
  } else if (process.env.BLOCOFY_API_KEY) {
    apiKey = process.env.BLOCOFY_API_KEY.trim();
  } else {
    console.error("Non-interactive shell: `login --api-key` needs a terminal for the hidden prompt. Set BLOCOFY_API_KEY (+ BLOCOFY_API_URL) instead. Nothing was written.");
    process.exit(1);
  }
  if (!isValidApiKey(apiKey)) {
    console.error("Invalid API key — a v1 key starts with blcf_live_ (a bcf_ dev token is not accepted for the v1 API). Nothing was written.");
    process.exit(1);
  }
  registerSecret(apiKey);
  const storeName = defaultSecretStoreName({ keychain: Boolean(flags.keychain) });

  const identity = await verifyApi({ url: apiUrl, apiKey, retry });
  const name = contextNameOrExit(typeof flags.context === "string" ? flags.context : identity.site.slug ?? "");
  await assertPairFitsContext(name, loadStore().contexts[name], identity, "dev");
  saveVerifiedPair(name, "api", { url: apiUrl, secret: apiKey, identity, storeName });
  console.log(`✓ API key saved to context "${name}" → ${credentialsPath()} (API: ${apiUrl})`);
  console.log(`  Site: ${siteLabel(identity.site) || identity.site.id}`);
  console.log("Next: blocofy pages media-uses <page-handle>");
}

async function login(rest) {
  const { flags, positionals } = parseArgsOrExit(rest, KNOWN.login);
  if (flags["api-key"] || flags["api-url"] !== undefined) {
    if (!flags["api-key"]) {
      console.error("--api-url is only used with --api-key. Nothing was written.");
      process.exit(1);
    }
    await loginApiKey(flags, positionals);
    return;
  }
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
  registerSecret(token);
  const storeName = defaultSecretStoreName({ keychain: Boolean(flags.keychain) });

  // CF-T1: the token's REAL site (resolved server-side from the token) must be verified BEFORE saving — a
  // wrong-tenant token or an unreachable platform saves nothing (TARGET_UNVERIFIED, exit 3).
  const identity = await verifyDev({ url, token, retry });
  const name = contextNameOrExit(typeof flags.context === "string" ? flags.context : identity.site.slug);
  await assertPairFitsContext(name, loadStore().contexts[name], identity, "api");
  saveVerifiedPair(name, "dev", { url, secret: token, identity, storeName });
  console.log(`✓ Saved context "${name}" → ${credentialsPath()}`);
  console.log(`  Site: ${siteLabel(identity.site)} — commands using context "${name}" target this site.`);
  console.log(`Next: bind a project directory:  blocofy link <dir> --context ${name}   (or pull into an empty one: blocofy theme pull <dir> --context ${name})`);
}

async function contextsCommand(rest) {
  const { positionals } = parseArgsOrExit(rest, []);
  if (positionals.length) throw new TargetError("USAGE", "Usage: blocofy contexts [--json]", {}, 1);
  const store = loadStore();
  const rows = Object.entries(store.contexts).map(([name, c]) => ({
    name,
    current: store.current_context === name,
    site: c.site ?? null,
    platform_origin: c.platform_origin ?? null,
    dev: c.dev ? { url: c.dev.url, store: c.dev.secret.store } : null,
    api: c.api ? { url: c.api.url, store: c.api.secret.store } : null,
    verified_at: c.verified_at ?? null,
  }));
  if (JSON_MODE) {
    console.log(JSON.stringify({ current_context: store.current_context, contexts: rows }, null, 2));
    return;
  }
  if (rows.length === 0) {
    console.log("No saved contexts. Run `blocofy login`.");
    return;
  }
  for (const r of rows) {
    const site = r.site ? `${siteLabel(r.site)} · ${r.site.id}` : "(not verified yet)";
    const pairs = [r.dev ? `dev ${r.dev.url} [${r.dev.store}]` : null, r.api ? `api ${r.api.url} [${r.api.store}]` : null].filter(Boolean).join(", ");
    console.log(`${r.current ? "*" : " "} ${r.name}  ${site}  ${pairs}`);
  }
}

async function useCommand(rest) {
  const { positionals } = parseArgsOrExit(rest, []);
  const name = positionals[0];
  if (!name || positionals.length > 1) throw new TargetError("USAGE", "Usage: blocofy use <context>", {}, 1);
  const store = loadStore();
  if (!store.contexts[name]) throw new TargetError("TARGET_CONTEXT_UNKNOWN", `No context named "${name}". List them with \`blocofy contexts\`.`, { context: name });
  store.current_context = name;
  saveStore(store);
  console.log(`✓ Default context for read-only commands outside a project: ${name}`);
  console.log("  (Inside a bound project the project's site decides; `use` never retargets it.)");
}

async function logoutCommand(rest) {
  const { flags, positionals } = parseArgsOrExit(rest, []);
  const name = typeof flags.context === "string" ? flags.context : null;
  if (!name || positionals.length) throw new TargetError("USAGE", "Usage: blocofy logout --context <name>", {}, 1);
  const store = loadStore();
  const ctx = store.contexts[name];
  if (!ctx) throw new TargetError("TARGET_CONTEXT_UNKNOWN", `No context named "${name}".`, { context: name });
  removeSecrets(name, ctx);
  delete store.contexts[name];
  if (store.current_context === name) store.current_context = null;
  saveStore(store);
  console.log(`✓ Removed context "${name}" and its secrets.`);
}

async function linkCommand(rest) {
  const { flags, positionals } = parseArgsOrExit(rest, ["adopt"]);
  const dir = resolve(positionals[0] ?? process.cwd());
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new TargetError("USAGE", `Directory not found: ${dir}`, { dir }, 1);
  const envCtx = envContext();
  const flagContext = typeof flags.context === "string" ? flags.context : null;
  if (!flagContext && !process.env.BLOCOFY_CONTEXT && !envCtx) {
    throw new TargetError("TARGET_CONTEXT_REQUIRED", "`blocofy link` needs the context to bind: pass --context <name> (see `blocofy contexts`).", {});
  }
  const resolved = await resolveContext({ flagContext, envContextName: process.env.BLOCOFY_CONTEXT || null, envCtx, getStore: () => loadStore(), binding: null, commandClass: "read" });
  const secrets = resolved.env ? resolved.env.secrets : readSecrets(resolved.name, resolved.context);
  registerSecret(secrets.devToken);
  registerSecret(secrets.apiKey);
  const identity = await verifyTarget({ resolved, secrets, binding: null, retry });
  for (const w of identity.warnings ?? []) printWarning(w, { json: JSON_MODE });

  let own = null;
  if (existsSync(join(dir, ".blocofy", "project.json"))) {
    try {
      own = findBinding(dir);
    } catch (error) {
      // Review M2: --adopt replaces an unreadable binding (the TARGET_BINDING_INVALID message recommends it).
      if (!(flags.adopt && error instanceof TargetError && error.code === "TARGET_BINDING_INVALID")) throw error;
    }
  }
  const ownOrigin = own ? compareOrigin(own.project.platform_origin, identity.platformOrigin) : "match";
  if (own && (String(own.project.site_id) !== String(identity.site.id) || (ownOrigin !== "match" && ownOrigin !== "upgrade")) && !flags.adopt) {
    throw new TargetError(
      "TARGET_SITE_MISMATCH",
      `${dir} is already bound to site ${own.project.site_slug ?? own.project.site_id}; context "${resolved.name}" is for ${identity.site.slug ?? identity.site.id}. Nothing was written. Pass --adopt to rebind it.`,
      { dir, binding_site_id: own.project.site_id, remote_site_id: identity.site.id },
    );
  }
  // Review M3: an env-context link owns no local.json; a stale one (naming another context) is removed.
  const projectPath = writeBinding(dir, { site: identity.site, platformOrigin: identity.platformOrigin, contextName: resolved.name, staleLocal: true });
  recordVerifiedSite(resolved, identity);
  console.log(`✓ Bound ${dir} to ${siteLabel(identity.site) || identity.site.id} (${identity.site.id}) via context "${resolved.name}".`);
  console.log(`  ${relative(process.cwd(), projectPath) || projectPath} — commit it; .blocofy/local.json stays private (git-ignored).`);
}

async function targetCommand(rest) {
  const { flags, positionals } = parseArgsOrExit(rest, []);
  const dir = resolve(positionals[0] ?? process.cwd());
  const t = await prepareTarget({ command: "target", commandClass: "read", dir, flags, needs: "any", mode: "read", record: false, quiet: true });
  if (JSON_MODE) console.log(JSON.stringify({ target: t.display }, null, 2));
  else printTarget(t.display, { stream: process.stdout });
}

/** An unverified (migrated) named context gets the verified site recorded once. */
function recordVerifiedSite(resolved, identity) {
  if (resolved.env || resolved.context.site) return;
  const store = loadStore();
  const ctx = store.contexts[resolved.name];
  if (!ctx || ctx.site) return;
  ctx.site = { id: identity.site.id, slug: identity.site.slug ?? null, name: identity.site.name ?? null, domain: identity.site.domain ?? null };
  ctx.platform_origin = identity.platformOrigin;
  ctx.verified_at = new Date().toISOString();
  saveStore(store);
}

async function promptContext(candidates) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    process.stderr.write(`Several saved contexts match this project's site:\n${candidates.map((c, i) => `  ${i + 1}) ${c}`).join("\n")}\n`);
    const answer = (await rl.question("Use which context? [number] ")).trim();
    return candidates[Number(answer) - 1] ?? null;
  } finally {
    rl.close();
  }
}

/**
 * The one gate every remote command passes BEFORE its first request (contract C2): binding policy → context
 * resolution → offline precheck → required pair → remote identity (both pairs when present) → binding match →
 * target block. Throws TargetError / CredentialsError; never returns an unverified target.
 *
 * `needs`: "dev" | "api" | "any". Returns `{ name, dev, api, identity, binding, newBinding, display }`.
 */
async function prepareTarget({ command, commandClass, dir, flags, needs, mode, record = true, quiet = false, resolveClass = commandClass }) {
  const binding = findBinding(dir);
  const { newBinding } = enforceBindingPolicy({ commandClass, binding, dir, command });
  const envCtx = envContext();
  let cachedStore = null;
  const resolved = await resolveContext({
    flagContext: typeof flags.context === "string" ? flags.context : null,
    envContextName: process.env.BLOCOFY_CONTEXT || null,
    envCtx,
    getStore: () => (cachedStore ??= loadStore()),
    binding,
    commandClass: resolveClass,
    isTTY: Boolean(process.stdin.isTTY && process.stderr.isTTY),
    prompt: promptContext,
  });
  precheckContext({ binding, resolved });
  const secrets = resolved.env ? resolved.env.secrets : readSecrets(resolved.name, resolved.context);
  registerSecret(secrets.devToken);
  registerSecret(secrets.apiKey);

  const hasDev = Boolean(resolved.context.dev && secrets.devToken);
  const hasApi = Boolean(resolved.context.api && secrets.apiKey);
  if (needs === "dev" && !hasDev) {
    throw new TargetError("LOGIN_REQUIRED", `Login required: context "${resolved.name}" has no dev token. Run \`blocofy login${resolved.env ? "" : ` --context ${resolved.name}`}\` (or set BLOCOFY_URL + BLOCOFY_TOKEN).`, { context: resolved.name }, 1);
  }
  if (needs === "api") {
    if (!hasApi) {
      throw new TargetError("LOGIN_REQUIRED", `API key required: run \`blocofy login --api-key\` (or set BLOCOFY_API_KEY + BLOCOFY_API_URL). The dev token (bcf_) is not accepted for the v1 API.`, { context: resolved.name }, 1);
    }
    if (!isValidApiKey(secrets.apiKey)) {
      throw new TargetError("LOGIN_REQUIRED", `The API key of context "${resolved.name}" is not a v1 key — it must start with blcf_live_. Run \`blocofy login --api-key\`.`, { context: resolved.name }, 1);
    }
  }

  const identity = await verifyTarget({ resolved, secrets, binding, retry });
  for (const w of identity.warnings ?? []) printWarning(w, { json: JSON_MODE });
  if (record) recordVerifiedSite(resolved, identity);

  const url = needs === "api" ? resolved.context.api?.url : resolved.context.dev?.url ?? resolved.context.api?.url;
  const bindingLabel = binding ? relative(process.cwd(), binding.projectPath) || binding.projectPath : newBinding ? "none (new pull)" : "none";
  const display = targetData({ site: identity.site, url, contextName: resolved.name, bindingLabel, operation: `${command} · ${mode}` });
  if (!quiet) printTarget(display, { json: JSON_MODE });
  return {
    name: resolved.name,
    dev: hasDev ? { url: resolved.context.dev.url, token: secrets.devToken } : null,
    api: hasApi ? { apiUrl: resolved.context.api.url, apiKey: secrets.apiKey } : null,
    identity,
    binding,
    newBinding,
    display,
  };
}

/** After a successful pull into a new directory: record provenance (project.json + local.json + .gitignore). */
function bindAfterPull(target, dir) {
  if (!target.newBinding) return;
  writeBinding(dir, { site: target.identity.site, platformOrigin: target.identity.platformOrigin, contextName: target.name });
  console.log(`  Bound ${dir} to ${siteLabel(target.identity.site) || target.identity.site.id} (.blocofy/project.json).`);
}


async function themePull(rest) {
  const { flags, positionals } = parseArgsOrExit(rest, KNOWN.themePull);
  const dir = resolve(positionals[0] ?? process.cwd());
  const draft = Boolean(flags.draft);
  const instance = typeof flags.instance === "string" ? flags.instance : null;
  const what = instance ? `instance ${instance}` : draft ? "draft" : "live";
  // Review M1: a draft pull provisions the draft server-side (`?draft=1`), so it is a remote mutation: binding required.
  const target = await prepareTarget({ command: draft ? "theme pull --draft" : "theme pull", commandClass: draft ? "remote-mutation" : "local-write", dir, flags, needs: "dev", mode: what });
  const { count } = await pullTheme({ dir, url: target.dev.url, token: target.dev.token, draft, instance, onRetry });
  console.log(`Downloaded ${count} ${what} theme files → ${dir}`);
  bindAfterPull(target, dir);
}

async function themePush(rest) {
  const { flags, positionals } = parseArgsOrExit(rest, KNOWN.themePush);
  const dir = resolve(positionals[0] ?? process.cwd());
  if (!existsSync(dir)) {
    console.error(`Theme directory not found: ${dir}`);
    process.exit(1);
  }
  const instanceFlag = typeof flags.instance === "string" ? flags.instance : null;
  const name = typeof flags.name === "string" ? flags.name : null;
  const dryRun = Boolean(flags["dry-run"] || flags.validate);
  // Yeni varsayılan hedef: DRAFT (güvenli). `--live` eski anında-canlı davranışını
  // açıkça geri getirir; `--instance` belirli bir temayı adresler. Sadece "live"
  // modu canlıya yazar ve onay gerektirir.
  const { mode, instance } = resolvePushMode({
    live: Boolean(flags.live),
    draft: Boolean(flags.draft),
    instance: instanceFlag,
  });
  // CF-T2: `--diff` and `--dry-run` are reads; every other push is a remote mutation (binding required). The
  // target is verified (whoami, both pairs, binding) before the first theme request — no best-effort swallow.
  const readOnly = Boolean(flags.diff) || dryRun;
  const opMode = flags.diff ? `read · diff vs ${instanceFlag ? `instance ${instanceFlag}` : "live"}` : dryRun ? `read · dry run (${mode === "instance" ? `instance ${instance}` : mode})` : mode === "instance" ? `instance ${instance}` : mode;
  const target = await prepareTarget({ command: "theme push", commandClass: readOnly ? "read" : "remote-mutation", dir, flags, needs: "dev", mode: `${opMode}${flags.prune && !readOnly ? " · prune" : ""}` });
  const creds = target.dev;
  // 0.5.0: her push'a otomatik idempotency key — kanonik dal (protokol + key) ancak böyle seçilir; key
  // OLMADAN header'lar tek başına legacy writer'a düşer ve --live push pinned render'a YANSIMAZ (M4
  // read cutover'ının ana CLI şikâyeti). Push-OPERASYONU-başına üretilir: fetchWithRetry'nin 5xx/429
  // denemeleri aynı key'le yakınsar, ardışık push'lar farklı key alır (sabit key, settings/hedef
  // değişiminde kalıcı 409 idempotency_conflict üretirdi). Ham id gönderilir — sunucu `idem:` ile
  // ad-alanlar, önek EKLENMEZ.
  const idempotencyKey = typeof flags["idempotency-key"] === "string" ? flags["idempotency-key"] : `cli-${randomUUID()}`;

  // `--diff`: read-only preview vs the LIVE theme (or --instance). No write; the draft target is not
  // diffable (a draft GET would PROVISION the draft server-side — a read-only command must not mutate).
  if (flags.diff) {
    const diffTarget = ` of ${siteLabel(target.identity.site)}`;
    const d = await diffTheme({ dir, url: creds.url, token: creds.token, instance: instanceFlag, onRetry });
    console.log(instanceFlag ? `Diff vs theme ${instanceFlag}${diffTarget}:` : `Diff vs the LIVE theme${diffTarget} (push default writes to a DRAFT):`);
    const total = d.added.length + d.changed.length + d.removed.length;
    if (total === 0) {
      console.log("No differences — local theme matches the target.");
      return;
    }
    for (const k of d.added) console.log(`  + ${k}`);
    for (const k of d.changed) console.log(`  ~ ${k}`);
    for (const k of d.removed) console.log(`  - ${k} (present on target, absent locally — ${flags.prune ? "--prune removes it" : "push does not delete"})`);
    console.log(`\n${d.added.length} added, ${d.changed.length} changed, ${d.removed.length} remote-only.`);
    return;
  }

  // Hedef tenant'ı GÖSTER — site sunucuda TOKEN'dan çözülür ve prepareTarget'ta DOĞRULANDI (CF-T2).
  const whoami = target.identity;
  const siteName = siteLabel(whoami.site) || String(whoami.site.id);
  if (mode === "instance") {
    console.log(`→ Pushing to theme ${instance} of ${siteName}`);
  } else if (mode === "live") {
    console.log(dryRun ? `→ Validating against the LIVE theme of ${siteName} (dry run — nothing will be written)` : `→ Pushing to the LIVE theme of ${siteName}`);
  } else {
    console.log(`→ Pushing to a draft of ${siteName}`);
  }

  // Canlı push (`--live`) ANINDA canlı temayı değiştirir (önizleme yok). Agent/CI
  // kazara canlıya basmasın diye açık onay şart (#431 L2). Draft/instance modu
  // güvenli → otomatik onay (prompt yok).
  // 0.5.0: `--dry-run` hiçbir şey yazmaz → canlı onayı gereksiz (draft:true gibi davranır).
  const decision = livePushDecision({
    draft: mode !== "live" || dryRun,
    yes: Boolean(flags.yes),
    confirm: Boolean(flags.confirm),
    isTTY: Boolean(process.stdin.isTTY),
  });
  if (decision.mustAbort) {
    console.error(`⚠ 'theme push --live' writes to the LIVE theme of ${siteName} immediately (no preview).`);
    console.error(`  Non-interactive shell: pass --live --yes to confirm, or omit --live to push to a safe draft.`);
    process.exit(1);
  }
  if (decision.needsPrompt) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    let answer;
    try {
      answer = await rl.question(`⚠ Push to the LIVE theme of ${siteName}? Immediate, no preview. [y/N] `);
    } finally {
      rl.close();
    }
    if (!isAffirmative(answer)) {
      console.error("Aborted. Omit `--live` to push to a safe draft, or pass `--live --yes` to confirm.");
      process.exit(1);
    }
  }

  // PS-13 `--prune`: canlı temadan dosya SİLER. Hedef canlıysa (`--live` ya da canlı temanın handle'ı
  // verilmiş `--instance`; whoami çözülemediyse canlı sayılır) canlı-push onay kuralı aynen uygulanır:
  // `--yes`/`--confirm` → onaylı, TTY → liste basıldıktan sonra y/N, non-TTY → yazımsız çıkış.
  const prune = Boolean(flags.prune) && !dryRun;
  const liveTarget = mode === "live" || (mode === "instance" && (whoami.liveThemeId == null || String(instance) === String(whoami.liveThemeId)));
  const pruneDecision = livePushDecision({
    draft: !prune || !liveTarget,
    yes: Boolean(flags.yes),
    confirm: Boolean(flags.confirm),
    isTTY: Boolean(process.stdin.isTTY),
  });
  if (pruneDecision.mustAbort) {
    console.error(`⚠ 'theme push --prune' removes files from the LIVE theme of ${siteName}.`);
    console.error(`  Non-interactive shell: pass --prune --yes to confirm. Nothing was written.`);
    process.exit(1);
  }
  const confirmPrune = async (keys) => {
    console.log(`--prune will remove ${keys.length} file(s) absent locally:`);
    for (const k of keys) console.log(`  - ${k}`);
    if (!pruneDecision.needsPrompt) return true;
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return isAffirmative(await rl.question(`⚠ Remove these files from the LIVE theme of ${siteName}? [y/N] `));
    } finally {
      rl.close();
    }
  };

  // `--name` yalnızca YENİ taslak yaratırken (draft modu) anlamlı — canlıya/mevcut
  // instance'a yazarken ad kaydedilmez, sessizce kaybolmasın diye açıkça uyar.
  if (name && mode !== "draft") {
    console.error("Note: --name yalnız yeni taslak yaratırken (varsayılan push) geçerli, yok sayıldı.");
  }

  // 0.5.0: eski (protokolsüz) bir sunucu `dryRun` alanını bilmez ve SESSİZCE GERÇEK YAZIM yapardı —
  // dry-run yalnız sunucu kanonik protokolü beyan ediyorsa koşar (sorgusuz, mutasyonsuz GET ön kontrolü).
  if (dryRun) {
    const { supported } = await fetchCanonicalSupport({ url: creds.url, token: creds.token, onRetry });
    if (!supported) {
      console.error("✗ --dry-run needs a server that speaks the canonical protocol; this one does not.");
      console.error("  An old server would IGNORE dryRun and write for real. Nothing was sent.");
      process.exit(1);
    }
  }

  let result;
  try {
    result = await pushTheme({
      dir,
      url: creds.url,
      token: creds.token,
      draft: mode === "draft",
      instance: mode === "instance" ? instance : null,
      name: mode === "draft" ? name : null,
      dryRun,
      idempotencyKey,
      onRetry,
      prune,
      confirmPrune,
    });
  } catch (error) {
    if (error?.code === "cli_upgrade_required") {
      const missing = Array.isArray(error?.body?.fence?.missing) ? error.body.fence.missing : [];
      if (!JSON_MODE) {
        console.error("✗ Sunucu bu CLI sürümünü reddetti (cli_upgrade_required).");
        console.error(`  Güncelle:  npm i -g @blocofy/cli@latest${missing.length ? `\n  Sunucunun istediği eksik yetenekler: ${missing.join(", ")}` : ""}`);
      }
      failAndExit({ code: "cli_upgrade_required", status: error.status, message: "The server refused this CLI version; update it: npm i -g @blocofy/cli@latest", details: { missing } });
    }
    if (error?.code === "idempotency_conflict") {
      if (!JSON_MODE) {
        console.error("✗ Idempotency çakışması: aynı anahtar daha önce FARKLI içerikle kullanılmış (409).");
        console.error("  `--idempotency-key` verdiysen yeni bir anahtarla dene; vermediysen tekrar `blocofy theme push` yeterli (her koşu taze anahtar üretir).");
      }
      failAndExit({ code: "idempotency_conflict", status: error.status, message: "The idempotency key was already used with different content. Retry with a new key (or omit --idempotency-key).", details: {} });
    }
    throw error;
  }

  if (result.aborted) {
    console.error("Aborted. Nothing was written.");
    process.exit(1);
  }

  // --dry-run / --validate: the server validated without writing. Report and stop.
  if (result.dryRun) {
    const warnings = Array.isArray(result.warnings) ? result.warnings : [];
    console.log(`✓ Validation passed (dry run — nothing written).${warnings.length ? ` ${warnings.length} warning(s).` : ""}`);
    for (const w of warnings) console.log(`  ⚠ ${w}`);
    return;
  }

  // 0.5.0: kanonik boru hattı yanıtı (CP üzerinden atomik deploy) — legacy created/updated alanları yok.
  if (result.committed === true) {
    if (Array.isArray(result.remoteOnlyKept) && result.remoteOnlyKept.length) {
      console.log(`  (kept ${result.remoteOnlyKept.length} remote-only file(s) — push does not delete)`);
    }
    if (Array.isArray(result.remoteOnlyRemoved) && result.remoteOnlyRemoved.length) {
      console.log(`  (removed ${result.remoteOnlyRemoved.length} file(s) absent locally — --prune)`);
    }
    console.log(`✓ Deployed atomically: deployment #${result.deploymentId}, revision #${result.sourceRevisionId}, pointer v${result.pointerVersion}.`);
    if (mode === "draft") {
      console.log("Preview & publish it in the admin panel: Theme -> Theme library -> \"Open in editor\".");
      console.log("Publish it live with:  blocofy theme publish");
    }
    return;
  }

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

/** PS-19 — print platform/CLI findings; returns the exit code they imply. */
function reportPageDiagnostics(diagnostics, { strict = false } = {}) {
  for (const d of diagnostics) (d.level === "error" ? console.error : console.warn)(formatDiagnostic(d));
  const errors = diagnostics.filter((d) => d.level === "error").length;
  const warnings = diagnostics.length - errors;
  return errors > 0 || (strict && warnings > 0) ? 1 : 0;
}

function localeLabel(p) {
  return `${p.locale} ${p.slug}`;
}

async function pagesPush(rest) {
  const { flags, positionals } = parseArgsOrExit(rest, KNOWN.pagesPush);
  const dir = resolve(positionals[0] ?? process.cwd());
  if (!existsSync(dir)) {
    console.error(`Directory not found: ${dir}`);
    process.exit(1);
  }
  const dryRun = Boolean(flags["dry-run"]);
  const target = await prepareTarget({ command: "pages push", commandClass: dryRun ? "read" : "remote-mutation", dir, flags, needs: "dev", mode: dryRun ? "read · dry run" : "live" });
  const creds = target.dev;
  const result = await pushContent({ dir, url: creds.url, token: creds.token, scope: "pages", dryRun, onRetry });
  const code = reportPageDiagnostics(result.diagnostics ?? [], { strict: Boolean(flags.strict) });
  const pages = result.pages ?? [];
  const count = (k, v) => pages.filter((p) => p[k] === v).length;
  const warnings = (result.diagnostics ?? []).filter((d) => d.level === "warning").length;
  if (dryRun) {
    console.log(`Preflight passed: ${count("action", "publish")} updates, ${count("action", "draft")} drafts, ${count("action", "unchanged")} unchanged, 0 conflicts, ${warnings} warning(s).`);
    console.log("Dry run only; no pages were changed.");
  } else {
    for (const p of pages) if (p.outcome !== "unchanged") console.log(`  ${p.outcome}  ${localeLabel(p)}  (${p.path})`);
    console.log(
      `Pages push: ${result.pagesUpdated} updated, ${result.pagesSkipped} skipped, ${warnings} warning(s) ` +
        `(only existing pages are updated — none created or deleted).`,
    );
  }
  process.exit(code);
}

async function pagesPull(rest) {
  const { flags, positionals } = parseArgsOrExit(rest, KNOWN.pagesPull);
  const dir = resolve(positionals[0] ?? process.cwd());
  const target = await prepareTarget({ command: "pages pull", commandClass: "local-write", dir, flags, needs: "dev", mode: "published pages" });
  const creds = target.dev;
  const { count, diagnostics } = await pullContent({ dir, url: creds.url, token: creds.token, scope: "pages", onRetry });
  const code = reportPageDiagnostics(diagnostics, { strict: Boolean(flags.strict) });
  console.log(`Downloaded ${count} page file(s) → ${dir}`);
  bindAfterPull(target, dir);
  process.exit(code);
}

async function pagesCheck(rest) {
  const { flags, positionals } = parseArgsOrExit(rest, KNOWN.pagesCheck);
  const dir = resolve(positionals[0] ?? process.cwd());
  if (!existsSync(dir)) {
    console.error(`Directory not found: ${dir}`);
    process.exit(1);
  }
  const creds = (await optionalTarget({ command: "pages check", dir, flags }))?.dev;
  const online = Boolean(creds);
  const r = await checkPages({ dir, onRetry, ...(online ? { url: creds.url, token: creds.token } : {}) });
  const code = reportPageDiagnostics(r.diagnostics, { strict: Boolean(flags.strict) });
  const errors = r.diagnostics.filter((d) => d.level === "error").length;
  console.log(`Checked ${r.fileCount} page file(s) ${r.online ? "(with the site's languages and a server dry run)" : "(offline — log in to also check against the site)"}: ${errors} error(s), ${r.diagnostics.length - errors} warning(s).`);
  process.exit(code);
}

async function pagesMigrate(rest) {
  const { flags, positionals } = parseArgsOrExit(rest, KNOWN.pagesMigrate);
  if (flags["dry-run"] && flags.write) {
    console.error("Use either --dry-run or --write, not both. Nothing was moved.");
    process.exit(1);
  }
  const dir = resolve(positionals[0] ?? process.cwd());
  if (!existsSync(dir)) {
    console.error(`Directory not found: ${dir}`);
    process.exit(1);
  }
  const creds = (await optionalTarget({ command: "pages migrate-layout", dir, flags, localWrite: Boolean(flags.write) }))?.dev;
  const online = Boolean(creds);
  const write = Boolean(flags.write);
  const r = await migrateLayout({ dir, write, onRetry, ...(online ? { url: creds.url, token: creds.token } : {}) });
  const code = reportPageDiagnostics(r.diagnostics, { strict: Boolean(flags.strict) });
  for (const m of r.moves) console.log(`  ${write && !r.refused ? "moved" : "move"}  ${m.from} → ${m.to}`);
  if (r.refused) console.error(`Migration refused; no files were moved.`);
  else if (write) console.log(`Moved ${r.moved} file(s) to the language-folder layout.`);
  else console.log(`${r.moves.length} file(s) would move. Dry run only; run with --write to move them.`);
  process.exit(r.refused ? 1 : code);
}

async function contentPush(scope, rest) {
  const { flags, positionals } = parseArgsOrExit(rest, KNOWN.content);
  const dir = resolve(positionals[0] ?? process.cwd());
  if (!existsSync(dir)) {
    console.error(`Directory not found: ${dir}`);
    process.exit(1);
  }
  const target = await prepareTarget({ command: `${scope} push`, commandClass: "remote-mutation", dir, flags, needs: "dev", mode: "live" });
  const creds = target.dev;
  const result = await pushContent({ dir, url: creds.url, token: creds.token, scope, onRetry });
  console.log(
    `Settings push: ${result.settingsUpdated ? "theme settings updated" : "theme settings unchanged"}, ` +
      `${result.schemesUpserted} color scheme(s) upserted (${result.fileCount} file).`,
  );
}

async function contentPull(scope, rest) {
  const { flags, positionals } = parseArgsOrExit(rest, KNOWN.content);
  const dir = resolve(positionals[0] ?? process.cwd());
  const target = await prepareTarget({ command: `${scope} pull`, commandClass: "local-write", dir, flags, needs: "dev", mode: "live" });
  const creds = target.dev;
  const { count } = await pullContent({ dir, url: creds.url, token: creds.token, scope, onRetry });
  console.log(`Downloaded ${count} settings file(s) → ${dir}`);
  bindAfterPull(target, dir);
}

/**
 * Optional online mode for offline-capable reads (`pages check`, `pages migrate-layout`): no credentials at all, or
 * no context choosable outside a project → offline. Inside a bound project every other refusal still applies.
 */
async function optionalTarget({ command, dir, flags, localWrite = false }) {
  try {
    // Review I3: a command that writes local files (migrate-layout --write) never borrows the global default
    // context — outside a binding it needs an explicit --context/env, else it runs offline.
    return await prepareTarget({ command, commandClass: "read", resolveClass: localWrite ? "local-write" : "read", dir, flags, needs: "dev", mode: localWrite ? "read · local write" : "read" });
  } catch (error) {
    if (error instanceof TargetError && (error.code === "LOGIN_REQUIRED" || (error.code === "TARGET_CONTEXT_REQUIRED" && !findBinding(dir)))) return null;
    throw error;
  }
}

function printMediaUsesView(view) {
  if (view.applicable === false) {
    console.log(`Page ${view.page?.id}: media decisions not applicable (${view.reason}).`);
    return;
  }
  const uses = Array.isArray(view.uses) ? view.uses : [];
  console.log(`Page ${view.page?.id} — draft revision ${view.revision?.id} v${view.revision?.version} — ${view.locale} ← ${view.source_locale}`);
  console.log(`${view.counts?.total ?? uses.length} use(s), ${view.counts?.blocked ?? 0} blocked`);
  for (const u of uses) {
    const marks = [u.stale ? "stale" : null, u.blocks ? "BLOCKS" : null, u.editable ? null : "read-only"].filter(Boolean);
    const extra = marks.length ? ` [${marks.join(", ")}]` : "";
    const reasons = Array.isArray(u.reasons) && u.reasons.length ? ` — ${u.reasons.join(", ")}` : "";
    console.log(`  ${u.decision.padEnd(9)} ${u.path} (${u.facet}, ${u.kind})${extra}${reasons}`);
  }
}

async function pagesMediaUses(rest) {
  const { flags, positionals } = parseArgsOrExit(rest, KNOWN.pages);
  const page = positionals[0];
  if (!page) {
    console.error("Usage: blocofy pages media-uses <page-handle> [--json]");
    process.exit(1);
  }
  const { apiUrl, apiKey } = (await prepareTarget({ command: "pages media-uses", commandClass: "read", dir: process.cwd(), flags, needs: "api", mode: `read · page ${page}` })).api;
  const view = await fetchPageMediaUses({ apiUrl, apiKey, page, onRetry });
  if (flags.json) console.log(JSON.stringify(view, null, 2));
  else printMediaUsesView(view);
}

function parseExpected(flags, name) {
  const raw = flags[name];
  if (raw === undefined) return null;
  const n = Number(raw);
  if (typeof raw !== "string" || !Number.isSafeInteger(n) || n < 0) {
    console.error(`--${name} must be a non-negative integer.`);
    process.exit(1);
  }
  return n;
}

async function pagesMediaDecide(rest) {
  const { flags, positionals } = parseArgsOrExit(rest, KNOWN.pages);
  const page = positionals[0];
  const file = typeof flags.decisions === "string" ? resolve(flags.decisions) : null;
  if (!page || !file) {
    console.error("Usage: blocofy pages media-decide <page-handle> --decisions <file.json> [--expected-revision-id <n> --expected-version <n>] [--json]");
    process.exit(1);
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    console.error(`Cannot read decisions file ${file}: ${error?.message ?? error}`);
    process.exit(1);
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.decisions) || parsed.decisions.length === 0) {
    console.error(`Decisions file must be { "decisions": [ ... ] } with at least one item: ${file}`);
    process.exit(1);
  }
  let expectedRevisionId = parseExpected(flags, "expected-revision-id");
  let expectedVersion = parseExpected(flags, "expected-version");
  if ((expectedRevisionId === null) !== (expectedVersion === null)) {
    console.error("--expected-revision-id and --expected-version must be given together (or both omitted to use the current draft).");
    process.exit(1);
  }

  const { apiUrl, apiKey } = (await prepareTarget({ command: "pages media-decide", commandClass: "remote-mutation", dir: process.cwd(), flags, needs: "api", mode: `draft · page ${page}` })).api;
  if (expectedRevisionId === null) {
    const view = await fetchPageMediaUses({ apiUrl, apiKey, page, onRetry });
    if (view.applicable === false) {
      console.error(`Page ${page}: media decisions not applicable (${view.reason}). Nothing was written.`);
      process.exit(1);
    }
    expectedRevisionId = view.revision.id;
    expectedVersion = view.revision.version;
  }
  const decisions = parsed.decisions.map((item) =>
    item && typeof item === "object" && typeof item.idempotency_key !== "string" ? { ...item, idempotency_key: randomUUID() } : item,
  );

  const out = await decidePageMediaUses({ apiUrl, apiKey, page, expectedRevisionId, expectedVersion, decisions, onRetry });
  if (flags.json) {
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  if (out.written === false) {
    console.log("No changes — the decisions were already recorded (replay).");
    return;
  }
  const applied = Array.isArray(out.applied) ? out.applied : [];
  console.log(`✓ Applied ${applied.length} decision(s) → draft revision ${out.revision?.id} v${out.revision?.version}`);
  for (const a of applied) console.log(`  ${a.decision.padEnd(9)} ${a.path} (${a.facet})${a.replayed ? " [replayed]" : ""}`);
}

async function themeDev(rest) {
  const { flags, positionals } = parseArgsOrExit(rest, KNOWN.themeDev);
  const themeDir = resolve(positionals[0] ?? process.cwd());

  if (!existsSync(themeDir)) {
    console.error(`Theme directory not found: ${themeDir}`);
    process.exit(1);
  }

  // CF-T2: draft sync mutates the site (remote-mutation, binding required); `--no-sync` only renders (read).
  const noSync = Boolean(flags["no-sync"]);
  const target = await prepareTarget({ command: "theme dev", commandClass: noSync ? "read" : "remote-mutation", dir: themeDir, flags, needs: "dev", mode: noSync ? "read · local preview" : "draft" });
  const creds = target.dev;
  const port = Number(flags.port) || 3030;

  // Dev session: live-domain preview + theme editor URLs (+ a draft to sync into).
  // Graceful: if the platform can't provide one, fall back to local-only preview.
  let session = null;
  if (!flags["no-sync"]) {
    try {
      const name = typeof flags.name === "string" ? flags.name : null;
      session = await fetchDevSession({ url: creds.url, token: creds.token, name, onRetry });
    } catch (error) {
      console.warn(
        `Warning: dev session unavailable (${error?.message || error}). ` +
          `Live-domain and editor views are disabled; draft sync and local preview keep working.`,
      );
    }
  }

  const localUrl = `http://localhost:${port}`;
  const previewUrl = session ? `${session.previewUrl}&hr=${port}` : null;
  const editorUrl = session ? `${session.editorUrl}&hr=${port}` : null;

  // Çözülen site'ı göster (session TOKEN'dan çözer) → hangi tenant'ı düzenlediğin belli olsun.
  const siteLine = session?.site ? `${siteLabel(session.site)} · ` : "";
  console.log(`\nblocofy theme dev — ${siteLine}${creds.url} (context ${target.name})\n`);
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
    // Taslak senkronu dev session'a BAĞLI DEĞİL: `pushTheme({draft:true})` /api/dev/theme'e gider ve
    // session'dan hiçbir veri kullanmaz. Bu satır `Boolean(session)` iken, session 410 alınca senkron
    // da sessizce kapanıyordu — ölü bir uç, çalışan bir özelliği götürüyordu. Tek kapatma yolu --no-sync.
    syncDraft: !flags["no-sync"],
    onRetry: (info) => console.error(`  ${retryNotice(info)}`),
    onWarn: (msg) => console.warn(`  ⚠ ${msg}`),
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
  const { flags } = parseArgsOrExit(rest, KNOWN.themePublish);
  const target = await prepareTarget({ command: "theme publish", commandClass: "remote-mutation", dir: process.cwd(), flags, needs: "dev", mode: `live${typeof flags.instance === "string" ? ` · instance ${flags.instance}` : " · CLI draft"}` });
  const creds = target.dev;
  let instance = typeof flags.instance === "string" ? flags.instance : null;
  if (!instance) {
    // Belirtilmediyse: `theme dev` / `theme push --draft`'ın yazdığı taslağı yayınla. Kaynak
    // `GET /api/dev/site` — eski `fetchDevSession` yolu sunucuda 410'a döndü ve bu komutu
    // try/catch'siz, boş mesajlı bir Error ile tamamen çalışmaz hâle getirmişti.
    //
    // `drafts` canlı OLMAYAN HER instance'ı içerir; sunucunun `ensureDraftInstance`'ı ise
    // `source === "import"` olanı seçer (yayınlanan taslak import'tan çıkarılır). Aynı seçimi
    // burada tekrarla — yoksa bir kez yayın yapmış her sitede iki taslak görünür ve komut takılır.
    const status = await fetchSiteStatus({ url: creds.url, token: creds.token, onRetry });
    const drafts = status?.drafts ?? [];
    const cliDrafts = drafts.filter((d) => d.source === "import");
    if (cliDrafts.length === 1) {
      instance = cliDrafts[0].id;
    } else if (drafts.length === 0) {
      console.error("No draft theme to publish. Create one first:  blocofy theme push --draft");
      process.exit(1);
    } else {
      console.error("Could not tell which draft to publish — pick one with --instance <handle>:");
      for (const d of drafts) console.error(`  ${d.id}  ${d.name ?? "(unnamed)"}`);
      process.exit(1);
    }
  }
  const result = await publishInstance({ url: creds.url, token: creds.token, instanceId: instance, onRetry });
  console.log(
    `✓ Theme ${result.published} is now LIVE${result.cloned ? " (pages cloned from the previous live theme)" : ""}.`,
  );
}

async function themeRename(rest) {
  const { flags, positionals } = parseArgsOrExit(rest, KNOWN.themeRename);
  const handle = positionals[0];
  const name = positionals.slice(1).join(" ") || (typeof flags.name === "string" ? flags.name : null);
  if (!handle || !name) {
    console.error("Usage: blocofy theme rename <handle> <new name>");
    console.error("  Rename a theme (handle from the panel theme card or `blocofy status`).");
    process.exit(1);
  }
  const creds = (await prepareTarget({ command: "theme rename", commandClass: "remote-mutation", dir: process.cwd(), flags, needs: "dev", mode: `instance ${handle}` })).dev;
  const result = await renameInstance({ url: creds.url, token: creds.token, instance: handle, name, onRetry });
  console.log(`✓ Renamed to "${result.name}" (${result.id}).`);
}

async function status(rest) {
  const { flags } = parseArgsOrExit(rest, []);
  const creds = (await prepareTarget({ command: "status", commandClass: "read", dir: process.cwd(), flags, needs: "dev", mode: "read" })).dev;
  const s = await fetchSiteStatus({ url: creds.url, token: creds.token, onRetry });
  const live = s.live_theme_instance;
  console.log(`\nSite: ${s.site.slug}${s.url ? ` · ${s.url}` : ""}`);
  console.log(
    live
      ? `Live theme: ${live.id}${live.name ? ` ${live.name}` : ""} — ${live.template_count} files, ${s.pages_on_live} pages`
      : `Live theme: none`,
  );
  console.log(`Health: ${s.health}`);
  // CF-T9: no imperative one-line fix — which theme holds the pages, why, and safe (preview-first) next steps.
  for (const line of healthAdvice(s)) console.error(line);
  if (Array.isArray(s.drafts) && s.drafts.length > 0) {
    console.log(`Drafts: ${s.drafts.map((d) => `${d.id}${d.name ? ` ${d.name}` : ""}`).join(", ")}`);
  }
  console.log("");
}

const [first, ...rest] = args;

function commandKey(a, b) {
  return `${a} ${b ?? ""}`;
}

// command → handler. Every failure exits through failAndExit (exit codes 1/2/3, --json envelope last).
const COMMANDS = {
  login: login,
  contexts: contextsCommand,
  use: useCommand,
  logout: logoutCommand,
  link: linkCommand,
  target: targetCommand,
  status: status,
  "theme dev": themeDev,
  "theme pull": themePull,
  "theme push": themePush,
  "theme publish": themePublish,
  "theme rename": themeRename,
  "pages media-uses": pagesMediaUses,
  "pages media-decide": pagesMediaDecide,
  "pages pull": pagesPull,
  "pages push": pagesPush,
  "pages check": pagesCheck,
  "pages migrate-layout": pagesMigrate,
  "settings pull": (r) => contentPull("settings", r),
  "settings push": (r) => contentPush("settings", r),
};

if (first === "--version" || first === "-v") {
  console.log(VERSION);
} else if (!first || first === "--help" || first === "-h" || first === "help") {
  printHelp();
} else if (args.includes("--help") || args.includes("-h")) {
  // 0.5.0: `--help` HERHANGİ bir konumda YARDIMDIR — alt-komut handler'ı asla koşmaz.
  // (0.4.0'da `blocofy theme push --help` GERÇEK bir push koşuyordu.)
  printHelp();
} else if (args.includes("--version") || args.includes("-v")) {
  // Aynı simetri: `theme push <dir> --version` da yalnız sürüm basar, asla yazmaz.
  console.log(VERSION);
} else if (COMMANDS[commandKey(first, rest[0])] || COMMANDS[first]) {
  const keyed = COMMANDS[commandKey(first, rest[0])];
  const handler = keyed ?? COMMANDS[first];
  handler(keyed ? rest.slice(1) : rest).catch(failAndExit);
} else {
  console.error(`Unknown command: ${args.join(" ")}\n`);
  printHelp();
  process.exit(1);
}
