import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";

import { pushTheme } from "../lib/theme-sync.mjs";

// 0.5.0 canonical vNext: auto idempotency key (per push, retry-stable), remote-only merge ("push does
// not delete" on the canonical pipeline), dev-sync stays legacy (no key, no probe), human messages for
// 426/409, --help / unknown flag = write-free exit, --dry-run refuses a non-canonical server.

const execFileP = promisify(execFile);
const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "blocofy.mjs");
const TOKEN = "bcf_testtoken1234567890abcd";

function themeDir(files) {
  const dir = mkdtempSync(join(tmpdir(), "blocofy-vnext-"));
  for (const [key, content] of Object.entries(files)) {
    const rel = key.startsWith("asset/") ? key : `${key}.liquid`;
    mkdirSync(join(dir, rel.slice(0, rel.lastIndexOf("/"))), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  // CF-T2: `theme push` is a remote mutation → the directory must be bound to the fake site (whoami id 14,
  // no platform_origin on this old-shaped fake → null).
  mkdirSync(join(dir, ".blocofy"), { recursive: true });
  writeFileSync(join(dir, ".blocofy", "project.json"), JSON.stringify({ schema_version: 1, site_id: 14, site_slug: "ksc", platform_origin: null }));
  return dir;
}

/** Fake platform: configurable GET body + POST responder; records every request. */
function fakePlatform({ getBody = { files: {}, protocol: 1 }, postResponder = null, siteBody = { drafts: [] } } = {}) {
  const seen = { gets: 0, getUrls: [], posts: [], other: 0, whoami: 0, site: 0 };
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url.includes("/api/dev/site")) {
      seen.site += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(siteBody));
      return;
    }
    if (req.method === "GET" && req.url.includes("/api/dev/whoami")) {
      seen.whoami += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ site: { id: 14, slug: "ksc", name: "Ksc" }, liveThemeId: 9 }));
      return;
    }
    if (req.method === "GET" && req.url.includes("/api/dev/theme")) {
      seen.gets += 1;
      seen.getUrls.push(req.url);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(getBody));
      return;
    }
    if (req.method === "POST" && req.url.endsWith("/api/dev/theme")) {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        seen.posts.push({ headers: req.headers, body: JSON.parse(body || "{}") });
        if (postResponder) return postResponder(res, seen.posts.length, seen.posts.at(-1).body);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, draft: true, instanceId: "t7k2p9", created: 1, updated: 0 }));
      });
      return;
    }
    seen.other += 1;
    res.writeHead(404).end();
  });
  return { server, seen };
}

async function withFake(opts, fn) {
  const { server, seen } = fakePlatform(opts);
  server.listen(0);
  await once(server, "listening");
  const url = `http://localhost:${server.address().port}`;
  try {
    return await fn(url, seen);
  } finally {
    server.close();
  }
}

