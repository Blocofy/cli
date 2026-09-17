import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { registerSecret, formatTargetBlock, printError, redact, targetData } from "../lib/output.mjs";
import { TargetError, enforceBindingPolicy, findBinding, precheckContext, resolveContext, verifyTarget, writeBinding } from "../lib/target.mjs";

/** CF-T1/T2 (contract C2) — the pure resolver order, binding policy, identity comparison and output format. */

const ORIGIN = "https://app.blocofy.test";
const siteA = { id: "sA1", slug: "alpha", name: "Alpha", domain: "alpha.myblocofy.test" };
const siteB = { id: "sB2", slug: "beta", name: "Beta", domain: null };
const ctx = (site, extra = {}) => ({ platform_origin: ORIGIN, site, dev: { url: `https://${site?.slug ?? "x"}.test`, secret: { store: "file" } }, ...extra });
const store = (contexts, current = null) => ({ schema_version: 2, current_context: current, contexts });
const bindingFor = (site, localContext = null) => ({ root: "/p", projectPath: "/p/.blocofy/project.json", project: { schema_version: 1, site_id: site.id, site_slug: site.slug, platform_origin: ORIGIN }, localContext });
const envCtx = { name: "env", source: "env", context: { platform_origin: null, site: null, dev: { url: "https://env.test" } }, secrets: { devToken: "bcf_env", apiKey: null } };

const code = async (promise) => {
  try {
    await promise;
    return "ok";
  } catch (e) {
    return e.code;
  }
};

const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

test("order: --context beats BLOCOFY_CONTEXT beats env beats local.json beats the binding match", async () => {
  const s = store({ a: ctx(siteA), a2: ctx(siteA), b: ctx(siteB) }, "b");
  const binding = bindingFor(siteA, "a2");
  const base = { getStore: () => s, binding, commandClass: "remote-mutation" };
  assert.equal((await resolveContext({ ...base, flagContext: "b", envContextName: "a", envCtx })).name, "b");
  assert.equal((await resolveContext({ ...base, envContextName: "a", envCtx })).name, "a");
  const env = await resolveContext({ ...base, envCtx });
  assert.equal(env.name, "env");
  assert.equal(env.source, "env");
  assert.equal((await resolveContext(base)).name, "a2");
  assert.equal((await resolveContext({ ...base, binding: bindingFor(siteB) })).name, "b");
});

test("with a binding current_context is IGNORED; the unique matching context wins", async () => {
  const s = store({ a: ctx(siteA), b: ctx(siteB) }, "b");
  const r = await resolveContext({ getStore: () => s, binding: bindingFor(siteA), commandClass: "local-write" });
  assert.equal(r.name, "a");
  assert.equal(r.source, "binding");
});

test("platform_origin is part of the match; an unverified (site null) context never matches", async () => {
  const other = { ...ctx(siteA), platform_origin: "https://other.test" };
  assert.equal(await code(resolveContext({ getStore: () => store({ other, unverified: ctx(null) }), binding: bindingFor(siteA), commandClass: "read" })), "TARGET_CONTEXT_REQUIRED");
});

test("several matches: non-TTY → TARGET_CONTEXT_REQUIRED (candidates listed); TTY → the injected prompt picks among matches only", async () => {
  const s = store({ a1: ctx(siteA), a2: ctx(siteA), b: ctx(siteB) });
  const binding = bindingFor(siteA);
  let err;
  try {
    await resolveContext({ getStore: () => s, binding, commandClass: "remote-mutation", isTTY: false, prompt: async () => "a2" });
  } catch (e) {
    err = e;
  }
  assert.equal(err.code, "TARGET_CONTEXT_REQUIRED");
  assert.deepEqual(err.details.candidates, ["a1", "a2"]);
  const offered = [];
  const picked = await resolveContext({ getStore: () => s, binding, commandClass: "remote-mutation", isTTY: true, prompt: async (c) => (offered.push(...c), "a2") });
  assert.deepEqual(offered, ["a1", "a2"]);
  assert.equal(picked.name, "a2");
  assert.equal(picked.source, "prompt");
  // A pick outside the candidates (e.g. the other site's context) is not accepted.
  assert.equal(await code(resolveContext({ getStore: () => s, binding, commandClass: "remote-mutation", isTTY: true, prompt: async () => "b" })), "TARGET_CONTEXT_REQUIRED");
});

test("no binding: current_context serves read commands only; no contexts at all → LOGIN_REQUIRED (exit 1)", async () => {
  const s = store({ a: ctx(siteA) }, "a");
  assert.equal((await resolveContext({ getStore: () => s, commandClass: "read" })).name, "a");
  assert.equal(await code(resolveContext({ getStore: () => s, commandClass: "local-write" })), "TARGET_CONTEXT_REQUIRED");
  assert.equal(await code(resolveContext({ getStore: () => s, commandClass: "remote-mutation" })), "TARGET_CONTEXT_REQUIRED");
  try {
    await resolveContext({ getStore: () => store({}), commandClass: "read" });
    assert.fail("expected LOGIN_REQUIRED");
  } catch (e) {
    assert.equal(e.code, "LOGIN_REQUIRED");
    assert.equal(e.exitCode, 1);
  }
});

