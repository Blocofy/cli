import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  PagesCliError,
  checkLocalBatch,
  folderConflicts,
  classifyPageFile,
  collectPageFiles,
  pageFileSemanticKey,
  pageFilePath,
  resolveContained,
  serializeV2PageFile,
  stagedWrite,
} from "./page-files.mjs";
import { fetchWithRetry } from "./http.mjs";
import { checkRelativePagePath, parsePageFilePath } from "./page-path-codec.mjs";

/**
 * `blocofy pages pull/push/check/migrate-layout` + `settings pull/push` (#119, PS-19). Page files use the
 * locale-aware layout (`pages/<locale>/index.json`, `pages/<locale>/routes/…/index.json`); the platform's
 * `/api/dev/content` protocol v2 is required for every page operation. Tema KODU `theme pull/push`'a gider.
 * Güvenlik platformda: push yalnız mevcut sayfayı günceller, yeni oluşturmaz, silmez.
 *
 * CF-T3: every request goes through `fetchWithRetry` (lib/http.mjs). Reads are safe to resend; a settings push is an
 * upsert; a pages push carries one `x-idempotency-key` per push operation, resent unchanged on every retry, and the
 * server treats a re-sent, already-applied page as `unchanged`.
 */

export const PAGES_PROTOCOL_VERSION = 2;

async function errorText(res) {
  const text = await res.text();
  try {
    return JSON.parse(text).error ?? text;
  } catch {
    return text;
  }
}

const baseOf = (url) => url.replace(/\/+$/, "");

/** scope "pages" → pages/**.json (lexical order, no symlinks); "settings" → config/settings.json. `{path: content}`. */
export function readContentFiles(dir, scope) {
  const out = {};
  if (scope === "settings") {
    const p = join(dir, "config", "settings.json");
    if (existsSync(p)) out["config/settings.json"] = readFileSync(p, "utf8");
    return out;
  }
  const { files, errors } = collectPageFiles(dir);
  if (errors.length > 0) throw new PagesCliError(errors[0].code, "Local page files cannot be read safely; nothing was sent.", { diagnostics: errors });
  for (const [path, content] of files) out[path] = content;
  return out;
}

/**
 * The server's page capabilities, or `PAGES_SERVER_UPGRADE_REQUIRED`. An old server answers `scope=capabilities`
 * as a full export without `protocol_version`; nothing is written either way.
 */
export async function probePagesServer({ url, token, onRetry = null }) {
  const res = await fetchWithRetry(`${baseOf(url)}/api/dev/content?scope=capabilities`, { headers: { authorization: `Bearer ${token}` } }, { onRetry });
  if (!res.ok) throw Object.assign(new Error(await errorText(res)), { status: res.status });
  const body = await res.json().catch(() => null);
  if (body?.protocol_version !== PAGES_PROTOCOL_VERSION) {
    throw new PagesCliError(
      "PAGES_SERVER_UPGRADE_REQUIRED",
      "This site's server does not support locale-aware page files yet. Nothing was changed; update the platform or use an older CLI.",
    );
  }
  return {
    defaultLocale: body.default_locale,
    supportedLocales: body.supported_locales ?? [],
    // CF-T3 — base_revision / expected_plan_hash / force are only sent to a server that says it checks them.
    revisionCas: body.page_revision_cas === 1 && body.plan_hash === 1,
  };
}

