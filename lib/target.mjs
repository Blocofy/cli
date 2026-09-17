import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * CF-T1/T2 (contract C2) — project binding + target resolution + remote identity verification.
 *
 * A project is bound to ONE site by `<root>/.blocofy/project.json` (shared, secret-free). The user's context
 * choice for that project is `<root>/.blocofy/local.json` (git-ignored). No global "last login" is ever the
 * authority for a mutation: with a binding present `current_context` is ignored, and a remote-mutation without a
 * binding is refused before any network call.
 */

/** A target/binding refusal: exit 3, nothing read or written. `exitCode` 1 for LOGIN_REQUIRED (usage). */
export class TargetError extends Error {
  constructor(code, message, details = {}, exitCode = 3) {
    super(message);
    this.name = "TargetError";
    this.code = code;
    this.details = details;
    this.exitCode = exitCode;
  }
}

/** The ephemeral environment-variable context (same name as credentials.mjs ENV_CONTEXT). */
const ENV_CONTEXT = "env";

export const COMMAND_CLASSES = new Set(["remote-mutation", "local-write", "read"]);
const PROJECT_DIR = ".blocofy";
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const sameId = (a, b) => a !== null && a !== undefined && b !== null && b !== undefined && String(a) === String(b);
const origin = (v) => (typeof v === "string" && v ? v : null);

/**
 * Platform-origin rule (orchestrator decision, CF-T2 follow-up). Servers deployed before contract C3 do not send
 * `platform_origin`, so records created against them hold null.
 *   recorded == remote (both non-null)      → "match"
 *   recorded null, remote non-null          → "upgrade"  (proceeds with one stderr warning; nothing is rewritten)
 *   recorded non-null, remote null          → "unproven" (TARGET_UNVERIFIED: the server does not prove its platform)
 *   both null                               → "match"
 *   two different non-null values           → "mismatch"
 * The site id must match separately in every case.
 */
export function compareOrigin(recorded, remote) {
  const a = origin(recorded);
  const b = origin(remote);
  if (a === b) return "match";
  if (a === null) return "upgrade";
  if (b === null) return "unproven";
  return "mismatch";
}

export const CONTEXT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// ── binding ─────────────────────────────────────────────────────────────────────────────────────────────────

