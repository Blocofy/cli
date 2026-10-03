import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";

import { THEME_DIRS, localPathFor, readLocalTemplates } from "./local-theme.mjs";
import { fetchWithRetry } from "./http.mjs";
import { PagesCliError, stagedWrite } from "./page-files.mjs";

/**
 * `blocofy theme pull/push`. Talks to the platform's `/api/dev/theme` endpoint
 * (Bearer token). pull = GET → write to disk (re-adding `.liquid`); push =
 * readLocalTemplates → POST (create/update; no delete).
 *
 * CF-T3: every request goes through `fetchWithRetry` (lib/http.mjs — 429/502/503/504 + network errors, Retry-After).
 * All are safe to resend: reads, a keyed (or naturally idempotent upsert) theme POST, publish (sets a pointer),
 * rename (sets a label). `onRetry` surfaces each retry on stderr.
 */

/**
 * M4 canonical source-write handshake. We declare the protocol version + the full canonical-write
 * capability set; the server is authoritative and fences an under-declaring client (a NEW CLI against an
 * OLD server just sees the headers ignored — forward compatible). Capabilities must match the server's
 * CANONICAL_WRITE_CAPABILITIES exactly, in order.
 */
const CANONICAL_PROTOCOL = "1";
const CANONICAL_CAPABILITIES = "validate,dry-run,diff,idempotency-key,target-instance";

/**
 * CF-T5 review I1 — OPTIONAL capabilities (never part of the required fence above). `theme-locales`: this CLI sends the
 * workspace's `locales/*` files, so a canonical deploy may replace `locales/` like any other theme folder (a server
 * that sees no declaration keeps stored locale rows). Sent on every theme POST; GETs don't need it.
 */
const OPTIONAL_CAPABILITIES = "theme-locales";

function canonicalHeaders(extra = {}) {
  return { "x-blocofy-protocol": CANONICAL_PROTOCOL, "x-blocofy-capabilities": CANONICAL_CAPABILITIES, ...extra };
}

async function errorText(res) {
  const text = await res.text();
  try {
    const parsed = JSON.parse(text).error;
    if (parsed) return parsed;
  } catch {
    /* JSON değil — ham metne düş */
  }
  // İçeriksiz yanıt (ör. 410 tombstone) boş dize döndürüp `Error("")` üretiyordu; kullanıcı
  // `unavailable ()` görüyordu. Gövde yoksa statü tek teşhis kaynağıdır — onu taşı.
  return text || `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`;
}

/** `errorText` as an Error that keeps the HTTP status (exit codes: 4xx → 2, 5xx → 1). */
async function responseError(res) {
  if (res.status === 409) {
    // #989: keep `reason`/`candidates` (errorText keeps only `error`). Read from a clone so the fallback below still can.
    const body = await res.clone().json().catch(() => null);
    if (body?.error === DRAFT_TARGET_AMBIGUOUS) return withDraftTargetDetails(Object.assign(new Error(DRAFT_TARGET_AMBIGUOUS), { status: 409, code: DRAFT_TARGET_AMBIGUOUS }), body);
  }
  const detail = await errorText(res);
  const err = new Error(typeof detail === "string" ? detail : detail?.message ?? JSON.stringify(detail));
  err.status = res.status;
  if (typeof detail === "object" && detail && typeof detail.code === "string") err.code = detail.code;
  else if (typeof detail === "string" && /^[a-z][a-z0-9_]*$/.test(detail)) err.code = detail;
  return err;
}

/**
 * Yapılandırılmış HTTP hatası (0.5.0): mesajın yanında `code` (sunucunun `error` alanı), `status` ve tam
 * `body` taşınır — 426 `cli_upgrade_required` (fence.missing/requiredVersion) ve 409 `idempotency_conflict`
 * için insan-dili mesajı ÇAĞIRAN kurar; buradaki throw yalnız veriyi kaybetmeden taşır.
 */
async function httpError(res) {
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* düz metin gövde */
  }
  const err = new Error(typeof body?.error === "string" ? body.error : text || `HTTP ${res.status}`);
  err.status = res.status;
  err.code = typeof body?.error === "string" ? body.error : null;
  err.body = body;
  return withDraftTargetDetails(err, body);
}