/** Site içeriğini diske çek (pull). Pages require protocol v2; every path is contained and staged. */
export async function pullContent({ dir, url, token, scope, writeFile, onRetry = null }) {
  const res = await fetchWithRetry(`${baseOf(url)}/api/dev/content?scope=${encodeURIComponent(scope)}`, {
    headers: { authorization: `Bearer ${token}` },
  }, { onRetry });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    // Nothing is written on a non-2xx: an incomplete export (PAGES_EXPORT_INCOMPLETE) carries every finding and no files.
    throw new PagesCliError(body?.code ?? "PAGES_PULL_FAILED", body?.error ?? `Pull failed (HTTP ${res.status}); nothing was written.`, {
      status: res.status,
      diagnostics: Array.isArray(body?.diagnostics) ? body.diagnostics : [],
    });
  }
  const files = body?.files ?? {};
  const wantsPages = scope !== "settings";
  if (wantsPages && body?.protocol_version !== PAGES_PROTOCOL_VERSION) {
    throw new PagesCliError(
      "PAGES_SERVER_UPGRADE_REQUIRED",
      "This site's server still uses the old page layout, which cannot keep languages apart. Nothing was written.",
    );
  }

  const diagnostics = [...(body?.diagnostics ?? [])];
  const errors = [];
  const entries = [];
  for (const path of Object.keys(files).sort()) {
    const content = files[path];
    if (path === "config/settings.json" && scope !== "pages") {
      entries.push([path, content]);
      continue;
    }
    const unsafe = checkRelativePagePath(path);
    const parsed = unsafe ? null : parsePageFilePath(path);
    if (unsafe || !parsed || (parsed.kind !== "canonical" && parsed.kind !== "hashed") || !wantsPages) {
      errors.push({ level: "error", code: unsafe?.code ?? "PAGES_INVALID_PATH", message: `server sent an unexpected path (${unsafe?.reason ?? "not a canonical page path"})`, path });
      continue;
    }
    const c = classifyPageFile(path, typeof content === "string" ? content : "", {});
    if (!c.ok || c.layout !== "v2") {
      errors.push({ level: "error", code: c.ok ? "PAGES_INVALID_PATH" : c.code, message: `server sent a page file that does not match its path (${c.ok ? "legacy payload" : c.message})`, path });
      continue;
    }
    entries.push([path, content]);
  }
  if (errors.length > 0) throw new PagesCliError(errors[0].code, "The server response failed validation; nothing was written.", { diagnostics: errors });

  // Local files this pull does not own: reported, never deleted or overwritten.
  if (wantsPages && existsSync(dir)) {
    const local = collectPageFiles(dir);
    for (const e of local.errors) diagnostics.push({ ...e, level: "warning" });
    const remote = new Set(Object.keys(files));
    for (const [path, content] of local.files) {
      if (remote.has(path)) continue;
      const c = classifyPageFile(path, content, { defaultLocale: body.default_locale });
      if (c.ok && c.layout === "legacy") {
        diagnostics.push({
          level: "warning",
          code: "PAGES_STALE_LEGACY_FILE",
          message: `${path} was not written by this pull. Canonical replacement: ${pageFilePath(c.locale, c.slug)}`,
          path,
          locale: c.locale,
          slug: c.slug,
        });
      } else {
        diagnostics.push({ level: "warning", code: "PAGES_STALE_FILE", message: `${path} is not on the site and was not written by this pull.`, path });
      }
    }
  }

  const count = stagedWrite(fsRoot(dir), entries, writeFile ? { writeFile } : {});
  return { count, diagnostics, defaultLocale: body?.default_locale ?? null };
}

function fsRoot(dir) {
  mkdirSync(dir, { recursive: true });
  return collectPageFiles(dir).root;
}

/** CF-T3 — the most a `--force` reason may be (the platform's FORCE_REASON_MAX). */
export const FORCE_REASON_MAX = 500;

/** CF-T3 — paths of `forced`, whether the server lists strings or `{path, base_revision, current_revision}` objects. */
export function forcedPaths(forced) {
  return (Array.isArray(forced) ? forced : []).map((f) => (typeof f === "string" ? f : f?.path)).filter((p) => typeof p === "string");
}

function pushRefusal(res, body, fallback) {
  return new PagesCliError(body?.code ?? "PAGES_PUSH_FAILED", body?.error ?? fallback, {
    diagnostics: body?.diagnostics ?? [],
    pages: body?.pages ?? null,
    status: res.status,
  });
}