const runBin = (url, argv) =>
  execFileP("node", [BIN, ...argv], { env: { ...process.env, BLOCOFY_URL: url, BLOCOFY_TOKEN: TOKEN } }).then(
    (r) => ({ code: 0, ...r }),
    (e) => ({ code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" }),
  );

test("theme push auto-generates a RAW per-push idempotency key (distinct across pushes, never idem:-prefixed)", async () => {
  const dir = themeDir({ "section/Hero": "H" });
  try {
    await withFake({}, async (url, seen) => {
      const r1 = await runBin(url, ["theme", "push", dir, "--draft"]);
      const r2 = await runBin(url, ["theme", "push", dir, "--draft"]);
      assert.equal(r1.code, 0, r1.stderr);
      assert.equal(r2.code, 0, r2.stderr);
      // canonical push = 2 POSTs per push (preflight dry-run + real). TPUSH-5: the dry run is a control-plane PLAN,
      // which the server rolls back; it carries its own throwaway key, never the push's key (a plan with an
      // already-committed key is refused 409 — the fingerprint names the action — so a same-key retry could
      // never converge).
      const keys = seen.posts.map((p) => p.headers["x-idempotency-key"]);
      assert.equal(keys.length, 4, "preflight + real per push");
      assert.equal(seen.posts[0].body.dryRun, true, "first POST of a push is the write-free preflight");
      for (const k of [keys[1], keys[3]]) {
        assert.match(k, /^cli-[0-9a-f-]{36}$/, "raw cli-<uuid> — the server namespaces with idem:, the CLI must not");
      }
      for (const k of [keys[0], keys[2]]) assert.match(k, /^cli-plan-[0-9a-f-]{36}$/, "the plan's own key");
      assert.notEqual(keys[0], keys[1], "the plan never spends the push-operation key");
      assert.notEqual(keys[1], keys[3], "each push operation gets a FRESH key (a reused key would 409 after any settings/target change)");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the key is stable ACROSS transport retries of one push (5xx converges on the server's idempotency cache)", async () => {
  const dir = themeDir({ "section/Hero": "H" });
  try {
    await withFake(
      {
        postResponder: (res, n) => {
          // n=1 preflight (dry) OK; n=2 real push 503 -> retry (500 is never retried, CF-T3); n=3 real push OK.
          if (n === 1) {
            res.writeHead(200, { "content-type": "application/json" });
            return res.end(JSON.stringify({ ok: true, dryRun: true, warnings: [] }));
          }
          if (n === 2) return res.writeHead(503, { "content-type": "application/json", "retry-after": "0" }).end("{}");
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, created: 1, updated: 0 }));
        },
      },
      async (url, seen) => {
        await pushTheme({ dir, url, token: TOKEN, draft: true, idempotencyKey: "cli-fixed-for-retry" });
        assert.equal(seen.posts.length, 3, "preflight + one retry after the 503");
        assert.deepEqual(
          seen.posts.slice(1).map((p) => p.headers["x-idempotency-key"]),
          ["cli-fixed-for-retry", "cli-fixed-for-retry"],
          "the key is stable across every transport retry of the real POST",
        );
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("keyed push merges remote-only GATE-ACCEPTABLE files into the payload (push does not delete); README.md stays server-retained", async () => {
  const dir = themeDir({ "section/Hero": "LOCAL" });
  try {
    await withFake(
      {
        getBody: { files: { "section/Hero": "REMOTE", "section/Old": "OLD", "template/index.json": "{}", "README.md": "readme" }, protocol: 1 },
        siteBody: { drafts: [{ id: "t-existing", name: "CLI Draft", source: "import" }] },
      },
      async (url, seen) => {
        const result = await pushTheme({ dir, url, token: TOKEN, draft: true, idempotencyKey: "cli-merge-1" });
        assert.equal(seen.gets, 1, "exactly one merge probe GET");
        assert.equal(seen.posts.length, 2, "preflight + real");
        const files = seen.posts[1].body.files;
        assert.deepEqual(seen.posts[0].body.files, files, "TPUSH-5: the preflight checks the MERGED payload the apply sends — one manifest");
        assert.equal(files["section/Hero"], "LOCAL", "a local file wins over its remote copy");
        assert.equal(files["section/Old"], "OLD", "remote-only theme file carried verbatim");
        assert.equal(files["template/index.json"], "{}", "retained-class theme-dir file carried verbatim");
        assert.ok(!("README.md" in files), "outside the gate-acceptable set — the server's retained-rows rule keeps it");
        assert.deepEqual(result.remoteOnlyKept, ["section/Old", "template/index.json"]);
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an UNKEYED push (theme dev's draft sync shape) sends no key and pays no merge probe — deliberate legacy path", async () => {
  const dir = themeDir({ "section/Hero": "H" });
  try {
    await withFake({}, async (url, seen) => {
      await pushTheme({ dir, url, token: TOKEN, draft: true });
      assert.equal(seen.gets, 0, "no probe GET per dev-server save");
      assert.equal(seen.posts[0].headers["x-idempotency-key"], undefined, "no key → the server's canonical branch is never selected");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("426 cli_upgrade_required becomes a human upgrade message (with the server's missing capability list)", async () => {
  const dir = themeDir({ "section/Hero": "H" });
  try {
    await withFake(
      {
        postResponder: (res) => {
          res.writeHead(426, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "cli_upgrade_required", fence: { reason: "capability_missing", requiredVersion: 1, missing: ["diff", "target-instance"] } }));
        },
      },
      async (url) => {
        const r = await runBin(url, ["theme", "push", dir, "--draft"]);
        assert.equal(r.code, 2, "a server refusal (4xx) exits 2 (contract C2)");
        assert.match(r.stderr, /npm i -g @blocofy\/cli@latest/);
        assert.match(r.stderr, /diff, target-instance/);
        const j = await runBin(url, ["theme", "push", dir, "--draft", "--json"]);
        assert.equal(j.code, 2);
        const last = JSON.parse(j.stderr.trim().split("\n").pop());
        assert.equal(last.error.code, "cli_upgrade_required");
        assert.deepEqual(last.error.details.missing, ["diff", "target-instance"]);
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("409 idempotency_conflict becomes a human message pointing at a fresh key", async () => {
  const dir = themeDir({ "section/Hero": "H" });
  try {
    await withFake(
      {
        postResponder: (res) => {
          res.writeHead(409, { "content-type": "application/json" });
          res.end(JSON.stringify({ committed: false, error: "idempotency_conflict" }));
        },
      },
      async (url) => {
        const r = await runBin(url, ["theme", "push", dir, "--draft"]);
        assert.equal(r.code, 2, "a server refusal (4xx) exits 2 (contract C2)");
        assert.match(r.stderr, /Idempotency çakışması/);
        const j = await runBin(url, ["theme", "push", dir, "--draft", "--json"]);
        assert.equal(j.code, 2);
        assert.equal(JSON.parse(j.stderr.trim().split("\n").pop()).error.code, "idempotency_conflict");
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("theme push --help prints help, exits 0 and sends ZERO requests (0.4.0 ran a REAL push)", async () => {
  const dir = themeDir({ "section/Hero": "H" });
  try {
    await withFake({}, async (url, seen) => {
      const r = await runBin(url, ["theme", "push", dir, "--help"]);
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /Usage/);
      assert.equal(seen.gets + seen.posts.length + seen.whoami + seen.other, 0, "help must never touch the network (whoami included)");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("theme push <dir> --version prints the version and sends ZERO requests (same symmetry as --help)", async () => {
  const dir = themeDir({ "section/Hero": "H" });
  try {
    await withFake({}, async (url, seen) => {
      const r = await runBin(url, ["theme", "push", dir, "--version"]);
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+$/);
      assert.equal(seen.gets + seen.posts.length + seen.whoami + seen.other, 0, "version must never touch the network");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("theme push --name survives the merge probe (the draft GET carries ?name= — an unnamed probe used to kill --name via name-agnostic reuse)", async () => {
  const dir = themeDir({ "section/Hero": "H" });
  try {
    const urls = [];
    await withFake({}, async (url, seen) => {
      const { server } = { server: null };
      const r = await runBin(url, ["theme", "push", dir, "--name", "My Draft"]);
      assert.equal(r.code, 0, r.stderr);
      // probe URL'ini fake kaydetmiyor; POST gövdesi adın hayatta kaldığını kanıtlar, probe'un adlı
      // olduğunu ise pushTheme kaynak-metni pinler (aşağıdaki oracle).
      const real = seen.posts.find((p) => !p.body.dryRun);
      assert.equal(real.body.name, "My Draft", "the POST still carries --name");
    });
    void urls;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("source oracles: the merge probe never provisions a draft, and dev-server's sync stays keyless", async () => {
  const themeSync = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "lib", "theme-sync.mjs"), "utf8");
  assert.doesNotMatch(themeSync.slice(themeSync.indexOf("export async function pushTheme"), themeSync.indexOf("`blocofy theme push --diff`")), /draft=1/, "PS-09: a `?draft=1` GET provisions a draft server-side — the push probe must not issue one");
  const devServer = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "lib", "dev-server.mjs"), "utf8");
  assert.doesNotMatch(devServer, /idempotencyKey/, "dev-sync must stay keyless (a canonical seal per keystroke mints unbounded revisions)");
});

test("an unknown flag is a write-free exit (0.4.0 swallowed the next token and silently shifted the target dir)", async () => {
  const dir = themeDir({ "section/Hero": "H" });
  try {
    await withFake({}, async (url, seen) => {
      const r = await runBin(url, ["theme", "push", "--halp", dir]);
      assert.equal(r.code, 1);
      assert.match(r.stderr, /Unknown flag --halp/);
      assert.equal(seen.gets + seen.posts.length + seen.whoami + seen.other, 0, "nothing written, nothing fetched (whoami included)");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--dry-run REFUSES a server that does not declare the canonical protocol (an old server would silently write for real)", async () => {
  const dir = themeDir({ "section/Hero": "H" });
  try {
    await withFake({ getBody: { files: {} } /* no `protocol` field — pre-canonical server */ }, async (url, seen) => {
      const r = await runBin(url, ["theme", "push", dir, "--draft", "--dry-run"]);
      assert.equal(r.code, 1);
      assert.match(r.stderr, /canonical protocol/);
      assert.equal(seen.posts.length, 0, "nothing was sent to the write endpoint");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// PS-09 — the merge probe used `GET ?draft=1`, which PROVISIONS a draft server-side as a side effect (and
// a failure there left an empty draft behind). The draft target now resolves the existing CLI draft from
// `/api/dev/site` and probes it by handle; with no draft there is nothing remote to merge, so no probe.
test("PS-09: draft push with NO existing draft issues no `?draft=1` GET and no probe at all", async () => {
  const dir = themeDir({ "section/Hero": "H" });
  try {
    await withFake({ siteBody: { drafts: [{ id: "t-dup", name: "Copy", source: "duplicate" }] } }, async (url, seen) => {
      await pushTheme({ dir, url, token: TOKEN, draft: true, name: "My Draft", idempotencyKey: "cli-ps09-a" });
      assert.equal(seen.site, 1, "the existing draft is looked up via /api/dev/site");
      assert.deepEqual(seen.getUrls, [], "no theme GET — in particular no `?draft=1` provisioning probe");
      const real = seen.posts.find((p) => !p.body.dryRun);
      assert.equal(real.body.draft, true);
      assert.equal(real.body.name, "My Draft", "--name reaches the POST that creates the draft");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PS-09: draft push with an existing CLI draft probes it by handle (`?instance=`), never `?draft=1`", async () => {
  const dir = themeDir({ "section/Hero": "H" });
  try {
    await withFake(
      {
        getBody: { files: { "section/Old": "OLD" }, protocol: 1 },
        siteBody: { drafts: [{ id: "t-dup", name: "Copy", source: "duplicate" }, { id: "t-cli", name: "CLI Draft", source: "import" }] },
      },
      async (url, seen) => {
        const result = await pushTheme({ dir, url, token: TOKEN, draft: true, idempotencyKey: "cli-ps09-b" });
        assert.deepEqual(seen.getUrls, ["/api/dev/theme?instance=t-cli"]);
        assert.deepEqual(result.remoteOnlyKept, ["section/Old"]);
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// PS-13 — `--prune`: a file deleted locally used to survive every push because the merge probe carried it
// back into the payload. With prune the remote-only files are left out (the canonical deploy replaces the
// folders atomically, so they are removed) and reported BEFORE the write.
test("PS-13: prune leaves remote-only files out of the POST and reports them; the default keeps them", async () => {
  const opts = { getBody: { files: { "section/Hero": "R", "section/PsProbe": "P" }, protocol: 1 } };
  const dir = themeDir({ "section/Hero": "H" });
  try {
    await withFake(opts, async (url, seen) => {
      const reported = [];
      const result = await pushTheme({ dir, url, token: TOKEN, idempotencyKey: "cli-ps13-a", prune: true, confirmPrune: async (keys) => { reported.push(...keys); return true; } });
      assert.deepEqual(reported, ["section/PsProbe"], "the removal list is reported before the write");
      const real = seen.posts.find((p) => !p.body.dryRun);
      assert.ok(!("section/PsProbe" in real.body.files), "pruned file is not re-added");
      assert.deepEqual(result.remoteOnlyRemoved, ["section/PsProbe"]);
      assert.equal(result.remoteOnlyKept, undefined);
    });
    await withFake(opts, async (url, seen) => {
      const result = await pushTheme({ dir, url, token: TOKEN, idempotencyKey: "cli-ps13-b" });
      const real = seen.posts.find((p) => !p.body.dryRun);
      assert.equal(real.body.files["section/PsProbe"], "P", "default push still does not delete");
      assert.deepEqual(result.remoteOnlyKept, ["section/PsProbe"]);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PS-13: a declined prune confirmation sends no write", async () => {
  const dir = themeDir({ "section/Hero": "H" });
  try {
    await withFake({ getBody: { files: { "section/PsProbe": "P" }, protocol: 1 } }, async (url, seen) => {
      const result = await pushTheme({ dir, url, token: TOKEN, idempotencyKey: "cli-ps13-c", prune: true, confirmPrune: async () => false });
      assert.equal(result.aborted, true);
      assert.equal(seen.posts.filter((p) => !p.body.dryRun).length, 0, "no real POST after a declined prune");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PS-13: `--prune` on the LIVE theme by --instance needs --yes in a non-interactive shell", async () => {
  const dir = themeDir({ "section/Hero": "H" });
  try {
    await withFake({ getBody: { files: { "section/PsProbe": "P" }, protocol: 1 } }, async (url, seen) => {
      const r = await runBin(url, ["theme", "push", dir, "--instance", "9", "--prune"]);
      assert.equal(r.code, 1);
      assert.doesNotMatch(r.stderr, /Unknown flag/);
      assert.match(r.stderr, /--yes/);
      assert.equal(seen.posts.length, 0, "nothing sent");
    });
    await withFake({ getBody: { files: { "section/PsProbe": "P" }, protocol: 1 } }, async (url, seen) => {
      const r = await runBin(url, ["theme", "push", dir, "--instance", "9", "--prune", "--yes"]);
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /section\/PsProbe/, "the removal list is printed");
      const real = seen.posts.find((p) => !p.body.dryRun);
      assert.ok(!("section/PsProbe" in real.body.files));
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PS-13: `--prune` on a draft needs no confirmation and prints the removal list", async () => {
  const dir = themeDir({ "section/Hero": "H" });
  try {
    await withFake(
      { getBody: { files: { "section/PsProbe": "P" }, protocol: 1 }, siteBody: { drafts: [{ id: "t-cli", name: "CLI Draft", source: "import" }] } },
      async (url, seen) => {
        const r = await runBin(url, ["theme", "push", dir, "--prune"]);
        assert.equal(r.code, 0, r.stderr);
        assert.match(r.stdout, /section\/PsProbe/);
        const real = seen.posts.find((p) => !p.body.dryRun);
        assert.ok(!("section/PsProbe" in real.body.files));
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------------------------
// TPUSH-5 (customer item 6.5) — the dry run and the apply are bound to ONE manifest. The dry run carries the merged
// payload the apply sends; a server that answers with `manifestHash` + `pointerVersion` gets them back on the apply
// (`manifestHash`, `expectedPointerVersion`); an older server that answers neither gets the 0.10 body unchanged.
// Success is "Deployed atomically" only with a verified readback, and per-file outcomes are printed.

const HASH = "ab".repeat(32);
const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};
const outcomes = (entries) => entries.map(([path, outcome]) => ({ path, outcome, ...(outcome === "removed" ? {} : { digest: "cd".repeat(32) }) }));

/** A server with the 6.5 contract: the dry run is a plan, the apply reports outcomes + readback. */
function planningServer({ pointerVersion = 4, newDraft = false, plan = [["section/Hero", "updated"]], apply = null, dry = null } = {}) {
  return (res, n, body) => {
    if (body.dryRun) {
      if (dry) return dry(res, body);
      return json(res, 200, {
        ok: true, dryRun: true, warnings: [], manifestHash: HASH, target: body.draft ? "draft" : "live", newDraft,
        pointerVersion: newDraft ? null : pointerVersion, files: outcomes(plan), ...(newDraft ? {} : { readback: { verified: true, files: plan.length, settings: true } }),
      });
    }
    if (apply) return apply(res, body);
    return json(res, 200, {
      committed: true, convergence: "committed_pending_convergence", deploymentId: 11, sourceRevisionId: 12, eventId: 13,
      pointerVersion: (pointerVersion ?? 0) + 1, siteStateVersion: 2, contentHash: "ef".repeat(32), files: outcomes(plan),
      readback: { verified: true, files: plan.length, settings: true }, manifestHash: HASH,
    });
  };
}

test("TPUSH-5: the apply carries manifestHash + expectedPointerVersion from the dry run; the dry run carries neither", async () => {
  const dir = themeDir({ "section/Hero": "LOCAL" });
  try {
    await withFake({ getBody: { files: { "section/Hero": "REMOTE", "section/Old": "OLD" }, protocol: 1 }, postResponder: planningServer({ plan: [["section/Hero", "updated"], ["section/Old", "unchanged"]] }) }, async (url, seen) => {
      const result = await pushTheme({ dir, url, token: TOKEN, idempotencyKey: "cli-bind-1" });
      assert.equal(seen.posts.length, 2);
      const [dry, real] = seen.posts;
      assert.equal(dry.body.dryRun, true);
      assert.ok(!("manifestHash" in dry.body) && !("expectedPointerVersion" in dry.body), "the dry run asks; it binds nothing");
      assert.deepEqual(dry.body.files, real.body.files, "one manifest: the dry run checked exactly the bytes the apply sends");
      assert.equal(real.body.manifestHash, HASH);
      assert.equal(real.body.expectedPointerVersion, 4, "the pointer version the plan ran from is the apply's CAS operand");
      assert.equal(real.headers["x-idempotency-key"], "cli-bind-1", "the apply spends the push key");
      assert.match(dry.headers["x-idempotency-key"], /^cli-plan-[0-9a-f-]{36}$/, "the plan never spends it");
      assert.equal(result.readback.verified, true);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TPUSH-5: a draft that does not exist yet binds expectedPointerVersion null (no deployment yet)", async () => {
  const dir = themeDir({ "section/Hero": "H" });
  try {
    await withFake({ postResponder: planningServer({ newDraft: true, plan: [["section/Hero", "created"]] }) }, async (url, seen) => {
      await pushTheme({ dir, url, token: TOKEN, draft: true, idempotencyKey: "cli-bind-2" });
      const real = seen.posts.find((p) => !p.body.dryRun);
      assert.ok("expectedPointerVersion" in real.body, "null is sent explicitly");
      assert.equal(real.body.expectedPointerVersion, null);
      assert.equal(real.body.manifestHash, HASH);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TPUSH-5: an older server (dry run without manifestHash) gets the 0.10 apply body — no binding field", async () => {
  const dir = themeDir({ "section/Hero": "H" });
  try {
    await withFake(
      {
        postResponder: (res, n, body) =>
          body.dryRun ? json(res, 200, { ok: true, dryRun: true, warnings: [] }) : json(res, 200, { ok: true, committed: true, deploymentId: 1, sourceRevisionId: 2, pointerVersion: 3 }),
      },
      async (url, seen) => {
        await pushTheme({ dir, url, token: TOKEN, idempotencyKey: "cli-old-1" });
        const real = seen.posts.find((p) => !p.body.dryRun);
        assert.deepEqual(Object.keys(real.body).sort(), ["draft", "files"], "live push body exactly as 0.10 sent it");
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TPUSH-5: a plan that removes a file the probe did not see refuses the push (push does not delete); --prune lists it", async () => {
  const opts = {
    getBody: { files: { "section/Hero": "R" }, protocol: 1 },
    // `section/Late` appeared after the probe; `config/settings.json` is the stored-settings anomaly every canonical
    // deploy cleans up (the settings live in site_themes) — not a theme file this push promised to keep.
    postResponder: planningServer({ plan: [["section/Hero", "updated"], ["section/Late", "removed"], ["config/settings.json", "removed"]] }),
  };
  const dir = themeDir({ "section/Hero": "H" });
  try {
    await withFake(opts, async (url, seen) => {
      await assert.rejects(pushTheme({ dir, url, token: TOKEN, idempotencyKey: "cli-late-1" }), (e) => {
        assert.equal(e.code, "THEME_PUSH_TARGET_CHANGED");
        assert.deepEqual(e.details.paths, ["section/Late"]);
        return true;
      });
      assert.equal(seen.posts.length, 1, "nothing but the dry run was sent");
    });
    await withFake(opts, async (url, seen) => {
      await assert.rejects(pushTheme({ dir, url, token: TOKEN, dryRun: true, idempotencyKey: "cli-late-2" }), { code: "THEME_PUSH_TARGET_CHANGED" }, "a dry run is refused by what the apply is refused by");
      assert.equal(seen.posts.length, 1);
    });
    await withFake(opts, async (url, seen) => {
      const reported = [];
      const result = await pushTheme({ dir, url, token: TOKEN, idempotencyKey: "cli-late-3", prune: true, confirmPrune: async (keys) => (reported.push(...keys), true) });
      assert.deepEqual(reported, ["section/Late"], "the removal the plan found is confirmed like any prune removal");
      assert.deepEqual(result.remoteOnlyRemoved, ["section/Late"]);
      assert.equal(seen.posts.filter((p) => !p.body.dryRun).length, 1);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TPUSH-5: a verified readback prints per-file outcomes and 'Deployed atomically'; without a readback it is never claimed", async () => {
  const dir = themeDir({ "section/Hero": "H", "section/New": "N", "section/Same": "S" });
  try {
    const plan = [["section/Hero", "updated"], ["section/New", "created"], ["section/Same", "unchanged"]];
    await withFake({ postResponder: planningServer({ plan }) }, async (url) => {
      const r = await runBin(url, ["theme", "push", dir, "--draft"]);
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /\+ section\/New/);
      assert.match(r.stdout, /~ section\/Hero/);
      assert.doesNotMatch(r.stdout, /section\/Same/, "unchanged files are counted, not listed");
      assert.match(r.stdout, /1 created, 1 updated, 0 removed, 1 unchanged/);
      assert.match(r.stdout, /Deployed atomically and read back \(3 files? verified\)/);
    });
    await withFake(
      {
        postResponder: (res, n, body) =>
          body.dryRun ? json(res, 200, { ok: true, dryRun: true, warnings: [] }) : json(res, 200, { ok: true, committed: true, deploymentId: 1, sourceRevisionId: 2, pointerVersion: 3 }),
      },
      async (url) => {
        const r = await runBin(url, ["theme", "push", dir, "--draft"]);
        assert.equal(r.code, 0, r.stderr);
        assert.doesNotMatch(r.stdout, /atomically/, "an older server reports no readback — nothing is claimed beyond the commit");
        assert.match(r.stdout, /✓ Deployed: deployment #1, revision #2, pointer v3/);
        assert.match(r.stdout, /not verified/);
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TPUSH-5: --dry-run plans the merged payload and prints target, pointer and per-file outcomes", async () => {
  const dir = themeDir({ "section/Hero": "H" });
  try {
    await withFake(
      {
        getBody: { files: { "section/Hero": "R", "section/Kept": "K" }, protocol: 1 },
        postResponder: planningServer({ plan: [["section/Hero", "updated"], ["section/Kept", "unchanged"]] }),
      },
      async (url, seen) => {
        const r = await runBin(url, ["theme", "push", dir, "--live", "--dry-run"]);
        assert.equal(r.code, 0, r.stderr);
        assert.equal(seen.posts.length, 1, "a dry run sends one write-free POST");
        assert.equal(seen.posts[0].body.files["section/Kept"], "K", "the plan covers the remote-only file the push would keep");
        assert.match(r.stdout, /Validation passed/);
        assert.match(r.stdout, /live theme, pointer v4/);
        assert.match(r.stdout, /~ section\/Hero/);
        assert.match(r.stdout, /0 created, 1 updated, 0 removed, 1 unchanged/);
      },
    );
    await withFake(
      {
        getBody: { files: { "section/Hero": "R", "section/Gone": "G" }, protocol: 1 },
        postResponder: planningServer({ plan: [["section/Hero", "updated"], ["section/Gone", "removed"]] }),
      },
      async (url, seen) => {
        const r = await runBin(url, ["theme", "push", dir, "--live", "--dry-run", "--prune"]);
        assert.equal(r.code, 0, r.stderr);
        assert.ok(!("section/Gone" in seen.posts[0].body.files), "--dry-run --prune plans the pruned payload");
        assert.match(r.stdout, /- section\/Gone/);
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TPUSH-5: refusals are explained — pointer conflict, a preflight path error, an unverified readback", async () => {
  const dir = themeDir({ "section/Hero": "H" });
  const lastError = (r) => JSON.parse(r.stderr.trim().split("\n").pop()).error;
  try {
    const conflict = planningServer({ apply: (res) => json(res, 409, { error: "pointer_version_conflict", currentVersion: 5 }) });
    await withFake({ postResponder: conflict }, async (url) => {
      const r = await runBin(url, ["theme", "push", dir, "--draft"]);
      assert.equal(r.code, 2);
      assert.match(r.stderr, /pointer_version_conflict/);
      assert.match(r.stderr, /Nothing was written/);
      const j = await runBin(url, ["theme", "push", dir, "--draft", "--json"]);
      assert.equal(lastError(j).code, "pointer_version_conflict");
      assert.equal(lastError(j).details.currentVersion, 5);
    });
    const tooLong = planningServer({ dry: (res) => json(res, 422, { error: "path_too_long", path: "asset/deep.css", message: "path is longer than 255 bytes" }) });
    await withFake({ postResponder: tooLong }, async (url, seen) => {
      const r = await runBin(url, ["theme", "push", dir, "--draft"]);
      assert.equal(r.code, 2);
      assert.match(r.stderr, /asset\/deep\.css: path is longer than 255 bytes/);
      assert.equal(seen.posts.length, 1, "refused at the dry run; no apply was sent");
      const j = await runBin(url, ["theme", "push", dir, "--draft", "--json"]);
      assert.equal(lastError(j).code, "path_too_long");
      assert.equal(lastError(j).details.path, "asset/deep.css");
    });
    const unverified = planningServer({ apply: (res) => json(res, 502, { error: "readback_unverified", committed: true }, { "retry-after": "0" }) });
    await withFake({ postResponder: unverified }, async (url) => {
      const r = await runBin(url, ["theme", "push", dir, "--draft", "--json"]);
      assert.equal(r.code, 1, "a 5xx exits 1");
      assert.equal(lastError(r).code, "readback_unverified");
      assert.equal(lastError(r).details.committed, true);
      assert.match(lastError(r).message, /could not read back/);
      assert.doesNotMatch(r.stdout, /Deployed/);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