/**
 * #989 — the platform refuses to GUESS which draft a draft push / `pull --draft` / `theme dev` sync writes to when it
 * cannot prove the draft is the CLI's: more than one candidate draft, a site-state restore draft, or a single draft
 * without the platform-generated "CLI Draft" name (a renamed CLI draft included). 409 `draft_target_ambiguous` with
 * `reason` and `candidates` [{instance, name}]; nothing was written. The way through is an explicit `--instance`.
 */
export const DRAFT_TARGET_AMBIGUOUS = "draft_target_ambiguous";
/**
 * The platform-generated CLI draft name — the server's TEMPORARY compatibility filter (never proof of ownership):
 * "CLI Draft", "CLI Draft — <date>" or "CLI Draft — <name>" (what a push with `--name <name>` creates).
 */
const CLI_DRAFT_NAME = /^CLI Draft( — .+)?$/;
/** The name the platform gives a draft a push creates with `--name` (mirror of the server's `cliDraftName`). */
export function cliDraftName(name) {
  const clean = String(name ?? "").trim().slice(0, 100);
  if (!clean) return null;
  return CLI_DRAFT_NAME.test(clean) ? clean : `CLI Draft — ${clean}`;
}
/** The name a site-state restore gives the draft it builds (`Site State · <12 hex>`). */
const SITE_STATE_DRAFT_NAME = /^Site State · [0-9a-f]{12}$/;

function withDraftTargetDetails(err, body) {
  if (err.code !== DRAFT_TARGET_AMBIGUOUS) return err;
  err.reason = typeof body?.reason === "string" ? body.reason : null;
  err.candidates = Array.isArray(body?.candidates)
    ? body.candidates
        .filter((c) => c && typeof c.instance === "string")
        .map((c) => ({ instance: c.instance, name: typeof c.name === "string" ? c.name : null, ...(typeof c.restore === "boolean" ? { restore: c.restore } : {}) }))
    : [];
  // The server names the one candidate safe to suggest (CLI-named, not a restore draft), or null for none.
  if (body && "suggestedInstance" in body) err.suggestedInstance = typeof body.suggestedInstance === "string" ? body.suggestedInstance : null;
  return err;
}

/** A candidate that is a site-state restore draft — the server's flag, else its `Site State · …` name. */
const isRestore = (c) => c.restore === true || SITE_STATE_DRAFT_NAME.test(c.name ?? "");

/** A local #989 refusal with the server's shape (used where the CLI selects the draft itself, e.g. `push --diff`). */
function draftTargetAmbiguous(reason, candidates) {
  for (const c of candidates) c.restore = SITE_STATE_DRAFT_NAME.test(c.name ?? "");
  return Object.assign(new Error(DRAFT_TARGET_AMBIGUOUS), { code: DRAFT_TARGET_AMBIGUOUS, status: 409, reason, candidates });
}

/**
 * The human message for a #989 refusal: why, which drafts, and how to go on. `command` is the command line to repeat
 * with `--instance <handle>` (e.g. "blocofy theme push ./shop"); `action` is what that command would do to the draft
 * ("write" or "publish").
 *
 * #989 review P1 — `--instance` is pre-filled ONLY with a candidate that is CLI-named and not a site-state restore
 * draft (the server's `suggestedInstance` when it sends one). Otherwise the command keeps the `<handle>` placeholder,
 * the message warns that naming a listed draft would OVERWRITE (or publish) it, and names the safe ways forward.
 *
 * `earlierAttempt` (review P3, a keyed apply resent after an attempt without a certain answer): this refusal wrote
 * nothing, but the earlier attempt may have — the message says so instead of "Nothing was written".
 */