/**
 * Push. `settings` keeps the v1 body. `pages`: server capability probe → local preflight (nothing is sent on a
 * local error) → `POST {protocol_version: 2, dry_run, files}`. The server preflights the whole batch again and
 * writes nothing unless every file passes.
 *
 * CF-T3 (contract C4) — on a server advertising `page_revision_cas` a push is two requests: a dry run (the plan,
 * handed to `onPlan` before anything is written), then the real push carrying the plan's `expected_plan_hash` and the
 * push's `x-idempotency-key`. A refused dry run (a stale file, a file without base_revision) throws and nothing else is
 * sent; a plan that no longer holds at push time is 409 `PAGES_PLAN_STALE`. `force` + `forceReason` travel on both
 * requests. An older server gets exactly the old single request (no CAS fields); `onServer(server)` lets the caller warn.
 */
export async function pushContent({ dir, url, token, scope, instance = null, dryRun = false, idempotencyKey = null, onRetry = null, force = false, forceReason = null, onServer = null, onPlan = null }) {
  const base = baseOf(url);
  if (scope === "settings") {
    const files = readContentFiles(dir, scope);
    // T10.1 — an older server ignores `instance` and would write the LIVE theme: send it only to a server that says
    // it honours it (scope=capabilities `settings_instance: 1`); otherwise refuse before anything is sent.
    if (instance) {
      const res = await fetchWithRetry(`${base}/api/dev/content?scope=capabilities`, { headers: { authorization: `Bearer ${token}` } }, { onRetry });
      if (!res.ok) throw Object.assign(new Error(await errorText(res)), { status: res.status });
      const caps = await res.json().catch(() => null);
      if (caps?.protocol_version !== PAGES_PROTOCOL_VERSION || caps?.settings_instance !== 1) {
        throw new PagesCliError(
          "SETTINGS_INSTANCE_UNSUPPORTED",
          "This site's server cannot target a theme with `settings push --instance` (it would write the live theme instead). Nothing was sent; update the platform or push with --live.",
        );
      }
    }
    const res = await fetchWithRetry(`${base}/api/dev/content`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(instance ? { files, instance } : { files }),
    }, { onRetry });
    if (!res.ok) {
      const text = await res.text();
      let body = null;
      try {
        body = JSON.parse(text);
      } catch {
        /* plain-text body */
      }
      const error = Object.assign(new Error(body?.error ?? text), { status: res.status });
      if (typeof body?.code === "string") error.code = body.code;
      throw error;
    }
    return { ...(await res.json()), fileCount: Object.keys(files).length };
  }

  const server = await probePagesServer({ url, token, onRetry });
  onServer?.(server);
  const { files: local, errors } = collectPageFiles(dir);
  if (errors.length > 0) throw new PagesCliError(errors[0].code, "Local page files cannot be read safely; nothing was sent.", { diagnostics: errors });
  const localDiagnostics = checkLocalBatch(local.map(([p, c]) => classifyPageFile(p, c, server)));
  const localErrors = localDiagnostics.filter((d) => d.level === "error");
  if (localErrors.length > 0) {
    throw new PagesCliError(localErrors[0].code, "Preflight failed locally; no pages were sent or changed.", { diagnostics: localDiagnostics });
  }

  const files = {};
  for (const [path, content] of local) files[path] = content;
  // One key per push operation: every transport retry resends this exact request (same key, same body).
  const key = idempotencyKey ?? `cli-${randomUUID()}`;
  const post = (payload, withKey) =>
    fetchWithRetry(`${base}/api/dev/content`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...(withKey ? { "x-idempotency-key": key } : {}) },
      body: JSON.stringify({ protocol_version: PAGES_PROTOCOL_VERSION, ...payload, files }),
    }, { onRetry });

  if (!server.revisionCas) {
    const res = await post({ dry_run: dryRun }, true);
    const body = await res.json().catch(() => null);
    if (!res.ok || body?.ok !== true) throw pushRefusal(res, body, `Push failed (HTTP ${res.status}).`);
    return { ...body, fileCount: local.length, revisionCas: false };
  }

  const forceFields = force ? { force: true, force_reason: forceReason } : {};
  const planRes = await post({ dry_run: true, ...forceFields }, false);
  const plan = await planRes.json().catch(() => null);
  if (!planRes.ok || plan?.ok !== true) {
    const error = pushRefusal(planRes, plan, `Push plan failed (HTTP ${planRes.status}); nothing was changed.`);
    if (error.code === "PAGES_REVISION_CONFLICT" || error.code === "PAGES_BASE_REVISION_REQUIRED") {
      const stale = error.diagnostics.filter((d) => d.code === "PAGES_REVISION_CONFLICT" || d.code === "PAGES_BASE_REVISION_REQUIRED").length;
      error.message =
        `${stale} page file(s) no longer describe the page on the site (changed since you pulled, or no base_revision); nothing was pushed or changed. ` +
        "Run `blocofy pages pull` to refresh, or `--force --reason <text>` to overwrite.";
    }
    throw error;
  }
  if (typeof plan.plan_hash !== "string") {
    throw new PagesCliError("PAGES_PUSH_FAILED", "The server's plan has no plan_hash; nothing was changed.", { status: planRes.status });
  }
  onPlan?.(plan);
  if (dryRun) return { ...plan, fileCount: local.length, revisionCas: true };

  const res = await post({ dry_run: false, expected_plan_hash: plan.plan_hash, ...forceFields }, true);
  const body = await res.json().catch(() => null);
  if (!res.ok || body?.ok !== true) {
    const error = pushRefusal(res, body, `Push failed (HTTP ${res.status}).`);
    if (error.code === "PAGES_PLAN_STALE") {
      error.message = "The site changed between the plan and the push; no pages were changed. Run the push again to review the new plan.";
    }
    throw error;
  }
  return { ...body, fileCount: local.length, revisionCas: true };
}