test("unknown named contexts (flag, env var, local.json) are refused; the env context needs env credentials", async () => {
  const s = store({ a: ctx(siteA) });
  assert.equal(await code(resolveContext({ getStore: () => s, flagContext: "zzz", commandClass: "read" })), "TARGET_CONTEXT_UNKNOWN");
  assert.equal(await code(resolveContext({ getStore: () => s, envContextName: "zzz", commandClass: "read" })), "TARGET_CONTEXT_UNKNOWN");
  assert.equal(await code(resolveContext({ getStore: () => s, binding: bindingFor(siteA, "gone"), commandClass: "read" })), "TARGET_CONTEXT_UNKNOWN");
  assert.equal(await code(resolveContext({ getStore: () => s, flagContext: "env", commandClass: "read" })), "TARGET_CONTEXT_UNKNOWN");
});

test("the env context does not load the store (a corrupt credentials file cannot block it)", async () => {
  const r = await resolveContext({ getStore: () => assert.fail("store loaded"), envCtx, commandClass: "remote-mutation", binding: bindingFor(siteA) });
  assert.equal(r.name, "env");
});

test("precheck: a context recorded for another site is refused offline", () => {
  assert.throws(() => precheckContext({ binding: bindingFor(siteA), resolved: { name: "b", context: ctx(siteB) } }), (e) => e.code === "TARGET_SITE_MISMATCH" && e.exitCode === 3);
  precheckContext({ binding: bindingFor(siteA), resolved: { name: "a", context: ctx(siteA) } });
  precheckContext({ binding: bindingFor(siteA), resolved: { name: "u", context: ctx(null) } });
  precheckContext({ binding: null, resolved: { name: "b", context: ctx(siteB) } });
});

test("binding policy: remote-mutation needs a binding; local-write allows only a missing/empty dir", () => {
  const empty = mkdtempSync(join(tmpdir(), "bcf-t-"));
  const full = mkdtempSync(join(tmpdir(), "bcf-t-"));
  dirs.push(empty, full);
  writeFileSync(join(full, "x"), "1");
  assert.throws(() => enforceBindingPolicy({ commandClass: "remote-mutation", binding: null, dir: empty, command: "theme push" }), (e) => e.code === "TARGET_BINDING_REQUIRED");
  assert.deepEqual(enforceBindingPolicy({ commandClass: "local-write", binding: null, dir: empty, command: "theme pull" }), { newBinding: true });
  assert.deepEqual(enforceBindingPolicy({ commandClass: "local-write", binding: null, dir: join(empty, "missing"), command: "theme pull" }), { newBinding: true });
  assert.throws(() => enforceBindingPolicy({ commandClass: "local-write", binding: null, dir: full, command: "theme pull" }), (e) => e.code === "TARGET_BINDING_REQUIRED");
  assert.deepEqual(enforceBindingPolicy({ commandClass: "read", binding: null, dir: full, command: "status" }), { newBinding: false });
  assert.deepEqual(enforceBindingPolicy({ commandClass: "remote-mutation", binding: bindingFor(siteA), dir: full, command: "theme push" }), { newBinding: false });
});

test("findBinding walks up to ancestors; writeBinding writes project.json + local.json + .gitignore (no local.json for env)", () => {
  const root = mkdtempSync(join(tmpdir(), "bcf-t-"));
  dirs.push(root);
  writeBinding(root, { site: siteA, platformOrigin: ORIGIN, contextName: "alpha" });
  mkdirSync(join(root, "a", "b"), { recursive: true });
  const b = findBinding(join(root, "a", "b"));
  assert.equal(b.root, root);
  assert.deepEqual(b.project, { schema_version: 1, site_id: "sA1", site_slug: "alpha", platform_origin: ORIGIN });
  assert.equal(b.localContext, "alpha");
  const envRoot = mkdtempSync(join(tmpdir(), "bcf-t-"));
  dirs.push(envRoot);
  writeBinding(envRoot, { site: siteA, platformOrigin: null, contextName: "env" });
  assert.equal(findBinding(envRoot).localContext, null);
  writeFileSync(join(envRoot, ".blocofy", "project.json"), "{broken");
  assert.throws(() => findBinding(envRoot), (e) => e.code === "TARGET_BINDING_INVALID");
});

function fakeFetch(routes) {
  return async (url) => {
    const r = routes[new URL(url).pathname];
    if (!r) throw new TypeError("fetch failed");
    return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body), { status: r.status ?? 200 });
  };
}