export function draftTargetAmbiguousMessage(error, { command = "blocofy theme push", action = "write", earlierAttempt = null } = {}) {
  const candidates = Array.isArray(error?.candidates) ? error.candidates : [];
  const why =
    error?.reason === "multiple_candidates"
      ? "this site has more than one draft theme that could be the CLI draft"
      : error?.reason === "site_state_restore"
        ? "a candidate draft belongs to a site-state restore"
        : error?.reason === "unrecognized_name"
          ? 'the only draft it could pick is not named "CLI Draft — …" (it may not be the CLI\'s draft; a draft renamed by hand is refused too)'
          : "it cannot tell which draft is the CLI draft";
  const safe =
    error?.suggestedInstance !== undefined
      ? candidates.find((c) => c.instance === error.suggestedInstance) ?? null
      : candidates.find((c) => !isRestore(c) && CLI_DRAFT_NAME.test(c.name ?? "")) ?? null;
  const unsafe = candidates.filter((c) => c !== safe);
  const done =
    earlierAttempt === "committed"
      ? "This attempt wrote nothing, but an earlier attempt of this push was committed (its answer said so)."
      : earlierAttempt === "unknown"
        ? "This attempt wrote nothing, but an earlier attempt of this push got no answer, so whether it wrote is unknown."
        : action === "publish"
          ? "Nothing was published."
          : "Nothing was written.";
  const lines = [`✗ Refused to pick a draft automatically: ${why}. ${done}`];
  if (earlierAttempt) lines.push("  Check what the site holds now with `blocofy status` (and `blocofy theme push --diff --instance <handle>`) before running the push again.");
  if (candidates.length) {
    lines.push("  Candidate drafts:");
    for (const c of candidates) lines.push(`    ${c.instance}${c.name ? `  "${c.name}"` : ""}${isRestore(c) ? "  (site-state restore draft)" : ""}`);
  }
  const verb = action === "publish" ? "PUBLISH it live" : "OVERWRITE it";
  if (unsafe.length) {
    lines.push(`  Warning: naming ${unsafe.map((c) => c.instance).join(", ")} with --instance would ${verb}${unsafe.some(isRestore) ? " (including the restore's work)" : ""}.`);
  }
  if (safe) {
    lines.push(`  To use the CLI draft:  ${command} --instance ${safe.instance}`);
  } else if (action === "publish") {
    lines.push(`  Publish the draft you mean explicitly:  ${command} --instance <handle>`);
  } else {
    lines.push(`  Choose the draft explicitly:  ${command} --instance <handle>`);
    lines.push("  Safe ways forward: create a new draft theme in the admin panel and pass its handle with --instance,");
    lines.push("  or publish or delete the site-state restore draft first.");
  }
  lines.push("  (`blocofy status` lists the site's drafts.)");
  return lines.join("\n");
}

/**
 * Sunucu kanonik protokolü konuşuyor mu? (0.5.0 `--dry-run` ön kontrolü.) SORGUSUZ canlı GET — mutasyonsuz
 * (`?draft=1` GET'i sunucuda taslak provizyonlar, o yüzden burada KULLANILMAZ). Eski bir sunucu `protocol`
 * alanını hiç dönmez → false → `--dry-run` reddedilir; aksi hâlde eski sunucu `dryRun`'ı yok sayıp GERÇEK
 * yazım yapardı (0.5.0 öncesi sessiz-yazım regresyonu).
 */
export async function fetchCanonicalSupport({ url, token, onRetry = null }) {
  const base = url.replace(/\/+$/, "");
  const res = await fetchWithRetry(`${base}/api/dev/theme`, {
    headers: canonicalHeaders({ authorization: `Bearer ${token}` }),
  }, { onRetry });
  if (!res.ok) throw await httpError(res);
  const body = await res.json();
  return { supported: body?.protocol === 1 };
}

/**
 * CF-T1/T2 review I1 — a pulled path is accepted only if `readLocalTemplates` would read it back: a top-level theme dir
 * (exact case) with a file below it, or `config/settings_schema.json`. Any `.blocofy`/staging segment (compared
 * case-insensitively: APFS/NTFS fold case, so `.BLOCOFY/project.json` IS the binding) and any dot-directory (`.git`…)
 * is refused. Returns a reason string, or null when the path is acceptable.
 */
/**
 * The flat root files a theme actually HAS. The platform's starter themes ship exactly these two, so exactly
 * these two come down.
 *
 * This is an allowlist on purpose. It was briefly a denylist of tooling filenames, and that inverted the rule
 * the rest of this function is built on: anything the server named that was not a lockfile - `CLAUDE.md`,
 * `AGENTS.md`, `next.config.js` - was written straight into the developer's project root by an ordinary pull.
 * A theme download must never be able to place a file the developer's own tooling then trusts. If a theme
 * legitimately grows another root file, this set is where it is added, deliberately.
 */