/**
 * `pages check`. Offline: path, JSON, format, layout and local duplicates. With `server` credentials it also
 * resolves the default/supported locales and asks the server for a dry-run preflight (targets, documents).
 */
export async function checkPages({ dir, url, token, onRetry = null }) {
  const { files: local, errors } = collectPageFiles(dir);
  const diagnostics = [...errors];
  let server = null;
  if (url && token) server = await probePagesServer({ url, token, onRetry });
  const classified = local.map(([p, c]) => classifyPageFile(p, c, server ?? {}));
  diagnostics.push(...checkLocalBatch(classified));
  // CF-T3 — a v2 file without base_revision will be refused by a revision-checking server; say so before the push.
  // Not on an older server: it never stamps the field, so the warning could never be fixed there.
  if (!server || server.revisionCas) {
    for (const c of classified) {
      if (c.ok && c.layout === "v2" && c.parsed.base_revision == null) {
        diagnostics.push({ level: "warning", code: "PAGES_BASE_REVISION_MISSING", message: "no base_revision: the site cannot tell whether this page changed since you pulled it, so a push will be refused. Run `blocofy pages pull` to refresh the file (or push with --force --reason <text>).", path: c.path, locale: c.locale, slug: c.slug });
      }
    }
  }

  let plan = null;
  if (server && !diagnostics.some((d) => d.level === "error")) {
    try {
      plan = await pushContent({ dir, url, token, scope: "pages", dryRun: true, onRetry });
      for (const d of plan.diagnostics ?? []) {
        if (!diagnostics.some((x) => x.code === d.code && x.path === d.path)) diagnostics.push(d);
      }
    } catch (error) {
      if (!(error instanceof PagesCliError)) throw error;
      diagnostics.push(...(error.diagnostics.length ? error.diagnostics : [{ level: "error", code: error.code, message: error.message }]));
    }
  }
  return { fileCount: local.length, diagnostics, plan, online: Boolean(server) };
}

/**
 * `pages migrate-layout`. Plans a move for every legacy file whose (locale, slug) is proven, and refuses the
 * whole migration — zero moves — on any error or ambiguity. `write: true` rewrites each file as v2 at its
 * canonical path (contained, staged per file, verified) and only then removes the legacy file.
 */
