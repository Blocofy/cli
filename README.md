# @blocofy/cli

Develop your [Blocofy](https://blocofy.com) theme locally against **live data**, see an
instant preview, and publish. The CLI does **not** build assets — generate them with your
own tools (npm/Vite/Tailwind); the platform serves plain Liquid + static assets.

```bash
npx @blocofy/cli login          # site URL + dev token (admin panel: Settings → Theme CLI tokens)
cd path/to/theme
npx @blocofy/cli theme dev       # http://localhost:3030 — local theme + live data, livereload
```

## Commands

```bash
blocofy login [--url <url>] [--token <bcf_…>]
                          # Save your platform URL + dev token (~/.blocofy/credentials.json, 0600).
blocofy theme dev [dir]   # Local dev server. Prints 3 views — local preview, a live-domain
                          # preview link, and the theme editor — all auto-reloading on save.
                          # --port <n> (default 3030), --no-sync (local preview only),
                          # --name <name> (name the draft when first created)
blocofy theme pull [dir]  # Download the live theme to disk.
blocofy theme push [dir]  # Write the local theme to a DRAFT by default (create/update; no
                          # delete) — preview & publish from the admin panel. --live writes
                          # to the live site immediately (asks to confirm; add --yes for CI).
                          # --name <name> names the new draft (draft mode only).
                          # --prune also removes target files deleted locally (lists them
                          # first; on the live theme asks to confirm — --yes for CI).
blocofy theme rename <handle> <new name>
                          # Rename a theme (label only). Works on any theme, live included.
                          # Handle from the panel theme card or `blocofy status`.
blocofy login --api-key [--api-url <url>]
                          # Save a v1 API key (blcf_live_…) for the `pages media-*` commands.
                          # The flag takes NO value: the key is typed into a hidden prompt, so
                          # it never lands in argv or shell history. Non-interactive shells use
                          # BLOCOFY_API_KEY + BLOCOFY_API_URL instead (no prompt, nothing
                          # written without them). --api-url defaults to https://app.blocofy.com.
blocofy pages media-uses <page-handle> [--json]
                          # List a page's localized-media decisions on its newest draft
                          # (v1 API, pages:read) with the draft revision id/version.
blocofy pages media-decide <page-handle> --decisions <file.json>
                          [--expected-revision-id <n> --expected-version <n>] [--json]
                          # Apply the file's { "decisions": [...] } (max 20) to the draft
                          # atomically (v1 API, pages:write). Without the --expected-* pair
                          # the CLI GETs the draft first and uses its current revision;
                          # items without idempotency_key get a random UUID. Exit 0 applied
                          # (or "No changes" when already recorded), 1 usage/auth/network/5xx
                          # (no retry), 2 server refusal (4xx) — {error} JSON on stderr.
blocofy pages pull [dir] [--strict]
                          # Download published pages, one folder per language:
                          # pages/<locale>/index.json and pages/<locale>/routes/<path>/index.json.
                          # Old-layout files are reported, never deleted or overwritten. If the site
                          # cannot export every page, nothing is written (PAGES_EXPORT_INCOMPLETE).
blocofy pages push [dir] [--dry-run] [--strict]
                          # Update EXISTING pages only. Every file is checked first; any invalid file,
                          # duplicate target or folder/locale mismatch changes NO page. An error after
                          # that check may leave some pages applied: the per-file result is printed,
                          # exit 1, and re-running is safe. --dry-run checks on the server, writes nothing.
blocofy pages check [dir] [--strict]
                          # Offline file/path/layout checks; with login also the server dry run.
blocofy pages migrate-layout [dir] [--dry-run | --write] [--strict]
                          # Move old-layout files (pages/<slug>.json) to language folders. Any
                          # ambiguity or conflict moves nothing (exit 1).
blocofy --version
blocofy --help
```

## Changelog

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

Credentials come from `~/.blocofy/credentials.json` (written by `blocofy login`) or the
`BLOCOFY_URL` + `BLOCOFY_TOKEN` environment variables (for CI/automation). The v1 API commands
(`pages media-uses`, `pages media-decide`) use a separate `blcf_live_…` key from the same file
(written by `blocofy login --api-key`) or `BLOCOFY_API_KEY` + `BLOCOFY_API_URL` — both variables
together; with only one set the CLI fails instead of falling back to the file.

## Theme structure

A theme is a directory of files grouped by top-level folder:

| Folder | Contents |
| --- | --- |
| `layout/` | Page shell (`theme.liquid`) |
| `section/` | Page sections (`Hero.liquid`, `FeaturedCards.liquid`, …) |
| `block/` | Repeatable pieces used inside sections |
| `partial/` | Shared snippets (header/footer, …) |
| `asset/` | CSS and static files (`theme.css`) |
| `pages/<locale>/index.json`, `pages/<locale>/routes/<path>/index.json` | Page content, one folder per language (`blocofy pages pull/push/check/migrate-layout`). The old `pages/<slug>.json` layout is still read, with a warning |
| `config/settings.json` | Theme settings + color schemes |
| `config/settings_schema.json` | Theme settings panel schema (synced with `pull`/`push`) |

Liquid templates use the `.liquid` extension; files under `asset/` are served as-is.

## Development

Zero runtime dependencies (Node built-ins only). Run the tests with:

```bash
node --test
```

Requires Node ≥ 18.

## License

[MIT](./LICENSE)
