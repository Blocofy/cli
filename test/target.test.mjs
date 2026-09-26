import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { registerSecret, formatTargetBlock, printError, redact, targetData } from "../lib/output.mjs";
import { TargetError, compareOrigin, enforceBindingPolicy, findBinding, precheckContext, resolveContext, verifyTarget, writeBinding } from "../lib/target.mjs";

/** CF-T1/T2 (contract C2) — the pure resolver order, binding policy, identity comparison and output format. */

const ORIGIN = "https://app.blocofy.test";
const siteA = { id: "sA1", slug: "alpha", name: "Alpha", domain: "alpha.myblocofy.test" };
const siteB = { id: "sB2", slug: "beta", name: "Beta", domain: null };
const ctx = (site, extra = {}) => ({ platform_origin: ORIGIN, site, dev: { url: `https://${site?.slug ?? "x"}.test`, secret: { store: "file" } }, ...extra });
const store = (contexts, current = null) => ({ schema_version: 2, current_context: current, contexts });
const bindingFor = (site, localContext = null) => ({ root: "/p", projectPath: "/p/.blocofy/project.json", project: { schema_version: 1, site_id: site.id, site_slug: site.slug, platform_origin: ORIGIN }, localContext });
const envCtx = { name: "env", source: "env", context: { platform_origin: null, site: null, dev: { url: "https://env.test" } }, secrets: { devToken: "bcf_env", apiKey: null } };

/** CF-T3: identity reads retry transient failures; tests skip the real backoff. */
const NO_WAIT = { sleep: async () => {} };

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

test("order: --context → BLOCOFY_CONTEXT → env pair → local.json → the binding match; each result names its source", async () => {
  const s = store({ a: ctx(siteA), a2: ctx(siteA), b: ctx(siteB) }, "b");
  const base = { getStore: () => s, binding: bindingFor(siteA), commandClass: "remote-mutation" };
  const flag = await resolveContext({ ...base, flagContext: "b" });
  assert.deepEqual([flag.name, flag.source, flag.ignored], ["b", "--context", []]);
  const envName = await resolveContext({ ...base, envContextName: "a" });
  assert.deepEqual([envName.name, envName.source, envName.ignored], ["a", "BLOCOFY_CONTEXT", []]);
  const env = await resolveContext({ ...base, envCtx });
  assert.deepEqual([env.name, env.source, env.ignored], ["env", "env", []]);
  const local = await resolveContext({ ...base, binding: bindingFor(siteA, "a2") });
  assert.deepEqual([local.name, local.source, local.ignored], ["a2", ".blocofy/local.json", []]);
  const match = await resolveContext({ ...base, binding: bindingFor(siteB) });
  assert.deepEqual([match.name, match.source, match.ignored], ["b", "binding", []]);
  // Two authorities that name the SAME context agree: no conflict, nothing overridden.
  const agree = await resolveContext({ ...base, envContextName: "a2", binding: bindingFor(siteA, "a2") });
  assert.deepEqual([agree.name, agree.source, agree.ignored], ["a2", "BLOCOFY_CONTEXT", []]);
  const agreeEnv = await resolveContext({ ...base, envContextName: "env", envCtx });
  assert.deepEqual([agreeEnv.name, agreeEnv.ignored], ["env", []]);
});