const ROOT_FILES_ALLOWED = new Set(["readme.md", "blueprint.json"]);

function pullPathProblem(rel) {
  const segs = rel.split("/");
  if (segs.some((seg) => { const l = seg.toLowerCase(); return l === ".blocofy" || l.startsWith(".blocofy-staging-"); })) return "reserved CLI path";
  if (segs.slice(0, -1).some((seg) => seg.startsWith("."))) return "hidden directory";
  // `config/` — the theme's own configuration rows. `settings_schema.json` is the one a push sends back; the
  // platform serves the others (a starter theme ships `config/theme.json`) and a pull that refused them
  // refused the WHOLE download, so a freshly provisioned site could not be pulled at all. They are written
  // read-only: the push gate accepts only `settings_schema.json` under `config/`, and `pages`/`settings`
  // have their own commands. One flat level, no nesting.
  if (segs[0] === "config") {
    if (segs.length !== 2) return "config files are one level deep";
    // `settings pull` owns this name; a theme row must not shadow the file that command writes.
    return segs[1] === "settings.json" ? "config/settings.json belongs to `settings pull`" : null;
  }
  if (segs.length === 1) {
    // A FLAT FILE AT THE THEME ROOT. The platform stores rows a push does not send (the starter themes ship
    // `README.md` and `blueprint.json`) and serves them on pull; refusing them refused the whole download.
    // Case-folded, because APFS and NTFS fold case: `Readme.MD` and `README.md` are one file on disk.
    if (segs[0].startsWith(".")) return "hidden file";
    return ROOT_FILES_ALLOWED.has(segs[0].toLowerCase()) ? null : "not a theme file at the theme root";
  }
  if (!THEME_DIRS.has(segs[0])) return "not a theme file (would not be pushed back)";
  return null;
}

/**
 * Download a theme to disk. `{ path: content }` (stripped) → `.liquid` files.
 * With `draft`, pulls the "CLI Draft" instance (what `theme dev` syncs into)
 * instead of the live theme — symmetric with `push --draft`.
 */
export async function pullTheme({ dir, url, token, draft = false, instance = null, onRetry = null }) {
  const base = url.replace(/\/+$/, "");
  const query = instance ? `?instance=${encodeURIComponent(instance)}` : draft ? "?draft=1" : "";
  const res = await fetchWithRetry(`${base}/api/dev/theme${query}`, {
    headers: canonicalHeaders({ authorization: `Bearer ${token}` }),
  }, { onRetry });
  if (!res.ok) throw await responseError(res);
  const { files } = await res.json();
  // CF-T2: staged + contained (all-or-nothing). Every path is validated before the first byte is written; a
  // server path that escapes the directory, targets the CLI's own `.blocofy/` binding, or would not be read back by
  // the next push refuses the whole pull.
  const entries = Object.entries(files ?? {}).map(([key, content]) => [localPathFor(key), content]);
  const rejected = entries.map(([rel]) => [rel, pullPathProblem(rel)]).filter(([, problem]) => problem);
  if (rejected.length) {
    throw new PagesCliError("PAGES_PATH_ESCAPE", "The server sent a path this CLI does not write; nothing was written.", {
      diagnostics: rejected.map(([rel, problem]) => ({ level: "error", code: "PAGES_PATH_ESCAPE", message: problem, path: rel })),
    });
  }
  const created = !existsSync(dir);
  mkdirSync(dir, { recursive: true });
  try {
    return { count: stagedWrite(realpathSync(dir), entries) };
  } catch (error) {
    if (created) rmSync(dir, { recursive: true, force: true }); // no empty directory left behind
    throw error;
  }
}

/**
 * Token'ın GERÇEK site'ını çözer (`GET /api/dev/whoami`). Site sunucuda TOKEN'dan
 * çözülür — login URL'i kozmetik. CLI bunu `login`'de (doğrula+göster) ve `push`
 * öncesi (hedef tenant'ı yaz) çağırır; yanlış-tenant'a yazımı görünür kılar.
 * `{ site: { id, slug, name }, liveThemeId }`.
 */
export async function fetchWhoami({ url, token, onRetry = null }) {
  const base = url.replace(/\/+$/, "");
  const res = await fetchWithRetry(`${base}/api/dev/whoami`, {
    headers: { authorization: `Bearer ${token}` },
  }, { onRetry });
  if (!res.ok) throw await responseError(res);
  return res.json();
}

