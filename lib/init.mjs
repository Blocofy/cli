import { randomBytes, randomUUID } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { hostname as osHostname } from "node:os";
import { join } from "node:path";

import { fetchWithRetry } from "./http.mjs";
import { CliRefusal } from "./media-uses.mjs";
import { writeBinding } from "./target.mjs";
import { pullTheme } from "./theme-sync.mjs";
import { saveWork } from "./theme-work.mjs";

/**
 * ADR-0014 §5.6 (wave P4) — `blocofy init [dir] [--site <handle|slug>]`: a new project directory with its own theme
 * work, a preview, and proof that the live site did not change.
 *
 * Pre-checks (no remote write): a missing/empty directory starts; one holding this CLI's own `init.json` resumes (same
 * site + platform only); a non-empty directory that is not ours is refused (INIT_DIR_NOT_EMPTY, nothing written); a
 * directory bound to another site/platform is refused (INIT_SITE_MISMATCH); a project bound by `link`/`pull` (no
 * `init.json`) is not taken over (INIT_ALREADY_BOUND).
 *
 * `.blocofy/init.json` (git-ignored, no secret, no preview link) records the steps:
 *   started → work_created → files_pulled → pinned → previewed
 * `init_key` is on disk BEFORE the first remote call and is the theme-work start's idempotency key (`init:<key>`), so
 * a timeout, a crash or a second run converges on the SAME work (057 replay). Each resume reads the work back from the
 * platform first: local state is never authority. `.blocofy/.init.lock` (O_EXCL, `{pid, hostname, acquired_at}`) lets
 * one init run per directory. Success = a preview link exists AND the live theme read back after it equals the one read
 * before the work started (`live_before`, kept across resumes). Nothing here deletes a live theme or another draft.
 */

export const INIT_STATES = ["started", "work_created", "files_pulled", "pinned", "previewed"];
export const INIT_INTENT = "blocofy init";
const PROJECT_DIR = ".blocofy";
const OUR_FILES = /^(init\.json|\.init\.lock|\.gitignore|\.init\.json\.[^/]+\.tmp)$/;
const INIT_LOCK_STALE_MS = 10 * 60_000;
const at = (s) => INIT_STATES.indexOf(s);

export class InitError extends Error {
  constructor(code, message, { details = {}, exitCode = 1, lines = [] } = {}) {
    super(message);
    this.name = "InitError";
    this.code = code;
    this.details = details;
    this.exitCode = exitCode;
    this.lines = lines;
  }
}

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const initPath = (dir) => join(dir, PROJECT_DIR, "init.json");
const lockPath = (dir) => join(dir, PROJECT_DIR, ".init.lock");

function readJson(p) {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return undefined;
  }
}

/** The saved init state, or null. A file that is not a valid state is INIT_STATE_INVALID (exit 3, nothing changed). */
export function readInitState(dir) {
  const p = initPath(dir);
  if (!existsSync(p)) return null;
  const s = readJson(p);
  if (!isObj(s) || s.schema_version !== 1 || typeof s.init_key !== "string" || !INIT_STATES.includes(s.state)) {
    throw new InitError("INIT_STATE_INVALID", `${p} is not a valid init state; nothing was changed. Fix it or start in a new, empty directory.`, { exitCode: 3, details: { path: p } });
  }
  return s;
}