test("verifyTarget: both pairs verified and compared (TARGET_CREDENTIAL_MISMATCH); binding compared (TARGET_SITE_MISMATCH); failures → TARGET_UNVERIFIED", async () => {
  const both = { name: "a", context: { ...ctx(null), api: { url: "https://api.test", secret: { store: "file" } } } };
  const secrets = { devToken: "bcf_x", apiKey: "blcf_live_x" };
  const whoamiA = { body: { site: siteA, liveThemeId: "t1", platform_origin: ORIGIN } };
  const pingA = { body: { ok: true, site: siteA, platform_origin: ORIGIN } };
  const pingB = { body: { ok: true, site: siteB, platform_origin: ORIGIN } };

  const id = await verifyTarget({ resolved: both, secrets, binding: bindingFor(siteA), fetchImpl: fakeFetch({ "/api/dev/whoami": whoamiA, "/api/v1/ping": pingA }) });
  assert.equal(id.site.id, "sA1");
  assert.equal(id.liveThemeId, "t1");
  assert.equal(await code(verifyTarget({ resolved: both, secrets, binding: null, fetchImpl: fakeFetch({ "/api/dev/whoami": whoamiA, "/api/v1/ping": pingB }) })), "TARGET_CREDENTIAL_MISMATCH");
  assert.equal(await code(verifyTarget({ resolved: both, secrets, binding: bindingFor(siteB), fetchImpl: fakeFetch({ "/api/dev/whoami": whoamiA, "/api/v1/ping": pingA }) })), "TARGET_SITE_MISMATCH");
  assert.equal(await code(verifyTarget({ resolved: both, secrets, binding: null, fetchImpl: fakeFetch({ "/api/dev/whoami": { status: 503, body: {} }, "/api/v1/ping": pingA }) })), "TARGET_UNVERIFIED");
  assert.equal(await code(verifyTarget({ resolved: both, secrets, binding: null, fetchImpl: fakeFetch({ "/api/dev/whoami": { body: "<html>" }, "/api/v1/ping": pingA }) })), "TARGET_UNVERIFIED");
  assert.equal(await code(verifyTarget({ resolved: both, secrets, binding: null, fetchImpl: fakeFetch({ "/api/dev/whoami": { body: { site: {} } }, "/api/v1/ping": pingA }) })), "TARGET_UNVERIFIED");
  assert.equal(await code(verifyTarget({ resolved: both, secrets, binding: null, fetchImpl: fakeFetch({}) })), "TARGET_UNVERIFIED");
  // An old server without platform_origin → null, which only matches a binding whose platform_origin is null.
  const oldServer = fakeFetch({ "/api/dev/whoami": { body: { site: siteA } } });
  const devOnly = { name: "a", context: ctx(null) };
  assert.equal(await code(verifyTarget({ resolved: devOnly, secrets, binding: bindingFor(siteA), fetchImpl: oldServer })), "TARGET_SITE_MISMATCH");
  const nullBinding = { ...bindingFor(siteA), project: { ...bindingFor(siteA).project, platform_origin: null } };
  assert.equal(await code(verifyTarget({ resolved: devOnly, secrets, binding: nullBinding, fetchImpl: oldServer })), "ok");
  // A context recorded for A whose token now resolves to B.
  assert.equal(await code(verifyTarget({ resolved: { name: "a", context: ctx(siteA) }, secrets, binding: null, fetchImpl: fakeFetch({ "/api/dev/whoami": { body: { site: siteB, platform_origin: ORIGIN } } }) })), "TARGET_SITE_MISMATCH");
});

test("output: the target block format, the error envelope, and secret redaction", () => {
  const t = targetData({ site: siteA, url: "https://alpha.test", contextName: "alpha", bindingLabel: ".blocofy/project.json", operation: "pages push · live" });
  assert.equal(
    formatTargetBlock(t),
    ["Target:    Alpha · sA1 · alpha.myblocofy.test", "Context:   alpha", "Binding:   .blocofy/project.json", "Operation: pages push · live"].join("\n"),
  );
  assert.match(formatTargetBlock(targetData({ site: siteB, url: "https://beta.test", contextName: "env", bindingLabel: "none (new pull)", operation: "theme pull · live" })), /Beta · sB2 · https:\/\/beta\.test/);
  registerSecret("bcf_supersecret_value_123");
  assert.equal(redact("x bcf_supersecret_value_123 y"), "x [redacted] y");
  let out = "";
  const stream = { write: (s) => (out += s) };
  printError(new TargetError("TARGET_SITE_MISMATCH", "token bcf_supersecret_value_123 mismatch", { a: 1 }), { json: true, stream });
  assert.deepEqual(JSON.parse(out), { error: { code: "TARGET_SITE_MISMATCH", message: "token [redacted] mismatch", details: { a: 1 } } });
  out = "";
  printError(new TargetError("TARGET_UNVERIFIED", "down"), { stream });
  assert.equal(out, "error [TARGET_UNVERIFIED]: down\n");
});
