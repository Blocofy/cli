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
                          # --port <n> (default 3030), --no-sync (local preview only)
blocofy theme pull [dir]  # Download the live theme to disk.
blocofy theme push [dir]  # Write the local theme to the live site (create/update; no delete).
blocofy --version
blocofy --help
```

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
`BLOCOFY_URL` + `BLOCOFY_TOKEN` environment variables (for CI/automation).

## Theme structure

A theme is a directory of files grouped by top-level folder:

| Folder | Contents |
| --- | --- |
| `layout/` | Page shell (`theme.liquid`) |
| `section/` | Page sections (`Hero.liquid`, `FeaturedCards.liquid`, …) |
| `block/` | Repeatable pieces used inside sections |
| `partial/` | Shared snippets (header/footer, …) |
| `asset/` | CSS and static files (`theme.css`) |
| `pages/<slug>.json` | Page content (`/` → `pages/index.json`) |
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