/** First `.blocofy/project.json` at `startDir` or an ancestor → `{ root, projectPath, project, localContext }` | null. */
export function findBinding(startDir) {
  let current = resolve(startDir);
  for (;;) {
    const projectPath = join(current, PROJECT_DIR, "project.json");
    if (existsSync(projectPath)) return readBinding(current);
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function readBinding(root) {
  const projectPath = join(root, PROJECT_DIR, "project.json");
  let project;
  try {
    project = JSON.parse(readFileSync(projectPath, "utf8"));
  } catch {
    project = null;
  }
  if (!isObj(project) || project.schema_version !== 1 || !(typeof project.site_id === "string" || Number.isFinite(project.site_id))) {
    throw new TargetError("TARGET_BINDING_INVALID", `The project binding is not valid: ${projectPath}. Nothing was read or written. Re-create it with \`blocofy link --context <name> --adopt\`.`, { binding: projectPath });
  }
  let localContext = null;
  const localPath = join(root, PROJECT_DIR, "local.json");
  if (existsSync(localPath)) {
    try {
      const local = JSON.parse(readFileSync(localPath, "utf8"));
      if (isObj(local) && typeof local.context === "string" && local.context) localContext = local.context;
    } catch {
      throw new TargetError("TARGET_BINDING_INVALID", `The local context file is not valid JSON: ${localPath}. Nothing was read or written.`, { binding: localPath });
    }
  }
  return { root, projectPath, project, localContext };
}

/** Write `.blocofy/project.json` (+ `local.json` for a named context, + `.gitignore`). */
export function writeBinding(root, { site, platformOrigin, contextName }) {
  const d = join(root, PROJECT_DIR);
  mkdirSync(d, { recursive: true });
  const project = { schema_version: 1, site_id: site.id, site_slug: site.slug ?? null, platform_origin: origin(platformOrigin) };
  writeFileSync(join(d, "project.json"), JSON.stringify(project, null, 2) + "\n");
  if (contextName && contextName !== ENV_CONTEXT) writeFileSync(join(d, "local.json"), JSON.stringify({ context: contextName }, null, 2) + "\n");
  writeFileSync(join(d, ".gitignore"), "local.json\n");
  return join(d, "project.json");
}

function isEmptyOrMissing(dir) {
  if (!existsSync(dir)) return true;
  if (!statSync(dir).isDirectory()) return false;
  return readdirSync(dir).length === 0;
}

/**
 * Command-class policy (before any credential or network use). Returns `{ newBinding }`: true when a local-write
 * into a missing/empty unbound dir will record provenance after it succeeds.
 */
export function enforceBindingPolicy({ commandClass, binding, dir, command }) {
  if (!COMMAND_CLASSES.has(commandClass)) throw new Error(`internal: unknown command class ${commandClass}`);
  if (binding) return { newBinding: false };
  if (commandClass === "remote-mutation") {
    throw new TargetError(
      "TARGET_BINDING_REQUIRED",
      `\`${command}\` changes a site, but ${dir} is not bound to one. Nothing was sent. Bind it first: blocofy link ${dir} --context <name>`,
      { dir },
    );
  }
  if (commandClass === "local-write") {
    if (isEmptyOrMissing(dir)) return { newBinding: true };
    throw new TargetError(
      "TARGET_BINDING_REQUIRED",
      `${dir} is not empty and not bound to a site. Nothing was written. Bind it first (blocofy link ${dir} --context <name>) or pull into an empty directory.`,
      { dir },
    );
  }
  return { newBinding: false };
}

// ── context resolution (pure) ───────────────────────────────────────────────────────────────────────────────

/** Offline: both sides are records, so a null on either side is not a mismatch (the remote check decides). */
function contextMatchesBinding(ctx, project) {
  return isObj(ctx?.site) && sameId(ctx.site.id, project.site_id) && compareOrigin(ctx.platform_origin, project.platform_origin) !== "mismatch";
}

/**
 * Contract C2 order: --context → BLOCOFY_CONTEXT → full env pair → .blocofy/local.json → the unique context
 * matching the binding (site.id + platform_origin) → TTY pick among matching candidates → TARGET_CONTEXT_REQUIRED.
 * With a binding present `current_context` is ignored; without one it is used only by `read` commands.
 *
 * `getStore()` is called only when a named context is needed (a corrupt file does not block the env context).
 * `prompt(candidates)` → name (TTY only). Returns `{ name, source, context, env? }`.
 */
export async function resolveContext({ flagContext = null, envContextName = null, envCtx = null, getStore, binding = null, commandClass, isTTY = false, prompt = null }) {
  const named = (name, source) => {
    if (name === ENV_CONTEXT) {
      if (envCtx) return { name: ENV_CONTEXT, source, context: envCtx.context, env: envCtx };
      throw new TargetError("TARGET_CONTEXT_UNKNOWN", `Context "env" needs BLOCOFY_URL+BLOCOFY_TOKEN or BLOCOFY_API_URL+BLOCOFY_API_KEY.`, { context: name });
    }
    const store = getStore();
    const ctx = store.contexts[name];
    if (!ctx) {
      throw new TargetError("TARGET_CONTEXT_UNKNOWN", `No context named "${name}" (from ${source}). List them with \`blocofy contexts\`.`, { context: name, source });
    }
    return { name, source, context: ctx };
  };

  if (flagContext) return named(flagContext, "--context");
  if (envContextName) return named(envContextName, "BLOCOFY_CONTEXT");
  if (envCtx) return { name: ENV_CONTEXT, source: "env", context: envCtx.context, env: envCtx };

  const store = getStore();
  const names = Object.keys(store.contexts);
  if (names.length === 0) {
    throw new TargetError("LOGIN_REQUIRED", "Login required: run `blocofy login` (or set BLOCOFY_URL + BLOCOFY_TOKEN).", {}, 1);
  }

  if (binding) {
    if (binding.localContext) return named(binding.localContext, ".blocofy/local.json");
    const candidates = names.filter((n) => contextMatchesBinding(store.contexts[n], binding.project));
    if (candidates.length === 1) return { name: candidates[0], source: "binding", context: store.contexts[candidates[0]] };
    if (candidates.length > 1 && isTTY && prompt) {
      const picked = await prompt(candidates);
      if (candidates.includes(picked)) return { name: picked, source: "prompt", context: store.contexts[picked] };
    }
    throw new TargetError(
      "TARGET_CONTEXT_REQUIRED",
      candidates.length > 1
        ? `Several contexts match this project's site (${candidates.join(", ")}). Choose one with --context <name> or \`blocofy link --context <name>\`.`
        : `No saved context matches this project's site (${binding.project.site_slug ?? binding.project.site_id}). Log in to it (blocofy login) or pass --context <name>.`,
      { site_id: binding.project.site_id, candidates },
    );
  }

  if (commandClass === "read" && store.current_context && store.contexts[store.current_context]) {
    return { name: store.current_context, source: "current_context", context: store.contexts[store.current_context] };
  }
  throw new TargetError("TARGET_CONTEXT_REQUIRED", "Choose the site: pass --context <name> (see `blocofy contexts`) or set BLOCOFY_CONTEXT.", { contexts: names });
}

/** Offline check before any network: a context already recorded for another site cannot serve this binding. */
export function precheckContext({ binding, resolved }) {
  const ctx = resolved.context;
  if (!binding || !isObj(ctx?.site)) return;
  if (!contextMatchesBinding(ctx, binding.project)) {
    throw new TargetError(
      "TARGET_SITE_MISMATCH",
      `Context "${resolved.name}" is for site ${ctx.site.slug ?? ctx.site.id}, but this project is bound to site ${binding.project.site_slug ?? binding.project.site_id}. Nothing was read or written.`,
      { context: resolved.name, context_site_id: ctx.site.id, binding_site_id: binding.project.site_id },
    );
  }
}

// ── remote identity ─────────────────────────────────────────────────────────────────────────────────────────

const IDENTITY_TIMEOUT_MS = 15000;

async function getJson(fetchImpl, url, secret) {
  let res;
  try {
    res = await fetchImpl(url, { headers: { authorization: `Bearer ${secret}`, accept: "application/json" }, signal: AbortSignal.timeout(IDENTITY_TIMEOUT_MS) });
  } catch (error) {
    return { error: `unreachable (${error?.name === "TimeoutError" ? "timeout" : "network error"})` };
  }
  const text = await res.text().catch(() => "");
  if (!res.ok) return { error: `HTTP ${res.status}` };
  try {
    return { body: JSON.parse(text) };
  } catch {
    return { error: "malformed response (not JSON)" };
  }
}

function unverified(what, url, reason) {
  return new TargetError("TARGET_UNVERIFIED", `Could not verify the target site via ${what} (${reason}). Nothing was sent or written.`, { endpoint: url, reason });
}

/** `GET {url}/api/dev/whoami` → `{ site, platformOrigin, liveThemeId }` or TARGET_UNVERIFIED. */
export async function verifyDev({ url, token, fetchImpl = fetch }) {
  const endpoint = `${url.replace(/\/+$/, "")}/api/dev/whoami`;
  const r = await getJson(fetchImpl, endpoint, token);
  if (r.error) throw unverified("/api/dev/whoami", endpoint, r.error);
  const site = r.body?.site;
  if (!isObj(site) || !(typeof site.id === "string" || Number.isFinite(site.id)) || typeof site.slug !== "string") {
    throw unverified("/api/dev/whoami", endpoint, "malformed response (no site id/slug)");
  }
  return { site: { id: site.id, slug: site.slug, name: typeof site.name === "string" ? site.name : null, domain: typeof site.domain === "string" ? site.domain : null }, platformOrigin: origin(r.body.platform_origin), liveThemeId: r.body.liveThemeId ?? null };
}

/** `GET {apiUrl}/api/v1/ping` → `{ site, platformOrigin }` or TARGET_UNVERIFIED. */
export async function verifyApi({ url, apiKey, fetchImpl = fetch }) {
  const endpoint = `${url.replace(/\/+$/, "")}/api/v1/ping`;
  const r = await getJson(fetchImpl, endpoint, apiKey);
  if (r.error) throw unverified("/api/v1/ping", endpoint, r.error);
  const site = r.body?.site;
  if (!isObj(site) || !(typeof site.id === "string" || Number.isFinite(site.id))) {
    throw unverified("/api/v1/ping", endpoint, "malformed response (no site id)");
  }
  return { site: { id: site.id, slug: typeof site.slug === "string" ? site.slug : null, name: typeof site.name === "string" ? site.name : null, domain: typeof site.domain === "string" ? site.domain : null }, platformOrigin: origin(r.body.platform_origin), liveThemeId: null };
}

function originUnproven(what, recorded) {
  return new TargetError(
    "TARGET_UNVERIFIED",
    `The server does not report its platform origin, so it cannot be proven to be ${recorded} (recorded for ${what}). Nothing was sent or written.`,
    { reason: "platform_origin_missing", recorded_platform_origin: recorded },
  );
}

/** Both pairs of one context must name the same site (and platform). */
export function assertSameSite(dev, api, contextName) {
  if (!sameId(dev.site.id, api.site.id) || dev.platformOrigin !== api.platformOrigin) {
    throw new TargetError(
      "TARGET_CREDENTIAL_MISMATCH",
      `Context "${contextName}" mixes credentials of two sites: the dev token is for ${dev.site.slug ?? dev.site.id}, the API key is for ${api.site.slug ?? api.site.id}. Nothing was sent or written.`,
      { context: contextName, dev_site_id: dev.site.id, api_site_id: api.site.id },
    );
  }
}

/**
 * Verify every usable pair of the resolved context, then compare with the context's recorded site and with the
 * binding. Returns the verified identity (`site`, `platformOrigin`, `liveThemeId`, and `warnings` when a record lacks
 * its platform origin — see `compareOrigin`).
 */
export async function verifyTarget({ resolved, secrets, binding, fetchImpl = fetch }) {
  const ctx = resolved.context;
  const dev = ctx.dev && secrets.devToken ? await verifyDev({ url: ctx.dev.url, token: secrets.devToken, fetchImpl }) : null;
  const api = ctx.api && secrets.apiKey ? await verifyApi({ url: ctx.api.url, apiKey: secrets.apiKey, fetchImpl }) : null;
  if (dev && api) assertSameSite(dev, api, resolved.name);
  const identity = dev ? { ...dev, site: { ...dev.site, domain: dev.site.domain ?? api?.site.domain ?? null } } : api;
  if (!identity) throw new TargetError("LOGIN_REQUIRED", `Context "${resolved.name}" has no usable credentials. Run \`blocofy login\`.`, { context: resolved.name }, 1);

  const warnings = [];
  if (isObj(ctx.site)) {
    const o = compareOrigin(ctx.platform_origin, identity.platformOrigin);
    if (!sameId(ctx.site.id, identity.site.id) || o === "mismatch") {
      throw new TargetError(
        "TARGET_SITE_MISMATCH",
        `Context "${resolved.name}" is recorded for site ${ctx.site.slug ?? ctx.site.id}, but its credentials now resolve to ${identity.site.slug ?? identity.site.id}. Nothing was sent or written. Log in again: blocofy login --context ${resolved.name}`,
        { context: resolved.name, context_site_id: ctx.site.id, remote_site_id: identity.site.id },
      );
    }
    if (o === "unproven") throw originUnproven(`context "${resolved.name}"`, ctx.platform_origin);
    if (o === "upgrade") {
      warnings.push({ code: "TARGET_CONTEXT_ORIGIN_MISSING", message: `Context "${resolved.name}" is missing its platform origin; run \`blocofy login --context ${resolved.name}\` to record ${identity.platformOrigin}.` });
    }
  }
  if (binding) {
    const o = compareOrigin(binding.project.platform_origin, identity.platformOrigin);
    if (!sameId(binding.project.site_id, identity.site.id) || o === "mismatch") {
      throw new TargetError(
        "TARGET_SITE_MISMATCH",
        `This project is bound to site ${binding.project.site_slug ?? binding.project.site_id}, but context "${resolved.name}" resolves to ${identity.site.slug ?? identity.site.id}. Nothing was sent or written.`,
        { context: resolved.name, binding_site_id: binding.project.site_id, remote_site_id: identity.site.id },
      );
    }
    if (o === "unproven") throw originUnproven("this project's binding", binding.project.platform_origin);
    if (o === "upgrade") {
      warnings.push({ code: "TARGET_BINDING_ORIGIN_MISSING", message: `The project binding is missing its platform origin; run \`blocofy link --adopt\` to record ${identity.platformOrigin}.` });
    }
  }
  if (warnings.length) identity.warnings = warnings;
  return identity;
}