export async function migrateLayout({ dir, url, token, write = false, onRetry = null }) {
  const { root, files: local, errors } = collectPageFiles(dir);
  const diagnostics = [...errors];
  const needsDefault = local.some(([, c]) => {
    try {
      const j = JSON.parse(c);
      return j && typeof j === "object" && !("format_version" in j) && !("locale" in j);
    } catch {
      return false;
    }
  });
  let server = null;
  if (url && token) server = await probePagesServer({ url, token, onRetry });

  const classified = local.map(([p, c]) => classifyPageFile(p, c, server ?? {}));
  diagnostics.push(...checkLocalBatch(classified).filter((d) => d.code !== "PAGES_LEGACY_LAYOUT"));
  if (needsDefault && !server) {
    for (const c of classified) {
      if (c.ok && c.localeSource === "unresolved") {
        diagnostics.push({ level: "error", code: "PAGES_AMBIGUOUS_LAYOUT", message: "file has no locale and the site's default language is unknown offline; log in (blocofy login) or add \"locale\" to the file", path: c.path, slug: c.slug });
      }
    }
  }

  const byPath = new Map(classified.filter((c) => c.ok).map((c) => [c.path, c]));
  const moves = [];
  const claimed = new Map();
  for (const c of classified) {
    if (!c.ok || c.layout !== "legacy" || !c.locale) continue;
    const to = pageFilePath(c.locale, c.slug);
    const existing = byPath.get(to);
    if (existing) {
      if (pageFileSemanticKey(existing.parsed) === pageFileSemanticKey(c.parsed)) {
        diagnostics.push({ level: "warning", code: "PAGES_DUPLICATE_EQUIVALENT", message: `${to} already holds the same content; ${c.path} was left in place (remove it yourself)`, path: c.path, locale: c.locale, slug: c.slug });
        continue;
      }
      // checkLocalBatch has already reported the conflicting pair as PAGES_DUPLICATE_TARGET.
      continue;
    }
    if (claimed.has(to)) {
      diagnostics.push({ level: "error", code: "PAGES_DUPLICATE_TARGET", message: `${c.path} and ${claimed.get(to)} both move to ${to}`, path: c.path, locale: c.locale, slug: c.slug });
      continue;
    }
    claimed.set(to, c.path);
    moves.push({ from: c.path, to, locale: c.locale, slug: c.slug, content: serializeV2PageFile(c.parsed, c.locale) });
  }
  moves.sort((a, b) => (a.from < b.from ? -1 : 1));
  const remaining = local.map(([p]) => p).filter((p) => !moves.some((m) => m.from === p));
  diagnostics.push(...folderConflicts([...remaining, ...moves.map((m) => m.to)]));

  const refused = diagnostics.some((d) => d.level === "error");
  if (!write || refused) return { moves, moved: 0, diagnostics, refused };

  // Every target validated before the first move.
  for (const m of moves) {
    const r = resolveContained(root, m.to);
    if (r.error) {
      diagnostics.push({ level: "error", code: r.error.code, message: r.error.reason, path: m.to });
      return { moves, moved: 0, diagnostics, refused: true };
    }
    if (existsSync(r.target)) {
      diagnostics.push({ level: "error", code: "PAGES_DUPLICATE_TARGET", message: "target appeared during migration", path: m.to });
      return { moves, moved: 0, diagnostics, refused: true };
    }
  }
  let moved = 0;
  for (const m of moves) {
    const verify = classifyPageFile(m.to, m.content, { defaultLocale: m.locale });
    if (!verify.ok || verify.layout !== "v2") throw new PagesCliError("PAGES_INVALID_PATH", `internal: ${m.to} would not be a valid v2 file; stopped after ${moved} move(s).`);
    const resolved = resolveContained(root, m.to);
    if (resolved.error) throw new PagesCliError(resolved.error.code, `${m.to}: ${resolved.error.reason}; stopped after ${moved} move(s).`);
    const { target } = resolved;
    mkdirSync(dirname(target), { recursive: true });
    const temp = `${target}.blocofy-tmp`;
    writeFileSync(temp, m.content, { flag: "wx" });
    renameSync(temp, target);
    const legacy = resolveContained(root, m.from);
    if (legacy.error) throw new PagesCliError(legacy.error.code, `${m.from}: ${legacy.error.reason}; stopped after ${moved} move(s).`);
    rmSync(legacy.target);
    moved += 1;
  }
  return { moves, moved, diagnostics, refused: false };
}
