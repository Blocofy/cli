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
import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

import { parseArgs } from "../lib/args.mjs";
import { FORCE_REASON_MAX, checkPages, forcedPaths, migrateLayout, pullContent, pushContent } from "../lib/content-sync.mjs";
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
  withStoreLock,
  writeSecret,
  credentialRefusal,
  readOAuthTokens,
  writeOAuthTokens,
} from "../lib/credentials.mjs";
import { CLI_CLIENT_ID, LoginError, revokeToken, runBrowserLogin } from "../lib/oauth.mjs";
import { accessTokenFor } from "../lib/refresh.mjs";
import { oauthSecretStore, storeLabel, SecretStoreError } from "../lib/secret-store.mjs";
import { InitError, inspectInitDir, readInitState, runInit, initApi } from "../lib/init.mjs";
import { printError, printTarget, printWarning, redact, registerSecret, targetData } from "../lib/output.mjs";
import {
  CONTEXT_NAME_RE,
  TargetError,
  assertCredentialTypes,
  claimNewBinding,
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
import {
  ImportNotApplied,
  ImportOutcomeUnknown,
  TRANSLATION_ONLY,
  XLIFF_MAX_CHARS,
  addImportReport,
  chunkPackage,
  emptyImportTally,
  exportAllTranslations,
  exportSkipLines,
  fitChunksToBodyCap,
  importSummaryLines,
  importTranslationChunk,
  readPackageFile,
  toXliff,
} from "../lib/translations.mjs";
import { githubNote, healthAdvice, retryNotice, statusLine, syncScopeNote } from "../lib/messages.mjs";
import { promptSecret } from "../lib/secret-prompt.mjs";
import { MANIFEST_PATH, buildManifest, validateSiteStateTree, verifyManifest } from "../lib/site-state.mjs";
import { SiteStateFsError, hashBuffer, readSiteStateTree, stagedWriteTree } from "../lib/site-state-fs.mjs";
import { migrateSiteState } from "../lib/site-migrate.mjs";
import { applySiteState, downloadAssetBytes, fetchSiteStateExport, planSiteState, publishSiteState, uploadMediaAsset } from "../lib/site-state-client.mjs";
import { DRAFT_TARGET_AMBIGUOUS, PUBLISH_TARGET_UNCONFIRMED, publishTargetUnconfirmedMessage, diffTheme, draftSyncErrorLine, draftTargetAmbiguousMessage, fetchCanonicalSupport, fetchDevSession, fetchSiteStatus, findCliDraft, publishInstance, pullTheme, pushTheme, renameInstance, themeCapacityRefusal } from "../lib/theme-sync.mjs";
import { isAffirmative, livePushDecision, resolvePushMode } from "../lib/confirm.mjs";
import { DEFAULT_WORK_INTENT, WORK_INTENT_MAX, WORK_KEY_RE, approvalOutcome, approvalWaitState, cancelWork, getPublishStatus, getWork, isWorkHandle, newWorkKey, publishStatusLines, readSavedWork, requestApproval, resumeWork, safeApprovalUrl, saveWork, sealWork, staleLines, startWork, stateLabel, themeWorkRefusal, workLines } from "../lib/theme-work.mjs";
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
  login: ["url", "token", "api-key", "api-url", "keychain", "site", "insecure-storage", "no-browser"],
  init: ["site", "api-url", "insecure-storage", "no-browser"],
  pages: ["decisions", "expected-revision-id", "expected-version", "json", "dir"],
  themePull: ["draft", "instance"],
  themePush: ["diff", "draft", "instance", "name", "live", "yes", "confirm", "dry-run", "validate", "idempotency-key", "prune", "work"],
  themeDev: ["port", "dry", "no-sync", "name", "instance"],
  themePublish: ["instance"],
  themeRename: ["name", "dir"],
  themeWorkStart: ["intent", "idempotency-key"],
  themeWorkStatus: ["dir"],
  themeWorkResume: ["dir", "require-fresh"],
  themeWorkCancel: ["dir"],
  themeWorkSeal: ["dir"],
  themeWorkRequestApproval: ["dir", "open", "wait", "interval"],
  content: [],
  settingsPush: ["instance", "live", "yes", "confirm"],
  pagesPull: ["strict"],
  pagesPush: ["dry-run", "strict", "force", "reason"],
  pagesCheck: ["strict"],
  pagesMigrate: ["dry-run", "write", "strict"],
  siteExport: [],
  siteValidate: ["strict"],
  siteMigrate: ["dry-run", "write"],
  sitePlan: ["target", "mode", "accept-live-effects"],
  siteApply: ["target", "mode", "accept-live-effects"],
  sitePublish: ["target", "mode", "yes"],
  translationsExport: ["locale", "out", "format", "only", "force"],
  translationsImport: ["dry-run", "publish", "on-source-change"],
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

/**
 * 1.8: the project directory a command resolves its binding from — the explicit argument (`[dir]` or `--dir <dir>`)
 * when given, else cwd. A missing directory is a usage error before any request.
 */
function commandDir(explicit) {
  if (explicit === undefined) return process.cwd();
  if (typeof explicit !== "string" || explicit === "") throw new TargetError("USAGE", "--dir needs a directory. Nothing was read or written.", {}, 1);
  const dir = resolve(explicit);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new TargetError("USAGE", `Directory not found: ${dir}. Nothing was read or written.`, { dir }, 1);
  return dir;
}

/** Commands whose only positional is the optional `[dir]`. */
function singleDirArg(positionals, usage) {
  if (positionals.length > 1) throw new TargetError("USAGE", `Usage: ${usage}`, {}, 1);
  return commandDir(positionals[0]);
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
  blocofy login [--context <name>] [--site <handle|slug>] [--api-url <url>] [--no-browser]
                [--insecure-storage]
      Log in with your browser (PKCE, loopback 127.0.0.1/[::1] callback): pick the site and
      approve. The login is draft-only ("Tema geliştirme"): it can never change the live site or
      publish. "Connected" is printed only after GET /api/v1/ping confirms site + profile. The
      tokens go to the OS secure store (macOS Keychain, Windows DPAPI file, Linux Secret Service);
      no store → refused, never a silent plain file. --insecure-storage (or
      BLOCOFY_SECRET_STORE=file) chooses ~/.blocofy/secrets.json (0600) explicitly.
      Needs a terminal: CI / SSH never opens a browser (use env credentials or the options below).
        --api-url <url>  platform (default https://app.blocofy.com)
        --no-browser     do not open the browser; open the printed URL yourself
        --site           refuse (and revoke) the login unless this site was approved

  blocofy login --url <url> --token [--context <name>] [--keychain]       (advanced)
      Verify a pasted dev token (bcf_… / bcf2_…) against its site (GET /api/dev/whoami) and save
      it as a named context (default name: the site's slug). The token is read from a hidden
      prompt; --token <value> works but warns (argv is visible in ps and shell history).
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
  blocofy use <name>                 default context for status / target / pages check outside a
                                     project (never used by any other command)
  blocofy logout [--context <name>]  remove a context and its secrets; a browser login is also
                                     revoked on the platform (RFC 7009). Both results are printed;
                                     exit 4 if the local copy could not be removed or the platform
                                     login was NOT revoked (then cut it in the panel).

  blocofy init [dir] [--site <handle|slug>] [--context <name>]
      Set up a new project: (browser login if needed) → a theme work of its own (idempotent:
      .blocofy/init.json keeps its key; re-run continues, never a second work) → the work's theme
      files → .blocofy/project.json → a preview link → the live theme read back unchanged.
      Refuses a non-empty directory that is not a project and one bound to another site
      (exit 3, nothing written). Non-interactive runs need --site and a saved/env credential.
      Exit 5: the live theme changed meanwhile (init never writes it; not reported as success).
  blocofy link [dir] --context <name> [--adopt]
      Bind a project directory to the context's (verified) site: writes .blocofy/project.json
      (commit it), .blocofy/local.json (your context; git-ignored) and .blocofy/.gitignore.
      Refuses to rebind a directory bound to another site unless --adopt.
  blocofy target [dir] [--context <name>] [--json]
      Show which site a command in [dir] would hit (verified), without writing anything.

  blocofy theme dev [dir] [--port <n>] [--no-sync] [--name <name>] [--instance <handle>]
      Start a local dev server that renders your local theme files with the site's
      live content. Press l to open it, q to quit. Edit a file and save → the view
      reloads. Saves sync to a DRAFT theme only (never the live site). (dir defaults to cwd)
      The platform's remote preview and editor views for this command are retired; to
      share a draft page, create a preview link for it (v1 API / MCP create_preview_link).
      The target site is verified ONCE at start; a long session keeps that target (restart
      it after changing credentials, context or the project binding).
        --port <n>   local port (default 3030)
        --no-sync    local preview only (skip draft sync)
        --name <name>  name the draft when it is first created (ignored if it already exists)
        --instance <handle>  sync into this draft (when the platform cannot tell which draft is
                             the CLI draft it refuses and asks for this; never the live theme)

  blocofy theme pull [dir] [--draft] [--instance <handle>]
      Download the live theme to disk. (dir defaults to cwd)
        --draft      pull the CLI draft (what 'theme dev' / 'theme push --draft' write into)
                     instead of live. Read-only: it never creates the draft — with none yet
                     it stops (target_missing); run 'blocofy theme push --draft' first.
                     Needs a bound project
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
        --instance <handle>  push to a specific theme by its handle. If the platform cannot
                             tell which draft is the CLI draft, a draft push refuses and asks
                             for this. The LIVE theme's handle asks for confirmation like --live
        --name <name>  name the NEW draft "CLI Draft — <name>" (draft mode only; ignored on
                       --live/--instance). With --draft --instance, writes that draft (never live)
        --dry-run    validate on the server WITHOUT writing (auth + snapshot + Liquid check)
        --validate   alias for --dry-run (validate only, nothing written)
        --diff       show what a push WOULD change vs the target (read-only), then stop
        --idempotency-key <k>  attach an idempotency key so a retried push is not double-applied
        --prune      also REMOVE target files that no longer exist locally, locales/ included
                     (lists them first; on the live theme asks to confirm — non-interactive
                     shells must add --yes)
        --work <wk_…>  write into that WORK's own draft theme (see 'theme work'); never live.
                       Needs both the dev token and the v1 API key of the same site. Refused
                       unless the work is open; with --live/--instance it is a usage error

  blocofy theme work start [dir] [--intent "<text>"] [--idempotency-key <k>]   (new)
      Start a WORK: a private, safe copy of the site's CURRENT live theme to change and
      later hand over for publication. Visitors never see it. Prints its handle (wk_…) and
      remembers it in .blocofy/local.json (git-ignored). Needs the v1 API key
      (blocofy login --api-key); the work belongs to that key.
        --intent "<text>"       a short label of the job (1-120 characters)
        --idempotency-key <k>   retry key: the same key returns the SAME work, never a second one.
                                Without it a fresh key is generated and printed
  blocofy theme work status <wk_…> [--dir <dir>]
      Show the work: its state, its theme handle, whether the site changed since it started,
      and where its publication stands (review, waiting for approval, published).
  blocofy theme work seal <wk_…> [--dir <dir>]
      Prepare the work for review: its content is frozen and can no longer change. Asks for
      no approval and publishes nothing.
  blocofy theme work request-approval <wk_…> [--dir <dir>] [--open] [--wait [--interval <s>]]
      Ask a person to publish the work (an open work is prepared for review first). Prints the
      approval URL: a signed-in site owner or team member with the theme permission approves it
      in Blocofy. The URL carries no token; having it is not a permission to publish.
        --open           also open the approval page in your browser
        --wait           wait until it is published, or the request expires, is declined, or the
                         live site changes (read-only polling; nothing is published from here)
        --interval <s>   seconds between status checks while waiting (1-60, default 3)
      --wait exit codes: 0 published · 2 ended, nothing published (approval_stale, approval_expired,
      approval_declined, approval_superseded, work_cancelled) · 1 wait_timeout or publish_failed
  blocofy theme work resume <wk_…> [--dir <dir>] [--require-fresh]
      Continue that exact work here (it becomes this project's saved work). Writes nothing.
        --require-fresh   refuse (work_stale) when the site changed since the work started
  blocofy theme work cancel <wk_…> [--dir <dir>]
      Give the work up. The live site is not touched; its theme stays in the theme library.
      Publication of a work is approved by a person in the admin panel; the CLI never publishes it.

  blocofy theme rename <handle> <new name> [--dir <dir>]
      Rename a theme (the name is just a label). Works on any of your themes,
      including the live one. Handle comes from the panel theme card or 'blocofy status'.
        --dir <dir>  the bound project whose site this is (default: cwd)

  blocofy theme publish [dir] [--instance <handle>]
      Publish a draft theme to the LIVE site: it REPLACES the live theme for every visitor.
      The site is the one [dir]'s project is bound to (dir defaults to cwd), so
      'theme push ./shop && theme publish ./shop' always publishes ./shop's site.
      With no flag, publishes the draft that 'theme dev' / 'theme push --draft' writes into.
      The server refuses to publish a theme that has no pages (it would 404); preview first.
        --instance <handle>  publish a specific theme (handle from the panel / status). Without it
                             the platform publishes only the site's CLI draft; any other theme
                             is refused (publish_target_unconfirmed) — name it with --instance

  blocofy status [dir]
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

  blocofy pages push [dir] [--dry-run] [--strict] [--force --reason <text>]
      Write pages/**.json to the site. Updates EXISTING pages only — never creates or
      deletes a page; unchanged pages are skipped. Every file is checked first: if any
      file is invalid, two files point at the same page, or a folder's language does not
      match the file's "locale", NO page is changed. If publishing then stops unexpectedly
      (PAGES_APPLY_FAILED or another publish error), some pages may already be applied: the per-file
      result printed is authoritative, the exit code is non-zero, and running the push again is safe.
      Stale files: every pulled file carries "base_revision" (the page as you pulled it). The push
      first asks for a plan (per page: action, live/draft, changed fields), prints it, then pushes
      exactly that plan. If a page changed on the site since you pulled it (PAGES_REVISION_CONFLICT)
      or a file has no base_revision (PAGES_BASE_REVISION_REQUIRED), nothing is changed (exit 2):
      run \`blocofy pages pull\`, merge your edits, push again. If the site changes between the plan
      and the push, nothing is changed either (PAGES_PLAN_STALE, exit 2) — run the push again.
      --force --reason <text>: overwrite anyway (reason: 1-500 characters); the
      forced pages are listed. An older server cannot check revisions: the push runs
      as before with a warning.
      --dry-run: print the plan, write nothing. --json: the server's plan/result JSON on stdout.
      Needs a platform that supports language folders (else PAGES_SERVER_UPGRADE_REQUIRED).

  blocofy pages check [dir] [--strict]
      Check page files. Offline: paths, JSON, layout, duplicates, missing base_revision
      (PAGES_BASE_REVISION_MISSING warning). Logged in: also the site's languages and the
      server-side dry run. Exit 1 on errors (--strict: warnings too).

  blocofy pages migrate-layout [dir] [--dry-run | --write] [--strict]
      Move old-layout files (pages/<slug>.json) to language folders. --dry-run (default)
      prints the plan; --write moves only proven files. Any ambiguity or conflict: nothing
      is moved, exit 1. Files without "locale" use the site's default language (login needed;
      with --write outside a bound project only an explicit --context/env credentials are used).

  blocofy pages media-uses <page-handle> [--dir <dir>] [--json]
      List a page's localized-media decisions on its newest DRAFT (v1 API, pages:read).
      Prints the draft's revision id/version needed by media-decide. --json: raw response.
      --dir <dir> (both media commands): the bound project whose site the page is on (default: cwd).

  blocofy pages media-decide <page-handle> --decisions <file.json>
                             [--expected-revision-id <n> --expected-version <n>] [--dir <dir>] [--json]
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

  blocofy translations export --locale <tag> --out <file> [--force] [--format json|xliff]
                              [--only all|missing|stale|pending] [--json]
      Write every text of one language that needs translating (pages, image texts, records,
      menus, site settings, theme texts) to ONE file (v1 API). The export asks for every kind,
      so the API key needs the read scopes of all of them: pages:read, content:read,
      navigation:write (menus have no read scope), settings:read, themes:read and models:read.
      The platform answers in windows; the command follows every window and merges them, then
      lists what was left out and why. --format xliff writes XLIFF 1.2 for translation tools.
        --only pending   only texts that are missing or need an update
        --force          replace --out if it already exists (refused otherwise, before any request)

  blocofy translations import <file.json|file.xlf> [--dry-run] [--publish]
                              [--on-source-change skip|apply] [--json]
      Import a translated package (v1 API; the write scopes of the kinds, and with --publish
      also pages:write and content:write). Empty translations are skipped; the rest is sent in
      chunks of at most 500 units (a page or record is never split, up to 5,000 units). Prints
      the count per state. New pages and records are created as drafts and page content goes to
      the draft; menus, site settings, theme texts, a live record's text and a live page's title
      and SEO texts change at once.
        --dry-run        write nothing; report what would change
        --publish        also publish the pages and records this import wrote. A publishing
                         chunk is never resent automatically: if it gets no definite answer (or a
                         429) the command stops and says so; running it again is safe.
        --on-source-change apply  also write texts whose source changed since the export
                                  (default: skip)
      If a chunk fails, the report of the chunks done before it is printed first (--json: one
      object with "stopped": true on stdout).
      Exit codes: 0 done; 1 usage/file/network/5xx (or a publishing chunk that was stopped);
      2 the server refused (4xx) — the {error} JSON is printed to stderr.

  blocofy settings pull [dir]
  blocofy settings push [dir] (--instance <handle> | --live [--yes])
      Download / upload config/settings.json (theme tokens/settings + color schemes).
      A push names its target (no implicit live write):
        --instance <handle>  write that theme's settings; a draft shows them in its preview
                             and goes live with 'blocofy theme publish --instance <handle>'
        --live       write the LIVE theme (asks to confirm; non-interactive shells add --yes)
      After a push the CLI says where it applied (preview now / live now / after deploy).

  blocofy site export [dir]
      Download the whole site as a declarative tree (pages, navigation, theme source, settings,
      chrome, translations, media/assets.json) into [dir], plus every media file's bytes at
      media/files/<sha256> (downloaded and hash-verified). Refuses to overwrite a directory
      bound to another site (same binding rule as every other pull).

  blocofy site validate [dir]
      Check an exported (or hand-authored) tree OFFLINE — zero network requests: paths, the
      path↔content binding (a page file's locale/slug must match its folder/name, and so on),
      duplicate identities, the size/count limits, and the tree against its own manifest digest.
      Exit 1 on errors (--strict: warnings too).

  blocofy site migrate [dir] [--dry-run | --write]
      Turn a directory left by the older separate 'theme pull' / 'pages pull' / 'settings pull'
      into the site-state v1 tree layout (theme-dirs-at-root → theme/**, config/settings.json →
      theme/config/settings.json). Purely local: no network request, no target/identity check,
      '.blocofy/' project binding untouched. 'pages/**' files are never moved (already canonical);
      a file still at the old flat page layout is left alone with a note to run
      'blocofy pages migrate-layout' first. --dry-run (default) prints the plan: every move,
      every file left alone, every conflict. --write performs it. Any ambiguity or conflict (a
      target already exists with different content, an unreadable or symlinked entry, a path the
      shared site-state rules refuse): zero moves, exit 1. Never invents the parts a directory of
      separate pulls never had (blocofy-site.json, site/locales.json, globals, navigation,
      translations, theme/chrome/**) — says so, and points at 'blocofy site export' for those.

  blocofy site plan [dir] [--target new|<handle>] [--mode same_site|restore]
                    [--accept-live-effects locales] [--json]
      Ask the site what applying this tree WOULD do — no write. Needs BOTH a dev token and a
      v1 API key (the dev token is what a theme deploy uses later). Prints the status
      (planned / awaiting_assets / awaiting_theme_source / draft_complete), the steps, and any
      missing assets or a differing theme source.
        --target new|<handle>   a fresh draft theme version (default), or a specific one you
                                own (from a previous plan/apply's target instance)
        --mode same_site|restore  same_site refuses a page that changed on this site since the
                                  tree was exported; restore (default) does not
        --accept-live-effects locales  required before a state that adds a language may be
                                       applied (publishing a language prepares its homepage
                                       LIVE, contract §A3)

  blocofy site apply [dir] [--target new|<handle>] [--mode same_site|restore]
                     [--accept-live-effects locales] [--json]
      Build the state into a DRAFT theme version — the live site is never touched. Loops:
      plan → (upload missing media via the v1 API, or deploy the theme source via the same
      canonical path 'theme push --instance' uses) → plan → apply, until the target reports
      draft_complete or 5 passes are used. Safe to re-run: every step is idempotent and a
      re-plan picks up exactly what is left, so an apply interrupted by anything (network,
      Ctrl-C, a crash) resumes with the same command.
      Preview it from the admin panel, then: blocofy site publish.

  blocofy site publish [dir] [--target new|<handle>] [--mode same_site|restore] [--yes]
      Make an applied state the LIVE site: pointer swap, then navigation, then settings.
      Refuses (exit 2) if the state is not fully applied yet — run 'site apply' first.
      Separate live gate: asks to confirm (non-interactive shells must add --yes).

  blocofy --version
  blocofy --help

Examples
  blocofy login && blocofy init my-site                                     (browser login, new project)
  blocofy login --url https://store.myblocofy.com --token                   (pasted dev token, hidden)
  blocofy theme pull store-theme --context store && cd store-theme && blocofy theme dev
  blocofy link ~/code/store-theme --context store     (an existing checkout)
  blocofy theme push && blocofy theme publish          (inside the bound project)
  blocofy theme push ./shop && blocofy theme publish ./shop   (from anywhere: ./shop's site)
  blocofy target && blocofy status
  blocofy login --api-key --context store
  blocofy pages media-uses pg_abc123 --json
  blocofy pages media-decide pg_abc123 --decisions decisions.json

Targets (which site a command talks to)
  Every remote command verifies its site first and prints a Target block on stderr: the site,
  the Platform it was verified on, the Context and where that choice came from (--context,
  BLOCOFY_CONTEXT, env credentials, .blocofy/local.json, the project's site, the \`use\`
  default), the Binding and the Operation (command · mode). --json: the same as {"target":…}.
  The context is chosen in this order: --context → BLOCOFY_CONTEXT → env credentials
  (BLOCOFY_URL+BLOCOFY_TOKEN and/or BLOCOFY_API_URL+BLOCOFY_API_KEY) → .blocofy/local.json
  → the one saved context matching the project's site → (terminal) pick from the matches.
  BLOCOFY_CONTEXT, the env credentials and .blocofy/local.json are each a choice: if two of them
  name different contexts the command is refused before anything is read or written
  (TARGET_CONTEXT_CONFLICT) — pass --context <name> to settle it (the Target block then lists
  what it overrode). Inside a bound project \`use\` is ignored; outside one it is used only by
  status, target and pages check — every other command needs --context/BLOCOFY_CONTEXT/env.
  Commands that change a site (theme push/publish/rename/dev sync, pages push, settings push,
  pages media-decide) need a bound project; pulls into a new empty directory bind it. A wrong project/site pairing changes nothing.
  A context holds two SEPARATE credentials — the theme dev token (bcf_…, BLOCOFY_TOKEN) and the
  v1 API key (blcf_live_…, BLOCOFY_API_KEY); one in the other's place is refused before any
  request (TARGET_CREDENTIAL_WRONG_TYPE, exit 1). Each is verified with its own endpoint
  (/api/dev/whoami, /api/v1/ping) and both must resolve to the same site.
  A binding made against an older server has no platform origin: it still matches the same site
  (one warning; run \`blocofy link --adopt\` to record it). A server that reports no origin cannot
  serve a binding that records one (TARGET_UNVERIFIED).
  Exit codes (every command): 0 ok · 1 usage/network/5xx/local check · 2 server refusal (HTTP 4xx)
  · 3 target/binding refusal · 4 'site apply': not finished within its bounded pass count —
  every step already applied is safe, re-run the same command to resume; 'logout': the local
  login was not removed or the platform login was NOT revoked · 5 'init': the live theme changed
  meanwhile (init never writes it; not reported as a success).
  --json: every failure prints {"error":{"code","message","details"}} as the LAST stderr line; the
  target block ({"target":…}) and any warning lines are printed on stderr before it.
  Retries: network errors and HTTP 429/502/503/504 are retried up to 3 times (Retry-After honoured,
  max 30s per wait; else 0.3s/0.9s/2s), resending the identical request (pages push carries one
  x-idempotency-key per push). HTTP 500 is never retried. Each retry prints a notice on stderr.

Auth: ~/.blocofy/credentials.json (contexts, no secrets). A browser login's tokens live in the OS
secure store (macOS Keychain, Windows DPAPI file, Linux Secret Service; the 0600 file only when
chosen); a pasted token/key in ~/.blocofy/secrets.json (0600) or the macOS keychain. A pre-0.10 credentials file is migrated on first use (backup:
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
  if (error instanceof LoginError || error instanceof InitError || error?.name === "LoopbackError") return error.exitCode ?? 1;
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
  if (error instanceof PagesCliError || error instanceof SiteStateFsError) {
    if (error.diagnostics?.length) details.diagnostics = error.diagnostics;
    if (Array.isArray(error.pages)) details.pages = error.pages;
  }
  return { code, message: error?.message || String(error), details };
}

/** The context the current command resolved (for the re-login hint of a credential refusal). */
let activeContext = null;

/**
 * ADR-0014 (wave P4) — the plain Turkish lines of a credential refusal (the profile gate's codes and the CLI's own
 * REAUTH_REQUIRED), printed before the usual `error [code]` line. Never under --json (the envelope carries the code).
 */
function printRefusalLines(error) {
  if (JSON_MODE) return;
  if (Array.isArray(error?.lines)) for (const line of error.lines) console.error(redact(line));
  const code = error instanceof CliRefusal ? error.error?.code : error?.details?.server_code ?? error?.code;
  const details = error instanceof CliRefusal ? error.error?.details : error?.serverDetails ?? error?.body?.details ?? error?.details;
  const refusal = credentialRefusal(code, details ?? {}, { context: error?.details?.context ?? activeContext });
  if (refusal) for (const line of refusal.lines) console.error(redact(line));
}

function failAndExit(error) {
  const code = exitCodeFor(error);
  printRefusalLines(error);
  if ((error instanceof PagesCliError || error instanceof SiteStateFsError) && !JSON_MODE) {
    if (error.diagnostics?.length) reportPageDiagnostics(error.diagnostics);
  }
  if ((error instanceof PagesCliError || error instanceof SiteStateFsError) && Array.isArray(error.pages) && error.pages.length && !JSON_MODE) {
    console.error("Per-file result:");
    for (const p of error.pages) console.error(`  ${p.outcome ?? p.action}  ${p.path}`);
  }
  if (error instanceof CliRefusal && !JSON_MODE) {
    // Existing media-* contract: the server's {error} JSON verbatim on stderr.
    process.stderr.write(redact(JSON.stringify({ error: error.error })) + "\n");
  } else if ((error instanceof PagesCliError || error instanceof SiteStateFsError) && !JSON_MODE) {
    process.stderr.write(redact(`${error.diagnostics?.length ? "\n" : ""}error [${error.code}]:\n    ${error.message}`) + "\n");
  } else if (!JSON_MODE && !(error instanceof TargetError || error instanceof CredentialsError) && !(typeof error?.code === "string" && error.code)) {
    process.stderr.write(redact(error?.message || String(error)) + "\n");
  } else {
    printError(envelopeFor(error), { json: JSON_MODE });
  }
  process.exit(code);
}

/**
 * #989 — the platform (or `findCliDraft`, which mirrors it) refused to pick the draft automatically. Says why, lists the
 * candidate drafts and the exact command to repeat with `--instance`; exits 2 (409). Never retried.
 */
function failDraftTargetAmbiguous(error, command, { action = "write" } = {}) {
  // Review P3: a refusal of a RESENT apply says nothing about the earlier attempt — never "Nothing was written" then.
  const earlierAttempt = error?.phase === "apply" && (error.earlierAttempt === "unknown" || error.earlierAttempt === "committed") ? error.earlierAttempt : null;
  failAndExit({
    code: DRAFT_TARGET_AMBIGUOUS,
    status: 409,
    message: draftTargetAmbiguousMessage(error, { command, action, earlierAttempt }),
    details: {
      reason: error.reason ?? null,
      candidates: error.candidates ?? [],
      suggestedInstance: error.suggestedInstance ?? null,
      ...(earlierAttempt ? { earlierAttempt } : {}),
    },
  });
}

/**
 * Theme-capacity (ADR-0013) refusals of the dev theme endpoint: `target_missing`, `quota_exceeded`,
 * `capacity_unavailable`, `resource_busy`, `source_stale`. The plain Turkish explanation first (human mode), then the
 * shared `error [code]` line / `--json` envelope; exit 2 for the 4xx ones, 1 for the 503 ones. Returns only when
 * `error` is not one of them.
 */
function failOnThemeCapacityRefusal(error, pushCommand) {
  const refusal = themeCapacityRefusal(error, { pushCommand });
  if (!refusal) return;
  if (!JSON_MODE) for (const line of refusal.lines) console.error(line);
  failAndExit({ code: error.code, status: error.status, message: refusal.message, details: refusal.details });
}

/**
 * Could `instance` be the live theme? Fail-closed (#989 review): yes when it is the live handle, when the live theme is
 * not known, and when it is a raw numeric id (the server accepts one, the live handle comparison cannot see it).
 */
const instanceMaybeLive = (instance, liveThemeId) =>
  liveThemeId == null || String(instance) === String(liveThemeId) || /^\d+$/.test(String(instance));

/** The command line to repeat with `--instance` (the directory argument kept, as the user typed it). */
const commandLine = (base, positionals) => [base, ...positionals.slice(0, 1)].join(" ");

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
function saveVerifiedPair(name, kind, args) {
  withStoreLock(() => saveVerifiedPairLocked(name, kind, args));
}

function saveVerifiedPairLocked(name, kind, { url, secret, identity, storeName }) {
  const store = loadStore();
  const existing = store.contexts[name];
  if (existing?.oauth) {
    throw new TargetError("TARGET_CONTEXT_OCCUPIED", `Context "${name}" is a browser login (blocofy login); a pasted ${kind === "dev" ? "dev token" : "API key"} gets a context of its own. Nothing was saved. Use --context <another-name>.`, { context: name });
  }
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
    apiKey = await promptSecret("API key (blcf_live_… / blcf_k2_…, hidden): ");
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
    console.error("Invalid API key — a v1 key starts with blcf_live_ or blcf_k2_ (a bcf_ dev token is not accepted for the v1 API). Nothing was written.");
    process.exit(1);
  }
  registerSecret(apiKey);
  const storeName = defaultSecretStoreName({ keychain: Boolean(flags.keychain) });

  const identity = await verifyApi({ url: apiUrl, apiKey, retry });
  const name = contextNameOrExit(typeof flags.context === "string" ? flags.context : identity.site.slug ?? "");
  await assertPairFitsContext(name, loadStore().contexts[name], identity, "dev");
  saveVerifiedPair(name, "api", { url: apiUrl, secret: apiKey, identity, storeName });
  console.log(`✓ API key saved to context "${name}" → ${credentialsPath()} (API: ${apiUrl})`);
  console.log(`  Secret store: ${storeLabel(storeName)}`);
  console.log(`  Site: ${siteLabel(identity.site) || identity.site.id}`);
  console.log("Next: blocofy pages media-uses <page-handle>");
}

// ── browser login (ADR-0014 §5, wave P4) ──────────────────────────────────────────────────────────────────

/** Where the owner manages connections (the "Connections and keys" hub). */
const CONNECTIONS_PATH = "/settings/connections";

/** A person at a terminal: stdin is a TTY and CI is not set. Unattended runs never open a browser. */
const isUnattended = () => !process.stdin.isTTY || Boolean(process.env.CI);
const isSshSession = () => Boolean(process.env.SSH_CONNECTION || process.env.SSH_CLIENT || process.env.SSH_TTY);

const withLines = (error, lines) => Object.assign(error, { lines });

function assertBrowserLoginPossible() {
  if (isUnattended()) {
    throw withLines(
      new LoginError("LOGIN_UNATTENDED", "Browser login needs an interactive terminal (no TTY, or CI is set): no browser was opened and nothing was sent. In CI use BLOCOFY_API_KEY + BLOCOFY_API_URL (or BLOCOFY_URL + BLOCOFY_TOKEN); advanced: blocofy login --token / blocofy login --api-key."),
      [
        "Tarayıcıyla giriş bir terminal ister; bu oturum etkileşimsiz (CI ya da yönlendirilmiş girdi). Tarayıcı açılmadı, hiçbir şey gönderilmedi.",
        "  CI/otomasyon: BLOCOFY_API_KEY + BLOCOFY_API_URL (ya da BLOCOFY_URL + BLOCOFY_TOKEN) ortam değişkenleri.",
        "  Gelişmiş: yapıştırılan token ile giriş:  blocofy login --token   ya da   blocofy login --api-key",
      ],
    );
  }
  if (isSshSession()) {
    throw withLines(
      new LoginError("LOGIN_NO_BROWSER", "Browser login is not supported over SSH (the browser cannot reach this machine's 127.0.0.1 callback). Nothing was sent. Advanced: blocofy login --token / blocofy login --api-key."),
      [
        "Uzak (SSH) oturumda tarayıcıyla giriş desteklenmiyor: tarayıcı bu makinenin 127.0.0.1 adresine dönemez. Hiçbir şey gönderilmedi.",
        "  Gelişmiş: yapıştırılan token ile giriş:  blocofy login --token   ya da   blocofy login --api-key",
      ],
    );
  }
}

function loginOrigin(flags) {
  const origin = normalizeUrl(typeof flags["api-url"] === "string" ? flags["api-url"] : DEFAULT_API_URL);
  if (!isValidUrl(origin)) throw new LoginError("USAGE", "Invalid --api-url — must be a valid http(s):// URL. Nothing was written.");
  return origin;
}

/** `--site <handle|slug>` names the approved site. */
const siteMatches = (site, arg) => String(site.id) === String(arg) || (site.slug != null && site.slug === arg);

/** A browser login owns its context: never one that holds pasted secrets, never one recorded for another site. */
function assertContextFreeForLogin(name, identity) {
  const ctx = loadStore().contexts[name];
  if (!ctx) return;
  if (ctx.dev || ctx.api) {
    throw new TargetError("TARGET_CONTEXT_OCCUPIED", `Context "${name}" holds a pasted dev token / API key; a browser login gets a context of its own. Nothing was saved. Use --context <another-name> (or \`blocofy logout --context ${name}\` first).`, { context: name });
  }
  if (identity && ctx.site) {
    const o = compareOrigin(ctx.platform_origin, identity.platformOrigin);
    if (String(ctx.site.id) !== String(identity.site.id) || o === "mismatch" || o === "unproven") {
      throw new TargetError("TARGET_SITE_MISMATCH", `Context "${name}" is for site ${ctx.site.slug ?? ctx.site.id}, but you approved ${identity.site.slug ?? identity.site.id}. Nothing was saved. Use another --context name.`, { context: name, context_site_id: ctx.site.id, new_site_id: identity.site.id });
    }
  }
}

/** Save a verified browser login (token set first, then the context). Returns the previous token set, if any. */
function saveOAuthContext(name, storeName, { tokens, identity, metadata }, origin) {
  return withStoreLock(() => {
    const store = loadStore();
    const existing = store.contexts[name];
    let previous = null;
    if (existing?.oauth) {
      try {
        const t = readOAuthTokens(name, existing);
        if (t) previous = { token: t.refresh_token ?? t.access_token, endpoint: existing.oauth.revocation_endpoint ?? null };
      } catch {
        previous = null;
      }
    }
    writeOAuthTokens(name, storeName, tokens);
    if (existing?.oauth && existing.oauth.secret.store !== storeName) {
      try {
        removeSecrets(name, { oauth: existing.oauth });
      } catch {
        /* the old copy stays in the other store; the context now points at the new one */
      }
    }
    store.contexts[name] = {
      platform_origin: identity.platformOrigin ?? origin,
      site: { id: identity.site.id, slug: identity.site.slug ?? null, name: identity.site.name ?? null, domain: identity.site.domain ?? null },
      oauth: {
        url: origin,
        issuer: metadata.issuer,
        client_id: CLI_CLIENT_ID,
        token_endpoint: metadata.token_endpoint,
        revocation_endpoint: metadata.revocation_endpoint ?? null,
        dev_url: identity.devUrl ?? null,
        profile: identity.profile,
        secret: { store: storeName },
        logged_in_at: new Date().toISOString(),
      },
      verified_at: new Date().toISOString(),
    };
    if (!store.current_context) store.current_context = name;
    saveStore(store);
    return previous;
  });
}

/**
 * The browser login and its save (ADR §5.2): used by `login` and by `init` when it has no credential. Success is the
 * canonical identity probe, then the save. Returns `{ name, identity, storeName, explicitStore, origin }`.
 */
async function browserLoginAndSave({ flags, contextName = null, siteArg = null }) {
  assertBrowserLoginPossible();
  const origin = loginOrigin(flags);
  let store;
  try {
    store = oauthSecretStore({ insecure: Boolean(flags["insecure-storage"]) });
  } catch (error) {
    throw error instanceof SecretStoreError ? new CredentialsError(error.code, error.message) : error;
  }
  if (contextName) {
    contextNameOrExit(contextName);
    assertContextFreeForLogin(contextName, null);
  }
  if (!JSON_MODE) console.error(`Blocofy girişi tarayıcıda açılıyor (${origin})…`);
  const result = await runBrowserLogin({
    origin,
    openBrowser: flags["no-browser"] ? async () => {} : async (url) => openUrl(url),
    print: (url) => {
      if (JSON_MODE) return;
      console.error("Tarayıcı açılmazsa bu adresi aç (adres sır içermez):");
      console.error(`  ${url}`);
      console.error("Tarayıcıda siteni seçip onayla; en çok 5 dakika bekliyorum…");
    },
    onRetry,
  });
  registerSecret(result.tokens.access_token);
  registerSecret(result.tokens.refresh_token);
  const { identity } = result;
  if (siteArg && !siteMatches(identity.site, siteArg)) {
    await result.abandon(new LoginError("LOGIN_SITE_MISMATCH", `You approved ${identity.site.slug ?? identity.site.id} in the browser, but --site asks for ${siteArg}. The new login was revoked; nothing was saved.`, { site: identity.site.id, requested: siteArg }, 3));
  }
  const name = contextName ?? identity.site.slug ?? "";
  try {
    contextNameOrExit(name);
    assertContextFreeForLogin(name, identity);
  } catch (error) {
    await result.abandon(error);
  }
  const previous = saveOAuthContext(name, store.name, result, origin);
  // A re-login replaces the context's previous login: close that one too (best effort; the hub lists any survivor).
  if (previous?.token && previous.endpoint) await revokeToken({ endpoint: previous.endpoint, token: previous.token });
  return { name, identity, storeName: store.name, explicitStore: store.explicit, origin };
}

async function browserLogin(flags, positionals) {
  if (positionals.length > 0) throw new TargetError("USAGE", "Usage: blocofy login [--context <name>] [--site <handle|slug>] [--api-url <url>] [--no-browser] [--insecure-storage]", {}, 1);
  const siteArg = typeof flags.site === "string" ? flags.site : null;
  const { name, identity, storeName, explicitStore, origin } = await browserLoginAndSave({ flags, contextName: typeof flags.context === "string" ? flags.context : null, siteArg });
  if (explicitStore) printWarning({ code: "SECRET_STORE_PLAINTEXT", message: `The login is kept in ~/.blocofy/secrets.json (0600) because you chose it (--insecure-storage / BLOCOFY_SECRET_STORE=file), not in the OS secure store.` }, { json: JSON_MODE });
  const p = identity.profile;
  if (JSON_MODE) {
    console.log(JSON.stringify({ login: { context: name, site: identity.site, platform_origin: identity.platformOrigin, profile: p, audience: identity.audience, store: storeName, policy_version: identity.policyVersion } }, null, 2));
    return;
  }
  console.log(`✓ Bağlandı: ${siteLabel(identity.site) || identity.site.id} — context "${name}"`);
  console.log(`  Profil: ${p.label ?? p.id} (${p.id}@${p.version ?? "?"})${p.id === "theme-dev" ? " — taslak üzerinde çalışır; canlı siteni değiştiremez, yayınlayamaz." : ""}`);
  console.log(`  Giriş bilgisi: ${storeLabel(storeName)}`);
  if (!identity.devUrl) console.log("  Not: sitenin henüz bir alan adı yok; tema dosyası komutları (theme dev/pull/push) şimdilik çalışmaz.");
  console.log(`Sonraki adım: yeni proje için  blocofy init <dizin>   ·   mevcut dizin için  blocofy link <dizin> --context ${name}`);
  console.log(`  Bağlantıyı panelden kesmek: ${origin}${CONNECTIONS_PATH}   ·   bu makineden çıkış: blocofy logout --context ${name}`);
  console.log(`technical: platform ${identity.platformOrigin ?? origin}, audience ${identity.audience}, policy_version ${identity.policyVersion ?? "?"}`);
}

async function login(rest) {
  const { flags, positionals } = parseArgsOrExit(rest, KNOWN.login);
  if (flags["api-key"]) {
    await loginApiKey(flags, positionals);
    return;
  }
  // ADR-0014 O2: the browser is the default; a pasted dev token (`--url` / `--token` / `--keychain`) is the advanced path.
  if (flags.url === undefined && flags.token === undefined && !flags.keychain) {
    await browserLogin(flags, positionals);
    return;
  }
  if (flags["api-url"] !== undefined || flags.site !== undefined || flags["insecure-storage"] || flags["no-browser"]) {
    console.error("--api-url / --site / --insecure-storage / --no-browser belong to the browser login (`blocofy login`) or `--api-key`; a pasted dev token takes --url and --token. Nothing was written.");
    process.exit(1);
  }
  let url = typeof flags.url === "string" ? normalizeUrl(flags.url) : "";
  let token = typeof flags.token === "string" ? flags.token.trim() : "";
  // ADR-0014 B6: a token on the command line is visible to other local users (ps) and kept in shell history.
  if (token) printWarning({ code: "TOKEN_IN_ARGV", message: "The dev token was given on the command line, where `ps` and your shell history can see it. Prefer `blocofy login --url <site> --token` (hidden prompt) or BLOCOFY_URL + BLOCOFY_TOKEN." }, { json: JSON_MODE });

  // Flag ile verildiyse anında doğrula (prompt'a düşmeden).
  if (url && !isValidUrl(url)) {
    console.error("Invalid --url — must be a valid http(s):// URL.");
    process.exit(1);
  }
  if (token && !isValidToken(token)) {
    console.error(
      token.startsWith("blcf_")
        ? "Invalid --token — that is a v1 API key (blcf_…), not a theme dev token (bcf_…). The two are separate credentials: add the API key with `blocofy login --api-key`. Nothing was written."
        : "Invalid --token — must start with bcf_ or bcf2_.",
    );
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
      if (!token && process.stdin.isTTY) {
        // ADR-0014 B6: the dev token prompt does not echo.
        rl.close();
        for (let i = 0; i < 3 && !token; i += 1) {
          const answer = await promptSecret("Dev token (bcf_… / bcf2_…, hidden): ");
          if (answer === null) {
            console.error("Cancelled. Nothing was written.");
            process.exit(1);
          }
          if (isValidToken(answer.trim())) token = answer.trim();
          else console.error("  ✗ Token must start with bcf_ or bcf2_ — get one from the admin panel: Settings → Theme CLI tokens.");
        }
        if (!token) {
          console.error("Too many invalid attempts.");
          process.exit(1);
        }
      }
      if (!token) {
        token = await promptValid(
          rl,
          "Dev token (bcf_…): ",
          (s) => s.trim(),
          isValidToken,
          "Token must start with bcf_ or bcf2_ — get one from the admin panel: Settings → Theme CLI tokens.",
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
  console.log(`  Secret store: ${storeLabel(storeName)}`);
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
    login: c.oauth ? { url: c.oauth.url, store: c.oauth.secret.store, profile: c.oauth.profile ?? null, state: c.oauth.state ?? "active" } : null,
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
    const login = r.login ? `cli-login ${r.login.url} [${r.login.store}]${r.login.profile ? ` ${r.login.profile.id}@${r.login.profile.version}` : ""}${r.login.state === "reauth_required" ? " (needs a new login)" : ""}` : null;
    const pairs = [r.dev ? `dev ${r.dev.url} [${r.dev.store}]` : null, r.api ? `api ${r.api.url} [${r.api.store}]` : null, login].filter(Boolean).join(", ");
    console.log(`${r.current ? "*" : " "} ${r.name}  ${site}  ${pairs}`);
  }
}

async function useCommand(rest) {
  const { positionals } = parseArgsOrExit(rest, []);
  const name = positionals[0];
  if (!name || positionals.length > 1) throw new TargetError("USAGE", "Usage: blocofy use <context>", {}, 1);
  withStoreLock(() => {
    const store = loadStore();
    if (!store.contexts[name]) throw new TargetError("TARGET_CONTEXT_UNKNOWN", `No context named "${name}". List them with \`blocofy contexts\`.`, { context: name });
    store.current_context = name;
    saveStore(store);
  });
  console.log(`✓ Default context for status / target / pages check outside a project: ${name}`);
  console.log("  (Inside a bound project the project's site decides; `use` never retargets it.)");
}

/**
 * ADR-0014 §5.5 — `blocofy logout [--context <name>]`. Two independent results, both printed:
 *   server  revoked (RFC 7009 /revoke answered 200) | unreachable (network / 5xx: NOT revoked) | refused (another
 *           answer: NOT revoked) | unavailable (the saved login could not be read: NOT revoked) | not_applicable
 *           (a pasted token or key: revoke it in the panel)
 *   local   cleared | failed — done whatever the server said.
 * Exit 0 only when the local login is cleared and nothing is left open on the server; otherwise 4.
 */
async function logoutCommand(rest) {
  const { flags, positionals } = parseArgsOrExit(rest, []);
  if (positionals.length) throw new TargetError("USAGE", "Usage: blocofy logout [--context <name>]", {}, 1);
  const store0 = loadStore();
  const name = typeof flags.context === "string" ? flags.context : store0.current_context;
  if (!name) throw new TargetError("USAGE", "Usage: blocofy logout --context <name> (no default context is set; see `blocofy contexts`).", {}, 1);
  const ctx = store0.contexts[name];
  if (!ctx) throw new TargetError("TARGET_CONTEXT_UNKNOWN", `No context named "${name}".`, { context: name });

  let server = { outcome: "not_applicable", status: null };
  if (ctx.oauth) {
    let tokens = null;
    try {
      tokens = readOAuthTokens(name, ctx);
    } catch {
      tokens = null;
    }
    const token = tokens?.refresh_token ?? tokens?.access_token ?? null;
    if (token) registerSecret(token);
    server = token && ctx.oauth.revocation_endpoint
      ? await revokeToken({ endpoint: ctx.oauth.revocation_endpoint, token, clientId: ctx.oauth.client_id ?? CLI_CLIENT_ID })
      : { outcome: "unavailable", status: null };
  }

  let local = "cleared";
  let localError = null;
  try {
    withStoreLock(() => {
      const store = loadStore();
      const current = store.contexts[name];
      if (!current) return;
      removeSecrets(name, current);
      delete store.contexts[name];
      if (store.current_context === name) store.current_context = null;
      saveStore(store);
    });
  } catch (error) {
    local = "failed";
    localError = error;
  }

  const hub = ctx.oauth ? `${String(ctx.oauth.url).replace(/\/+$/, "")}${CONNECTIONS_PATH}` : null;
  const ok = local === "cleared" && (server.outcome === "revoked" || server.outcome === "not_applicable");
  if (JSON_MODE) {
    console.log(JSON.stringify({ logout: { context: name, local, server: server.outcome, ...(server.status ? { server_status: server.status } : {}), ...(hub && server.outcome !== "revoked" ? { revoke_in_panel: hub } : {}) } }, null, 2));
  } else {
    console.log(local === "cleared" ? `✓ Yerel giriş silindi (context "${name}").` : `✗ Yerel giriş SİLİNEMEDİ (context "${name}"): ${redact(localError?.message ?? String(localError))}`);
    switch (server.outcome) {
      case "revoked":
        console.log("✓ Sunucudaki CLI bağlantısı iptal edildi.");
        break;
      case "not_applicable":
        console.log("  Sunucuda iptal edilecek bir CLI girişi yok: bu context yapıştırılmış bir token/anahtar taşıyordu; onu panelden iptal edebilirsin.");
        break;
      case "unreachable":
        console.log(`✗ Sunucudaki bağlantı İPTAL EDİLMEDİ (platforma ulaşılamadı${server.status ? `, HTTP ${server.status}` : ""}) — panelden kes: ${hub}`);
        break;
      case "refused":
        console.log(`✗ Sunucudaki bağlantı İPTAL EDİLMEDİ (platform isteği reddetti, HTTP ${server.status}) — panelden kes: ${hub}`);
        break;
      default:
        console.log(`✗ Sunucudaki bağlantı İPTAL EDİLMEDİ (kayıtlı giriş okunamadı) — panelden kes: ${hub}`);
    }
  }
  if (!ok) {
    if (!JSON_MODE) console.error(`logout: local ${local}, server ${server.outcome} — not complete (exit 4).`);
    process.exit(4);
  }
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
  const { resolved, secrets } = await credentialsFor(await resolveContext({ flagContext, envContextName: process.env.BLOCOFY_CONTEXT || null, envCtx, getStore: () => loadStore(), binding: null }));
  registerSecret(secrets.devToken);
  registerSecret(secrets.apiKey);
  assertCredentialTypes({ resolved, secrets });
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
  if (resolved.ignored.length) console.log(`  ${resolved.source} ${resolved.name} overrode ${overridesLabel(resolved.ignored)}.`);
  console.log(`  ${relative(process.cwd(), projectPath) || projectPath} — commit it; .blocofy/local.json stays private (git-ignored).`);
}

async function targetCommand(rest) {
  const { flags, positionals } = parseArgsOrExit(rest, []);
  const dir = singleDirArg(positionals, "blocofy target [dir]");
  const t = await prepareTarget({ command: "target", commandClass: "read", dir, flags, needs: "any", mode: "read", record: false, quiet: true, allowCurrentContext: true });
  if (JSON_MODE) console.log(JSON.stringify({ target: t.display }, null, 2));
  else printTarget(t.display, { stream: process.stdout });
}

/**
 * ADR-0014 §5 — the secrets of a resolved context. A browser-login context answers with its (renewed) CLI token in
 * both places: the v1 API at its platform origin and, when the site has a domain, the renderer's `/api/dev`.
 * Returns `{ resolved, secrets, renewToken }` (`renewToken`: a getter for long-running commands, else null).
 */
async function credentialsFor(resolved) {
  activeContext = resolved.name;
  if (resolved.env) return { resolved, secrets: resolved.env.secrets, renewToken: null };
  const ctx = resolved.context;
  if (!ctx.oauth) return { resolved, secrets: readSecrets(resolved.name, ctx), renewToken: null };
  const access = await accessTokenFor(resolved.name);
  registerSecret(access);
  const view = { ...ctx, api: { url: ctx.oauth.url, secret: ctx.oauth.secret } };
  if (ctx.oauth.dev_url) view.dev = { url: ctx.oauth.dev_url, secret: ctx.oauth.secret };
  return {
    resolved: { ...resolved, context: view, oauth: true },
    secrets: { devToken: ctx.oauth.dev_url ? access : null, apiKey: access },
    renewToken: async () => {
      const t = await accessTokenFor(resolved.name);
      registerSecret(t);
      return t;
    },
  };
}

/** "BLOCOFY_CONTEXT=beta, env credentials" — the stated context choices an explicit --context overrode. */
function overridesLabel(ignored) {
  return ignored.map((a) => (a.source === "env" ? "env credentials" : `${a.source}=${a.name}`)).join(", ");
}

/** An unverified (migrated) named context gets the verified site recorded once. */
function recordVerifiedSite(resolved, identity) {
  if (resolved.env || resolved.context.site) return;
  withStoreLock(() => {
    const store = loadStore();
    const ctx = store.contexts[resolved.name];
    if (!ctx || ctx.site) return;
    ctx.site = { id: identity.site.id, slug: identity.site.slug ?? null, name: identity.site.name ?? null, domain: identity.site.domain ?? null };
    ctx.platform_origin = identity.platformOrigin;
    ctx.verified_at = new Date().toISOString();
    saveStore(store);
  });
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
 * `needs`: "dev" | "api" | "any". `allowCurrentContext`: only `status`, `target` and `pages check` may fall back to
 * the `blocofy use` default outside a project (contract C2). Returns `{ name, dev, api, identity, binding, newBinding, display }`.
 */
async function prepareTarget({ command, commandClass, dir, flags, needs, mode, record = true, quiet = false, allowCurrentContext = false }) {
  const binding = findBinding(dir);
  const { newBinding } = enforceBindingPolicy({ commandClass, binding, dir, command });
  const envCtx = envContext();
  let cachedStore = null;
  const chosen = await resolveContext({
    flagContext: typeof flags.context === "string" ? flags.context : null,
    envContextName: process.env.BLOCOFY_CONTEXT || null,
    envCtx,
    getStore: () => (cachedStore ??= loadStore()),
    binding,
    allowCurrentContext,
    isTTY: Boolean(process.stdin.isTTY && process.stderr.isTTY),
    prompt: promptContext,
  });
  precheckContext({ binding, resolved: chosen });
  const { resolved, secrets, renewToken } = await credentialsFor(chosen);
  registerSecret(secrets.devToken);
  registerSecret(secrets.apiKey);
  assertCredentialTypes({ resolved, secrets });

  const hasDev = Boolean(resolved.context.dev && secrets.devToken);
  const hasApi = Boolean(resolved.context.api && secrets.apiKey);
  if (needs === "dev" && !hasDev && resolved.oauth) {
    throw new TargetError("LOGIN_REQUIRED", `Context "${resolved.name}" is a CLI login, but the site has no domain yet, so the theme-file endpoints (/api/dev) cannot be reached. Nothing was sent. Give the site a domain in the panel, then log in again: blocofy login --context ${resolved.name}`, { context: resolved.name }, 1);
  }
  if (needs === "dev" && !hasDev) {
    throw new TargetError("LOGIN_REQUIRED", `Login required: context "${resolved.name}" has no dev token. Run \`blocofy login${resolved.env ? "" : ` --context ${resolved.name}`}\` (or set BLOCOFY_URL + BLOCOFY_TOKEN).`, { context: resolved.name }, 1);
  }
  if (needs === "api" || needs === "both") {
    if (!hasApi) {
      throw new TargetError("LOGIN_REQUIRED", `API key required: run \`blocofy login --api-key\` (or set BLOCOFY_API_KEY + BLOCOFY_API_URL). The dev token (bcf_) is not accepted for the v1 API.`, { context: resolved.name }, 1);
    }
  }
  // CF-T4 — site plan/apply need BOTH pairs: the v1 API for the site-state endpoints, the dev token for the
  // canonical theme deploy `awaiting_theme_source` asks for. `verifyTarget` below already asserts they
  // resolve to the same site whenever both are present (dev && api), which "both" makes unconditional.
  if (needs === "both" && !hasDev) {
    throw new TargetError(
      "LOGIN_REQUIRED",
      `Login required: context "${resolved.name}" has no dev token. Run \`blocofy login${resolved.env ? "" : ` --context ${resolved.name}`}\` (or set BLOCOFY_URL + BLOCOFY_TOKEN). This command needs both a dev token and a v1 API key (site plan/apply, theme push --work).`,
      { context: resolved.name },
      1,
    );
  }

  const identity = await verifyTarget({ resolved, secrets, binding, retry });
  for (const w of identity.warnings ?? []) printWarning(w, { json: JSON_MODE });
  if (record) recordVerifiedSite(resolved, identity);

  const url = needs === "api" ? resolved.context.api?.url : resolved.context.dev?.url ?? resolved.context.api?.url;
  const bindingLabel = binding ? relative(process.cwd(), binding.projectPath) || binding.projectPath : newBinding ? "none (new pull)" : "none";
  const display = targetData({ site: identity.site, url, platformOrigin: identity.platformOrigin, contextName: resolved.name, contextSource: resolved.source, contextOverrides: resolved.ignored, bindingLabel, command, mode });
  if (!quiet) printTarget(display, { json: JSON_MODE });
  return {
    name: resolved.name,
    dev: hasDev ? { url: resolved.context.dev.url, token: secrets.devToken } : null,
    api: hasApi ? { apiUrl: resolved.context.api.url, apiKey: secrets.apiKey } : null,
    identity,
    binding,
    newBinding,
    display,
    renewToken,
  };
}

/**
 * Review M4: a pull into a new directory claims the binding exclusively BEFORE fetching/writing content; the claim is
 * released if the pull fails. `fn` performs the pull.
 */
async function withNewBindingClaim(target, dir, fn) {
  if (!target.newBinding) return fn();
  const claim = claimNewBinding(dir, { site: target.identity.site, platformOrigin: target.identity.platformOrigin });
  try {
    return await fn();
  } catch (error) {
    claim.release();
    throw error;
  }
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
  // Review M1: a draft pull was classed a remote mutation (binding required) because `?draft=1` used to provision the
  // draft server-side. A current platform never creates a theme on a read (ADR-0013 D6: 404 `target_missing`); the
  // class is kept fail-closed for platforms from before that change.
  const target = await prepareTarget({ command: draft ? "theme pull --draft" : "theme pull", commandClass: draft ? "remote-mutation" : "local-write", dir, flags, needs: "dev", mode: what });
  let count;
  try {
    ({ count } = await withNewBindingClaim(target, dir, () => pullTheme({ dir, url: target.dev.url, token: target.dev.token, draft, instance, onRetry })));
  } catch (error) {
    if (error?.code === DRAFT_TARGET_AMBIGUOUS) failDraftTargetAmbiguous(error, commandLine("blocofy theme pull", positionals));
    if (error?.code === "draft_target_unverifiable") {
      failAndExit({ code: "draft_target_unverifiable", status: 503, message: "The platform could not verify which draft to pull (a read failed on its side). Nothing was written. Try again in a moment.", details: {} });
    }
    failOnThemeCapacityRefusal(error, commandLine("blocofy theme push", positionals));
    throw error;
  }
  console.log(`Downloaded ${count} ${what} theme files → ${dir}`);
  bindAfterPull(target, dir);
}

// ── draft-only logins write into their own theme work (ADR-0014 §3.5, P4 follow-up) ───────────────────────

/** Profiles that never write a live or implicit target: their writes go to their own theme work. */
const DRAFT_ONLY_PROFILES = new Set(["theme-dev", "review", "service-ci"]);

/** The project's saved work: `.blocofy/local.json` (theme work start / init), else `.blocofy/init.json`. */
function savedWorkOf(binding) {
  const local = readSavedWork(binding);
  if (local?.handle && local.theme) return local;
  let init = null;
  try {
    init = readInitState(binding.root);
  } catch {
    init = null;
  }
  if (init && isWorkHandle(init.work_handle) && String(init.site_id) === String(binding.project.site_id)) {
    return { handle: init.work_handle, theme: typeof init.work_theme === "string" ? init.work_theme : null };
  }
  return local?.handle ? local : null;
}

/**
 * Offline (no request): when the context this command will use carries a draft-only profile (a browser login, or a
 * recorded profile), `{ profile, work }` with the project's saved work (or null); otherwise null — then the command
 * behaves as before. Any resolution problem returns null and is reported by `prepareTarget` as usual.
 */
async function draftOnlyDefaults(dir, flags) {
  let binding;
  let resolved;
  try {
    binding = findBinding(dir);
    resolved = await resolveContext({ flagContext: typeof flags.context === "string" ? flags.context : null, envContextName: process.env.BLOCOFY_CONTEXT || null, envCtx: envContext(), getStore: () => loadStore(), binding, isTTY: false, prompt: null });
  } catch {
    return null;
  }
  const profile = resolved.context?.oauth?.profile ?? resolved.context?.profile ?? null;
  if (!profile || !DRAFT_ONLY_PROFILES.has(profile.id)) return null;
  return { profile, work: binding ? savedWorkOf(binding) : null };
}

function themeWorkRequired(profile, command) {
  return withLines(
    new TargetError(
      "THEME_WORK_REQUIRED",
      `This login is draft-only (profile ${profile.id}): \`${command}\` writes only into its own theme work, and this project has no saved work. Nothing was sent. Set one up: blocofy init <dir> (a new project) or blocofy theme work start (this project); or name the target: --work <wk_…> / --instance <theme>.`,
      { profile: profile.id },
      3,
    ),
    [
      `Bu giriş yalnız taslak üzerinde çalışır ("${profile.label ?? profile.id}"): \`${command}\` yalnız kendi tema çalışmasına yazar ve bu projede kayıtlı bir tema çalışması yok. Hiçbir şey gönderilmedi.`,
      "  Yeni proje:  blocofy init <dizin>   ·   bu projede yeni çalışma:  blocofy theme work start",
      "  Ya da hedefi açıkça ver:  --work <wk_…>  /  --instance <tema>",
    ],
  );
}

const savedWorkNote = (work) => `Kayıtlı tema çalışması kullanılıyor: ${work.handle}${work.theme ? ` (tema ${work.theme})` : ""} — başka bir hedef için --work / --instance ver.`;

async function themePush(rest) {
  const { flags, positionals } = parseArgsOrExit(rest, KNOWN.themePush);
  const dir = resolve(positionals[0] ?? process.cwd());
  if (!existsSync(dir)) {
    console.error(`Theme directory not found: ${dir}`);
    process.exit(1);
  }
  let instanceFlag = typeof flags.instance === "string" ? flags.instance : null;
  const name = typeof flags.name === "string" ? flags.name : null;
  const dryRun = Boolean(flags["dry-run"] || flags.validate);
  // CF-T2: `--diff` and `--dry-run` are reads; every other push is a remote mutation (binding required). The
  // target is verified (whoami, both pairs, binding) before the first theme request — no best-effort swallow.
  const readOnly = Boolean(flags.diff) || dryRun;
  // Theme work: `--work <wk_…>` names the target itself — that work's own draft theme, read from the v1 API (the
  // work belongs to the API key) and written through the dev token as `--draft --instance <work theme>`. Both pairs
  // must resolve to the same site (prepareTarget "both"); the work must be open. Never live.
  // A draft-only login with no explicit target writes into the project's saved work (explicit flags win).
  let savedWork = null;
  if (flags.work === undefined && !instanceFlag && !flags.live) {
    const d = await draftOnlyDefaults(dir, flags);
    if (d) {
      if (!d.work) throw themeWorkRequired(d.profile, "theme push");
      savedWork = d.work.handle;
      if (!JSON_MODE) console.error(savedWorkNote(d.work));
    }
  }
  const workHandle = flags.work === undefined ? savedWork : flags.work;
  let workTarget = null;
  if (workHandle !== null) {
    if (!isWorkHandle(workHandle)) throw new TargetError("USAGE", "--work needs a work handle (wk_…, from `blocofy theme work start`). Nothing was sent.", {}, 1);
    if (flags.live || instanceFlag) throw new TargetError("USAGE", "--work names the target itself; it cannot be combined with --live or --instance. Nothing was sent.", {}, 1);
    workTarget = await prepareTarget({ command: "theme push", commandClass: readOnly ? "read" : "remote-mutation", dir, flags, needs: "both", mode: `${readOnly ? (flags.diff ? "read · diff vs " : "read · dry run · ") : "draft · "}work ${workHandle}` });
    instanceFlag = (await openWorkTheme(workTarget.api, workHandle)).theme;
  }
  const draftFlag = Boolean(flags.draft) || workHandle !== null;
  // Yeni varsayılan hedef: DRAFT (güvenli). `--live` eski anında-canlı davranışını
  // açıkça geri getirir; `--instance` belirli bir temayı adresler. Sadece "live"
  // modu canlıya yazar ve onay gerektirir.
  const { mode, instance } = resolvePushMode({
    live: Boolean(flags.live),
    draft: draftFlag,
    instance: instanceFlag,
  });
  const opMode = flags.diff ? `read · diff vs ${instanceFlag ? `instance ${instanceFlag}` : mode === "draft" ? "CLI draft" : "live"}` : dryRun ? `read · dry run (${mode === "instance" ? `instance ${instance}` : mode})` : mode === "instance" ? `instance ${instance}` : mode;
  const target = workTarget ?? (await prepareTarget({ command: "theme push", commandClass: readOnly ? "read" : "remote-mutation", dir, flags, needs: "dev", mode: `${opMode}${flags.prune && !readOnly ? " · prune" : ""}` }));
  const creds = target.dev;
  // 0.5.0: her push'a otomatik idempotency key — kanonik dal (protokol + key) ancak böyle seçilir; key
  // OLMADAN header'lar tek başına legacy writer'a düşer ve --live push pinned render'a YANSIMAZ (M4
  // read cutover'ının ana CLI şikâyeti). Push-OPERASYONU-başına üretilir: fetchWithRetry'nin 5xx/429
  // denemeleri aynı key'le yakınsar, ardışık push'lar farklı key alır (sabit key, settings/hedef
  // değişiminde kalıcı 409 idempotency_conflict üretirdi). Ham id gönderilir — sunucu `idem:` ile
  // ad-alanlar, önek EKLENMEZ.
  const idempotencyKey = typeof flags["idempotency-key"] === "string" ? flags["idempotency-key"] : `cli-${randomUUID()}`;

  // `--diff`: read-only preview vs what the push would write to. PS-26: a draft push writes to the CLI draft, so
  // that draft is found via `/api/dev/site` and diffed by handle — never via `?draft=1`, which PROVISIONS a draft
  // server-side (a read-only command must not mutate). With no CLI draft yet the push would create one: vs live.
  if (flags.diff) {
    const diffTarget = ` of ${siteLabel(target.identity.site)}`;
    let cliDraft = null;
    try {
      cliDraft = mode === "draft" ? findCliDraft(await fetchSiteStatus({ url: creds.url, token: creds.token, onRetry })) : null;
    } catch (error) {
      // #989: the diff compares with the draft the push would write to — and refuses exactly when the push would.
      if (error?.code === DRAFT_TARGET_AMBIGUOUS) failDraftTargetAmbiguous(error, `${commandLine("blocofy theme push", positionals)} --diff`);
      throw error;
    }
    const diffInstance = instanceFlag ?? cliDraft?.id ?? null;
    const d = await diffTheme({ dir, url: creds.url, token: creds.token, instance: diffInstance, onRetry });
    if (instanceFlag) console.log(`Diff vs theme ${instanceFlag}${diffTarget}:`);
    else if (cliDraft) console.log(`Diff vs draft ${cliDraft.id}${cliDraft.name ? ` "${cliDraft.name}"` : ""}${diffTarget} (the CLI draft this push writes to):`);
    else if (mode === "draft") console.log(`No CLI draft yet — this push would create one. Diff vs the LIVE theme${diffTarget}:`);
    else console.log(`Diff vs the LIVE theme${diffTarget}:`);
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
    console.log(`→ Pushing to theme ${instance} of ${siteName}${workHandle ? ` (work ${workHandle})` : whoami.liveThemeId != null && String(instance) === String(whoami.liveThemeId) ? " (the LIVE theme)" : ""}`);
  } else if (mode === "live") {
    console.log(dryRun ? `→ Validating against the LIVE theme of ${siteName} (dry run — nothing will be written)` : `→ Pushing to the LIVE theme of ${siteName}`);
  } else {
    console.log(`→ Pushing to a draft of ${siteName}`);
  }

  // Canlı push (`--live`) ANINDA canlı temayı değiştirir (önizleme yok). Agent/CI
  // kazara canlıya basmasın diye açık onay şart (#431 L2). Draft/instance modu
  // güvenli → otomatik onay (prompt yok).
  // 0.5.0: `--dry-run` hiçbir şey yazmaz → canlı onayı gereksiz (draft:true gibi davranır).
  // #989 review: `--instance <the live theme's handle>` writes the LIVE theme exactly like `--live`, so it needs the
  // same confirmation (an explicit --instance is the documented way past a refused draft pick — it must not become a
  // way to write live without asking).
  const instanceIsLive = mode === "instance" && instanceMaybeLive(instance, whoami.liveThemeId);
  // `--draft --instance <h>`: a draft write to a chosen draft. It never reaches the live theme — refused here when the
  // handle may be live (fail-closed), and by the server (422 draft_target_is_live) in any case.
  const draftInstance = mode === "instance" && draftFlag;
  if (draftInstance && instanceIsLive && !dryRun) {
    console.error(`✗ --draft --instance ${instance}: ${whoami.liveThemeId != null && String(instance) === String(whoami.liveThemeId) ? "that is the LIVE theme" : "this may be the LIVE theme (it could not be told apart from it)"}; a draft push never writes live. Nothing was written.`);
    console.error("  Pass a draft's handle (`blocofy status`), or drop --draft and confirm a live push.");
    process.exit(2);
  }
  const decision = livePushDecision({
    draft: (mode !== "live" && (!instanceIsLive || draftInstance)) || dryRun,
    yes: Boolean(flags.yes),
    confirm: Boolean(flags.confirm),
    isTTY: Boolean(process.stdin.isTTY),
  });
  if (decision.mustAbort) {
    if (instanceIsLive) {
      console.error(
        whoami.liveThemeId != null && String(instance) === String(whoami.liveThemeId)
          ? `⚠ Theme ${instance} is the LIVE theme of ${siteName}: this push writes to it immediately (no preview).`
          : `⚠ Theme ${instance} may be the LIVE theme of ${siteName} (it could not be told apart from it): a push to it may write live immediately.`,
      );
      console.error(`  Non-interactive shell: pass --yes to confirm, or push to a draft instead. Nothing was written.`);
      process.exit(1);
    }
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
  // TPUSH-5: `--dry-run --prune` plans the pruned payload (it writes nothing, so it asks nothing).
  const prune = Boolean(flags.prune);
  const liveTarget = mode === "live" || instanceIsLive;
  const pruneDecision = livePushDecision({
    draft: !prune || dryRun || !liveTarget,
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
      draft: mode === "draft" || draftInstance,
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
    if (error?.code === DRAFT_TARGET_AMBIGUOUS) failDraftTargetAmbiguous(error, commandLine("blocofy theme push", positionals));
    if (error?.code === "draft_target_is_live") {
      failAndExit({ code: "draft_target_is_live", status: 422, message: "A draft push cannot write the LIVE theme; nothing was written. Pass a draft's handle (`blocofy status`), or drop --draft and confirm a live push.", details: {} });
    }
    if (error?.code === "idempotency_conflict") {
      if (!JSON_MODE) {
        console.error("✗ Idempotency çakışması: aynı anahtar daha önce FARKLI içerikle kullanılmış (409).");
        console.error("  `--idempotency-key` verdiysen yeni bir anahtarla dene; vermediysen tekrar `blocofy theme push` yeterli (her koşu taze anahtar üretir).");
      }
      failAndExit({ code: "idempotency_conflict", status: error.status, message: "The idempotency key was already used with different content. Retry with a new key (or omit --idempotency-key).", details: {} });
    }
    // ADR-0013: the new draft this push needs was refused (definite answer, before the unknown-outcome handling below).
    failOnThemeCapacityRefusal(error, commandLine("blocofy theme push", positionals));
    const refusal = themePushRefusal(error, { draft: mode === "draft", idempotencyKey });
    if (refusal) failAndExit({ code: error.code, status: error.status, ...refusal });
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
    // TPUSH-5: a 6.5 server plans the push on the control plane; an older one only validated.
    if (result.newDraft === true) console.log("Plan against a new draft (created by the push):");
    else if (result.target === "live" || result.target === "draft") {
      console.log(`Plan against the ${result.target} theme, pointer ${result.pointerVersion == null ? "none yet" : `v${result.pointerVersion}`}:`);
    }
    printThemeOutcomes(result.files);
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
    printThemeOutcomes(result.files);
    const ids = `deployment #${result.deploymentId}, revision #${result.sourceRevisionId}, pointer v${result.pointerVersion}`;
    // TPUSH-5: "atomically" only when the server read the written files back and they match what was sent.
    if (result.readback?.verified === true) {
      console.log(`✓ Deployed atomically and read back (${result.readback.files} file${result.readback.files === 1 ? "" : "s"} verified): ${ids}.`);
    } else {
      console.log(`✓ Deployed: ${ids}. The written files were not verified (this server does not read them back).`);
    }
    if (result.convergence === "converged") console.log("  (already applied by an earlier push with the same idempotency key)");
    if (workHandle) {
      console.log(`Çalışma ${workHandle} güncellendi (tema ${instance}). Canlı site değişmedi.`);
      console.log(`Durumu:  blocofy theme work status ${workHandle}`);
    }
    if (mode === "draft") {
      const h = typeof result.targetInstance === "string" ? result.targetInstance : null;
      const label = result.targetName ? ` "${result.targetName}"` : "";
      if (h) console.log(result.newDraft ? `Draft: ${h}${label} (new)` : `Draft: ${h}${label} (existing CLI draft, updated)`);
      // --name only names a draft this push creates. #989 review: no rename advice — a draft renamed by hand to a name
      // that does not start with "CLI Draft — " is no longer picked automatically.
      if (name && result.newDraft !== true) {
        console.log(`Note: --name was not applied — it names only a draft this push creates; this push updated the existing CLI draft${h ? ` ${h}` : ""}.`);
      }
      console.log("Preview & publish it in the admin panel: Theme -> Theme library -> \"Open in editor\".");
      console.log(`Publish it live with:  blocofy theme publish${h ? ` --instance ${h}` : ""}`);
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

/**
 * TPUSH-5 — per-file outcomes of a theme push or its plan (6.5 server; an older one sends none). Changed files are
 * listed, unchanged ones only counted.
 */
function printThemeOutcomes(files) {
  if (!Array.isArray(files)) return;
  const count = { created: 0, updated: 0, removed: 0, unchanged: 0 };
  const mark = { created: "+", updated: "~", removed: "-" };
  for (const f of files) {
    if (!(f?.outcome in count)) continue;
    count[f.outcome] += 1;
    if (f.outcome !== "unchanged") console.log(`  ${mark[f.outcome]} ${f.path}`);
  }
  console.log(`Files: ${count.created} created, ${count.updated} updated, ${count.removed} removed, ${count.unchanged} unchanged.`);
}

/**
 * TPUSH-5 — the 6.5 theme push refusals, in words. `null` = not one of them. A refusal writes nothing, but when the
 * apply was resent after an attempt without a certain answer (`error.earlierAttempt`), that earlier attempt may have
 * written: then the message says so instead of "Nothing was written", and `details.earlierAttempt` names it.
 */
function themePushRefusal(error, { draft = false, idempotencyKey = null } = {}) {
  const body = error?.body ?? {};
  const earlier = error?.phase === "apply" && (error.earlierAttempt === "unknown" || error.earlierAttempt === "committed") ? error.earlierAttempt : null;
  // Where an earlier attempt of this push could have written: the theme its dry run bound it to (every attempt is the
  // same request), never the current target a refusal may name. A new-draft binding (null) is found via the drafts.
  const bound = error?.expectedTargetInstance;
  const check =
    typeof bound === "string"
      ? `\`blocofy theme push --diff --instance ${bound}\``
      : bound === null
        ? "`blocofy status` (it lists the drafts; one this push created would be there) and `blocofy theme push --diff --instance <handle>`"
        : "`blocofy status` and `blocofy theme push --diff --instance <handle>`";
  const target = typeof bound === "string" ? `theme ${bound}` : "the target";
  // `wrote`/`none`: what this refusal certainly did not do ("deployed" for target_changed, see below).
  const nothing = (next, { wrote = "wrote", none = "Nothing was written." } = {}) =>
    earlier === "committed"
      ? `This attempt ${wrote} nothing, but an earlier attempt of this push was committed (its answer said so). Check ${target} with ${check} before running the push again.`
      : earlier === "unknown"
        ? `This attempt ${wrote} nothing, but an earlier attempt of this push got no answer, so whether it wrote is unknown. Check ${target} with ${check} before running the push again.`
        : `${none} ${next}`;
  const withEarlier = (details) => (earlier ? { ...details, earlierAttempt: earlier } : details);
  // tpush round 5: a write whose last answer is transient (a passed-through 5xx, a 503 fail-closed, 502
  // readback_unverified with outcomeUnknown, or no answer) has an unknown outcome. It is retryable under the SAME key:
  // the platform then reports the committed deploy instead of writing it again. Keys are per run, so name this one.
  const unknownOutcome = (what) => ({
    ...(error?.code ? {} : { code: error?.status ? `HTTP_${error.status}` : "NETWORK_ERROR" }),
    message:
      `${what}, so whether this push was deployed${typeof bound === "string" ? ` to theme ${bound}` : ""} is unknown` +
      `${earlier === "committed" ? " (an earlier attempt's answer said it was committed)" : ""}. ` +
      `Run the same command again with \`--idempotency-key ${idempotencyKey ?? "<the same key>"}\`: if this push was deployed, the server reports that deploy instead of writing it again.`,
    details: withEarlier({ phase: "apply", outcome: "unknown", idempotencyKey, ...(error?.status ? { status: error.status } : {}), ...(bound !== undefined ? { expectedTargetInstance: bound } : {}) }),
  });
  switch (error?.code) {
    case "draft_target_unverifiable":
      // #989 review P3: the platform could not read which draft to write to; it wrote nothing for this attempt.
      return {
        message: `The platform could not verify which draft this push would write to (a read failed on its side). ${nothing("Run the push again in a moment.")}`,
        details: withEarlier({}),
      };
    case "pointer_version_conflict":
      return {
        message: `The target theme was deployed again after this push checked it (now at pointer ${body.currentVersion == null ? "none" : `v${body.currentVersion}`}). ${nothing("Run the push again.")}`,
        details: withEarlier({ currentVersion: body.currentVersion ?? null }),
      };
    case "site_state_version_conflict":
      return { message: `The theme's settings were saved on the site while this push was running. ${nothing("Run the push again.")}`, details: withEarlier({}) };
    case "manifest_mismatch":
      return { message: `The files sent for writing differ from the files the dry run checked. ${nothing("Run the push again.")}`, details: withEarlier({}) };
    case "target_changed": {
      const was = error.expectedTargetInstance === undefined ? "the theme its dry run planned against" : error.expectedTargetInstance === null ? "a new draft (its dry run planned one)" : `theme ${error.expectedTargetInstance}`;
      const now = typeof body.targetInstance === "string" ? `theme ${body.targetInstance}` : "a new draft (there is no draft to reuse any more)";
      // Definitive, but "nothing written" is not true of it: a draft push that lost the read/provision race may have
      // provisioned a new empty draft first (kept; the next draft push reuses it). No theme file was deployed.
      const none = `Nothing was deployed${draft ? " (at most a new, empty draft was created, which the next push reuses)" : ""}.`;
      return {
        message: `The push's target changed after its dry run: it planned against ${was}, but it would now write to ${now} (the live theme was switched, or the draft to reuse changed). ${nothing("Run the push again to plan against the current target.", { wrote: "deployed", none })}`,
        details: withEarlier({ expectedTargetInstance: error.expectedTargetInstance ?? null, targetInstance: typeof body.targetInstance === "string" ? body.targetInstance : null }),
      };
    }
    case "readback_unverified":
      // The dry run's plan is rolled back on the server: nothing was written, whatever `committed` says.
      if (error.phase === "plan") {
        return {
          message: "The server could not verify the plan of this push's dry run (a plan is rolled back). Nothing was written. Run the push again.",
          details: { phase: "plan", committed: false },
        };
      }
      if (body.outcomeUnknown === true) return unknownOutcome("The server could not read the control plane's answer to the write");
      // The write went to the theme the dry run bound it to; a plain --diff compares with the live theme only.
      return {
        message: `The server could not read back the files it wrote${body.committed === true ? " (the deploy was committed)" : body.committed === false ? " (nothing was committed)" : ""}. Check ${target} with ${check}.`,
        details: { phase: "apply", committed: typeof body.committed === "boolean" ? body.committed : null, ...(bound !== undefined ? { expectedTargetInstance: bound } : {}) },
      };
  }
  if (error?.phase === "apply" && (error.status == null || error.status >= 500)) {
    return unknownOutcome(error.status == null ? "The write got no answer" : `The write got no definite answer (HTTP ${error.status}${error.code ? ` ${error.code}` : ""})`);
  }
  // The 6.5 preflight names the file it refused (reserved_path, path_too_long, invalid_json…).
  if (error?.status === 422 && typeof body.path === "string") {
    return { message: `${body.path}: ${typeof body.message === "string" ? body.message : error.code}. ${nothing("").trim()}`, details: withEarlier({ path: body.path }) };
  }
  return null;
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

/** CF-T3 — plan totals, as the target block's operation and the table footer show them. */
function planTotals(pages) {
  const count = (action) => pages.filter((p) => p.action === action).length;
  return { live: count("publish"), draft: count("draft"), unchanged: count("unchanged"), conflicts: pages.filter((p) => p.conflict === true).length };
}

/** CF-T3 — the per-page plan a revision-checking server returned (stdout). */
function printPlanTable(plan) {
  const pages = plan.pages ?? [];
  const rows = pages.map((p) => [p.action ?? "", p.target ?? "", p.locale ?? "", p.path ?? "", (p.changed_fields ?? []).join(", ") || "-", p.conflict ? "[conflict]" : ""]);
  const header = ["ACTION", "TARGET", "LOCALE", "PATH", "CHANGED", ""];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (r) => "  " + r.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd();
  console.log("Plan:");
  console.log(line(header));
  for (const r of rows) console.log(line(r));
  const t = planTotals(pages);
  console.log(`Totals: live ${t.live} · draft ${t.draft} · unchanged ${t.unchanged} · conflicts ${t.conflicts}`);
}

async function pagesPush(rest) {
  const { flags, positionals } = parseArgsOrExit(rest, KNOWN.pagesPush);
  const dir = resolve(positionals[0] ?? process.cwd());
  if (!existsSync(dir)) {
    console.error(`Directory not found: ${dir}`);
    process.exit(1);
  }
  const dryRun = Boolean(flags["dry-run"]);
  const force = Boolean(flags.force);
  const reason = typeof flags.reason === "string" ? flags.reason : null;
  // CF-T3 — force always carries a reason (1–500 characters); a reason without force is a mistake, not a no-op.
  if (flags.reason !== undefined && !force) {
    printError({ code: "USAGE_REASON_WITHOUT_FORCE", message: "--reason is only used with --force. Nothing was sent." }, { json: JSON_MODE });
    process.exit(1);
  }
  if (force && (reason === null || reason.trim() === "" || reason.length > FORCE_REASON_MAX)) {
    printError({ code: "USAGE_FORCE_REASON_REQUIRED", message: `--force needs --reason <text> (1-${FORCE_REASON_MAX} characters): why newer content on the site may be overwritten. Nothing was sent.` }, { json: JSON_MODE });
    process.exit(1);
  }
  const baseMode = `${dryRun ? "read · dry run" : "live"}${force ? " · FORCE" : ""}`;
  const target = await prepareTarget({ command: "pages push", commandClass: dryRun ? "read" : "remote-mutation", dir, flags, needs: "dev", mode: baseMode, quiet: true });
  // The target block is printed once: with the plan totals when the server returns a plan, else as soon as it is known.
  let shown = false;
  const showTarget = (operation = target.display.operation) => {
    if (shown) return;
    shown = true;
    printTarget({ ...target.display, operation }, { json: JSON_MODE });
  };
  const creds = target.dev;
  let result;
  try {
    result = await pushContent({
      dir,
      url: creds.url,
      token: creds.token,
      scope: "pages",
      dryRun,
      force,
      forceReason: reason,
      onRetry,
      onServer: (server) => {
        if (server.revisionCas) return;
        showTarget();
        printWarning({ code: "PAGES_REVISION_CAS_UNAVAILABLE", message: "stale-file protection is not available on this server: a page file pulled before someone else's edit can overwrite it. Pull right before you push." }, { json: JSON_MODE });
      },
      onPlan: (plan) => {
        const t = planTotals(plan.pages ?? []);
        showTarget(`pages push · ${dryRun ? "dry run · " : ""}${force ? "FORCE · " : ""}live ${t.live} · draft ${t.draft} · unchanged ${t.unchanged}`);
        if (!JSON_MODE) printPlanTable(plan);
      },
    });
  } catch (error) {
    showTarget();
    throw error;
  }
  showTarget();
  const code = reportPageDiagnostics(result.diagnostics ?? [], { strict: Boolean(flags.strict) });
  if (JSON_MODE) {
    const { fileCount: _f, revisionCas: _r, ...body } = result;
    console.log(JSON.stringify(body, null, 2));
    process.exit(code);
  }
  const pages = result.pages ?? [];
  const count = (k, v) => pages.filter((p) => p[k] === v).length;
  const warnings = (result.diagnostics ?? []).filter((d) => d.level === "warning").length;
  if (dryRun) {
    console.log(`Preflight passed: ${count("action", "publish")} updates, ${count("action", "draft")} drafts, ${count("action", "unchanged")} unchanged, ${count("conflict", true)} conflicts, ${warnings} warning(s).`);
    console.log("Dry run only; no pages were changed.");
  } else {
    for (const p of pages) if (p.outcome !== "unchanged") console.log(`  ${p.outcome}  ${localeLabel(p)}  (${p.path})`);
    console.log(
      `Pages push: ${result.pagesUpdated} updated, ${result.pagesSkipped} skipped, ${warnings} warning(s) ` +
        `(only existing pages are updated — none created or deleted).`,
    );
  }
  const forced = forcedPaths(result.forced);
  if (forced.length) {
    console.log(dryRun ? "Forced (would overwrite without a base check):" : "Forced:");
    for (const path of forced) console.log(`  ${path}`);
  }
  process.exit(code);
}

async function pagesPull(rest) {
  const { flags, positionals } = parseArgsOrExit(rest, KNOWN.pagesPull);
  const dir = resolve(positionals[0] ?? process.cwd());
  const target = await prepareTarget({ command: "pages pull", commandClass: "local-write", dir, flags, needs: "dev", mode: "published pages" });
  const creds = target.dev;
  const { count, diagnostics } = await withNewBindingClaim(target, dir, () => pullContent({ dir, url: creds.url, token: creds.token, scope: "pages", onRetry }));
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
  const creds = (await optionalTarget({ command: "pages check", dir, flags, allowCurrentContext: true }))?.dev;
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

// ── site state (CF-T4): export | validate | plan | apply | publish ─────────────────────────────────────────

/**
 * A site-state tree on disk → what a plan/apply/publish request body needs: `files` (every tree path
 * EXCEPT `blocofy-site.json` itself and `media/files/<sha256>` bytes — contract §A1, those never travel in
 * a request) and a freshly recomputed `manifest` (the digest must describe the CURRENT files; a stale
 * committed one would just be refused). Provenance fields (`platform_origin`, `source_site`, `exported_at`)
 * are kept from the tree's own `blocofy-site.json` when it parses — that is what `site export` wrote — and
 * only synthesized from the verified target identity for a tree that never had one.
 *
 * Throws `SiteStateFsError` when the tree read found a symlink or other unreadable entry: nothing is sent.
 */
function loadSiteStateForRequest(dir, identity) {
  const tree = readSiteStateTree(dir);
  if (tree.diagnostics.length > 0) {
    throw new SiteStateFsError("SITE_STATE_INVALID_PATH", "The local tree has unreadable entries; nothing was sent.", tree.diagnostics);
  }
  const requestFiles = { ...tree.files };
  delete requestFiles[MANIFEST_PATH];

  let provenance = null;
  if (tree.files[MANIFEST_PATH] !== undefined) {
    try {
      const parsed = JSON.parse(tree.files[MANIFEST_PATH]);
      if (parsed && typeof parsed === "object") {
        provenance = {
          platformOrigin: typeof parsed.platform_origin === "string" ? parsed.platform_origin : null,
          sourceSite: parsed.source_site ?? null,
          exportedAt: typeof parsed.exported_at === "string" ? parsed.exported_at : null,
        };
      }
    } catch {
      /* fall back to the verified identity below */
    }
  }
  const manifest = buildManifest({
    files: requestFiles,
    platformOrigin: provenance?.platformOrigin ?? identity.platformOrigin ?? null,
    sourceSite: provenance?.sourceSite ?? { id: identity.site.id, slug: identity.site.slug ?? "" },
    exportedAt: provenance?.exportedAt ?? new Date().toISOString(),
  });
  return { tree, requestFiles, manifest };
}

/** `--target new|<handle>` (default new), `--mode same_site|restore` (default restore), `--accept-live-effects locales`. */
function siteStateTargetFlags(flags) {
  const targetFlag = typeof flags.target === "string" && flags.target ? flags.target : "new";
  const mode = typeof flags.mode === "string" && flags.mode ? flags.mode : "restore";
  if (mode !== "same_site" && mode !== "restore") {
    console.error('--mode must be "same_site" or "restore". Nothing was sent.');
    process.exit(1);
  }
  const acceptLiveEffects =
    typeof flags["accept-live-effects"] === "string"
      ? flags["accept-live-effects"].split(",").map((s) => s.trim()).filter(Boolean)
      : [];
  return { targetFlag, mode, acceptLiveEffects };
}

function siteStateBody({ manifest, requestFiles, opts }) {
  return { manifest, files: requestFiles, mode: opts.mode, target: { instance: opts.targetFlag }, accept_live_effects: opts.acceptLiveEffects };
}

/** CF-T4 — the target block's operation: "plan/apply/publish · <draft instance> · mode <m> [· LIVE EFFECTS: …]". */
function siteStateOperationLabel(opts, op) {
  const t = opts.targetFlag === "new" ? "new draft instance" : `instance ${opts.targetFlag}`;
  const live = opts.acceptLiveEffects.length ? ` · LIVE EFFECTS: ${opts.acceptLiveEffects.join(",")}` : "";
  return `${op} · ${t} · mode ${opts.mode}${live}`;
}

function printSiteStatePlan(plan) {
  console.log(`Status: ${plan.status} (target instance: ${plan.target_instance ?? "not created yet"})`);
  if (plan.steps.length === 0) {
    console.log("No steps: this state is already applied to the target.");
  } else {
    console.log("Steps:");
    for (const s of plan.steps) {
      console.log(`  ${String(s.seq).padStart(2)}  ${s.owner.padEnd(14)} ${s.action.padEnd(16)} ${s.key}${s.live_effect ? "  [LIVE EFFECT]" : ""}`);
    }
  }
  if (plan.assets_missing.length > 0) console.log(`Assets missing on the site: ${plan.assets_missing.join(", ")}`);
  if (plan.theme_source) {
    console.log(`Theme source differs (digest ${plan.theme_source.digest.slice(0, 12)}…); deploy it to ${plan.theme_source.instance ?? "the new draft instance"}.`);
  }
  for (const p of plan.preconditions ?? []) console.warn(`precondition [${p.code}]: ${p.message}`);
  for (const d of plan.diagnostics ?? []) console.warn(formatDiagnostic(d));
}

async function siteExport(rest) {
  const { flags, positionals } = parseArgsOrExit(rest, KNOWN.siteExport);
  const dir = resolve(positionals[0] ?? process.cwd());
  const target = await prepareTarget({ command: "site export", commandClass: "local-write", dir, flags, needs: "api", mode: "export" });
  const { apiUrl, apiKey } = target.api;
  const { fileCount, assetCount } = await withNewBindingClaim(target, dir, async () => {
    const data = await fetchSiteStateExport({ apiUrl, apiKey, onRetry });
    const entries = [[MANIFEST_PATH, JSON.stringify(data.manifest, null, 2) + "\n"]];
    for (const [path, content] of Object.entries(data.files ?? {})) entries.push([path, content]);
    const assets = Array.isArray(data.assets) ? data.assets : [];
    for (const asset of assets) {
      const buf = await downloadAssetBytes({ url: asset.url, onRetry });
      const got = hashBuffer(buf);
      if (got !== asset.sha256) {
        throw new Error(`Downloaded ${asset.filename ?? asset.sha256} does not match its sha256 (expected ${asset.sha256}, got ${got}); nothing was written.`);
      }
      entries.push([`media/files/${asset.sha256}`, buf]);
    }
    // Staged, all-or-nothing: nothing lands on disk until every text file AND every downloaded, hash-verified
    // asset is ready.
    stagedWriteTree(dir, entries);
    return { fileCount: entries.length - assets.length, assetCount: assets.length };
  });
  console.log(`Exported ${fileCount} file(s) + ${assetCount} asset(s) → ${dir}`);
  bindAfterPull(target, dir);
}

async function siteValidate(rest) {
  const { flags, positionals } = parseArgsOrExit(rest, KNOWN.siteValidate);
  const dir = resolve(positionals[0] ?? process.cwd());
  if (!existsSync(dir)) {
    console.error(`Directory not found: ${dir}`);
    process.exit(1);
  }
  const tree = readSiteStateTree(dir);
  const combined = { ...tree.files };
  for (const a of tree.assets) combined[a.path] = ""; // content irrelevant to the structural checks below
  const findings = [...tree.diagnostics, ...validateSiteStateTree(combined)];

  if (tree.files[MANIFEST_PATH] !== undefined) {
    let manifest = null;
    try {
      manifest = JSON.parse(tree.files[MANIFEST_PATH]);
    } catch {
      /* reported below */
    }
    if (manifest === null) {
      findings.push({ level: "error", code: "SITE_STATE_INVALID_FILE", message: "blocofy-site.json is not valid JSON", path: MANIFEST_PATH });
    } else {
      const withoutManifest = { ...tree.files };
      delete withoutManifest[MANIFEST_PATH];
      const refusal = verifyManifest(manifest, withoutManifest);
      if (refusal) findings.push({ level: "error", code: refusal.code, message: refusal.message, path: MANIFEST_PATH });
    }
  }

  const code = reportPageDiagnostics(findings, { strict: Boolean(flags.strict) });
  const errors = findings.filter((f) => f.level === "error").length;
  console.log(`Checked ${Object.keys(tree.files).length + tree.assets.length} file(s): ${errors} error(s), ${findings.length - errors} warning(s).`);
  process.exit(code);
}

/**
 * `site migrate` — purely local (no `prepareTarget`, no identity call, `.blocofy/` never read): turns a
 * directory left by the older separate `theme pull` / `pages pull` / `settings pull` into the site-state
 * v1 tree layout. Always reports the plan first (every move, every file left alone, every conflict), then
 * with --write performs it.
 */
async function siteMigrate(rest) {
  const { flags, positionals } = parseArgsOrExit(rest, KNOWN.siteMigrate);
  if (flags["dry-run"] && flags.write) {
    console.error("Use either --dry-run or --write, not both. Nothing was moved.");
    process.exit(1);
  }
  const dir = resolve(positionals[0] ?? process.cwd());
  if (!existsSync(dir)) {
    console.error(`Directory not found: ${dir}`);
    process.exit(1);
  }
  const write = Boolean(flags.write);
  const r = migrateSiteState({ dir, write });

  for (const m of r.moves) console.log(`  ${write && !r.refused ? "moved" : "move "}  ${m.from} → ${m.to}`);
  for (const u of r.untouched) console.log(`  leave  ${u.path}  (${u.reason})`);
  for (const d of r.diagnostics) console.error(formatDiagnostic(d));

  if (r.refused) {
    console.error("Migration refused; nothing was moved.");
  } else if (r.moves.length === 0) {
    console.log("Nothing to do: this directory is already in the site-state tree layout.");
  } else if (write) {
    console.log(`Moved ${r.moved} file(s) into the site-state tree layout.`);
  } else {
    console.log(`${r.moves.length} file(s) would move. Dry run only; run with --write to move them.`);
  }
  if (!r.refused && r.needsExport) {
    console.log(
      "This tree still has no blocofy-site.json (and none of site/locales.json, globals, media-policy, " +
        "content-model, translations, navigation, theme/chrome/**): run `blocofy site export` against a live " +
        "site to complete it before `site plan`/`apply`/`publish`.",
    );
  }
  process.exit(r.refused ? 1 : 0);
}

async function sitePlan(rest) {
  const { flags, positionals } = parseArgsOrExit(rest, KNOWN.sitePlan);
  const dir = resolve(positionals[0] ?? process.cwd());
  if (!existsSync(dir)) {
    console.error(`Directory not found: ${dir}`);
    process.exit(1);
  }
  const opts = siteStateTargetFlags(flags);
  const target = await prepareTarget({ command: "site plan", commandClass: "read", dir, flags, needs: "both", mode: siteStateOperationLabel(opts, "plan") });
  const { requestFiles, manifest } = loadSiteStateForRequest(dir, target.identity);
  const plan = await planSiteState({ apiUrl: target.api.apiUrl, apiKey: target.api.apiKey, body: siteStateBody({ manifest, requestFiles, opts }), onRetry });
  if (JSON_MODE) console.log(JSON.stringify(plan));
  else printSiteStatePlan(plan);
}

/** CF-T4 — bounded: plan → (upload assets | deploy theme) → plan → apply, repeated, never more than this many passes. */
const MAX_APPLY_PASSES = 5;

async function siteApply(rest) {
  const { flags, positionals } = parseArgsOrExit(rest, KNOWN.siteApply);
  const dir = resolve(positionals[0] ?? process.cwd());
  if (!existsSync(dir)) {
    console.error(`Directory not found: ${dir}`);
    process.exit(1);
  }
  const opts = siteStateTargetFlags(flags);
  const target = await prepareTarget({ command: "site apply", commandClass: "remote-mutation", dir, flags, needs: "both", mode: siteStateOperationLabel(opts, "apply") });
  const { apiUrl, apiKey } = target.api;
  const { requestFiles, manifest, tree } = loadSiteStateForRequest(dir, target.identity);
  const assetsBySha = new Map(tree.assets.map((a) => [a.sha256, a]));
  // media/assets.json carries each asset's real filename + mime; the filesystem entry alone (media/files/<sha256>)
  // does not, and uploading with the right content-type is what lets the server categorize/reject it correctly.
  const assetMetaBySha = new Map();
  try {
    for (const entry of JSON.parse(requestFiles["media/assets.json"] ?? "[]")) {
      if (entry && typeof entry.sha256 === "string") assetMetaBySha.set(entry.sha256, entry);
    }
  } catch {
    /* an unparsable media/assets.json is caught by `site validate`; upload falls back to generic metadata */
  }
  const body = () => siteStateBody({ manifest, requestFiles, opts });

  const deployThemeSource = async (themeSource) => {
    const themeDir = join(tree.root, "theme");
    if (!existsSync(themeDir)) {
      console.error(`This state's theme source (theme/) is missing locally at ${themeDir}; nothing was deployed.`);
      process.exit(1);
    }
    console.error(`  deploying theme source to ${themeSource.instance}…`);
    await pushTheme({ dir: themeDir, url: target.dev.url, token: target.dev.token, instance: themeSource.instance, idempotencyKey: themeSource.idempotency_key, prune: true, onRetry });
  };

  let last = null;
  for (let pass = 1; pass <= MAX_APPLY_PASSES; pass++) {
    const plan = await planSiteState({ apiUrl, apiKey, body: body(), onRetry });
    last = plan;

    if (plan.status === "awaiting_assets") {
      for (const sha of plan.assets_missing) {
        const asset = assetsBySha.get(sha);
        if (!asset) {
          console.error(`Asset ${sha} is missing on the site and not found locally at media/files/${sha}. Export the site state again, or add the file. Nothing more was sent.`);
          process.exit(1);
        }
        const meta = assetMetaBySha.get(sha);
        console.error(`  uploading ${meta?.filename ?? asset.path}…`);
        await uploadMediaAsset({
          apiUrl,
          apiKey,
          filename: typeof meta?.filename === "string" ? meta.filename : asset.path.split("/").pop(),
          content: readFileSync(asset.abs),
          mime: typeof meta?.mime === "string" ? meta.mime : undefined,
          onRetry,
        });
      }
      continue;
    }
    if (plan.status === "awaiting_theme_source") {
      await deployThemeSource(plan.theme_source);
      continue;
    }
    if (plan.steps.length === 0) break; // draft_complete (or published — an apply target is never live)

    const applied = await applySiteState({ apiUrl, apiKey, body: { ...body(), expected_plan_hash: plan.plan_hash }, onRetry });
    last = applied;
    if (applied.status === "awaiting_theme_source") {
      await deployThemeSource(applied.theme_source);
      continue;
    }
    if (applied.status === "draft_complete") break;
    // else still "planned" (e.g. the server's own bounded per-call convergence left steps): loop, re-plan.
  }

  const done = last?.status === "draft_complete" || last?.status === "published";
  if (JSON_MODE) console.log(JSON.stringify(last));
  if (done) {
    console.log(`✓ draft_complete — target instance ${last.target_instance}.`);
    return;
  }
  console.log(
    `Not finished after ${MAX_APPLY_PASSES} pass(es) — target instance ${last?.target_instance ?? "?"}, status ${last?.status ?? "unknown"}. ` +
      "Run `blocofy site apply` again to continue; every step already applied is safe to resume from.",
  );
  process.exit(4);
}

async function sitePublish(rest) {
  const { flags, positionals } = parseArgsOrExit(rest, KNOWN.sitePublish);
  const dir = resolve(positionals[0] ?? process.cwd());
  if (!existsSync(dir)) {
    console.error(`Directory not found: ${dir}`);
    process.exit(1);
  }
  const opts = siteStateTargetFlags(flags);
  const target = await prepareTarget({ command: "site publish", commandClass: "remote-mutation", dir, flags, needs: "api", mode: `${siteStateOperationLabel(opts, "publish")} · LIVE` });
  const { apiUrl, apiKey } = target.api;
  const siteName = siteLabel(target.identity.site) || String(target.identity.site.id);

  // Separate live gate (contract §A3): TTY asks y/N, a non-interactive shell must pass --yes — same
  // decision `settings push --live` uses, before ANY site-state request is sent.
  const decision = livePushDecision({ draft: false, yes: Boolean(flags.yes), confirm: false, isTTY: Boolean(process.stdin.isTTY) });
  if (decision.mustAbort) {
    console.error(`⚠ 'site publish' makes this state the LIVE site of ${siteName}.`);
    console.error("  Non-interactive shell: pass --yes to confirm. Nothing was sent.");
    process.exit(1);
  }
  if (decision.needsPrompt) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    let answer;
    try {
      answer = await rl.question(`⚠ Publish this state as the LIVE site of ${siteName}? [y/N] `);
    } finally {
      rl.close();
    }
    if (!isAffirmative(answer)) {
      console.error("Aborted. Nothing was sent.");
      process.exit(1);
    }
  }

  const { requestFiles, manifest } = loadSiteStateForRequest(dir, target.identity);
  const result = await publishSiteState({ apiUrl, apiKey, body: siteStateBody({ manifest, requestFiles, opts }), onRetry });
  if (JSON_MODE) console.log(JSON.stringify(result));
  console.log(
    `✓ Published — target instance ${result.target_instance}${result.swapped ? " (now live)" : " (already live)"}; ` +
      `${result.navigation.length} menu(s) written, globals ${result.globals ? "updated" : "unchanged"}.`,
  );
}

async function contentPush(scope, rest) {
  const { flags, positionals } = parseArgsOrExit(rest, KNOWN.settingsPush);
  const dir = resolve(positionals[0] ?? process.cwd());
  // T10.1 "never implicitly live": the target is named — a theme handle or an explicit --live. Refused before any request.
  if (flags.instance === true || flags.instance === "") {
    console.error("--instance needs a theme handle (from the admin panel theme card, or `blocofy status`). Nothing was sent.");
    process.exit(1);
  }
  const instance = typeof flags.instance === "string" ? flags.instance : null;
  if (instance && flags.live) {
    console.error("Pass either --instance <handle> or --live, not both. Nothing was sent.");
    process.exit(1);
  }
  if (!instance && !flags.live) {
    console.error("settings push needs a target. Nothing was sent.");
    console.error("  --instance <handle>  write a specific theme (a draft stays out of the live site until published)");
    console.error("  --live               write the LIVE theme (asks to confirm; non-interactive shells add --yes)");
    process.exit(1);
  }
  if (!existsSync(dir)) {
    console.error(`Directory not found: ${dir}`);
    process.exit(1);
  }
  const target = await prepareTarget({ command: `${scope} push`, commandClass: "remote-mutation", dir, flags, needs: "dev", mode: instance ? `instance ${instance}` : "live" });
  const creds = target.dev;
  if (!instance) {
    const siteName = siteLabel(target.identity.site) || String(target.identity.site.id);
    const decision = livePushDecision({ draft: false, yes: Boolean(flags.yes), confirm: Boolean(flags.confirm), isTTY: Boolean(process.stdin.isTTY) });
    if (decision.mustAbort) {
      console.error(`⚠ 'settings push --live' writes the theme settings of the LIVE theme of ${siteName}.`);
      console.error("  Non-interactive shell: pass --live --yes to confirm, or target a draft with --instance <handle>. Nothing was sent.");
      process.exit(1);
    }
    if (decision.needsPrompt) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      let answer;
      try {
        answer = await rl.question(`⚠ Push settings to the LIVE theme of ${siteName}? [y/N] `);
      } finally {
        rl.close();
      }
      if (!isAffirmative(answer)) {
        console.error("Aborted. Nothing was sent.");
        process.exit(1);
      }
    }
  }
  const result = await pushContent({ dir, url: creds.url, token: creds.token, scope, instance, onRetry });
  console.log(
    `Settings push: ${result.settingsUpdated ? "theme settings updated" : "theme settings unchanged"}, ` +
      `${result.schemesUpserted} color scheme(s) upserted (${result.fileCount} file).`,
  );
  // T10.1 — where the write is visible (an older server sends none of these fields).
  const h = result.instance ?? instance;
  if (result.live_requires === "theme_publish") {
    console.log(`Applied to draft theme ${h} — visible in its preview; not live until \`blocofy theme publish --instance ${h}\`.`);
  } else if (result.live_requires === "theme_deploy") {
    console.log(`Saved; the live site shows it after the next theme deploy/publish (live_applied: false). Visible in the preview now.`);
  } else if (result.live_applied === true) {
    console.log(`Applied to the live theme${h ? ` ${h}` : ""} — live now.`);
  }
}

async function contentPull(scope, rest) {
  const { flags, positionals } = parseArgsOrExit(rest, KNOWN.content);
  const dir = resolve(positionals[0] ?? process.cwd());
  const target = await prepareTarget({ command: `${scope} pull`, commandClass: "local-write", dir, flags, needs: "dev", mode: "live" });
  const creds = target.dev;
  const { count } = await withNewBindingClaim(target, dir, () => pullContent({ dir, url: creds.url, token: creds.token, scope, onRetry }));
  console.log(`Downloaded ${count} settings file(s) → ${dir}`);
  bindAfterPull(target, dir);
}

/**
 * Optional online mode for offline-capable reads (`pages check`, `pages migrate-layout`): no credentials at all, or
 * no context choosable outside a project → offline. Inside a bound project every other refusal still applies.
 */
async function optionalTarget({ command, dir, flags, localWrite = false, allowCurrentContext = false }) {
  try {
    // Review I3 / contract C2: only `pages check` may borrow the global default context outside a binding;
    // migrate-layout (dry run or --write) needs an explicit --context/env there, else it runs offline.
    return await prepareTarget({ command, commandClass: "read", allowCurrentContext, dir, flags, needs: "dev", mode: localWrite ? "read · local write" : "read" });
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
  const usage = "blocofy pages media-uses <page-handle> [--dir <dir>] [--json]";
  if (!page) {
    console.error(`Usage: ${usage}`);
    process.exit(1);
  }
  // 1.8: the project directory is `--dir`; a directory given as a positional is refused, never dropped for cwd's.
  if (positionals.length > 1) throw new TargetError("USAGE", `Usage: ${usage}`, {}, 1);
  const { apiUrl, apiKey } = (await prepareTarget({ command: "pages media-uses", commandClass: "read", dir: commandDir(flags.dir), flags, needs: "api", mode: `read · page ${page}` })).api;
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
  const usage = "blocofy pages media-decide <page-handle> --decisions <file.json> [--expected-revision-id <n> --expected-version <n>] [--dir <dir>] [--json]";
  if (!page || !file) {
    console.error(`Usage: ${usage}`);
    process.exit(1);
  }
  if (positionals.length > 1) throw new TargetError("USAGE", `Usage: ${usage}`, {}, 1);
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

  const { apiUrl, apiKey } = (await prepareTarget({ command: "pages media-decide", commandClass: "remote-mutation", dir: commandDir(flags.dir), flags, needs: "api", mode: `draft · page ${page}` })).api;
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
  // A draft-only login syncs into the project's saved work's theme unless --instance names another target.
  let savedInstance = null;
  if (!noSync && typeof flags.instance !== "string") {
    const d = await draftOnlyDefaults(themeDir, flags);
    if (d) {
      if (!d.work?.theme) throw themeWorkRequired(d.profile, "theme dev");
      savedInstance = d.work.theme;
      if (!JSON_MODE) console.error(savedWorkNote(d.work));
    }
  }
  const target = await prepareTarget({ command: "theme dev", commandClass: noSync ? "read" : "remote-mutation", dir: themeDir, flags, needs: "dev", mode: noSync ? "read · local preview" : "draft" });
  const creds = target.dev;
  const port = Number(flags.port) || 3030;
  // #989: `--instance <handle>` names the draft to sync into, for a site where the platform refuses to pick one. Draft
  // sync never writes the live theme, so the live theme's handle is refused here.
  const devInstance = typeof flags.instance === "string" ? flags.instance : savedInstance;
  if (devInstance && instanceMaybeLive(devInstance, target.identity?.liveThemeId ?? null)) {
    console.error(`✗ ${devInstance} is (or could not be told apart from) the LIVE theme. 'theme dev' syncs to a draft only; pick a draft handle (\`blocofy status\`) or use --no-sync.`);
    process.exit(2);
  }

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
    // A CLI login's access token lives 10 minutes: the server asks for a fresh one per request.
    token: target.renewToken ?? creds.token,
    port,
    // Taslak senkronu dev session'a BAĞLI DEĞİL: `pushTheme({draft:true})` /api/dev/theme'e gider ve
    // session'dan hiçbir veri kullanmaz. Bu satır `Boolean(session)` iken, session 410 alınca senkron
    // da sessizce kapanıyordu — ölü bir uç, çalışan bir özelliği götürüyordu. Tek kapatma yolu --no-sync.
    syncDraft: !flags["no-sync"],
    instance: devInstance,
    // #989: the platform refused to pick the draft — say which drafts and how to choose, then stop (no retry loop).
    onSyncRefused: (error) => {
      try {
        handle.close();
      } catch {
        /* yoksay */
      }
      if (error?.code === "draft_target_is_live") {
        failAndExit({ code: "draft_target_is_live", status: 422, message: draftSyncErrorLine(error), details: {} });
      }
      failDraftTargetAmbiguous(error, commandLine("blocofy theme dev", positionals));
    },
    onRetry: (info) => console.error(`  ${retryNotice(info)}`),
    onWarn: (msg) => console.warn(`  ⚠ ${msg}`),
    // Her kaydetmede ne olduğunu bas — "reloaded" = watch tetiklendi; "0 views"
    // = hiçbir tarayıcı sekmesi bağlı değil (yanlış görünüme bakıyorsun); sync
    // hatası = draft güncellenemedi (preview/editör eski kalır, local yine yenilenir).
    onReload: ({ file, synced, clients, error }) => {
      const what = file || "change";
      if (error) {
        console.error(`  ↻ ${what} — ${error} (local view still reloaded)`);
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
  const { flags, positionals } = parseArgsOrExit(rest, KNOWN.themePublish);
  const dir = singleDirArg(positionals, "blocofy theme publish [dir] [--instance <handle>]");
  const target = await prepareTarget({ command: "theme publish", commandClass: "remote-mutation", dir, flags, needs: "dev", mode: `live${typeof flags.instance === "string" ? ` · instance ${flags.instance}` : " · CLI draft"}` });
  const creds = target.dev;
  let instance = typeof flags.instance === "string" ? flags.instance : null;
  if (!instance) {
    // Belirtilmediyse: `theme dev` / `theme push --draft`'ın yazdığı taslağı yayınla. Kaynak `GET /api/dev/site`.
    // #989 review P2: the SAME rule as a draft push (`findCliDraft`, mirroring the server) and the same refusal — a
    // guessed draft (a site-state restore draft, a renamed one, one of several) is never published live.
    const status = await fetchSiteStatus({ url: creds.url, token: creds.token, onRetry });
    const drafts = status?.drafts ?? [];
    let cliDraft;
    try {
      cliDraft = findCliDraft(status);
    } catch (error) {
      if (error?.code === DRAFT_TARGET_AMBIGUOUS) failDraftTargetAmbiguous(error, commandLine("blocofy theme publish", positionals), { action: "publish" });
      throw error;
    }
    if (cliDraft) {
      instance = cliDraft.id;
    } else if (drafts.length === 0) {
      console.error("No draft theme to publish. Create one first:  blocofy theme push --draft");
      process.exit(1);
    } else {
      // Drafts exist, but none is the CLI draft (panel copies, starter themes…): publishing one is a choice to make.
      console.error("No CLI draft to publish. Publish one of the site's drafts explicitly with --instance <handle>:");
      for (const d of drafts) console.error(`  ${d.id}  ${d.name ?? "(unnamed)"}`);
      process.exit(1);
    }
  }
  let result;
  try {
    // K1 (#989): `explicit` only when the user named the theme; the automatic pick is re-checked by the platform.
    result = await publishInstance({ url: creds.url, token: creds.token, instanceId: instance, explicit: typeof flags.instance === "string", onRetry });
  } catch (error) {
    if (error?.code === PUBLISH_TARGET_UNCONFIRMED) {
      failAndExit({
        code: PUBLISH_TARGET_UNCONFIRMED,
        status: 409,
        message: publishTargetUnconfirmedMessage(error, { command: commandLine("blocofy theme publish", positionals) }),
        details: { reason: error.reason ?? null, instance: error.instance ?? null },
      });
    }
    // A theme work's copy is never published directly; its way live is the approval (`theme work request-approval`).
    if (error?.code === "work_not_publishable") failOnThemeWorkRefusal(error, { op: "publish" });
    throw error;
  }
  console.log(
    `✓ Theme ${result.published} is now LIVE${result.cloned ? " (pages cloned from the previous live theme)" : ""}.`,
  );
}

// ── theme work ("çalışma"): a safe, private copy of the live theme, continued by its exact handle ──────────────

/**
 * A theme-work refusal: the plain Turkish explanation first (human mode), then the shared `error [code]` line /
 * `--json` envelope; exit 2 for a 4xx refusal, 1 for a 5xx one. Returns only when `error` is not a known refusal.
 */
function failOnThemeWorkRefusal(error, opts) {
  const refusal = themeWorkRefusal(error, opts);
  if (!refusal) return;
  if (!JSON_MODE) for (const line of refusal.lines) console.error(line);
  const code = error instanceof CliRefusal ? error.error?.code : error?.code;
  failAndExit({ code, status: error.status, message: refusal.message, details: refusal.details });
}

/** The handle positional of status/resume/cancel — explicit, never "the latest"; the saved one is only suggested. */
function workHandleArg(positionals, flags, usage) {
  const handle = positionals[0];
  if (positionals.length > 1) throw new TargetError("USAGE", `Usage: ${usage}`, {}, 1);
  if (handle === undefined) {
    let saved = null;
    try {
      saved = readSavedWork(findBinding(commandDir(flags.dir)));
    } catch {
      saved = null;
    }
    const hint = saved ? ` This project's saved work is ${saved.handle}${saved.intent ? ` ("${saved.intent}")` : ""}.` : "";
    throw new TargetError("USAGE", `Usage: ${usage} — name the work by its handle (wk_…).${hint} Nothing was sent.`, saved ? { saved_work: saved.handle } : {}, 1);
  }
  if (!isWorkHandle(handle)) throw new TargetError("USAGE", `"${handle}" is not a work handle (wk_ + 26 characters, from \`blocofy theme work start\`). Nothing was sent.`, {}, 1);
  return handle;
}

/** `theme push --work`: the work's theme, only while the work is open. Refusals exit here. */
async function openWorkTheme(api, handle) {
  let work;
  try {
    ({ work } = await getWork({ ...api, handle, onRetry }));
  } catch (error) {
    failOnThemeWorkRefusal(error, { op: "push", handle });
    throw error;
  }
  if (work.state !== "open" || !work.theme) {
    if (!JSON_MODE) {
      console.error(`Çalışma ${handle} şu an değiştirilemez (durum: ${stateLabel(work.state)}). Hiçbir şey yazılmadı.`);
      console.error(work.state === "sealed" ? "  İnceleme bitince ya da panelde düzenlemeye geri alınınca tekrar dene." : "  Yeni bir çalışma başlat:  blocofy theme work start");
    }
    failAndExit({ code: "work_state_conflict", status: 409, message: `The work is ${work.state}; a push needs an open work. Nothing was written.`, details: { state: work.state, stateVersion: work.state_version } });
  }
  if (!JSON_MODE) for (const line of staleLines(work) ?? []) console.error(line);
  return work;
}

async function themeWorkStart(rest) {
  const { flags, positionals } = parseArgsOrExit(rest, KNOWN.themeWorkStart);
  const dir = singleDirArg(positionals, 'blocofy theme work start [dir] [--intent "<text>"] [--idempotency-key <k>]');
  if (flags.intent !== undefined && (typeof flags.intent !== "string" || !flags.intent.trim() || flags.intent.trim().length > WORK_INTENT_MAX)) {
    throw new TargetError("USAGE", `--intent needs a short label (1-${WORK_INTENT_MAX} characters). Nothing was sent.`, {}, 1);
  }
  if (flags["idempotency-key"] !== undefined && (typeof flags["idempotency-key"] !== "string" || !WORK_KEY_RE.test(flags["idempotency-key"]))) {
    throw new TargetError("USAGE", "--idempotency-key must be 8-120 characters: letters, digits, . _ : - Nothing was sent.", {}, 1);
  }
  const intent = typeof flags.intent === "string" ? flags.intent.trim() : DEFAULT_WORK_INTENT;
  const key = typeof flags["idempotency-key"] === "string" ? flags["idempotency-key"] : newWorkKey();
  const target = await prepareTarget({ command: "theme work start", commandClass: "remote-mutation", dir, flags, needs: "api", mode: "draft · new work" });
  const retryLine = `blocofy theme work start${positionals[0] ? ` ${positionals[0]}` : ""} --intent ${JSON.stringify(intent)} --idempotency-key ${key}`;
  let answer;
  try {
    answer = await startWork({ ...target.api, intent, idempotencyKey: key, onRetry });
  } catch (error) {
    // A 4xx is a definite refusal (nothing started). Anything else (network, a 5xx after the retries) may hide a work
    // that WAS started: the SAME key returns it, a new key would start a second one — so the retry line names the key.
    const definite = error instanceof CliRefusal;
    const refusal = themeWorkRefusal(error, { op: "start" });
    if (definite && !refusal) throw error;
    if (!JSON_MODE) {
      const lines = refusal?.lines ?? ["Platformdan kesin yanıt alınamadı; çalışmanın başlayıp başlamadığı bilinmiyor."];
      for (const line of lines) console.error(line);
      if (!definite) console.error(`  Aynı anahtarla tekrar çalıştır (başladıysa aynı çalışma döner, ikincisi açılmaz):  ${retryLine}`);
    }
    const code = definite ? error.error?.code : error?.code ?? (error instanceof TypeError ? "NETWORK_ERROR" : "ERROR");
    const message = refusal?.message ?? `No definite answer from the platform; whether the work started is unknown. Run again with the same key: ${retryLine}`;
    failAndExit({ code, status: error.status, message, details: { ...(refusal?.details ?? {}), ...(definite ? {} : { idempotencyKey: key }) } });
  }
  const { work } = answer;
  const saved = saveWork(target.binding, work);
  if (JSON_MODE) {
    console.log(JSON.stringify({ work, ...(answer.replayed ? { replayed: true } : {}), idempotency_key: key, saved }, null, 2));
    return;
  }
  console.log(answer.replayed ? `✓ Bu anahtarla başlatılmış çalışma bulundu (yeni bir çalışma açılmadı): ${work.id}` : `✓ Çalışma başlatıldı: ${work.id}`);
  for (const line of workLines(work)) console.log(line);
  for (const line of staleLines(work) ?? []) console.log(line);
  console.log("Canlı site değişmedi; bu çalışma ziyaretçilere görünmez.");
  console.log(`Dosyalarını gönder:  blocofy theme push${positionals[0] ? ` ${positionals[0]}` : ""} --draft --work ${work.id}`);
  console.log(`Durumu:              blocofy theme work status ${work.id}`);
  console.log(saved ? "  (Bu projede kayıtlı çalışma olarak .blocofy/local.json'a yazıldı.)" : "  (Proje bağlı olmadığı için tanıtıcı kaydedilmedi; bir yere not et.)");
  console.log(`technical: work ${work.id}, theme ${work.theme}, idempotency key ${key}`);
}

async function themeWorkStatus(rest) {
  const { flags, positionals } = parseArgsOrExit(rest, KNOWN.themeWorkStatus);
  const handle = workHandleArg(positionals, flags, "blocofy theme work status <wk_…> [--dir <dir>]");
  const target = await prepareTarget({ command: "theme work status", commandClass: "read", dir: commandDir(flags.dir), flags, needs: "api", mode: `read · work ${handle}` });
  let answer;
  try {
    answer = await getWork({ ...target.api, handle, onRetry });
  } catch (error) {
    failOnThemeWorkRefusal(error, { op: "status", handle });
    throw error;
  }
  // Where its publication stands (read-only). A platform without the status endpoint just shows the work.
  let publish = null;
  try {
    publish = await getPublishStatus({ ...target.api, handle, onRetry });
  } catch {
    publish = null;
  }
  if (JSON_MODE) {
    console.log(JSON.stringify({ work: answer.work, ...(publish ? { publish } : {}) }, null, 2));
    return;
  }
  for (const line of workLines(answer.work)) console.log(line);
  for (const line of publishStatusLines(publish)) console.log(line);
  for (const line of staleLines(answer.work) ?? []) console.log(line);
}

/** A 404/405 from a review endpoint right after the work was read means the platform has no such endpoint yet. */
const endpointMissing = (error) =>
  error instanceof CliRefusal && ["not_found", "http_404", "http_405", "method_not_allowed"].includes(error.error?.code) && error.error?.details?.reason !== "target_deleted";

async function themeWorkSeal(rest) {
  const { flags, positionals } = parseArgsOrExit(rest, KNOWN.themeWorkSeal);
  const handle = workHandleArg(positionals, flags, "blocofy theme work seal <wk_…> [--dir <dir>]");
  const target = await prepareTarget({ command: "theme work seal", commandClass: "remote-mutation", dir: commandDir(flags.dir), flags, needs: "api", mode: `draft · prepare work ${handle} for review` });
  try {
    await getWork({ ...target.api, handle, onRetry });
  } catch (error) {
    failOnThemeWorkRefusal(error, { op: "seal", handle });
    throw error;
  }
  let answer;
  try {
    answer = await sealWork({ ...target.api, handle, onRetry });
  } catch (error) {
    if (endpointMissing(error)) {
      if (!JSON_MODE) {
        console.error("Bu platform ayrı bir 'incelemeye hazırla' adımını henüz desteklemiyor. Hiçbir şey yazılmadı.");
        console.error(`  Onay isteği çalışmayı kendisi hazırlar:  blocofy theme work request-approval ${handle}`);
      }
      failAndExit({ code: "seal_unsupported", status: error.status, message: "This platform has no seal endpoint yet; request-approval prepares the work itself (seal_unsupported)." });
    }
    failOnThemeWorkRefusal(error, { op: "seal", handle });
    throw error;
  }
  if (JSON_MODE) {
    console.log(JSON.stringify(answer, null, 2));
    return;
  }
  console.log(answer.already_sealed ? `✓ Çalışma zaten incelemeye hazır: ${handle}` : `✓ Çalışma incelemeye hazır: ${handle}`);
  console.log("  İçeriği artık değişmiyor. Canlı site değişmedi; onay istenmedi.");
  if (answer.package?.digest_short) console.log(`  İçerik özeti: ${answer.package.digest_short}`);
  console.log(`Yayın için onay iste:  blocofy theme work request-approval ${handle}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `--wait`: poll the read-only status until the request this command made ends (published, stale, expired, declined,
 * superseded, cancelled, failed) or a deadline passes (the request's expiry + 1 minute, at most 20 minutes). A
 * transient error keeps polling; a refusal ends the wait. Never publishes and never decides.
 */
async function waitForApproval(api, handle, approval, intervalMs) {
  const expiry = Date.parse(approval.expires_at ?? "");
  const cap = Date.now() + 20 * 60_000;
  const deadline = Number.isFinite(expiry) ? Math.min(cap, expiry + 60_000) : cap;
  let last = null;
  for (;;) {
    try {
      last = await getPublishStatus({ ...api, handle, onRetry });
      const state = approvalWaitState(last, approval.id);
      if (state !== "pending") return { state, status: last };
    } catch (error) {
      if (error instanceof CliRefusal) {
        failOnThemeWorkRefusal(error, { op: "wait", handle });
        throw error;
      }
      if (!JSON_MODE) console.error("Durum okunamadı; tekrar denenecek.");
    }
    if (Date.now() + intervalMs > deadline) return { state: "timeout", status: last };
    await sleep(intervalMs);
  }
}

async function themeWorkRequestApproval(rest) {
  const { flags, positionals } = parseArgsOrExit(rest, KNOWN.themeWorkRequestApproval);
  const handle = workHandleArg(positionals, flags, "blocofy theme work request-approval <wk_…> [--dir <dir>] [--open] [--wait [--interval <s>]]");
  let intervalMs = 3000;
  if (flags.interval !== undefined) {
    const n = Number(flags.interval);
    if (!flags.wait || typeof flags.interval !== "string" || !Number.isInteger(n) || n < 1 || n > 60) {
      throw new TargetError("USAGE", "--interval needs --wait and a whole number of seconds (1-60). Nothing was sent.", {}, 1);
    }
    intervalMs = n * 1000;
  }
  const target = await prepareTarget({ command: "theme work request-approval", commandClass: "remote-mutation", dir: commandDir(flags.dir), flags, needs: "api", mode: `draft · request approval for work ${handle}` });
  let answer;
  try {
    answer = await requestApproval({ ...target.api, handle, onRetry });
  } catch (error) {
    failOnThemeWorkRefusal(error, { op: "request-approval", handle });
    throw error;
  }
  const { approval } = answer;
  const url = safeApprovalUrl(approval?.approval_url, target.api.apiUrl);
  if (!JSON_MODE) {
    console.log(`✓ Çalışma incelemeye hazır ve onay istendi: ${handle}`);
    console.log(`Onay URL'i:  ${url ? (process.stdout.isTTY ? hyperlink(url) : url) : approval?.approval_url ?? "(yok)"}`);
    console.log("  Site sahibi ya da tema yetkisi olan bir ekip üyesi Blocofy'de oturum açıp bu sayfadan onaylar.");
    console.log("  URL'de gizli bir anahtar yok; URL'e sahip olmak yayın yetkisi vermez.");
    if (approval?.digest_short) console.log(`  Onaylanacak içerik özeti: ${approval.digest_short}${approval.expires_at ? ` · son geçerlilik: ${approval.expires_at}` : ""}`);
    console.log("  Onaylanana kadar canlı site değişmez. Bu komut yayınlamaz.");
  }
  if (flags.open) {
    if (url) {
      openUrl(url);
      if (!JSON_MODE) console.log("Onay sayfası tarayıcıda açılıyor.");
    } else if (!JSON_MODE) {
      console.error("Onay URL'i bu platformun onay sayfası gibi görünmüyor; tarayıcıda açılmadı.");
    }
  }
  if (!flags.wait) {
    if (JSON_MODE) console.log(JSON.stringify(answer, null, 2));
    else console.log(`Durumu izle:  blocofy theme work status ${handle}   (ya da --wait ile bekle)`);
    return;
  }
  if (!JSON_MODE) console.log("Karar bekleniyor (Ctrl+C ile çıkabilirsin; onay isteği geçerli kalır)…");
  const { state, status } = await waitForApproval(target.api, handle, approval, intervalMs);
  const outcome = approvalOutcome(state, { handle, status });
  if (outcome.ok) {
    if (JSON_MODE) console.log(JSON.stringify({ ...answer, outcome: state, publish: status }, null, 2));
    else for (const line of outcome.lines) console.log(line);
    return;
  }
  if (!JSON_MODE) for (const line of outcome.lines) console.error(line);
  // A definite "not published" end is a refusal (exit 2); a timeout or a failure is not (exit 1).
  const definite = !["timeout", "failed"].includes(state);
  failAndExit({ code: outcome.code, ...(definite ? { status: 409 } : {}), message: outcome.message, details: { approval: approval?.id ?? null, phase: status?.phase ?? null } });
}

async function themeWorkResume(rest) {
  const { flags, positionals } = parseArgsOrExit(rest, KNOWN.themeWorkResume);
  const handle = workHandleArg(positionals, flags, "blocofy theme work resume <wk_…> [--dir <dir>] [--require-fresh]");
  const target = await prepareTarget({ command: "theme work resume", commandClass: "read", dir: commandDir(flags.dir), flags, needs: "api", mode: `read · work ${handle}` });
  let answer;
  try {
    answer = await resumeWork({ ...target.api, handle, requireFresh: Boolean(flags["require-fresh"]), onRetry });
  } catch (error) {
    failOnThemeWorkRefusal(error, { op: "resume", handle });
    throw error;
  }
  const saved = saveWork(target.binding, answer.work);
  if (JSON_MODE) {
    console.log(JSON.stringify({ work: answer.work, saved }, null, 2));
    return;
  }
  console.log(`✓ Çalışmaya devam ediliyor: ${handle}`);
  for (const line of workLines(answer.work)) console.log(line);
  for (const line of staleLines(answer.work) ?? []) console.log(line);
  console.log(`Dosyalarını gönder:  blocofy theme push --draft --work ${handle}`);
}

async function themeWorkCancel(rest) {
  const { flags, positionals } = parseArgsOrExit(rest, KNOWN.themeWorkCancel);
  const handle = workHandleArg(positionals, flags, "blocofy theme work cancel <wk_…> [--dir <dir>]");
  const target = await prepareTarget({ command: "theme work cancel", commandClass: "remote-mutation", dir: commandDir(flags.dir), flags, needs: "api", mode: `draft · cancel work ${handle}` });
  let work;
  try {
    ({ work } = await getWork({ ...target.api, handle, onRetry }));
    if (work.state !== "cancelled") ({ work } = await cancelWork({ ...target.api, handle, expectedStateVersion: work.state_version, onRetry }));
  } catch (error) {
    // A resend after a lost answer meets its own earlier cancel: the work IS cancelled — report it, not a conflict.
    if (!(error instanceof CliRefusal && error.error?.code === "work_state_conflict" && error.error?.details?.state === "cancelled")) {
      failOnThemeWorkRefusal(error, { op: "cancel", handle });
      throw error;
    }
    work = { id: handle, state: "cancelled", state_version: error.error.details.stateVersion ?? null };
  }
  const saved = readSavedWork(target.binding);
  if (saved?.handle === handle) saveWork(target.binding, null);
  if (JSON_MODE) {
    console.log(JSON.stringify({ work }, null, 2));
    return;
  }
  console.log(`✓ Çalışma iptal edildi: ${handle}. Canlı site değişmedi; çalışmanın teması tema kitaplığında duruyor.`);
}

// ── blocofy init (ADR-0014 §5.6, wave P4) ─────────────────────────────────────────────────────────────────

const INIT_USAGE = "blocofy init [dir] [--site <handle|slug>] [--context <name>] [--api-url <url>] [--no-browser] [--insecure-storage]";

/** The context a resumed init directory recorded (`.blocofy/local.json`), if any. */
function savedInitContext(dir) {
  try {
    const local = JSON.parse(readFileSync(join(dir, ".blocofy", "local.json"), "utf8"));
    return typeof local?.context === "string" && local.context ? local.context : null;
  } catch {
    return null;
  }
}

/**
 * `blocofy init [dir]`: pre-checks without any request; then the credential (a saved context, env credentials, or a
 * browser login on a terminal); then the state machine of lib/init.mjs. Exit 0 only when a preview exists and the live
 * theme read back is the one read before; 5 when the live theme changed meanwhile; 3 for a directory/site refusal.
 */
async function initCommand(rest) {
  const { flags, positionals } = parseArgsOrExit(rest, KNOWN.init);
  if (positionals.length > 1) throw new TargetError("USAGE", `Usage: ${INIT_USAGE}`, {}, 1);
  const dir = resolve(positionals[0] ?? process.cwd());
  const siteArg = typeof flags.site === "string" ? flags.site : null;
  const unattended = isUnattended();

  // 1. Pre-checks: nothing sent, nothing written.
  const pre = inspectInitDir(dir);
  if (pre.kind === "dirty") {
    throw new InitError("INIT_DIR_NOT_EMPTY", `${dir} is not empty and is not a Blocofy project. Nothing was written. Run \`blocofy init\` in a new, empty directory (init never overwrites files).`, {
      exitCode: 3,
      details: { dir },
      lines: ["Bu dizin boş değil ve bir Blocofy projesi değil; hiçbir şeyin üzerine yazılmadı.", "  Boş, yeni bir dizinde çalıştır:  blocofy init <yeni-dizin>"],
    });
  }
  if (pre.kind === "legacy_project") {
    throw new InitError("INIT_ALREADY_BOUND", `${dir} is already bound to a site (by \`link\` or \`theme pull\`); init does not take it over. Nothing was written. In that project use: blocofy theme work start`, {
      exitCode: 3,
      details: { dir },
      lines: ["Bu dizin zaten bir siteye bağlı (link ya da theme pull ile); init onu sahiplenmez. Hiçbir şey yazılmadı.", "  O projede yeni bir tema çalışması başlat:  blocofy theme work start"],
    });
  }
  if (siteArg && pre.kind === "resume" && String(pre.init.site_id) !== siteArg && pre.project?.site_slug !== siteArg) {
    throw new InitError("INIT_SITE_MISMATCH", `${dir} was set up for site ${pre.project?.site_slug ?? pre.init.site_id}, not ${siteArg}. Nothing was sent or written.`, { exitCode: 3, details: { dir } });
  }
  // Unattended: never a browser, never a guessed site.
  if (unattended && !siteArg) {
    throw new InitError("INIT_SITE_REQUIRED", "In a non-interactive run, init needs the site named explicitly: --site <handle|slug> (and a saved --context or env credentials). Nothing was sent.", {
      exitCode: 3,
      lines: ["Etkileşimsiz çalıştırmada init hangi siteye kurulacağını tahmin etmez; hiçbir şey gönderilmedi.", "  Siteyi açıkça ver:  blocofy init <dizin> --site <site> --context <giriş>"],
    });
  }

  // 2. The credential.
  const envCtx = envContext();
  let contextName = typeof flags.context === "string" ? flags.context : process.env.BLOCOFY_CONTEXT || (envCtx ? ENV_CONTEXT : null) || (pre.kind === "resume" ? savedInitContext(dir) : null);
  if (!contextName) {
    if (unattended) {
      throw new InitError("INIT_LOGIN_REQUIRED", "No credential for init: pass --context <name> of a saved login, or set env credentials. A non-interactive run never opens a browser. Nothing was sent.", { exitCode: 3 });
    }
    ({ name: contextName } = await browserLoginAndSave({ flags, contextName: null, siteArg }));
  }
  const chosen = await resolveContext({ flagContext: contextName, envContextName: null, envCtx, getStore: () => loadStore(), binding: null });
  const { resolved, secrets, renewToken } = await credentialsFor(chosen);
  registerSecret(secrets.devToken);
  registerSecret(secrets.apiKey);
  assertCredentialTypes({ resolved, secrets });
  if (!(resolved.context.api && secrets.apiKey) || !(resolved.context.dev && secrets.devToken)) {
    throw new TargetError("LOGIN_REQUIRED", `Context "${resolved.name}" cannot run init: it needs the v1 API (theme work, preview) and the theme files endpoint. Log in with \`blocofy login\` (one login covers both) or add the missing pair.`, { context: resolved.name }, 1);
  }
  const identity = await verifyTarget({ resolved, secrets, binding: null, retry });
  for (const w of identity.warnings ?? []) printWarning(w, { json: JSON_MODE });
  if (siteArg && !siteMatches(identity.site, siteArg)) {
    throw new InitError("INIT_SITE_MISMATCH", `Context "${resolved.name}" is for ${identity.site.slug ?? identity.site.id}, not ${siteArg}. Nothing was sent or written.`, { exitCode: 3, details: { context: resolved.name, site: identity.site.id } });
  }
  if (!JSON_MODE) printTarget(targetData({ site: identity.site, url: resolved.context.api.url, platformOrigin: identity.platformOrigin, contextName: resolved.name, contextSource: chosen.source, contextOverrides: [], bindingLabel: pre.kind === "resume" ? "this init directory" : "none (new init)", command: "init", mode: "draft · new work" }));

  // 3. The state machine.
  const api = initApi({
    apiUrl: resolved.context.api.url,
    devUrl: resolved.context.dev.url,
    token: renewToken ?? secrets.apiKey,
    devToken: renewToken ?? secrets.devToken,
    onRetry,
  });
  const result = await runInit({
    dir,
    identity,
    contextName: resolved.env ? ENV_CONTEXT : resolved.name,
    profile: resolved.context.oauth?.profile ?? null,
    api,
    log: (line) => {
      if (!JSON_MODE) console.error(line);
    },
  });

  const rel = relative(process.cwd(), dir) || ".";
  if (!result.liveUnchanged) {
    throw new InitError("INIT_LIVE_CHANGED", `The live theme read back after init (${result.liveAfter ?? "none"}) is not the one read before it started (${result.liveBefore ?? "none"}). init never writes the live site; the change came from elsewhere. Not reported as a success.`, {
      exitCode: 5,
      details: { live_before: result.liveBefore, live_after: result.liveAfter, work: result.work.id },
      lines: [
        `Canlı tema init başladığından beri değişti (önce: ${result.liveBefore ?? "yok"}, şimdi: ${result.liveAfter ?? "yok"}). Bu yüzden başarı denmedi.`,
        "  init canlı siteye yazmaz; değişiklik panelden ya da başka bir bağlantıdan gelmiş olabilir. Panelde tema geçmişine bak.",
        `  Çalışman ve dosyaların yerinde: ${result.work.id} → ${rel}`,
      ],
    });
  }
  if (result.state !== "previewed") {
    throw new InitError("INIT_PREVIEW_UNAVAILABLE", `The project is set up (work ${result.work.id}, files in ${rel}) and the live site did not change, but no preview link could be made (${result.preview}: the work's theme has no page with a plain address). Run \`blocofy init\` again to retry the preview.`, {
      exitCode: 1,
      details: { work: result.work.id, preview: result.preview },
      lines: [
        "Proje hazır ve canlı siten değişmedi, ama önizleme bağlantısı oluşturulamadı: çalışmanın temasında adresi olan bir sayfa yok.",
        `  Aynı dizinde yeniden çalıştırınca yalnız önizleme denenir:  blocofy init ${rel}`,
      ],
    });
  }
  if (JSON_MODE) {
    console.log(JSON.stringify({ init: { dir, state: result.state, work: { id: result.work.id, theme: result.work.theme }, preview_url: result.previewUrl, preview_created_earlier: result.previewCreatedEarlier, live_unchanged: true, live_theme: result.liveAfter, context: resolved.name, site: identity.site } }, null, 2));
    return;
  }
  console.log("✓ Taslak hazır. Canlı siten değişmedi.");
  console.log(`  Çalışma: ${result.work.id} (tema ${result.work.theme}) — dosyalar: ${rel}`);
  if (result.previewUrl) console.log(`  Önizleme (bir kez gösterilir; paylaşılabilir, süresi dolar): ${result.previewUrl}`);
  else console.log("  Önizleme bağlantısı daha önce oluşturuldu (bağlantılar bir kez gösterilir).");
  console.log(`Sonraki adım: dosyaları düzenle, sonra  blocofy theme push ${rel} --draft --work ${result.work.id}`);
  console.log(`  Yayın için insan onayı iste:  blocofy theme work request-approval ${result.work.id}`);
  console.log(`technical: live theme ${result.liveAfter ?? "none"} read before and after; state in ${join(rel, ".blocofy", "init.json")}`);
}

const THEME_WORK_USAGE = "blocofy theme work start|status|resume|seal|request-approval|cancel … (see `blocofy --help`)";

async function themeWork(rest) {
  const [sub, ...subRest] = rest;
  const handler = { start: themeWorkStart, status: themeWorkStatus, resume: themeWorkResume, seal: themeWorkSeal, "request-approval": themeWorkRequestApproval, cancel: themeWorkCancel }[sub];
  if (!handler) throw new TargetError("USAGE", `Usage: ${THEME_WORK_USAGE}`, {}, 1);
  return handler(subRest);
}

async function themeRename(rest) {
  const { flags, positionals } = parseArgsOrExit(rest, KNOWN.themeRename);
  const handle = positionals[0];
  const name = positionals.slice(1).join(" ") || (typeof flags.name === "string" ? flags.name : null);
  if (!handle || !name) {
    console.error("Usage: blocofy theme rename <handle> <new name> [--dir <dir>]");
    console.error("  Rename a theme (handle from the panel theme card or `blocofy status`).");
    process.exit(1);
  }
  const creds = (await prepareTarget({ command: "theme rename", commandClass: "remote-mutation", dir: commandDir(flags.dir), flags, needs: "dev", mode: `instance ${handle}` })).dev;
  const result = await renameInstance({ url: creds.url, token: creds.token, instance: handle, name, onRetry });
  console.log(`✓ Renamed to "${result.name}" (${result.id}).`);
}

async function status(rest) {
  const { flags, positionals } = parseArgsOrExit(rest, []);
  const creds = (await prepareTarget({ command: "status", commandClass: "read", dir: singleDirArg(positionals, "blocofy status [dir]"), flags, needs: "dev", mode: "read", allowCurrentContext: true })).dev;
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

// ── translations (#925): one language's texts as a package file, and back ──────────────────────────────────

const TRANSLATIONS_EXPORT_USAGE = "blocofy translations export --locale <tag> --out <file> [--force] [--format json|xliff] [--only all|missing|stale|pending] [--json]";
const TRANSLATIONS_IMPORT_USAGE = "blocofy translations import <file.json|file.xlf> [--dry-run] [--publish] [--on-source-change skip|apply] [--json]";

function usageExit(usage) {
  console.error(`Usage: ${usage}`);
  process.exit(1);
}

const outExists = (out) =>
  Object.assign(new Error(`${out} already exists. Nothing was requested or written. Choose another --out file, or add --force to replace it.`), { code: "TRANSLATIONS_OUT_EXISTS", details: { file: out } });

/** Write `text` to `out` through a temp file + rename, so `out` is never left half-written. */
function writeOutFile(out, text, force) {
  const temp = `${out}.${process.pid}.blocofy-tmp`;
  try {
    writeFileSync(temp, text, { flag: "wx" });
    if (!force && existsSync(out)) throw outExists(out);
    renameSync(temp, out);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

async function translationsExport(rest) {
  const { flags, positionals } = parseArgsOrExit(rest, KNOWN.translationsExport);
  const locale = typeof flags.locale === "string" ? flags.locale : null;
  const out = typeof flags.out === "string" ? resolve(flags.out) : null;
  const format = flags.format === undefined ? "json" : flags.format;
  const only = flags.only === undefined ? "all" : flags.only;
  const force = flags.force === true;
  if (!locale || !out || positionals.length > 0 || (format !== "json" && format !== "xliff") || !TRANSLATION_ONLY.includes(only)) usageExit(TRANSLATIONS_EXPORT_USAGE);
  // A file the customer may have filled in is never replaced silently.
  if (!force && existsSync(out)) throw outExists(out);
  // A read of the site; the package goes to --out, never into the project tree (so no binding is needed or written).
  const { apiUrl, apiKey } = (await prepareTarget({ command: "translations export", commandClass: "read", dir: process.cwd(), flags, needs: "api", mode: `read · ${locale}` })).api;
  const { pkg, skipped } = await exportAllTranslations({ apiUrl, apiKey, locale, only, onRetry, onPage: ({ page, units }) => console.error(`Export: request ${page}, ${units} unit(s) so far`) });
  // toXliff refuses a text XML cannot carry BEFORE anything is written.
  const text = format === "xliff" ? toXliff(pkg) : `${JSON.stringify(pkg, null, 2)}\n`;
  writeOutFile(out, text, force);
  if (format === "xliff" && text.length > XLIFF_MAX_CHARS) {
    console.error(`Warning: this XLIFF file is over ${XLIFF_MAX_CHARS.toLocaleString("en-US")} characters and cannot be imported back. Export with --format json, or a smaller scope such as --only pending.`);
  }
  if (flags.json) {
    console.log(JSON.stringify({ file: out, format, target_locale: pkg.target_locale, units: pkg.units.length, skipped }));
    return;
  }
  console.log(`Exported ${pkg.units.length} unit(s) for ${pkg.target_locale} to ${out} (${format === "xliff" ? "XLIFF" : "JSON"}).`);
  const skipLines = exportSkipLines(skipped);
  if (skipLines.length > 0) {
    console.log("Left out:");
    for (const line of skipLines) console.log(`  - ${line}`);
  }
}

/** The one `--json` shape of an import run: complete, stopped part-way, or with nothing to send. */
function importJson(tally, { dryRun, publish, locale, chunks, chunksDone, caches, splitGroups, stopped }) {
  return {
    dry_run: dryRun,
    target_locale: locale,
    chunks,
    chunks_done: chunksDone,
    stopped,
    counts: tally.counts,
    created: tally.created,
    stamped: tally.stamped,
    publication: !dryRun && publish ? { published: tally.published, blocked: tally.publishBlocked } : null,
    publish_skipped: tally.publishSkipped,
    notes: tally.notes,
    hints: tally.hints,
    cache: caches,
    split_groups: splitGroups,
  };
}

async function translationsImport(rest) {
  const { flags, positionals } = parseArgsOrExit(rest, KNOWN.translationsImport);
  const onSourceChange = flags["on-source-change"] === undefined ? "skip" : flags["on-source-change"];
  if (positionals.length !== 1 || (onSourceChange !== "skip" && onSourceChange !== "apply")) usageExit(TRANSLATIONS_IMPORT_USAGE);
  const file = resolve(positionals[0]);
  const dryRun = flags["dry-run"] === true;
  const publish = flags.publish === true;
  // Everything local is checked before the first request: the file, its chunks, every chunk's body size.
  let pkg;
  let chunked;
  try {
    pkg = readPackageFile(readFileSync(file, "utf8"), file);
    chunked = chunkPackage(pkg);
    chunked.chunks = fitChunksToBodyCap(chunked.chunks);
  } catch (error) {
    console.error(`Cannot read translation package ${file}: ${String(error?.message ?? error).replace(/\.?$/, ".")} Nothing was sent.`);
    process.exit(1);
  }
  const { chunks, skippedEmpty, splitGroups } = chunked;
  let tally = emptyImportTally();
  tally.counts.skipped_empty += skippedEmpty;
  const caches = [];
  let done = 0;
  const shape = { dryRun, publish, locale: pkg.target_locale, chunks: chunks.length, caches, splitGroups };
  if (chunks.length === 0) {
    if (flags.json) console.log(JSON.stringify(importJson(tally, { ...shape, chunksDone: 0, stopped: false })));
    else console.log("Every translation in the file is empty; nothing to import. Nothing was sent.");
    return;
  }
  const mode = `${dryRun ? "dry run" : publish ? "write + publish" : "write"} · ${pkg.target_locale}`;
  const { apiUrl, apiKey } = (await prepareTarget({ command: "translations import", commandClass: dryRun ? "read" : "remote-mutation", dir: process.cwd(), flags, needs: "api", mode })).api;
  try {
    for (const chunk of chunks) {
      const answer = await importTranslationChunk({ apiUrl, apiKey, chunk, dryRun, publish, onSourceChange, onRetry });
      tally = addImportReport(tally, answer);
      if (answer?.cache !== undefined && answer.cache !== null) caches.push(answer.cache);
      done += 1;
      if (chunks.length > 1) console.error(`${dryRun ? "Checked" : "Imported"} ${done} of ${chunks.length} chunks`);
    }
  } catch (error) {
    // What the chunks before the failure did (published pages, held drafts, a failed cache flush) is reported in
    // full: a rerun answers `unchanged` for them and could never tell it again.
    if (done > 0) {
      if (flags.json) console.log(JSON.stringify(importJson(tally, { ...shape, chunksDone: done, stopped: true })));
      else {
        console.log(`Report for the ${done} of ${chunks.length} chunks done before the stop:`);
        for (const line of importSummaryLines(tally, { dryRun, publish, locale: pkg.target_locale, splitGroups })) console.log(line);
      }
    }
    if (!JSON_MODE) {
      const invalid = error instanceof CliRefusal && Array.isArray(error.error?.details?.units) ? error.error.details.units : [];
      if (invalid.length > 0) {
        console.error("These texts were refused; fix the file and import again:");
        for (const u of invalid.slice(0, 20)) console.error(`  ${u.id}: ${u.message ?? u.reason ?? "refused"}`);
        if (invalid.length > 20) console.error(`  …and ${invalid.length - 20} more.`);
      }
      if (!dryRun && done > 0) {
        console.error(`Import stopped after ${done} of ${chunks.length} chunks. The chunks before it were saved; running the same command again is safe (units already applied report as unchanged).`);
      }
    }
    const details = { chunk: done + 1, chunks: chunks.length, reason: error?.reason };
    if (error instanceof ImportOutcomeUnknown) {
      throw Object.assign(
        new Error(
          `The import of chunk ${done + 1} of ${chunks.length} got no definite answer (${error.reason}) and was not resent, because it publishes: that chunk may or may not have been applied and published. Running the same command again is safe (units already applied report as unchanged).`,
        ),
        { code: "TRANSLATIONS_IMPORT_OUTCOME_UNKNOWN", details },
      );
    }
    if (error instanceof ImportNotApplied) {
      throw Object.assign(
        new Error(
          `The import of chunk ${done + 1} of ${chunks.length} was refused (${error.reason}, too many requests) and was not applied; it was not resent, because it publishes. Wait a moment and run the same command again (units already applied report as unchanged).`,
        ),
        { code: "TRANSLATIONS_IMPORT_NOT_APPLIED", details },
      );
    }
    throw error;
  }
  if (flags.json) {
    console.log(JSON.stringify(importJson(tally, { ...shape, chunksDone: done, stopped: false })));
    return;
  }
  for (const line of importSummaryLines(tally, { dryRun, publish, locale: pkg.target_locale, splitGroups })) console.log(line);
}

const [first, ...rest] = args;

function commandKey(a, b) {
  return `${a} ${b ?? ""}`;
}

// command → handler. Every failure exits through failAndExit (exit codes 1/2/3, --json envelope last).
const COMMANDS = {
  login: login,
  init: initCommand,
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
  "theme work": themeWork,
  "pages media-uses": pagesMediaUses,
  "pages media-decide": pagesMediaDecide,
  "pages pull": pagesPull,
  "pages push": pagesPush,
  "pages check": pagesCheck,
  "pages migrate-layout": pagesMigrate,
  "settings pull": (r) => contentPull("settings", r),
  "settings push": (r) => contentPush("settings", r),
  "site export": siteExport,
  "site validate": siteValidate,
  "site migrate": siteMigrate,
  "site plan": sitePlan,
  "site apply": siteApply,
  "site publish": sitePublish,
  "translations export": translationsExport,
  "translations import": translationsImport,
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
