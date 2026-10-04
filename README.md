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
blocofy use <name>                 # default context for status / target / pages check outside a project
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
blocofy theme dev [dir] [--port <n>] [--no-sync] [--name <name>] [--instance <handle>]
```
Start a local dev server that renders your local theme files with the site's live content.
Press `l` to open it, `q` to quit. Edit a file and save → the view reloads. Saves sync to a
**draft** theme only (never the live site). `dir` defaults to cwd. The platform's remote preview
and editor views for this command are retired; to share a draft page, create a preview link for
it (v1 API `POST /themes/{id}/preview-links` or MCP `create_preview_link`; one page per link).
The target site is verified once at start; a long session keeps that target (restart it after
changing credentials, context or the project binding).
- `--port <n>` — local port (default 3030).
- `--no-sync` — local preview only (skip draft sync).
- `--name <name>` — name the draft when it is first created (ignored if it already exists).
- `--instance <handle>` — sync into this draft. Needed when the platform cannot tell which draft is the
  CLI draft (see "Which draft a draft command writes to" below); the live theme's handle is refused.

```
blocofy theme pull [dir] [--draft] [--instance <handle>]
```
Download the live theme to disk. `dir` defaults to cwd.
- `--draft` — pull the CLI draft (what `theme dev` and `theme push --draft` write into) instead of
  live. Read-only: it never creates the draft. With no CLI draft yet the platform answers
  `target_missing` and the CLI stops (exit 2, nothing written) and tells you to run
  `blocofy theme push --draft` first. It still needs a bound project.
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
- `--instance <handle>` — push to a specific theme by its handle. The live theme's handle asks for
  the same confirmation as `--live` (non-interactive shells add `--yes`); so does any handle the CLI
  cannot tell apart from the live theme (the live theme is unknown, or a raw numeric id was given).
  With `--draft --instance <handle>` the push is a draft write to that draft: it never writes the
  live theme (refused locally and by the platform, `draft_target_is_live`).
  On a site with **no live theme** (or when the live theme cannot be read) the CLI cannot tell any
  handle apart from the live one, so it stays on the safe side by design: every `--instance` push
  asks for confirmation (`--yes` in non-interactive shells), and `--draft --instance` and
  `theme dev --instance` refuse.
- `--name <name>` — name the new draft: it is created as `CLI Draft — <name>` (draft mode only;
  ignored on `--live`/`--instance`). When the push reuses the existing CLI draft instead, it says
  `--name` was not applied. Do not rename the CLI draft by hand to a name that does not start with
  `CLI Draft — `: the next draft push would refuse it and ask for `--instance`.
- `--dry-run` / `--validate` — check the push on the server without writing; the two flags are
  aliases. The dry run covers exactly the files the push would send (remote-only files it keeps
  included; with `--prune`, without the ones it would remove). A current platform plans the whole
  deploy and prints the target, its pointer version and what happens to each file
  (`+` created, `~` updated, `-` removed; unchanged files are counted).
- `--diff` — show what a push would change vs the target (read-only), then stop. A draft push
  compares with the CLI draft it writes to (named by handle); with no CLI draft yet, with the live
  theme (the push would create the draft). `--live` compares with live, `--instance` with that theme.

**Which draft a draft command writes to.** A draft push, `theme pull --draft` and the `theme dev`
sync write to (or read) the CLI draft only when the platform can tell which draft that is: exactly
one draft created by a CLI push, still carrying a name the platform gives it (`CLI Draft`,
`CLI Draft — YYYY-MM-DD` or `CLI Draft — <name>`), and not a draft a site-state restore built.
Otherwise — two such drafts, a site-state restore draft, or a CLI draft renamed by hand — the command
writes nothing, lists the candidate drafts and exits 2 (`draft_target_ambiguous`). The message
pre-fills `--instance <handle>` only for a CLI-named draft that is not a restore draft; naming any
other listed draft would overwrite it. On a site whose only candidate is a site-state restore draft,
create a new draft theme in the admin panel and pass its handle with `--instance`, or publish or
delete the restore draft first. `theme publish` without `--instance` uses the same rule and never
publishes a guessed draft. With no draft at all, the first push creates one as before.

**When the platform cannot create the new draft.** A draft push (or the `theme dev` sync) that needs
a new CLI draft can be refused by the platform's capacity check. Nothing is written in any of these
cases; the CLI explains it in plain words first, then prints the `error [code]` line (the `--json`
envelope keeps the code and details):
- `quota_exceeded` (exit 2) — the plan's limit is reached; the message shows the usage the platform
  reports (for example storage used / limit and what the new draft needs).
- `capacity_unavailable` / `resource_busy` (exit 1) — temporary. The CLI has already retried within
  its normal retry policy (waiting as long as the server's `Retry-After` asks); try again later.
- `source_stale` (exit 2) — the live theme the new draft copies changed meanwhile; run the command
  again.
`theme dev` reports each of them in one line and tries again on the next save.

After a draft push the CLI prints the draft it wrote to (`Draft: <handle> "<name>" (new)` or
`(existing CLI draft, updated)`) and the `blocofy theme publish --instance <handle>` command.
- `--idempotency-key <k>` — attach a key so a retried push is not double-applied.
- `--prune` — also remove target files that no longer exist locally (`locales/` included);
  lists them first, and on the live theme asks to confirm (non-interactive shells add `--yes`).

Every push first runs that dry run, then writes the same files. On a current platform the write is
bound to the dry run: it is refused, with nothing written, if the files differ from what was checked
(`manifest_mismatch`), the target theme was deployed again in between (`pointer_version_conflict`),
or the push would now write to another theme than the one its dry run planned against — the live
theme was switched, or the draft to reuse changed (`target_changed`: nothing was deployed, though a
draft push may have created a new, empty draft that the next push reuses; run the push again).
A write that gets no answer (network error, 429/502/503/504) is resent (up to 3 times) under the same
key; a push the platform already committed is then reported as deployed (`already applied by an
earlier push with the same idempotency key`). If that resend is refused, the refusal cannot say
what the earlier attempt did: the message says whether it was committed or its outcome is
unknown (`details.earlierAttempt`), never "Nothing was written". Check the theme the dry run bound
the write to (`details.expectedTargetInstance`, not the current target a refusal names) with
`blocofy theme push --diff --instance <handle>` — or, for a new draft, find it with `blocofy status` —
before running the push again. A write whose last answer is still not definite (HTTP 500 or another
5xx, a 503, a 502 `readback_unverified` with `outcomeUnknown`, or no answer) has an unknown outcome
(`details.outcome: "unknown"`): the message names the push's key (`details.idempotencyKey`); run the
same command again with `--idempotency-key <that key>`, and a push that was deployed is reported as
deployed instead of being written again.
If the dry run would remove a file the push did not carry, the push stops
(`THEME_PUSH_TARGET_CHANGED`). The message says which case each file is:
- a path the push cannot send (not a file inside a theme folder, e.g. a bare `layout` row; listed in
  `details.notCarryable`) stops every run the same way, and only `--prune` gets past it (it removes
  the file);
- any other file was either added while the push was running, and running the push again keeps it,
  or the push cannot read it (for example a theme file that is not published): then it stops every
  run the same way, and you add `--prune` to remove it or add a local file at that path to replace it.

`Deployed atomically` is printed only when the server read the written files back and they match;
an older platform that does not read back gets `Deployed: … not verified`.

```
blocofy theme rename <handle> <new name> [--dir <dir>]
```
Rename a theme (the name is just a label). Works on any of your themes, including the live one.
- `--dir <dir>` — the bound project whose site the theme is on (default: cwd).

```
blocofy theme publish [dir] [--instance <handle>]
```
Publish a draft theme to the LIVE site: it replaces the live theme for every visitor. With no
flag, publishes the draft that `theme dev` / `theme push --draft` writes into. The server
refuses to publish a theme that has no pages (it would 404); preview first. The site is the one
`[dir]`'s project is bound to (`dir` defaults to cwd), so `blocofy theme push ./shop && blocofy
theme publish ./shop` always publishes `./shop`'s site, whatever directory you run it from.
- `--instance <handle>` — publish a specific theme. Without it the platform publishes only the
  site's CLI draft; any other theme (a site-state restore draft, a renamed or panel-copied theme) is
  refused with `publish_target_unconfirmed` (exit 2, nothing published) — name it with `--instance`.

### Theme work (new)

A **work** is a private, safe copy of the site's current live theme: you change it, visitors never
see it, and a person approves its publication in the admin panel (the CLI never publishes a work).
Work commands use the **v1 API key** (`blocofy login --api-key`, or `BLOCOFY_API_KEY` +
`BLOCOFY_API_URL`): the work belongs to the key that started it. The dev token alone is refused
(`LOGIN_REQUIRED`) before any request.

```
blocofy theme work start [dir] [--intent "<text>"] [--idempotency-key <k>]
blocofy theme work status <wk_…> [--dir <dir>]
blocofy theme work resume <wk_…> [--dir <dir>] [--require-fresh]
blocofy theme work cancel <wk_…> [--dir <dir>]
blocofy theme work seal <wk_…> [--dir <dir>]
blocofy theme work request-approval <wk_…> [--dir <dir>] [--open] [--wait [--interval <s>]]
blocofy theme push [dir] --draft --work <wk_…>
```
- `seal` prepares the work for review: its content is frozen and can no longer change. It asks for
  no approval and publishes nothing. On a platform without this step it says so (`seal_unsupported`,
  exit 2); `request-approval` prepares the work itself.
- `request-approval` asks a person to publish the work (an open work is prepared for review first)
  and prints the **approval URL**. A signed-in site owner, or a team member with the theme permission,
  approves on that Blocofy page. The URL carries no token: having it is not a permission to publish.
  `--open` also opens it in your browser (only when it is this platform's approval page). `--wait`
  polls the read-only publish status until the work is published (exit 0) or the request ends without
  a publication: the live site changed (`approval_stale`), the request expired (`approval_expired`,
  15 minutes), was declined (`approval_declined`) or the work was reopened (`approval_superseded`) —
  exit 2, nothing published; a timeout is exit 1 (`wait_timeout`). The CLI never publishes a work.
- `status` also shows where the publication stands (preparing, ready for review, waiting for
  approval with its URL, published, needs update).
- `start` prints the work's handle (`wk_…`) and saves it in `.blocofy/local.json` (git-ignored; the
  handle alone grants nothing). It sends an `Idempotency-Key` (yours, or a printed `cli-work-<uuid>`):
  the same key returns the same work, never a second one. When the answer is lost (network, 5xx),
  the CLI prints the exact command to run again with the same key.
- `status`, `resume` and `cancel` always take the handle; with none they suggest the project's saved
  work and stop. `status` and `resume` say whether the site changed since the work started; a changed
  site is never overwritten. `resume --require-fresh` refuses (`work_stale`) instead.
- `cancel` reads the work's `state_version` and sends it; the live site is untouched and the work's
  theme stays in the theme library.
- `theme push --work <wk_…>` writes into that work's own draft theme (`--work` implies `--draft`; it
  cannot be combined with `--live` or `--instance`). It needs **both** the dev token and the API key of
  the same site, and refuses unless the work is open (`work_state_conflict`, nothing written).
- Refusals print a plain Turkish explanation first, then the `error [code]` line (`--json`: the
  envelope only): `not_found`, `work_forbidden`, `work_state_conflict`, `work_stale`, `work_sealed`,
  `work_base_unavailable`, `quota_exceeded`, `capacity_unavailable`, `resource_busy`,
  `idempotency_key_reuse` (exit 2 for a 4xx, 1 for a 5xx).

### Status

```
blocofy status [dir]
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
blocofy pages media-uses <page-handle> [--dir <dir>] [--json]
```
List a page's localized-media decisions on its newest **draft** (v1 API, `pages:read`). Prints
the draft's revision id/version needed by `media-decide`. `--dir <dir>` (both media commands):
the bound project whose site the page is on (default: cwd).

```
blocofy pages media-decide <page-handle> --decisions <file.json>
                            [--expected-revision-id <n> --expected-version <n>] [--dir <dir>] [--json]
