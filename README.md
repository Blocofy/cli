# @blocofy/cli

Develop your [Blocofy](https://blocofy.com) theme locally against **live data**, see an
instant preview, and publish. The CLI does **not** build assets — generate them with your
own tools (npm/Vite/Tailwind); the platform serves plain Liquid + static assets.

```bash
npx @blocofy/cli login          # site URL + dev token (admin panel: Settings → Theme CLI tokens)
cd path/to/theme
npx @blocofy/cli theme dev       # http://localhost:3030 — local theme + live data, livereload
```

`login` saves the site under a named **context** (default: the site's slug) in
`~/.blocofy/credentials.json`. `blocofy link <dir> --context <name>` (or a pull into an empty
directory) then binds a project directory to that site so every command run inside it always
targets the right one — see [Contexts and project binding](#contexts-and-project-binding).

## Commands

### Login & contexts

```
blocofy login [--context <name>] [--url <url>] [--token <bcf_…>] [--keychain]
```
Verify a dev token against its site (`GET /api/dev/whoami`) and save it as a named context
(default name: the site's slug). Nothing is saved if verification fails. Get a token from the
admin panel → Settings → Theme CLI tokens.
- `--keychain` — keep the secret in the macOS keychain (or `BLOCOFY_SECRET_STORE=keychain`);
  default is `~/.blocofy/secrets.json` (0600).

```
blocofy login --api-key [--context <name>] [--api-url <url>]
```
Verify a v1 API key (`blcf_live_…`, `GET /api/v1/ping`) and add it to a context. The key is
read from a **hidden prompt** — the flag takes no value, so it never lands in argv or shell
history. If the context already has a dev token for another site, nothing is saved
(`TARGET_CREDENTIAL_MISMATCH`).
- `--api-url <url>` — API origin (default `https://app.blocofy.com`).
- Non-interactive shells: set `BLOCOFY_API_KEY` + `BLOCOFY_API_URL` instead.

```
blocofy contexts [--json]          # list saved contexts (never prints secrets)
blocofy use <name>                 # default context for read-only commands outside a project
blocofy logout --context <name>    # remove a context and its secrets
```

### Project binding

```
blocofy link [dir] --context <name> [--adopt]
```
Bind a project directory to the context's (verified) site: writes `.blocofy/project.json`
(commit it), `.blocofy/local.json` (your context; git-ignored) and `.blocofy/.gitignore`.
Refuses to rebind a directory bound to another site unless `--adopt`.

```
blocofy target [dir] [--context <name>] [--json]
```
Show which site a command in `[dir]` would hit (verified), without writing anything.

### Theme

```
blocofy theme dev [dir] [--port <n>] [--no-sync] [--name <name>]
```
Start a dev server and print 3 auto-reloading views — Local, live-domain Preview, and the theme
Editor. Press `l` / `p` / `e` to open each, `q` to quit. Edit a file and save → every open view
reloads. Saves sync to a **draft** theme only (never the live site). `dir` defaults to cwd.
The target site is verified once at start; a long session keeps that target (restart it after
changing credentials, context or the project binding).
- `--port <n>` — local port (default 3030).
- `--no-sync` — local preview only (skip draft sync + remote views).
- `--name <name>` — name the draft when it is first created (ignored if it already exists).

```
blocofy theme pull [dir] [--draft] [--instance <handle>]
```
Download the live theme to disk. `dir` defaults to cwd.
- `--draft` — pull the draft theme (what `theme dev` syncs into) instead of live; creates the
  draft if missing, so it needs a bound project.
- `--instance <handle>` — pull a specific theme by its handle (admin panel theme card, or
  `blocofy status`).

```
blocofy theme push [dir] [--live] [--yes] [--instance <handle>] [--prune]
                    [--name <name>] [--dry-run | --validate] [--diff]
                    [--idempotency-key <k>]
```
By **default** writes to a draft theme (create/update; no delete) — preview & publish it from
the admin panel, never touching the live site. Publish it with `blocofy theme publish`.
- `--live` — write to the LIVE site immediately (no preview). Asks for confirmation first;
  non-interactive shells must add `--yes`.
- `--draft` — explicit draft (same as the default; safe).
- `--yes` — confirm a `--live` push without prompting (CI/agents).
- `--instance <handle>` — push to a specific theme by its handle (safe targeted write — no
  live-confirmation prompt).
- `--name <name>` — name the new draft (draft mode only; ignored on `--live`/`--instance`).
- `--dry-run` / `--validate` — validate on the server without writing (auth + snapshot + Liquid
  check); the two flags are aliases.
- `--diff` — show what a push would change vs the target (read-only), then stop.
- `--idempotency-key <k>` — attach a key so a retried push is not double-applied.
- `--prune` — also remove target files that no longer exist locally (`locales/` included);
  lists them first, and on the live theme asks to confirm (non-interactive shells add `--yes`).

```
blocofy theme rename <handle> <new name>
```
Rename a theme (the name is just a label). Works on any of your themes, including the live one.

```
blocofy theme publish [--instance <handle>]
```
Publish a draft theme to the LIVE site: it replaces the live theme for every visitor. With no
flag, publishes the draft that `theme dev` / `theme push --draft` writes into. The server
refuses to publish a theme that has no pages (it would 404); preview first.
- `--instance <handle>` — publish a specific theme.

### Status

```
blocofy status
```
Show the live theme, page distribution per instance, drafts, and a health flag (`ok` /
`live_instance_empty` / `pages_split`). For a problem it names the theme holding the pages, the
missing pages, why, and safe preview-first next steps — never a one-line fix.

### Pages

```
blocofy pages pull [dir] [--strict]
```
Download published pages, one folder per language: `pages/<locale>/index.json` (home) and
`pages/<locale>/routes/<path>/index.json` (everything else). Files from the old flat layout
(`pages/<slug>.json`) are reported, never deleted or overwritten. If the site cannot export
every published page, nothing is written, every reason is printed
(`PAGES_EXPORT_INCOMPLETE`) and the exit code is 2 (`--strict`: warnings exit 1).

```
blocofy pages push [dir] [--dry-run] [--strict] [--force --reason <text>]
```
Write `pages/**.json` to the site. Updates **existing** pages only — never creates or deletes a
page; unchanged pages are skipped. Every file is checked first: an invalid file, two files
pointing at the same page, or a folder/locale mismatch changes **no** page. Every pulled file
carries `base_revision` (the page as you pulled it); the push first asks for a plan (per page:
action, live/draft, changed fields), prints it, then pushes exactly that plan.
- If a page changed on the site since you pulled it (`PAGES_REVISION_CONFLICT`) or a file has no
  `base_revision` (`PAGES_BASE_REVISION_REQUIRED`), nothing is changed: run `blocofy pages pull`,
  merge your edits, and push again.
- If the site changes between the plan and the push, nothing is changed either
  (`PAGES_PLAN_STALE`) — run the push again.
- `--force --reason <text>` — overwrite anyway (reason: 1–500 characters); the forced pages are
  listed. Against an older server that cannot check revisions, the push runs as before with a
  warning.
- `--dry-run` — print the plan, write nothing.
- If publishing stops unexpectedly after the plan (`PAGES_APPLY_FAILED` or another publish
  error), some pages may already be applied: the per-file result printed is authoritative, the
  exit code is non-zero, and re-running the push is safe.

```
blocofy pages check [dir] [--strict]
```
Check page files. Offline: paths, JSON, layout, duplicates, missing `base_revision`
(`PAGES_BASE_REVISION_MISSING` warning). Logged in: also the site's languages and a server-side
dry run. Exit 1 on errors (`--strict`: warnings too).

```
blocofy pages migrate-layout [dir] [--dry-run | --write] [--strict]
```
Move old flat-layout files (`pages/<slug>.json`) to language folders. `--dry-run` (default)
prints the plan; `--write` moves only proven files. Any ambiguity or conflict: nothing is moved,
exit 1. Files without `"locale"` use the site's default language (needs login); with `--write`
outside a bound project only explicit `--context`/env credentials are used.

```
blocofy pages media-uses <page-handle> [--json]
```
List a page's localized-media decisions on its newest **draft** (v1 API, `pages:read`). Prints
the draft's revision id/version needed by `media-decide`.

```
blocofy pages media-decide <page-handle> --decisions <file.json>
                            [--expected-revision-id <n> --expected-version <n>] [--json]
```
Apply one or more media decisions to the page's draft atomically (v1 API, `pages:write`). The
file is `{ "decisions": [ { path, facet, decision, target_asset?, alt?, caption?, decorative?,
idempotency_key?, witness? } ] }` (max 20). Without the two `--expected-*` flags the CLI first
`GET`s the draft and uses its current revision id/version; items without an `idempotency_key`
get a random UUID. Transient failures (429/502/503/504, network) are retried against the same
idempotency key, so a retry replays the same batch. Exit 0 on success (or "No changes" when
every item was already recorded).

### Settings

```
blocofy settings pull [dir]
blocofy settings push [dir] (--instance <handle> | --live [--yes])
```
Download / upload `config/settings.json` (theme tokens/settings + color schemes). A push
**names its target** — there is no implicit live write, and the command refuses with neither
flag:
- `--instance <handle>` — write that theme's settings; a draft shows them in its preview and
  goes live with `blocofy theme publish --instance <handle>`.
- `--live` — write the LIVE theme (asks to confirm; non-interactive shells add `--yes`).

After a push the CLI says where it applied (preview now / live now / after deploy).

### Site (declarative state)

The `site` commands move a whole site — pages, navigation, theme source, settings, chrome,
translations, media — as one declarative tree on disk (`blocofy-site.json` + `site/**` +
`theme/**` + `pages/**` + `media/**`), instead of the per-scope `theme`/`pages`/`settings`
commands above.

```
blocofy site export [dir]
```
Download the whole site as a declarative tree into `[dir]`, plus every media file's bytes at
`media/files/<sha256>` (downloaded and hash-verified). Refuses to overwrite a directory bound to
another site (same binding rule as every other pull).

```
blocofy site validate [dir]
```
Check an exported (or hand-authored) tree **offline** — zero network requests: paths, the
path↔content binding (a page file's locale/slug must match its folder/name, and so on),
duplicate identities, the size/count limits, and the tree against its own manifest digest.
- `--strict` — warnings also exit non-zero.

```
blocofy site migrate [dir] [--dry-run | --write]
```
Turn a directory left by the **older separate** `theme pull` / `pages pull` / `settings pull`
into the site-state v1 tree layout (theme directories at the root → `theme/**`,
`config/settings.json` → `theme/config/settings.json`). Purely local: no network request, no
target/identity check, `.blocofy/` project binding untouched. `pages/**` files are never moved
(the location is already identical); a file still at the old flat page layout is left alone with
a note to run `blocofy pages migrate-layout` first.
- `--dry-run` (default) — print the plan: every move, every file left alone, every conflict.
- `--write` — perform it.
- Any ambiguity or conflict (a target already exists with different content, an unreadable or
  symlinked entry, a path the shared site-state rules refuse): zero moves, exit 1.
- Never invents the parts a directory of separate pulls never had (`blocofy-site.json`,
  `site/locales.json`, globals, navigation, translations, `theme/chrome/**`) — it says so and
  points at `blocofy site export` for those.

```
blocofy site plan [dir] [--target new|<handle>] [--mode same_site|restore]
                  [--accept-live-effects locales] [--json]
```
Ask the site what applying this tree **would** do — no write. Needs **both** a dev token and a
v1 API key (the dev token is what a theme deploy uses later). Prints the status (`planned` /
`awaiting_assets` / `awaiting_theme_source` / `draft_complete`), the steps, and any missing
assets or a differing theme source.
- `--target new|<handle>` — a fresh draft theme version (default), or a specific one you own
  (from a previous plan/apply's target instance).
- `--mode same_site|restore` — `same_site` refuses a page that changed on this site since the
  tree was exported; `restore` (default) does not.
- `--accept-live-effects locales` — required before a state that adds a language may be applied
  (publishing a language prepares its homepage LIVE).

```
blocofy site apply [dir] [--target new|<handle>] [--mode same_site|restore]
                   [--accept-live-effects locales] [--json]
```
Build the state into a **draft** theme version — the live site is never touched. Loops: plan →
(upload missing media via the v1 API, or deploy the theme source via the same canonical path
`theme push --instance` uses) → plan → apply, until the target reports `draft_complete` or 5
passes are used. Safe to re-run: every step is idempotent and a re-plan picks up exactly what is
left, so an apply interrupted by anything (network, Ctrl-C, a crash) resumes with the same
command. Preview it from the admin panel, then run `blocofy site publish`.

```
blocofy site publish [dir] [--target new|<handle>] [--mode same_site|restore] [--yes]
```
Make an applied state the LIVE site: pointer swap, then navigation, then settings. Refuses (exit
2) if the state is not fully applied yet — run `site apply` first. Separate live gate: asks to
confirm (non-interactive shells must add `--yes`).

```
blocofy --version
blocofy --help
```

## Contexts and project binding

Every remote command verifies its site first and prints a `Target` block on stderr. The context
is chosen in this order:

1. `--context <name>`
2. `BLOCOFY_CONTEXT`
3. env credentials (`BLOCOFY_URL` + `BLOCOFY_TOKEN` and/or `BLOCOFY_API_URL` + `BLOCOFY_API_KEY`)
4. `.blocofy/local.json` (the project's own context choice)
5. the one saved context matching the project's site
6. (terminal) pick from the matches

Inside a **bound project**, `blocofy use` is ignored — the project's binding decides, not the
global default context. Commands that change a site (`theme push`/`publish`/`rename`, `theme
dev` sync, `pages push`, `settings push`, `pages media-decide`) need a bound project; a pull into
a new empty directory binds it automatically. A wrong project/site pairing changes nothing
(`TARGET_SITE_MISMATCH` — pass `--adopt` on `link` to rebind deliberately).

A binding made against an older server has no recorded `platform_origin`: it still matches the
same site (one warning printed; run `blocofy link --adopt` to record it). A server that reports
no origin cannot serve a binding that records one — that refuses with `TARGET_UNVERIFIED` (the
server cannot prove it is the platform the binding was made against).

A refusal in this area (`TARGET_SITE_MISMATCH`, `TARGET_UNVERIFIED`, `TARGET_CREDENTIAL_MISMATCH`,
`TARGET_CONTEXT_REQUIRED`, `TARGET_CONTEXT_UNKNOWN`, `TARGET_BINDING_INVALID`) always means:
**nothing was read or written** — the command stops before it touches the site or the local
project files, and exits 3 (see [Exit codes](#exit-codes)).

`blocofy site migrate` is the one exception: it never resolves a target or a context at all (no
network, no identity call), so it leaves any `.blocofy/` binding in the directory completely
untouched.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Ok. |
| 1 | Usage / network / HTTP 5xx / a local check that refuses before any request (e.g. a `site migrate` conflict, a `pages migrate-layout` ambiguity). |
| 2 | The server refused the request (HTTP 4xx) — its `{error}` JSON is printed. |
| 3 | Target/binding refusal — nothing was read or written (see [Contexts and project binding](#contexts-and-project-binding)). |
| 4 | `site apply` only: not finished within its bounded pass count. Every step already applied is safe — re-run the same command to resume. |

`--json`: every failure prints `{"error":{"code","message","details"}}` as the **last** stderr
line; the target block (`{"target":…}`) and any warning lines are printed on stderr before it.

Retries: network errors and HTTP 429/502/503/504 are retried up to 3 times (`Retry-After`
honoured, max 30s per wait; else 0.3s/0.9s/2s), resending the identical request (`pages push`
carries one `x-idempotency-key` per push). HTTP 500 is never retried. Each retry prints a notice
on stderr.

## Changelog

- **0.10.0** — Named contexts + verified project binding, and a declarative whole-site state.
  - `login` now saves a **named context** (`--context <name>`, default the site's slug) instead
    of one global credentials pair; `blocofy contexts` / `use` / `logout` manage them, and
    `blocofy link [dir] --context <name> [--adopt]` binds a project directory to one verified
    site (`.blocofy/project.json`, committed; `.blocofy/local.json`, git-ignored).
    `blocofy target [dir]` shows which site a command would hit without writing anything.
    `login --keychain` keeps the secret in the macOS keychain instead of
    `~/.blocofy/secrets.json`. A pre-0.10 `credentials.json` is migrated on first use (backup:
    `~/.blocofy/credentials.v1.bak.json`).
  - New `blocofy site export/validate/migrate/plan/apply/publish`: pull a whole site as one
    declarative tree, check it fully offline, turn an older separate-pulls directory into that
    tree layout (`site migrate`), ask what applying it would do, build it into a draft theme
    version, and make it live. `site apply` is resumable — every step is idempotent and picks up
    exactly what is left.
  - `pages push` speaks page revision CAS: every pulled file carries `base_revision`, a push
    previews its plan before writing, and a page changed on the site since the pull (or missing
    `base_revision`) refuses with nothing changed instead of silently overwriting — recover with
    `pages pull` + push again, or `--force --reason <text>`.
  - `settings push` now **requires** `--instance <handle>` or `--live` — there is no longer an
    implicit live write.
  - Consistent exit codes across every command (see [Exit codes](#exit-codes)) and a `--json`
    envelope (`{"error":{code,message,details}}`) as the last stderr line on any failure.

- **0.9.0** — Locale-aware page files for multilingual sites (needs a platform with page file protocol 2;
  against an older server page commands stop with `PAGES_SERVER_UPGRADE_REQUIRED` and write nothing).
  `pages pull` writes `pages/<locale>/index.json` and `pages/<locale>/routes/<path>/index.json`, so the same
  URL in two languages no longer shares one file. `pages push` preflights the whole directory and the server
  refuses the batch before any write on an invalid file, duplicate target or folder/locale mismatch; a
  failure after preflight prints the per-file result. New `pages check`, `pages push --dry-run` and
  `pages migrate-layout [--dry-run | --write]`. Pull validates every server path, never follows symlinks,
  never writes outside the target directory and stages its writes (0.8.0 could write a server-supplied
  `../` path outside it). An incomplete export prints every reason with `PAGES_EXPORT_INCOMPLETE` and writes
  nothing. Limits: 500 page files, 2 MiB per file, 4 MiB total.
- **0.8.0** — Page media decisions over the public v1 API: `pages media-uses <page-handle>` lists a
  page's localized-media decisions on its newest draft, and `pages media-decide <page-handle>
  --decisions <file.json>` applies a batch of decisions to that draft atomically (all or nothing;
  a replayed batch answers "No changes"). Both use a **v1 API key** (`blcf_live_…`, scopes
  `pages:read` / `pages:write`) — the `bcf_` dev token is not accepted. `blocofy login --api-key`
  stores the key from a **hidden prompt**; the flag deliberately takes no value so the key never
  enters argv or shell history, and a non-interactive shell without `BLOCOFY_API_KEY` +
  `BLOCOFY_API_URL` exits without writing. The API pair lives next to the dev pair in
  `~/.blocofy/credentials.json` (still 0600): logging in one way keeps the other. Exit codes for
  the new commands: 0 success, 1 usage/auth/network/5xx (no automatic retry), 2 server refusal
  (4xx, with the server's `{error}` JSON on stderr). Existing commands and the dev-token flow are
  unchanged.

- **0.7.0** — `theme push --prune`: files that exist on the platform but no longer exist locally are
  removed. Until now a push merged remote-only files back into the upload, so a file deleted locally
  stayed on the theme forever. The list is printed before anything is written; pruning the LIVE theme
  (`--live`, or `--instance` pointing at the live theme) asks for confirmation or `--yes`, and a
  non-interactive shell without `--yes` exits without writing. Removal goes through the platform's atomic
  deploy, so it is revision-tracked. A draft push also no longer creates a draft as a side effect of its
  pre-push remote read: the CLI probes the existing CLI draft by handle and skips the probe when there is
  none. Previously a failure during that read left an empty draft behind and printed a bare `HTTP 500`.

- **0.6.0** — `theme dev`'s local view finally shows what you are working on. It used to render your
  DRAFT theme against the site's LIVE page content, so draft page documents were invisible; each render
  now carries the draft theme instance and the platform resolves that instance's pages. Three failures
  caused by a retired server endpoint (`/api/dev/session`, gone since the platform's preview-security
  work) are fixed at the root: **draft sync** was switched off whenever that endpoint failed even though
  sync never used it (it posts to `/api/dev/theme`); **`theme publish`** without `--instance` called it
  with no error handling and died with an empty message — it now resolves the CLI draft from
  `blocofy status` (`source: "import"`); and an empty response body produced the undiagnosable
  `dev session unavailable ()` — errors now fall back to `HTTP <status>` and a 410 explains itself.
  If the server ever stops returning a draft handle, the CLI now says so instead of silently rendering
  live content. Remote (shared-link and editor) preview is NOT restored — that surface was retired on
  the platform side; `theme dev` prints the local view only.

- **0.5.0** — M4 canonical deploy protocol. `theme push` now deploys through the platform's atomic
  source pipeline: the CLI declares the protocol handshake and auto-generates a per-push idempotency
  key (transport retries converge; `--idempotency-key <k>` overrides it for scripting). A `--live`
  push is finally visible on the pinned production render again. "Push does not delete" still holds —
  remote-only files are carried along, and server-retained rows survive. New flags: `--dry-run` /
  `--validate` (server-side validation, nothing written — refused against a server that predates the
  protocol, which would otherwise silently write), `--diff` (read-only compare vs the LIVE theme).
  `--help` on ANY subcommand now prints help and never runs the command (0.4.0 executed a real push);
  unknown flags exit write-free instead of silently swallowing the next argument. `layer/` joined the
  synced theme directories. Server errors `cli_upgrade_required` (426) and `idempotency_conflict`
  (409) get human messages. Token format check aligned to the server minimum (total length ≥24 incl. the
  `bcf_` prefix; real tokens are 47 chars). Two honest costs of the canonical pipeline: re-pushing
  identical bytes still records a NEW deployment (the revision itself is deduplicated server-side; on
  a repo-linked live target it also produces a reconcile bot commit), and the no-delete guarantee is
  bought by carrying remote-only files in the payload — a very large theme (local+remote > 256 files
  or > 4 MiB) can now hit the server's payload limits where 0.4.0's upsert did not.
- **0.4.0** — `theme push` / `theme dev` accept `--name <name>` to name a new draft (applied
  only when the draft is first created; reuse ignores it). New `theme rename <handle> <new name>`
  renames a theme (the name is a label; works on any theme, including the live one).
- **0.3.0** — `theme push` now writes to a **draft** by default; use `--live` for the old
  immediate-live behavior (with a confirmation prompt; `--yes` to skip it in CI). `blocofy
  status` now names the exact pages at 404 risk when a theme's pages are split off the live theme.

## How it works

`theme dev` starts a local HTTP server. For each page request it reads your local theme
files and sends them to the platform's dev-render endpoint (`/api/dev/render`). The platform
renders them with the site's **live data** and returns HTML — so the CLI ships no rendering
engine and you see exactly the production output.

It also continuously syncs your local files to a **draft theme** so you can view the same work
three ways — the local preview, a shareable live-domain preview link, and the admin theme
editor — without affecting your published theme. Save a file and **every open view reloads**
(the platform-rendered pages connect back to the local dev server's reload channel). Publish
the draft from the theme editor when you're ready.

Credentials live in `~/.blocofy/credentials.json` (contexts, no secrets) + either
`~/.blocofy/secrets.json` (0600) or the macOS keychain — written by `blocofy login`, or the
`BLOCOFY_URL` + `BLOCOFY_TOKEN` environment variables (for CI/automation). The v1 API commands
(`pages media-uses`/`media-decide`, `site plan`/`export`/`publish`) use a separate
`blcf_live_…` key from the same file (written by `blocofy login --api-key`) or `BLOCOFY_API_KEY`
+ `BLOCOFY_API_URL` — both variables together; with only one set the CLI fails instead of
falling back to the file.

## Theme structure

A theme is a directory of files grouped by top-level folder:

| Folder | Contents |
| --- | --- |
| `layout/` | Page shell (`theme.liquid`) |
| `section/` | Page sections (`Hero.liquid`, `FeaturedCards.liquid`, …) |
| `block/` | Repeatable pieces used inside sections |
| `partial/` | Shared snippets (header/footer, …) |
| `asset/` | CSS and static files (`theme.css`) |
| `locales/` | Legacy Liquid translation files (`<tag>.json`, `<tag>.default.json`) |
| `pages/<locale>/index.json`, `pages/<locale>/routes/<path>/index.json` | Page content, one folder per language (`blocofy pages pull/push/check/migrate-layout`). The old `pages/<slug>.json` layout is still read, with a warning |
| `config/settings.json` | Theme settings + color schemes (`blocofy settings pull`; `settings push` needs `--instance <handle>` or `--live`) |
| `config/settings_schema.json` | Theme settings panel schema (synced with `theme pull`/`push`) |

Liquid templates use the `.liquid` extension; files under `asset/` are served as-is.

`blocofy site export` pulls the same content plus navigation, chrome and translations as one
declarative tree instead (see [Site (declarative state)](#site-declarative-state)); `blocofy
site migrate` turns a directory built from the commands above into that tree's layout.

## Development

Zero runtime dependencies (Node built-ins only). Run the tests with:

```bash
node --test
```

Requires Node ≥ 18.

## License

[MIT](./LICENSE)
