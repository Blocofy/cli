import assert from "node:assert/strict";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { after, test } from "node:test";

import { fetchWhoami } from "../lib/theme-sync.mjs";

const execFileP = promisify(execFile);
const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "blocofy.mjs");

function themeFixture() {
  const dir = mkdtempSync(join(tmpdir(), "blocofy-cli-"));
  mkdirSync(join(dir, "layout"), { recursive: true });
  writeFileSync(join(dir, "layout", "theme.liquid"), "<html></html>");
  return dir;
}

/** Fake platform that records the /api/dev/theme push body and answers whoami. */
function fakePlatform() {
  const state = { pushBody: null };
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url.endsWith("/api/dev/whoami")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ site: { id: 14, slug: "ksc", name: "Ksc Metal" }, liveThemeId: 9 }));
      return;
    }
    if (req.method === "POST" && req.url.endsWith("/api/dev/theme")) {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        state.pushBody = JSON.parse(body || "{}");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify(
            state.pushBody.draft
              ? { ok: true, draft: true, instanceId: 77, created: 1, updated: 0 }
              : { ok: true, created: 1, updated: 0 },
          ),
        );
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return { server, state };
}

async function runPush(extraArgs) {
  const { server, state } = fakePlatform();
  server.listen(0);
  await once(server, "listening");
  const url = `http://localhost:${server.address().port}`;
  const dir = themeFixture();
  try {
    const { stdout } = await execFileP("node", [BIN, "theme", "push", dir, ...extraArgs], {
      env: { ...process.env, BLOCOFY_URL: url, BLOCOFY_TOKEN: "bcf_t" },
    });
    return { pushBody: state.pushBody, stdout };
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("fetchWhoami: GET /api/dev/whoami → token's real site (Bearer)", async () => {
  const fake = createServer((req, res) => {
    assert.equal(req.method, "GET");
    assert.equal(req.headers.authorization, "Bearer bcf_t");
    assert.ok(req.url.endsWith("/api/dev/whoami"));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ site: { id: 14, slug: "ksc", name: "Ksc Metal" }, liveThemeId: 9 }));
  });
  fake.listen(0);
  await once(fake, "listening");
  after(() => fake.close());

  const who = await fetchWhoami({ url: `http://localhost:${fake.address().port}`, token: "bcf_t" });
  assert.equal(who.site.slug, "ksc");
  assert.equal(who.site.name, "Ksc Metal");
});

test("theme push (no flags) writes to a DRAFT — never clobbers live by default", async () => {
  const { pushBody } = await runPush([]);
  assert.equal(pushBody.draft, true);
});

test("theme push --live writes to the live theme", async () => {
  const { pushBody } = await runPush(["--live"]);
  assert.equal(pushBody.draft, false);
});