```
Apply one or more media decisions to the page's draft atomically (v1 API, `pages:write`). The
file is `{ "decisions": [ { path, facet, decision, target_asset?, alt?, caption?, decorative?,
idempotency_key?, witness? } ] }` (max 20). Without the two `--expected-*` flags the CLI first
`GET`s the draft and uses its current revision id/version; items without an `idempotency_key`
get a random UUID. Transient failures (429/502/503/504, network) are retried against the same
idempotency key, so a retry replays the same batch. Exit 0 on success (or "No changes" when
every item was already recorded).

### Translations

```
blocofy translations export --locale <tag> --out <file> [--force] [--format json|xliff] [--only all|missing|stale|pending] [--json]
blocofy translations import <file.json|file.xlf> [--dry-run] [--publish] [--on-source-change skip|apply] [--json]
```
`export` writes every text of one language that needs translating (pages, image texts, records,
menus, site settings, theme texts) to ONE file. The platform answers in windows; the command
follows every window until the last and merges them, then lists what was left out and why.
`--format xliff` writes XLIFF 1.2 for translation tools (the platform's own dialect, byte for
byte); `--only pending` limits the file to texts that are missing or need an update. The export
asks for every kind, so the API key needs the read scopes of all of them: `pages:read`,
`content:read`, `navigation:write` (menus have no read scope), `settings:read`, `themes:read` and
`models:read`; a key without one of them is refused for the whole export. An existing `--out` file
is never replaced silently: the command refuses before any request unless `--force` is given, and
the file is written through a temporary file and a rename.

`import` reads a JSON or XLIFF package, drops empty translations, and sends the rest as JSON in
chunks of at most 500 units (a page or record is never split; one group of up to 5,000 units is
sent whole). Every chunk is checked locally before the first request. It prints the count per
state (written, unchanged, empty, source changed, target changed, invalid, blocked). New pages and
records are created as drafts and page content goes to the draft; menus, site settings, theme texts,
a live record's text and a live page's title and SEO texts change at once (a live page's URL only
with `--publish`, once that page's publish succeeded). `--publish` also publishes the pages and records this
import wrote (needs `pages:write` and `content:write`) and reports what could not be published;
`--dry-run` writes nothing and reports what would change. The API key needs the write scopes of
the kinds in the package. A refusal (for example an invalid text) exits 2 with the server's error
JSON on stderr; if a later chunk fails, the chunks already written stay written, the report of
those chunks (counts, what was published or held back, a failed cache refresh) is printed before the
error (`--json`: one object with `"stopped": true` on stdout), and running the command again is safe
(written texts answer "unchanged"). Transient failures (429/502/503/504, network) are retried, except
for a chunk imported with `--publish`: a resend could not see what the first attempt already
published, so such a chunk is sent once. A 5xx or a lost connection stops the command with
`TRANSLATIONS_IMPORT_OUTCOME_UNKNOWN` (exit 1), naming the chunk that may or may not have been
applied and published; a 429 stops it with `TRANSLATIONS_IMPORT_NOT_APPLIED` (exit 1), since that
chunk was not applied.

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

A **context** is one named operator profile for one site. It references two **separate**
credentials, each kept in the secret store and never printed: the theme dev token (`bcf_…`,
verified with `GET /api/dev/whoami`) and the v1 API key (`blcf_live_…`, verified with
`GET /api/v1/ping`). They stay two credentials with their own scopes — the CLI never merges them
into one token and never sends one to the other's endpoint. Both pairs of a context must resolve
to the same site (`TARGET_CREDENTIAL_MISMATCH`); a secret of the wrong type in either slot is
refused before any request (`TARGET_CREDENTIAL_WRONG_TYPE`, exit 1 — e.g. a `blcf_live_…` key in
`BLOCOFY_TOKEN`).

Every remote command verifies its site first and prints a `Target` block on stderr (`--json`:
the same as a `{"target":…}` line with `platform_origin`, `context_source`,
`context_overrides`, `command` and `mode`):

```
Target:    Alpha Bakery · s1a2b3 · alpha.myblocofy.com
Platform:  https://app.blocofy.com
Context:   alpha (from .blocofy/local.json)
Binding:   .blocofy/project.json
Operation: theme push · draft
```

The context is chosen in this order:

1. `--context <name>`
2. `BLOCOFY_CONTEXT`
3. env credentials (`BLOCOFY_URL` + `BLOCOFY_TOKEN` and/or `BLOCOFY_API_URL` + `BLOCOFY_API_KEY`)
4. `.blocofy/local.json` (the project's own context choice)
5. the one saved context matching the project's site
6. (terminal) pick from the matches
7. outside a project, and only for `status`, `target` and `pages check`: the `blocofy use` default

**Conflicts fail closed.** `BLOCOFY_CONTEXT`, the env credentials and `.blocofy/local.json` are
each a choice. When two of them name different contexts, the command is refused before
anything is read or written (`TARGET_CONTEXT_CONFLICT`, exit 3) — e.g. `BLOCOFY_URL`/
`BLOCOFY_TOKEN` exported in a shell that then runs inside a project whose `local.json` names a
context. Settle it with `--context <name>` (or unset the others); the `Context` line then lists
what it overrode, e.g. `alpha (from --context; overrides env credentials)`.

Inside a **bound project**, `blocofy use` is ignored — the project's binding decides, not the
global default context. Outside one, the `use` default serves only `status`, `target` and
`pages check`, and the `Context` line says so (`from default context (blocofy use)`); every other
command in an unbound directory needs `--context`, `BLOCOFY_CONTEXT` or env credentials, so a
`use` in another terminal never changes what a diff, dry run or plan compares against. Commands
that change a site (`theme push`/`publish`/`rename`, `theme dev` sync, `pages push`, `settings
push`, `pages media-decide`) need a bound project; a pull into a new empty directory binds it
automatically. A wrong project/site pairing changes nothing (`TARGET_SITE_MISMATCH` — pass
`--adopt` on `link` to rebind deliberately).

Every command resolves its binding from the directory it acts on — the `[dir]` argument (or
`--dir <dir>` for `theme rename` and `pages media-uses|media-decide`), else cwd.

**CI:** commit `.blocofy/project.json` (never `local.json`) and set the env pairs the job needs
(`BLOCOFY_URL` + `BLOCOFY_TOKEN` for theme/pages/settings, plus `BLOCOFY_API_URL` +
`BLOCOFY_API_KEY` for the v1 commands and `site plan`/`apply`). The env credentials are then the
only choice, and each command still verifies they belong to the committed binding's site.

A binding made against an older server has no recorded `platform_origin`: it still matches the
same site (one warning printed; run `blocofy link --adopt` to record it). A server that reports
no origin cannot serve a binding that records one — that refuses with `TARGET_UNVERIFIED` (the
server cannot prove it is the platform the binding was made against).

A refusal in this area (`TARGET_SITE_MISMATCH`, `TARGET_UNVERIFIED`, `TARGET_CREDENTIAL_MISMATCH`,
`TARGET_CONTEXT_CONFLICT`, `TARGET_CONTEXT_REQUIRED`, `TARGET_CONTEXT_UNKNOWN`,
`TARGET_BINDING_INVALID`, and `TARGET_CREDENTIAL_WRONG_TYPE` with exit 1) always means:
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
carries one `x-idempotency-key` per push). HTTP 500 is never retried, nor is a `theme push` dry
run answered 502 `readback_unverified` (a verdict on a rolled-back plan, not a transient failure).
`translations import --publish` is never retried either: a resend could not see what the first
attempt already published, so a failed chunk stops the command with
`TRANSLATIONS_IMPORT_OUTCOME_UNKNOWN` (5xx, network) or `TRANSLATIONS_IMPORT_NOT_APPLIED` (429).
Each retry prints a notice on stderr.

## Changelog

- **0.15.0** (next minor release; not published yet) — Theme space, theme work and human-approved
  publishing. Pairs with the platform release that replaces the 5-draft limit with a per-site theme
  space.
  - **Capacity refusals in plain words.** A theme write refused by the platform explains why in
    plain Turkish first, then prints the usual `error [code]` line (`--json`: the envelope only):
    - `quota_exceeded` (exit 2) is worded by `details.resource`. `theme_bytes`: the site's theme space
      is full — on any push, a push to an existing draft with `--instance` included. It shows used /
      allowance from `details`, says to free space by removing an unused draft or ending a theme work,
      or to contact support, and never suggests a plan upgrade or says "new draft" (theme space is not
      a plan quota). `theme_drafts` (the older draft-count limit, may still appear while sites move
      over) and `storage_mb` keep the plan message. The envelope carries the server's `details`.
    - `capacity_unavailable` / `resource_busy` (exit 1, after the usual retries that honour
      `Retry-After`; the envelope carries `retryAfterSeconds`): a temporary refusal, try again later.
      A 503 on the write is no longer reported as "outcome unknown" (the platform wrote nothing),
      unless an earlier attempt of the same push got no answer.
    - `source_stale` (exit 2): the live theme changed while a new draft was copied; run it again.
    - `theme dev` reports the same refusals in one line per save.
  - **`theme pull --draft` is read-only.** Help and README no longer claim it creates the draft. With
    no CLI draft the platform answers 404 `target_missing`; the CLI tells you to run
    `blocofy theme push --draft` first (exit 2, nothing written). The command still needs a bound
    project (kept for platforms from before this change).
  - **New: theme work.** `theme work start|status|resume|cancel` and `theme push --work <wk_…>`
    (v1 API key; see "Theme work"). A work is a private copy of the current live theme, named only by
    its handle; the handle is saved in `.blocofy/local.json`. A plain `theme push` is unchanged and
    never calls the work API.
  - **New: human-approved publishing.** `theme work seal` (prepare for review, asks for no approval)
    and `theme work request-approval [--open] [--wait [--interval <s>]]`: prints the approval URL (no
    token in it), optionally opens it, and `--wait` polls the status read-only — exit 0 when
    published, 2 when the request ends without a publication (`approval_stale`, `approval_expired`,
    `approval_declined`, `approval_superseded`, `work_cancelled`), 1 on `wait_timeout`. `theme work
    status` shows the publish status. The CLI never publishes a work.
  - Unchanged: retry classes, `draft_target_ambiguous` handling, idempotency keys, target guards and
    protocol headers.
- **0.14.0** — Draft commands no longer guess their draft (platform #989).
  - **Behaviour change:** `theme push` (draft), `theme push --diff`, `theme pull --draft` and the
    `theme dev` sync refuse, writing nothing, when the platform answers `draft_target_ambiguous` (or the
    site status shows the same case): the message lists the candidate drafts and the exact
    `--instance <handle>` command; exit code 2; never retried. A CLI draft you renamed is refused too.
  - The refusal pre-fills `--instance` only for a safe candidate (CLI-named, not a restore draft) and
    otherwise warns that naming a listed draft would overwrite it.
  - `theme dev --instance <handle>` and `theme push --draft --instance <handle>` write to a chosen draft
    (sent with `draft: true`; never the live theme).
  - `theme dev` reports a draft-sync failure in one line, also at startup (it was silent there):
    `draft_target_unverifiable` (the next save tries again) and `draft_target_is_live` (stops).
  - **Behaviour change:** `theme publish` without `--instance` uses the same rule; it never publishes
    a guessed draft.
  - **Behaviour change:** `--name X` creates the draft as `CLI Draft — X`; the rename advice after a
    reused draft is gone (a draft renamed by hand to another name is refused).
  - **Behaviour change (CI):** `theme push --instance <the live theme's handle>` asks for the same
    confirmation as `--live` (`--yes` in non-interactive shells); so does a handle the CLI cannot tell
    apart from the live theme (live theme unknown, or a raw numeric id).
  - `theme publish --instance <handle>` tells the platform the theme was named explicitly
    (`explicit: true`); the automatic pick sends no flag and the platform re-checks it. A theme that is
    not the site's CLI draft (a site-state restore draft, a renamed or panel-copied theme) is published
    through the CLI only with `--instance`; otherwise the platform refuses with
    `publish_target_unconfirmed` (exit 2, nothing published). Older CLIs get that refusal as a generic
    error and can never publish such a theme.