/**
 * Dev session bilgisi (#119 `theme dev`): platform draft instance'ı hazırlar ve
 * 3 görünümün URL'lerini döner — `{ draftInstanceId, previewUrl, editorUrl, site }`.
 */
export async function fetchDevSession({ url, token, name = null, onRetry = null }) {
  const base = url.replace(/\/+$/, "");
  const query = name ? `?name=${encodeURIComponent(name)}` : "";
  const res = await fetchWithRetry(`${base}/api/dev/session${query}`, {
    headers: { authorization: `Bearer ${token}` },
  }, { onRetry });
  if (!res.ok) {
    const detail = await errorText(res);
    // Yeni sunucular 410'da açıklayıcı bir gövde döndürür — onu olduğu gibi göster, o otoritedir.
    // Gövdesiz 410 (eski sunucu) `errorText`'ten "HTTP 410 …" olarak gelir; o durumda teşhisi
    // biz veririz, yoksa kullanıcı yalnız bir statü kodu görür.
    if (res.status === 410 && /^HTTP 410\b/.test(detail)) {
      throw new Error(
        "CLI remote preview (the signed preview URL and the editor view) is retired on this server " +
          "(HTTP 410). Draft sync and `theme publish` are unaffected — they use different endpoints.",
      );
    }
    throw Object.assign(new Error(detail), { status: res.status });
  }
  return res.json();
}

/**
 * TPUSH-5 (6.5) — what a dry run binds the apply to. A server with the 6.5 contract answers a keyed dry run with the
 * `manifestHash` of the files it checked and the `pointerVersion` its plan ran from (null: no deployment yet); the
 * apply sends both back (`manifestHash`, `expectedPointerVersion`) so it is refused unless it writes exactly those
 * bytes over exactly that state. An older server answers neither and gets the 0.10 body unchanged.
 * The pointer version is per instance, so the apply also names the instance the plan ran against: a server that
 * answers `targetInstance` (an opaque theme handle, or null for "a new draft") gets it back as
 * `expectedTargetInstance` and refuses 409 `target_changed` when the apply would write anywhere else.
 */
function pushBindings(plan) {
  if (typeof plan?.manifestHash !== "string" || !/^[0-9a-f]{64}$/.test(plan.manifestHash)) return {};
  const v = plan.pointerVersion;
  const t = plan.targetInstance;
  return {
    manifestHash: plan.manifestHash,
    ...(v === null || (Number.isInteger(v) && v >= 0) ? { expectedPointerVersion: v } : {}),
    ...(t === null || (typeof t === "string" && t !== "") ? { expectedTargetInstance: t } : {}),
  };
}

/**
 * The paths a dry-run plan says the push would remove. `config/settings.json` is left out: a stored row there is the
 * anomaly every canonical deploy cleans up (the settings themselves live in site_themes), not a theme file.
 */
function plannedRemovals(plan) {
  if (!Array.isArray(plan?.files)) return [];
  return plan.files.filter((f) => f?.outcome === "removed" && typeof f.path === "string" && f.path !== "config/settings.json").map((f) => f.path);
}

async function isReadbackUnverified(res) {
  try {
    return (await res.json())?.error === "readback_unverified";
  } catch {
    return false;
  }
}

/**
 * The paths a push can send: the mirror of the server's gate — multi-segment paths under THEME_DIRS plus the one
 * config exception (a slash-less remote key such as a bare `layout` would be refused 422 by the server).
 */
function sendable(key) {
  return (key.includes("/") && THEME_DIRS.has(key.split("/")[0] ?? "")) || key === "config/settings_schema.json";
}

/**
 * THEME_PUSH_TARGET_CHANGED — the plan would remove files this push did not carry, and says only what is true of them.
 * A path the push cannot send (outside the merge mirror, e.g. a bare `layout`) is never kept by a re-run, nor by a
 * local file at that path: only --prune gets past it. That includes every path the merge probe returned, since a
 * sendable one would have been merged. Any other path was either added while the push ran (a re-run reads and keeps
 * it) or is a row the probe cannot list (it lists published rows only), which no re-run keeps either.
 */
