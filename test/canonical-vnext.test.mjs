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
  return dir;
}

/** Fake platform: configurable GET body + POST responder; records every request. */
function fakePlatform({ getBody = { files: {}, protocol: 1 }, postResponder = null } = {}) {
  const seen = { gets: 0, posts: [], other: 0, whoami: 0 };
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url.includes("/api/dev/whoami")) {
      seen.whoami += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ site: { id: 14, slug: "ksc", name: "Ksc" }, liveThemeId: 9 }));
      return;
    }
    if (req.method === "GET" && req.url.includes("/api/dev/theme")) {
      seen.gets += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(getBody));
      return;
    }
    if (req.method === "POST" && req.url.endsWith("/api/dev/theme")) {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        seen.posts.push({ headers: req.headers, body: JSON.parse(body || "{}") });
        if (postResponder) return postResponder(res, seen.posts.length);
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
      // 0.5.0 canonical push = 2 POSTs per push (preflight dry-run + real), SAME key within a push.
      const keys = seen.posts.map((p) => p.headers["x-idempotency-key"]);
      assert.equal(keys.length, 4, "preflight + real per push");
      assert.equal(seen.posts[0].body.dryRun, true, "first POST of a push is the write-free preflight");
      for (const k of keys) {
        assert.match(k, /^cli-[0-9a-f-]{36}$/, "raw cli-<uuid> — the server namespaces with idem:, the CLI must not");
      }
      assert.equal(keys[0], keys[1], "preflight and real share ONE push-operation key");
      assert.equal(keys[2], keys[3], "second push likewise");
      assert.notEqual(keys[0], keys[2], "each push operation gets a FRESH key (a reused key would 409 after any settings/target change)");
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
          // n=1 preflight (dry) OK; n=2 real push 500 -> retry; n=3 real push OK.
          if (n === 1) {
            res.writeHead(200, { "content-type": "application/json" });
            return res.end(JSON.stringify({ ok: true, dryRun: true, warnings: [] }));
          }
          if (n === 2) return res.writeHead(500, { "content-type": "application/json" }).end("{}");
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, created: 1, updated: 0 }));
        },
      },
      async (url, seen) => {
        await pushTheme({ dir, url, token: TOKEN, draft: true, idempotencyKey: "cli-fixed-for-retry" });
        assert.equal(seen.posts.length, 3, "preflight + one retry after the 500");
        assert.deepEqual(
          seen.posts.map((p) => p.headers["x-idempotency-key"]),
          ["cli-fixed-for-retry", "cli-fixed-for-retry", "cli-fixed-for-retry"],
          "the key is stable across the preflight AND every transport retry of the real POST",
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
      { getBody: { files: { "section/Hero": "REMOTE", "section/Old": "OLD", "template/index.json": "{}", "README.md": "readme" }, protocol: 1 } },
      async (url, seen) => {
        const result = await pushTheme({ dir, url, token: TOKEN, draft: true, idempotencyKey: "cli-merge-1" });
        assert.equal(seen.gets, 1, "exactly one merge probe GET");
        assert.equal(seen.posts.length, 2, "preflight + real");
        assert.ok(!("section/Old" in seen.posts[0].body.files), "the preflight validates the LOCAL set only (before any provisioning)");
        const files = seen.posts[1].body.files;
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
        assert.equal(r.code, 1);
        assert.match(r.stderr, /npm i -g @blocofy\/cli@latest/);
        assert.match(r.stderr, /diff, target-instance/);
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
        assert.equal(r.code, 1);
        assert.match(r.stderr, /Idempotency çakışması/);
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

test("source oracles: the draft probe carries ?name=, and dev-server's sync stays keyless", async () => {
  const themeSync = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "lib", "theme-sync.mjs"), "utf8");
  assert.match(themeSync, /draft=1\$\{name \? `&name=/, "the merge probe forwards --name to the draft GET");
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