- **0.13.0** — Draft push names its target (customer items PS-22/PS-23/PS-26).
  - `theme push` (draft) prints the draft it wrote to — handle, name, new or existing — and
    `blocofy theme publish --instance <handle>`. When it updated the existing CLI draft, it says
    `--name` was not applied and prints the rename command.
  - **Behaviour change:** `theme push --diff` without `--live`/`--instance` now compares with the CLI
    draft the push writes to (found read-only via the site status, never provisioned), not with the
    live theme. With no CLI draft yet it says so and compares with live. Release it after the
    platform's PS-22 fix (uncached theme reads): before that fix a draft read could return its
    pre-push files for up to five minutes.
  - `theme dev` help no longer lists the retired live-domain and editor views.
  - `TARGET_BINDING_REQUIRED` also names `blocofy link <dir>` for env credentials.
- **0.12.0** — Translation packages (#925).
  - `blocofy translations export --locale <tag> --out <file> [--format json|xliff] [--only …]`
    writes every text of one language that needs translating to one JSON or XLIFF 1.2 file. It
    follows every export window and lists what the platform left out, by reason.
  - `blocofy translations import <file> [--dry-run] [--publish] [--on-source-change skip|apply]`
    reads a JSON or XLIFF package and imports it in chunks of at most 500 units (a page or record
    is never split, up to 5,000 units). It prints the count per state, what was published, and
    whether the site cache could not be refreshed. A chunk imported with `--publish` is never
    resent automatically: when it gets no definite answer the command stops with
    `TRANSLATIONS_IMPORT_OUTCOME_UNKNOWN` (a 429: `TRANSLATIONS_IMPORT_NOT_APPLIED`), exit 1, names
    the chunk, and running it again is safe. A run that stops part-way still prints the report of
    the chunks done before it.
  - `export` refuses an existing `--out` file unless `--force`.
- **0.11.0** — One named context per site, one explicit target (customer item 1.8).
  The dev token and the v1 API key remain two separate credentials; a context references both.
  - **Breaking:** conflicting context choices now fail closed. When `BLOCOFY_CONTEXT`, the env
    credentials (`BLOCOFY_URL`/`BLOCOFY_TOKEN`, `BLOCOFY_API_URL`/`BLOCOFY_API_KEY`) and a
    project's `.blocofy/local.json` name different contexts, the command stops with
    `TARGET_CONTEXT_CONFLICT` (exit 3) instead of silently taking the first. A shell that exports
    the env credentials inside a project with a `local.json` must pass `--context <name>` (or
    unset them). An explicit `--context` still wins, and the target block lists what it overrode.
  - **Breaking:** outside a bound project the `blocofy use` default is used only by `status`,
    `target` and `pages check` (as contract C2 specified). `theme push --diff/--dry-run`,
    `pages push --dry-run`, `site plan`, `theme dev --no-sync` and `pages media-uses` in an unbound
    directory now need `--context`, `BLOCOFY_CONTEXT` or env credentials
    (`TARGET_CONTEXT_REQUIRED`).
  - The target block shows the platform the site was verified on and where the context choice
    came from (`Platform:` line; `Context: <name> (from …)`); `--json` adds `platform_origin`,
    `context_source`, `context_overrides`, `command` and `mode`.
  - `theme publish [dir]` and `status [dir]` take the project directory as an argument, and
    `theme rename` / `pages media-uses|media-decide` take `--dir <dir>`. Before, they always used
    cwd, so `theme push ./a && theme publish` run from another project published that project's
    draft. A directory that does not exist, or one given where the command takes none (a second
    positional to `target`/`status`/`theme publish`, any directory positional to
    `pages media-uses|media-decide`), is a usage error (exit 1) before any request.
  - A secret of the wrong type (a `blcf_live_…` key as the dev token, a `bcf_…` token as the API
    key) is refused before any request with `TARGET_CREDENTIAL_WRONG_TYPE`, naming the variable
    or context — it was sent to the wrong endpoint and reported as `TARGET_UNVERIFIED`.
    `login --token blcf_…` points at `login --api-key`.
  - Theme push preflight bound to the write (customer item 6.5):
    - `theme push` checks the MERGED payload (local files plus the remote-only files it keeps) in its
      dry run, then writes exactly those files with the dry run's `manifestHash` and
      `expectedPointerVersion`, and — when the platform names it — the theme the dry run planned
      against (`expectedTargetInstance`; refused with `target_changed` if the target moved). The dry
      run carries its own throwaway idempotency key, so
      `--idempotency-key` retries of a committed push still converge.
    - A write resent after an attempt without an answer is reported as deployed when the platform
      had committed it. A refusal of such a resend says the earlier attempt's outcome is unknown (or
      that it was committed) instead of "Nothing was written", and `details.earlierAttempt` names it.
    - A write that gets no definite answer (a 5xx, a 503, `readback_unverified` with an unknown
      outcome, or no answer after the resends) is reported as an unknown outcome, not a failure: the
      message names this push's key, to run the same command again with `--idempotency-key <key>`
      (the platform then reports the committed deploy instead of writing it again); `--json` details
      carry `outcome: "unknown"` and `idempotencyKey`.
    - A `target_changed` refusal names the theme the dry run planned against and the current target,
      and says "Nothing was deployed" (a `--draft` push may have created a new, empty draft, which
      the next push reuses). After a write's `readback_unverified` the CLI points at
      `theme push --diff --instance <handle>` for the theme the write was bound to (or `blocofy status`
      for a new draft), not at a plain `--diff`, which compares with the live theme only.
    - Per-file outcomes are printed for the push and for `--dry-run`. `Deployed atomically` appears only
      with a verified readback. New refusals with messages: `pointer_version_conflict`,
      `site_state_version_conflict`, `manifest_mismatch`, `readback_unverified` (worded for the dry
      run, where nothing was written, or for the write; `details.phase` says which) and the preflight path
      errors (`path_too_long`, `reserved_path`, `binary_content_rejected`…, naming the file).
    - A push stops with `THEME_PUSH_TARGET_CHANGED` when the dry run would remove a file the push did
      not carry; the message says whether a re-run can keep it or only `--prune` gets past it, and
      `details.notCarryable` lists the paths the push cannot send. `--prune` lists them for
      confirmation instead. `--dry-run --prune` now plans the pruned set.
    - Against an older platform the write body is unchanged from 0.10.
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

It also continuously syncs your local files to a **draft theme**, so the same work can be opened
in the admin theme editor without affecting your published theme. Save a file and the local view
reloads. Publish the draft from the theme editor, or with `blocofy theme publish`, when you're ready.

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
