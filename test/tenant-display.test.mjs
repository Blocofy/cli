import assert from "node:assert/strict";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";

import { fetchWhoami } from "../lib/theme-sync.mjs";

const execFileP = promisify(execFile);
const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "blocofy.mjs");

/** Fake platform: answers /api/dev/whoami and records the /api/dev/theme push body. */
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
        res.end(JSON.stringify({ ok: true, draft: true, instanceId: 77, created: 1, updated: 0 }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return { server, state };
}

test("fetchWhoami: GET /api/dev/whoami → token's real site (Bearer)", async () => {
  const fake = createServer((req, res) => {
    assert.equal(req.headers.authorization, "Bearer bcf_t");
    assert.ok(req.url.endsWith("/api/dev/whoami"));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ site: { id: 14, slug: "ksc", name: "Ksc Metal" }, liveThemeId: 9 }));
  });
  fake.listen(0);
  await once(fake, "listening");
  try {
    const who = await fetchWhoami({ url: `http://localhost:${fake.address().port}`, token: "bcf_t" });
    assert.equal(who.site.slug, "ksc");
    assert.equal(who.site.name, "Ksc Metal");
  } finally {
    fake.close();
  }
});

test("login shows the token's real site (catches a wrong-tenant token)", async () => {
  const { server } = fakePlatform();
  server.listen(0);
  await once(server, "listening");
  const url = `http://localhost:${server.address().port}`;
  // Isolated HOME so the smoke test never clobbers the real ~/.blocofy/credentials.json.
  const home = mkdtempSync(join(tmpdir(), "blocofy-home-"));
  try {
    const { stdout } = await execFileP("node", [BIN, "login", "--url", url, "--token", "bcf_testtoken123"], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });
    assert.match(stdout, /Site:\s*Ksc Metal \(ksc\)/);
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("theme push --draft names the target tenant before writing", async () => {
  const { server, state } = fakePlatform();
  server.listen(0);
  await once(server, "listening");
  const url = `http://localhost:${server.address().port}`;
  const dir = mkdtempSync(join(tmpdir(), "blocofy-cli-"));
  mkdirSync(join(dir, "layout"), { recursive: true });
  writeFileSync(join(dir, "layout", "theme.liquid"), "<html></html>");
  try {
    const { stdout } = await execFileP("node", [BIN, "theme", "push", dir, "--draft"], {
      env: { ...process.env, BLOCOFY_URL: url, BLOCOFY_TOKEN: "bcf_t" },
    });
    assert.match(stdout, /Pushing to a draft of Ksc Metal \(ksc\)/);
    assert.equal(state.pushBody.draft, true);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