function targetChangedError(paths, remote) {
  const notCarryable = paths.filter((p) => Object.hasOwn(remote, p) || !sendable(p));
  const unseen = paths.filter((p) => !notCarryable.includes(p));
  const parts = [`The dry run would remove ${paths.length} file(s) this push does not have locally (${paths.join(", ")}). Nothing was written.`];
  if (notCarryable.length) {
    parts.push(`${notCarryable.join(", ")}: the push cannot carry these paths, so running it again will not keep them; it can go ahead only with --prune, which removes them.`);
  }
  if (unseen.length) {
    parts.push(
      `${unseen.join(", ")}: not on the target when this push read it. If they were added while this push was running, run the push again and it keeps them. ` +
        "If the same files stop the push again, the push cannot read them (for example a theme file that is not published) and cannot keep them: pass --prune to remove them, or add a local file at that path to replace it.",
    );
  }
  return Object.assign(new Error(parts.join(" ")), { code: "THEME_PUSH_TARGET_CHANGED", details: { paths, notCarryable } });
}

/**
 * Write the local theme to the site (create/update; no delete). With `draft`,
 * writes to a draft theme instance instead of the live theme — preview & publish
 * it from the admin panel without affecting the live site.
 */
export async function pushTheme({ dir, url, token, draft = false, instance = null, name = null, dryRun = false, idempotencyKey = null, onRetry = null, prune = false, confirmPrune = null }) {
  const base = url.replace(/\/+$/, "");
  const files = readLocalTemplates(dir);
  const headersFor = (extra = {}) => canonicalHeaders({ authorization: `Bearer ${token}`, ...extra });
  const postHeaders = (extra = {}) => headersFor({ "content-type": "application/json", "x-blocofy-optional-capabilities": OPTIONAL_CAPABILITIES, ...extra });
  // #989 review: a draft push naming an instance sends both — the server then refuses the live instance (422).
  const target = instance ? { files, instance, ...(draft ? { draft: true } : {}) } : name ? { files, draft, name } : { files, draft };
  const post = (body, key, retry = {}) =>
    fetchWithRetry(
      `${base}/api/dev/theme`,
      { method: "POST", headers: postHeaders(key ? { "x-idempotency-key": key } : {}), body: JSON.stringify(body) },
      { onRetry, ...retry },
    );

  // Keyless (theme dev's draft sync): one POST to the per-file writer — no probe, no plan (deliberate legacy path).
  if (!idempotencyKey) {
    const res = await post(dryRun ? { ...target, dryRun: true } : target, null);
    if (!res.ok) throw await httpError(res);
    return res.json();
  }

  // Keyed canonical push (and its --dry-run), TPUSH-5: ONE manifest for the dry run and the apply.
  //  1) MERGE PROBE GET — "push does not delete": remote files missing locally that the server's gate accepts are
  //     added to the payload verbatim; rows outside that set (README.md…) are kept by the server's retained-rows
  //     rule. `--prune` leaves them out instead (the canonical deploy replaces the folders, so they are removed).
  //     PS-09: a draft target is never probed with a draft-flagged GET (that provisions a draft server-side). The
  //     existing CLI draft is found via `/api/dev/site` (`source === "import"`, the server's own pick: the first by
  //     id) and probed by handle; with no draft there is nothing remote to merge, so there is no probe.
  //  2) DRY RUN of that MERGED payload. On a 6.5 server this is the control plane's rolled-back plan of the very
  //     operation the apply runs: refused by what the apply is refused by, with per-file outcomes, the manifest hash
  //     and the pointer version it ran from. It carries its OWN throwaway key: the control plane fingerprints the
  //     action, so a plan under a key an earlier deploy already spent is refused 409 — a same-key retry of a
  //     committed push could never converge. A plan removing a file the probe did not see means the target changed
  //     under this push; without --prune that is refused (push does not delete), with --prune it is confirmed.
  //  3) APPLY of the same payload under the push key, bound by `manifestHash` + `expectedPointerVersion`.
  //  theme dev's sync sends no key and pays none of this.
  const remoteOnlyKept = [];
  const remoteOnlyRemoved = [];
  let probeInstance = instance;
  let cliDraft = null;
  if (!instance && draft) {
    cliDraft = findCliDraft(await fetchSiteStatus({ url, token, onRetry }));
    probeInstance = cliDraft?.id ?? null;
  }
  let remote = {};
  if (probeInstance || !draft) {
    const query = probeInstance ? `?instance=${encodeURIComponent(probeInstance)}` : "";
    const probe = await fetchWithRetry(`${base}/api/dev/theme${query}`, { headers: headersFor() }, { onRetry });
    if (!probe.ok) throw await httpError(probe);
    remote = (await probe.json()).files ?? {};
  }
  for (const [key, content] of Object.entries(remote)) {
    if (key in files) continue;
    if (sendable(key)) {
      if (prune) {
        remoteOnlyRemoved.push(key);
      } else {
        files[key] = typeof content === "string" ? content : "";
        remoteOnlyKept.push(key);
      }
    }
  }

  // A plan's 502 readback_unverified is a verdict on a rolled-back plan, not a transient failure: not resent.
  const pre = await post({ ...target, dryRun: true }, `cli-plan-${randomUUID()}`, { isFinal: isReadbackUnverified });
  if (!pre.ok) throw Object.assign(await httpError(pre), { phase: "plan" });
  const plan = await pre.json();
  const unexpected = plannedRemovals(plan).filter((p) => !remoteOnlyRemoved.includes(p)).sort();
  if (unexpected.length && !prune) throw targetChangedError(unexpected, remote);
  remoteOnlyRemoved.push(...unexpected);
  remoteOnlyKept.sort();
  remoteOnlyRemoved.sort();
  const extras = {
    ...(remoteOnlyKept.length ? { remoteOnlyKept } : {}),
    ...(remoteOnlyRemoved.length ? { remoteOnlyRemoved } : {}),
  };
  if (dryRun) return { ...plan, ...extras };
  if (remoteOnlyRemoved.length && confirmPrune && !(await confirmPrune(remoteOnlyRemoved))) {
    return { aborted: true, remoteOnlyRemoved };
  }

  const bindings = pushBindings(plan);
  // An apply attempt without a certain answer (network error, 429/502/503/504) is resent under the same key. A
  // refusal of the resend says nothing about that earlier attempt: "unknown", or "committed" when its answer said so.
  let earlierAttempt = null;
  const applyError = (err) => {
    Object.assign(err, { phase: "apply" });
    // target_changed names the current target; the one this push planned against is known only here.
    if ("expectedTargetInstance" in bindings) err.expectedTargetInstance = bindings.expectedTargetInstance;
    if (earlierAttempt) err.earlierAttempt = earlierAttempt;
    return err;
  };
  let res;
  try {
    res = await post({ ...target, ...bindings }, idempotencyKey, {
      onRetry: (info) => {
        earlierAttempt ??= "unknown";
        onRetry?.(info);
      },
      isFinal: async (attempt) => {
        if ((await attempt.json().catch(() => null))?.committed === true) earlierAttempt = "committed";
        return false;
      },
    });
  } catch (error) {
    // No answer to the last attempt either (network error, timeout): the write's outcome is unknown.
    throw applyError(error);
  }
  if (!res.ok) throw applyError(await httpError(res));
  const applied = await res.json();
  // PS-22: which theme received the files. A current server names it on the apply; an older one only in the plan
  // (null for "a new draft"); oldest of all, the CLI draft looked up before the push is the one reused.
  // A server whose plan carries no `newDraft` created one exactly when a draft push found no CLI draft to reuse.
  const newDraft = typeof plan.newDraft === "boolean" ? plan.newDraft : Boolean(draft && !instance && cliDraft == null);
  const targetInstance = applied.targetInstance ?? plan.targetInstance ?? (newDraft ? null : probeInstance) ?? null;
  // #989 review: a draft this push created is named "CLI Draft — <name>" by the platform (date when no --name).
  const targetName = newDraft ? cliDraftName(name) : cliDraft && cliDraft.id === targetInstance ? cliDraft.name ?? null : null;
  return { ...applied, ...extras, targetInstance, newDraft, targetName };
}