test("1.8: conflicting implicit authorities fail closed (TARGET_CONTEXT_CONFLICT, exit 3) — env pair + BLOCOFY_CONTEXT, env pair + local.json, BLOCOFY_CONTEXT ≠ local.json", async () => {
  const s = store({ a: ctx(siteA), a2: ctx(siteA), b: ctx(siteB) }, "b");
  const cases = [
    [{ envContextName: "a", envCtx }, ["BLOCOFY_CONTEXT", "env"]],
    [{ envCtx, binding: bindingFor(siteA, "a2") }, ["env", ".blocofy/local.json"]],
    [{ envContextName: "b", binding: bindingFor(siteA, "a2") }, ["BLOCOFY_CONTEXT", ".blocofy/local.json"]],
    [{ envContextName: "a", envCtx, binding: bindingFor(siteA, "a2") }, ["BLOCOFY_CONTEXT", "env", ".blocofy/local.json"]],
  ];
  for (const [extra, sources] of cases) {
    let err;
    try {
      await resolveContext({ getStore: () => assert.fail("store loaded before the conflict was refused"), commandClass: "read", ...extra });
    } catch (e) {
      err = e;
    }
    assert.ok(err, `no refusal for ${sources.join(" + ")}`);
    assert.equal(err.code, "TARGET_CONTEXT_CONFLICT", sources.join(" + "));
    assert.equal(err.exitCode, 3);
    assert.deepEqual(err.details.authorities.map((a) => a.source), sources);
    assert.match(err.message, /--context/);
    assert.match(err.message, /Nothing was read or written/);
  }
  // Unbound dir: the same env pair + BLOCOFY_CONTEXT conflict (nothing pins the site).
  assert.equal(await code(resolveContext({ getStore: () => s, envContextName: "b", envCtx, commandClass: "read" })), "TARGET_CONTEXT_CONFLICT");
});