function writeInitState(dir, state) {
  const d = join(dir, PROJECT_DIR);
  const st = lstatSync(d);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new InitError("INIT_DIR_INVALID", `${d} is not a real directory; nothing was written.`, { exitCode: 3 });
  const { schema_version: _v, updated_at: _u, ...rest } = state;
  const value = { schema_version: 1, ...rest, updated_at: new Date().toISOString() };
  const tmp = join(d, `.init.json.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o644 });
  renameSync(tmp, initPath(dir));
  return value;
}

/** `{ kind: "fresh" | "resume" | "dirty" | "legacy_project", init?, project? }` — read only. */
export function inspectInitDir(dir) {
  if (!existsSync(dir)) return { kind: "fresh" };
  if (!statSync(dir).isDirectory()) return { kind: "dirty" };
  const entries = readdirSync(dir);
  const project = existsSync(join(dir, PROJECT_DIR, "project.json")) ? readJson(join(dir, PROJECT_DIR, "project.json")) ?? null : null;
  if (existsSync(initPath(dir))) return { kind: "resume", init: readInitState(dir), project };
  if (project !== null || existsSync(join(dir, PROJECT_DIR, "project.json"))) return { kind: "legacy_project", project };
  const others = entries.filter((e) => e !== PROJECT_DIR);
  if (others.length > 0) return { kind: "dirty" };
  if (!entries.includes(PROJECT_DIR)) return { kind: "fresh" };
  const st = lstatSync(join(dir, PROJECT_DIR));
  if (st.isSymbolicLink() || !st.isDirectory()) return { kind: "dirty" };
  return readdirSync(join(dir, PROJECT_DIR)).every((f) => OUR_FILES.test(f)) ? { kind: "fresh" } : { kind: "dirty" };
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

/** One init per directory. A dead holder on this host, or a lock older than 10 minutes, is stale. */
function acquireInitLock(dir) {
  const p = lockPath(dir);
  const host = osHostname();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const mine = JSON.stringify({ pid: process.pid, hostname: host, acquired_at: new Date().toISOString() });
    try {
      const fd = openSync(p, "wx", 0o600);
      writeSync(fd, mine);
      closeSync(fd);
      return () => {
        try {
          if (readFileSync(p, "utf8") === mine) rmSync(p, { force: true });
        } catch {
          /* gone */
        }
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    const raw = (() => {
      try {
        return readFileSync(p, "utf8");
      } catch {
        return null;
      }
    })();
    const holder = raw ? readJson(p) : null;
    const age = holder && Number.isFinite(Date.parse(holder.acquired_at)) ? Date.now() - Date.parse(holder.acquired_at) : 0;
    const stale = raw !== null && (age > INIT_LOCK_STALE_MS || (holder?.hostname === host && Number.isInteger(holder?.pid) && !alive(holder.pid)));
    if (!stale) break;
    try {
      if (readFileSync(p, "utf8") === raw) rmSync(p, { force: true });
    } catch {
      /* gone */
    }
  }
  throw new InitError("INIT_IN_PROGRESS", `Another \`blocofy init\` is running in ${dir}. Nothing was sent by this one; wait for it to finish, then run the command again to see where it stands.`, { exitCode: 3, details: { lock: p } });
}

// ── the platform calls (v1 + the dev theme read) ─────────────────────────────────────────────────────────────

async function asJson(res) {
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (res.ok && isObj(json)) return json;
  if (res.status >= 400 && res.status < 500) {
    throw new CliRefusal(res.status, isObj(json?.error) ? json.error : { code: `http_${res.status}`, message: text.slice(0, 200) || `HTTP ${res.status}` });
  }
  throw Object.assign(new Error(`HTTP ${res.status}${json?.error?.message ? `: ${json.error.message}` : ""}`), { status: res.status, code: typeof json?.error?.code === "string" ? json.error.code : undefined });
}

/**
 * `token` (v1) and `devToken` (the theme read; default `token`) are credential strings or async getters (a CLI login
 * renews itself and uses one token for both). `timeoutMs` per attempt;
 * `retryBackoff` overrides the shared retry waits (tests).
 */