/**
 * The CLI draft a draft push writes into, or `null` when a push would create one. #989: mirrors the server's rule —
 * exactly one `source: "import"` draft, carrying the platform-generated "CLI Draft" name and not a site-state restore
 * draft — and otherwise throws the server's 409 `draft_target_ambiguous` shape, so `push --diff` and the push's merge
 * probe never read a draft the push itself would refuse. The server stays authoritative (it also refuses a CLI-named
 * draft a site-state theme deploy wrote to, which this list cannot show).
 */
export function findCliDraft(status) {
  const candidates = (status?.drafts ?? []).filter((d) => d.source === "import");
  if (candidates.length === 0) return null;
  const listed = candidates.map((d) => ({ instance: d.id, name: d.name ?? null }));
  if (candidates.length > 1) {
    throw draftTargetAmbiguous(candidates.some((d) => SITE_STATE_DRAFT_NAME.test(d.name ?? "")) ? "site_state_restore" : "multiple_candidates", listed);
  }
  const [only] = candidates;
  if (SITE_STATE_DRAFT_NAME.test(only.name ?? "")) throw draftTargetAmbiguous("site_state_restore", listed);
  if (!CLI_DRAFT_NAME.test(only.name ?? "")) throw draftTargetAmbiguous("unrecognized_name", listed);
  return only;
}