test("1.8: an explicit --context settles a conflict and REPORTS every authority it overrode", async () => {
  const s = store({ a: ctx(siteA), a2: ctx(siteA), b: ctx(siteB) }, "b");
  const r = await resolveContext({ getStore: () => s, flagContext: "a", envContextName: "b", envCtx, binding: bindingFor(siteA, "a2"), commandClass: "remote-mutation" });
  assert.equal(r.name, "a");
  assert.equal(r.source, "--context");
  assert.deepEqual(r.ignored, [
    { source: "BLOCOFY_CONTEXT", name: "b" },
    { source: "env", name: "env" },
    { source: ".blocofy/local.json", name: "a2" },
  ]);
  // --context env selects the env pair; a local.json naming another context is still reported.
  const e = await resolveContext({ getStore: () => s, flagContext: "env", envCtx, binding: bindingFor(siteA, "a2"), commandClass: "read" });
  assert.deepEqual([e.name, e.source, e.ignored], ["env", "--context", [{ source: ".blocofy/local.json", name: "a2" }]]);
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

test("contract C2: without a binding current_context serves ONLY the commands that opt in (status, target, pages check); no contexts at all → LOGIN_REQUIRED (exit 1)", async () => {
  const s = store({ a: ctx(siteA) }, "a");
  const cur = await resolveContext({ getStore: () => s, allowCurrentContext: true });
  assert.deepEqual([cur.name, cur.source, cur.ignored], ["a", "current_context", []]);
  // Every other command — reads that compare a local tree with the site included — needs an explicit choice.
  for (const commandClass of ["read", "local-write", "remote-mutation"]) {
    assert.equal(await code(resolveContext({ getStore: () => s, commandClass })), "TARGET_CONTEXT_REQUIRED", commandClass);
  }
  // With a binding current_context is never used, even by an opted-in command.
  assert.equal(await code(resolveContext({ getStore: () => s, binding: bindingFor(siteB), allowCurrentContext: true })), "TARGET_CONTEXT_REQUIRED");
  try {
    await resolveContext({ getStore: () => store({}), allowCurrentContext: true });
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

  const id = await verifyTarget({ retry: NO_WAIT, resolved: both, secrets, binding: bindingFor(siteA), fetchImpl: fakeFetch({ "/api/dev/whoami": whoamiA, "/api/v1/ping": pingA }) });
  assert.equal(id.site.id, "sA1");
  assert.equal(id.liveThemeId, "t1");
  assert.equal(await code(verifyTarget({ retry: NO_WAIT, resolved: both, secrets, binding: null, fetchImpl: fakeFetch({ "/api/dev/whoami": whoamiA, "/api/v1/ping": pingB }) })), "TARGET_CREDENTIAL_MISMATCH");
  assert.equal(await code(verifyTarget({ retry: NO_WAIT, resolved: both, secrets, binding: bindingFor(siteB), fetchImpl: fakeFetch({ "/api/dev/whoami": whoamiA, "/api/v1/ping": pingA }) })), "TARGET_SITE_MISMATCH");
  assert.equal(await code(verifyTarget({ retry: NO_WAIT, resolved: both, secrets, binding: null, fetchImpl: fakeFetch({ "/api/dev/whoami": { status: 503, body: {} }, "/api/v1/ping": pingA }) })), "TARGET_UNVERIFIED");
  // CF-T3: a transient identity failure is retried (503 then 200 → verified); a 500 is not.
  let n = 0;
  const flaky = async (url) => (new URL(url).pathname === "/api/dev/whoami" && ++n === 1 ? new Response("{}", { status: 503 }) : fakeFetch({ "/api/dev/whoami": whoamiA, "/api/v1/ping": pingA })(url));
  assert.equal(await code(verifyTarget({ retry: NO_WAIT, resolved: both, secrets, binding: null, fetchImpl: flaky })), "ok");
  assert.equal(n, 2);
  let m = 0;
  const hard = async (url) => (new URL(url).pathname === "/api/dev/whoami" ? (m++, new Response("{}", { status: 500 })) : fakeFetch({ "/api/v1/ping": pingA })(url));
  assert.equal(await code(verifyTarget({ retry: NO_WAIT, resolved: both, secrets, binding: null, fetchImpl: hard })), "TARGET_UNVERIFIED");
  assert.equal(m, 1, "500 is not retried");
  assert.equal(await code(verifyTarget({ retry: NO_WAIT, resolved: both, secrets, binding: null, fetchImpl: fakeFetch({ "/api/dev/whoami": { body: "<html>" }, "/api/v1/ping": pingA }) })), "TARGET_UNVERIFIED");
  assert.equal(await code(verifyTarget({ retry: NO_WAIT, resolved: both, secrets, binding: null, fetchImpl: fakeFetch({ "/api/dev/whoami": { body: { site: {} } }, "/api/v1/ping": pingA }) })), "TARGET_UNVERIFIED");
  assert.equal(await code(verifyTarget({ retry: NO_WAIT, resolved: both, secrets, binding: null, fetchImpl: fakeFetch({}) })), "TARGET_UNVERIFIED");
  // Old server (no platform_origin) + a binding that records one: the platform cannot be proven (four-way rule below).
  const oldServer = fakeFetch({ "/api/dev/whoami": { body: { site: siteA } } });
  const devOnly = { name: "a", context: ctx(null) };
  assert.equal(await code(verifyTarget({ retry: NO_WAIT, resolved: devOnly, secrets, binding: bindingFor(siteA), fetchImpl: oldServer })), "TARGET_UNVERIFIED");
  const nullBinding = { ...bindingFor(siteA), project: { ...bindingFor(siteA).project, platform_origin: null } };
  assert.equal(await code(verifyTarget({ retry: NO_WAIT, resolved: devOnly, secrets, binding: nullBinding, fetchImpl: oldServer })), "ok");
  // A context recorded for A whose token now resolves to B.
  assert.equal(await code(verifyTarget({ retry: NO_WAIT, resolved: { name: "a", context: ctx(siteA) }, secrets, binding: null, fetchImpl: fakeFetch({ "/api/dev/whoami": { body: { site: siteB, platform_origin: ORIGIN } } }) })), "TARGET_SITE_MISMATCH");
});

test("null platform origin rule: binding × server origin, all four combinations (+ the context record)", async () => {
  const secrets = { devToken: "bcf_x", apiKey: null };
  const devOnly = { name: "a", context: ctx(null) };
  const server = (platform_origin, site = siteA) => fakeFetch({ "/api/dev/whoami": { body: { site, ...(platform_origin === undefined ? {} : { platform_origin }) } } });
  const withOrigin = (site, o) => ({ ...bindingFor(site), project: { ...bindingFor(site).project, platform_origin: o } });
  const outcome = async (binding, fetchImpl, resolved = devOnly) => {
    try {
      const id = await verifyTarget({ retry: NO_WAIT, resolved, secrets, binding, fetchImpl });
      return { code: "ok", warnings: (id.warnings ?? []).map((w) => w.code), messages: (id.warnings ?? []).map((w) => w.message) };
    } catch (e) {
      return { code: e.code, message: e.message };
    }
  };

  assert.deepEqual(["match", "upgrade", "unproven", "mismatch"], [compareOrigin(ORIGIN, ORIGIN), compareOrigin(null, ORIGIN), compareOrigin(ORIGIN, null), compareOrigin(ORIGIN, "https://other.test")]);
  assert.equal(compareOrigin(null, null), "match");

  // 1. binding null × server non-null, same site → proceeds with ONE warning naming `link --adopt` and the origin.
  const up = await outcome(withOrigin(siteA, null), server(ORIGIN));
  assert.equal(up.code, "ok");
  assert.deepEqual(up.warnings, ["TARGET_BINDING_ORIGIN_MISSING"]);
  assert.match(up.messages[0], /blocofy link --adopt/);
  assert.ok(up.messages[0].includes(ORIGIN));
  //    …but a different site id is still a mismatch.
  assert.equal((await outcome(withOrigin(siteA, null), server(ORIGIN, siteB))).code, "TARGET_SITE_MISMATCH");
  // 2. binding non-null × server null → TARGET_UNVERIFIED, message says the server does not report its origin.
  const unproven = await outcome(withOrigin(siteA, ORIGIN), server(undefined));
  assert.equal(unproven.code, "TARGET_UNVERIFIED");
  assert.match(unproven.message, /does not report its platform origin/);
  // 3. both non-null: exactly equal → ok without warning; different → mismatch.
  assert.deepEqual(await outcome(withOrigin(siteA, ORIGIN), server(ORIGIN)), { code: "ok", warnings: [], messages: [] });
  assert.equal((await outcome(withOrigin(siteA, ORIGIN), server("https://app.blocofy.other"))).code, "TARGET_SITE_MISMATCH");
  assert.equal((await outcome(withOrigin(siteA, "https://app.blocofy.test/"), server(ORIGIN))).code, "TARGET_SITE_MISMATCH", "no normalisation: exact equality");
  // 4. both null → ok, no warning.
  assert.deepEqual(await outcome(withOrigin(siteA, null), server(null)), { code: "ok", warnings: [], messages: [] });

  // The context record follows the same rule (a context verified against an old server, server upgraded since).
  const oldCtx = { name: "a", context: { ...ctx(siteA), platform_origin: null } };
  const ctxUp = await outcome(null, server(ORIGIN), oldCtx);
  assert.equal(ctxUp.code, "ok");
  assert.deepEqual(ctxUp.warnings, ["TARGET_CONTEXT_ORIGIN_MISSING"]);
  assert.equal((await outcome(null, server(undefined), { name: "a", context: ctx(siteA) })).code, "TARGET_UNVERIFIED");

  // Offline pre-check / resolution: a null on either record is not a mismatch (the remote check decides).
  assert.doesNotThrow(() => precheckContext({ binding: withOrigin(siteA, null), resolved: { name: "a", context: ctx(siteA) } }));
  const s = store({ a: ctx(siteA) });
  assert.equal((await resolveContext({ getStore: () => s, binding: withOrigin(siteA, null), commandClass: "remote-mutation" })).name, "a");
});

test("output: the target block format (site, platform, context + its source, binding, operation/mode), the error envelope, and secret redaction", () => {
  const t = targetData({ site: siteA, url: "https://alpha.test", platformOrigin: ORIGIN, contextName: "alpha", contextSource: ".blocofy/local.json", bindingLabel: ".blocofy/project.json", command: "pages push", mode: "live" });
  assert.equal(
    formatTargetBlock(t),
    [
      "Target:    Alpha · sA1 · alpha.myblocofy.test",
      `Platform:  ${ORIGIN}`,
      "Context:   alpha (from .blocofy/local.json)",
      "Binding:   .blocofy/project.json",
      "Operation: pages push · live",
    ].join("\n"),
  );
  assert.deepEqual(t, {
    site: { id: "sA1", slug: "alpha", name: "Alpha", domain: "alpha.myblocofy.test" },
    url: "https://alpha.test",
    platform_origin: ORIGIN,
    context: "alpha",
    context_source: ".blocofy/local.json",
    context_overrides: [],
    binding: ".blocofy/project.json",
    command: "pages push",
    mode: "live",
    operation: "pages push · live",
  });
  // An explicit --context names what it overrode; the default context and the env pair are labelled; a server
  // that reports no platform origin is said so (never blank).
  const over = targetData({ site: siteB, url: "https://beta.test", platformOrigin: null, contextName: "beta", contextSource: "--context", contextOverrides: [{ source: "BLOCOFY_CONTEXT", name: "a" }, { source: "env", name: "env" }], bindingLabel: "none", command: "status", mode: "read" });
  assert.match(formatTargetBlock(over), /^Platform:  \(not reported by the server\)$/m);
  assert.match(formatTargetBlock(over), /^Context:   beta \(from --context; overrides BLOCOFY_CONTEXT=a, env credentials\)$/m);
  assert.deepEqual(over.context_overrides, [{ source: "BLOCOFY_CONTEXT", context: "a" }, { source: "env", context: "env" }]);
  assert.match(formatTargetBlock(targetData({ site: siteA, url: null, platformOrigin: ORIGIN, contextName: "alpha", contextSource: "current_context", bindingLabel: "none", command: "status", mode: "read" })), /^Context:   alpha \(from default context \(blocofy use\)\)$/m);
  assert.match(formatTargetBlock(targetData({ site: siteB, url: "https://beta.test", platformOrigin: ORIGIN, contextName: "env", contextSource: "env", bindingLabel: "none (new pull)", command: "theme pull", mode: "live" })), /Beta · sB2 · https:\/\/beta\.test[\s\S]*Context:   env \(from env credentials\)/);
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

test("review I2: writeBinding never follows symlinks (the .blocofy dir or any of its three files); outside files untouched", () => {
  const outside = mkdtempSync(join(tmpdir(), "bcf-outside-"));
  dirs.push(outside);
  const victim = join(outside, "victim.txt");
  const site = { id: "sA1", slug: "alpha" };

  // .blocofy itself is a symlink to another directory.
  const r1 = mkdtempSync(join(tmpdir(), "bcf-link-"));
  dirs.push(r1);
  symlinkSync(outside, join(r1, ".blocofy"));
  assert.throws(() => writeBinding(r1, { site, platformOrigin: ORIGIN, contextName: "alpha" }), (e) => e.code === "TARGET_BINDING_INVALID");
  assert.equal(existsSync(join(outside, "project.json")), false, "wrote through a symlinked .blocofy");

  for (const name of ["project.json", "local.json", ".gitignore"]) {
    writeFileSync(victim, "ORIGINAL");
    const r = mkdtempSync(join(tmpdir(), "bcf-link-"));
    dirs.push(r);
    mkdirSync(join(r, ".blocofy"));
    symlinkSync(victim, join(r, ".blocofy", name));
    assert.throws(() => writeBinding(r, { site, platformOrigin: ORIGIN, contextName: "alpha" }), (e) => e.code === "TARGET_BINDING_INVALID", name);
    assert.equal(readFileSync(victim, "utf8"), "ORIGINAL", `${name}: a symlink target outside the project was overwritten`);
    assert.equal(existsSync(join(r, ".blocofy", "project.json")) && name !== "project.json", false, `${name}: nothing is written when any file is a symlink`);
  }

  // Normal case still works, atomically (no temp leftovers), and re-writing replaces the files.
  const ok = mkdtempSync(join(tmpdir(), "bcf-link-"));
  dirs.push(ok);
  writeBinding(ok, { site, platformOrigin: ORIGIN, contextName: "alpha" });
  writeBinding(ok, { site, platformOrigin: null, contextName: "alpha" });
  assert.deepEqual(JSON.parse(readFileSync(join(ok, ".blocofy", "project.json"), "utf8")).platform_origin, null);
  assert.deepEqual(readdirSync(join(ok, ".blocofy")).sort(), [".gitignore", "local.json", "project.json"]);
});