export function initApi({ apiUrl, devUrl, token, devToken = token, fetchImpl, timeoutMs = 30_000, retryBackoff, onRetry = null }) {
  const base = String(apiUrl).replace(/\/+$/, "");
  const resolveToken = async (t) => (typeof t === "function" ? await t() : t);
  const bearer = () => resolveToken(token);
  const opts = { fetchImpl, timeoutMs, onRetry, ...(retryBackoff ? { backoff: retryBackoff } : {}) };
  const call = async (method, path, { body, headers = {} } = {}) => {
    const h = { authorization: `Bearer ${await bearer()}`, accept: "application/json", ...headers };
    if (body !== undefined) h["content-type"] = "application/json";
    return asJson(await fetchWithRetry(`${base}${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }, opts));
  };
  return {
    siteStatus: () => call("GET", "/api/v1/site/status"),
    startWork: (key, intent) => call("POST", "/api/v1/theme-work", { body: { intent }, headers: { "idempotency-key": key } }),
    getWork: (handle) => call("GET", `/api/v1/theme-work/${encodeURIComponent(handle)}`),
    async listPages() {
      const pages = [];
      for (let page = 1; page <= 20; page += 1) {
        const r = await call("GET", `/api/v1/pages?limit=100&page=${page}`);
        const batch = Array.isArray(r.pages) ? r.pages : [];
        pages.push(...batch);
        if (batch.length < 100) break;
      }
      return pages;
    },
    createPreviewLink: (theme, page) => call("POST", `/api/v1/themes/${encodeURIComponent(theme)}/preview-links`, { body: { page } }),
    /** Newer platforms: the work's own preview link (the work theme's home page by default). */
    createWorkPreviewLink: (handle) => call("POST", `/api/v1/theme-work/${encodeURIComponent(handle)}/preview-links`, { body: {} }),
    async pullFiles(dir, instance) {
      if (!devUrl) throw new InitError("INIT_NO_DEV_ENDPOINT", "The site has no address for theme files yet (no domain), so init cannot download the work's theme. Nothing was written.");
      return pullTheme({ dir, url: devUrl, token: await resolveToken(devToken), instance, onRetry });
    },
  };
}

const liveId = (status) => (isObj(status?.live_theme_instance) ? status.live_theme_instance.id ?? null : null);

/** The preview page: the work theme's home page when it has one, else its first page with a plain address. */
function previewPage(pages, theme) {
  const own = pages.filter((p) => isObj(p) && String(p.theme_instance) === String(theme) && typeof p.slug === "string" && p.slug && !p.slug.includes("["));
  return own.find((p) => p.slug === "/" || p.slug === "index") ?? own[0] ?? null;
}

const sameSite = (a, siteId, origin) => String(a.site_id) === String(siteId) && (a.platform_origin ?? null) === (origin ?? null);

function definiteOrUnknown(error, what) {
  if (error instanceof CliRefusal) return error;
  return new InitError(
    "INIT_OUTCOME_UNKNOWN",
    `No definite answer from the platform while ${what} (${error?.message ?? "network error"}). Run \`blocofy init\` again in the same directory: it continues with the same init key, so a work that was started is found again, never started twice.`,
    { details: { status: error?.status ?? null } },
  );
}

/**
 * The state machine. `identity` = the credential's verified `{ site, platformOrigin }`; `api` = `initApi(...)` (or a
 * fake). Returns `{ state, work, previewUrl, preview, previewCreatedEarlier, liveBefore, liveAfter, liveUnchanged }`.
 * Throws InitError / CliRefusal; a refusal before the lock writes nothing.
 */
export async function runInit({ dir, identity, contextName, profile = null, api, log = () => {} }) {
  const siteId = identity.site.id;
  const origin = identity.platformOrigin ?? null;
  const pre = inspectInitDir(dir);
  const mismatch = (what) =>
    new InitError("INIT_SITE_MISMATCH", `${dir} belongs to ${what}; this login is for ${identity.site.slug ?? siteId}. Nothing was sent or written. Use another directory.`, { exitCode: 3, details: { dir } });
  if (pre.kind === "dirty") {
    throw new InitError("INIT_DIR_NOT_EMPTY", `${dir} is not empty and is not a Blocofy project. Nothing was written. Run \`blocofy init\` in a new, empty directory (init never overwrites files).`, { exitCode: 3, details: { dir } });
  }
  if (pre.kind === "legacy_project") {
    if (!isObj(pre.project) || !sameSite(pre.project, siteId, origin)) throw mismatch(`another site (${pre.project?.site_slug ?? pre.project?.site_id ?? "unreadable binding"})`);
    throw new InitError(
      "INIT_ALREADY_BOUND",
      `${dir} is already a project of this site (made by \`link\` or \`theme pull\`); init does not take it over. Nothing was written. Start a theme work there instead: blocofy theme work start ${dir}`,
      { exitCode: 3, details: { dir } },
    );
  }
  if (pre.kind === "resume") {
    if (!sameSite(pre.init, siteId, origin)) throw mismatch(`site ${pre.init.site_id} on ${pre.init.platform_origin ?? "an unknown platform"}`);
    if (pre.project !== null && (!isObj(pre.project) || !sameSite(pre.project, siteId, origin))) throw mismatch(`site ${pre.project?.site_slug ?? pre.project?.site_id ?? "?"}`);
  }

  mkdirSync(join(dir, PROJECT_DIR), { recursive: true });
  const release = acquireInitLock(dir);
  try {
    let s = readInitState(dir);
    if (s && !sameSite(s, siteId, origin)) throw mismatch(`site ${s.site_id}`);
    if (!s) {
      // The key is on disk before the first remote call; the git-ignore before anything else lands in the directory.
      writeFileSync(join(dir, PROJECT_DIR, ".gitignore"), "local.json\ninit.json\n", { mode: 0o644 });
      s = writeInitState(dir, { init_key: randomUUID(), site_id: siteId, platform_origin: origin, state: "started", work_handle: null, work_theme: null, live_before: null });
    }
    const save = (patch) => (s = writeInitState(dir, { ...s, ...patch }));

    if (!Object.prototype.hasOwnProperty.call(s, "live_before") || (s.live_before === null && s.state === "started")) {
      let status;
      try {
        status = await api.siteStatus();
      } catch (error) {
        throw definiteOrUnknown(error, "reading the live theme");
      }
      save({ live_before: liveId(status) });
    }

    let work = null;
    if (s.state === "started") {
      log("Tema çalışması başlatılıyor (canlı siten değişmez)…");
      let answer;
      try {
        answer = await api.startWork(`init:${s.init_key}`, INIT_INTENT);
      } catch (error) {
        const e = definiteOrUnknown(error, "starting the theme work");
        if (e instanceof CliRefusal && e.error?.code === "idempotency_key_reuse") {
          throw new InitError("idempotency_key_reuse", "The platform already used this init's key for a different request (idempotency_key_reuse); nothing new was started.", {
            exitCode: 2,
            lines: [
              "Bu init anahtarı platformda başka bir istekle kullanılmış; yeni bir çalışma başlatılmadı.",
              "  .blocofy/init.json dosyasını silip yeniden başlatma: yarım kalan çalışma bulunamaz ve ikinci bir çalışma açılır.",
              "  Bu dizini olduğu gibi bırak ve boş, yeni bir dizinde `blocofy init` çalıştır; eski çalışma panelde görünür.",
            ],
          });
        }
        throw e;
      }
      work = answer.work;
      if (!isObj(work) || typeof work.id !== "string" || typeof work.theme !== "string") throw new InitError("INIT_OUTCOME_UNKNOWN", "The platform's answer to the theme-work start has no work handle. Run `blocofy init` again in the same directory.");
      save({ state: "work_created", work_handle: work.id, work_theme: work.theme });
    } else {
      // Remote readback: the saved handle must still be this site's work.
      try {
        ({ work } = await api.getWork(s.work_handle));
      } catch (error) {
        if (error instanceof CliRefusal && (error.status === 404 || error.error?.code === "not_found")) {
          throw new InitError("INIT_WORK_MISSING", `The theme work this directory was set up with (${s.work_handle}) is not on the platform any more. Nothing was changed. Run \`blocofy init\` in a new, empty directory.`, { exitCode: 2, details: { work: s.work_handle } });
        }
        throw definiteOrUnknown(error, "reading the theme work back");
      }
      if (!isObj(work) || work.id !== s.work_handle) throw new InitError("INIT_WORK_MISSING", `The platform did not confirm the theme work ${s.work_handle}. Nothing was changed.`, { exitCode: 2 });
    }

    if (at(s.state) < at("files_pulled")) {
      log(`Çalışmanın tema dosyaları indiriliyor (${work.theme})…`);
      try {
        await api.pullFiles(dir, work.theme);
      } catch (error) {
        throw error instanceof InitError ? error : definiteOrUnknown(error, "downloading the work's theme files");
      }
      save({ state: "files_pulled" });
    }

    if (at(s.state) < at("pinned")) {
      writeBinding(dir, { site: identity.site, platformOrigin: origin, contextName, profile, ignore: ["local.json", "init.json"] });
      saveWork({ root: dir, project: { site_id: siteId } }, { ...work, intent: work.intent ?? INIT_INTENT });
      save({ state: "pinned" });
    }

    let previewUrl = null;
    let preview = at(s.state) >= at("previewed") ? "created_earlier" : null;
    if (at(s.state) < at("previewed")) {
      // Preferred: the work-level endpoint (the platform picks the work theme's home page). A platform without it
      // answers 404/405 (no write); then the page scan below.
      let link = null;
      let scan = true;
      if (typeof api.createWorkPreviewLink === "function") {
        try {
          link = await api.createWorkPreviewLink(work.id);
          scan = false;
        } catch (error) {
          if (!(error instanceof CliRefusal && (error.status === 404 || error.status === 405))) throw definiteOrUnknown(error, "creating the preview link");
        }
      }
      if (scan) {
        let pages;
        try {
          pages = await api.listPages();
        } catch (error) {
          throw definiteOrUnknown(error, "listing the work's pages");
        }
        const page = previewPage(pages, work.theme);
        if (page) {
          try {
            link = await api.createPreviewLink(work.theme, page.id);
          } catch (error) {
            throw definiteOrUnknown(error, "creating the preview link");
          }
        }
      }
      previewUrl = typeof link?.preview_link?.url === "string" ? link.preview_link.url : null;
      if (previewUrl) {
        preview = "created";
        save({ state: "previewed" });
      } else preview = link ? "no_link" : "no_page";
    }

    let after;
    try {
      after = await api.siteStatus();
    } catch (error) {
      throw definiteOrUnknown(error, "reading the live theme back");
    }
    const liveAfter = liveId(after);
    return {
      state: s.state,
      work,
      previewUrl,
      preview,
      previewCreatedEarlier: preview === "created_earlier",
      liveBefore: s.live_before ?? null,
      liveAfter,
      liveUnchanged: String(s.live_before ?? null) === String(liveAfter ?? null),
    };
  } finally {
    release();
  }
}