/**
 * `blocofy theme push --diff` — compare the LOCAL theme with the LIVE theme (or an explicit `--instance`).
 * Read-only: the draft target is deliberately NOT diffable — `?draft=1` GET'i sunucuda taslak PROVİZYONLAR
 * (sayfa klonları dahil), read-only bir komut mutasyon tetikleyemez (0.5.0 denetim düzeltmesi). Çağıran
 * çıktıyı "canlıya göre fark" diye etiketler. Returns `{ added, changed, removed }` (stripped keys).
 */
export async function diffTheme({ dir, url, token, instance = null, onRetry = null }) {
  const base = url.replace(/\/+$/, "");
  const query = instance ? `?instance=${encodeURIComponent(instance)}` : "";
  const res = await fetchWithRetry(`${base}/api/dev/theme${query}`, {
    headers: canonicalHeaders({ authorization: `Bearer ${token}` }),
  }, { onRetry });
  if (!res.ok) throw await responseError(res);
  const { files: remote = {} } = await res.json();
  const local = readLocalTemplates(dir);
  const added = [];
  const changed = [];
  for (const [key, content] of Object.entries(local)) {
    if (!(key in remote)) added.push(key);
    else if (remote[key] !== content) changed.push(key);
  }
  const removed = Object.keys(remote).filter((k) => !(k in local));
  return { added: added.sort(), changed: changed.sort(), removed: removed.sort() };
}

/**
 * Bir taslak tema instance'ını CANLIYA al (`POST /api/dev/publish`). Sunucu guard'ı
 * içi-sayfasız bir instance'ı reddeder ya da canlının sayfalarını klonlar (#431) —
 * yayın sonrası site asla 404'e düşmez. `{ ok, published, cloned }` döner.
 */
export async function publishInstance({ url, token, instanceId, onRetry = null }) {
  const base = url.replace(/\/+$/, "");
  const res = await fetchWithRetry(`${base}/api/dev/publish`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ instanceId }),
  }, { onRetry });
  if (!res.ok) throw await responseError(res);
  return res.json();
}

/**
 * Bir tema instance'ının adını değiştir (`POST /api/dev/theme/rename`). Ad yalnızca
 * bir etiket — canlı instance dahil sahip olunan her instance yeniden adlandırılabilir.
 * `{ ok, id, name }` döner.
 */
export async function renameInstance({ url, token, instance, name, onRetry = null }) {
  const base = url.replace(/\/+$/, "");
  const res = await fetchWithRetry(`${base}/api/dev/theme/rename`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ instance, name }),
  }, { onRetry });
  if (!res.ok) throw await responseError(res);
  return res.json();
}

/**
 * Site sağlık/durum özeti (`GET /api/dev/site`) — `blocofy status`. Canlı tema instance'ı,
 * instance-başına sayfa dağılımı, taslaklar ve health döner.
 */
export async function fetchSiteStatus({ url, token, onRetry = null }) {
  const base = url.replace(/\/+$/, "");
  const res = await fetchWithRetry(`${base}/api/dev/site`, { headers: { authorization: `Bearer ${token}` } }, { onRetry });
  if (!res.ok) throw await responseError(res);
  return res.json();
}
