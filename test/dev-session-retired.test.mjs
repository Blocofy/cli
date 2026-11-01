import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";

// 0.18.1: the platform retired the CLI remote preview (`/api/dev/session` answers 410). That is the expected answer
// now, so `theme dev` starts quietly; any other session failure still warns.

const execFileP = promisify(execFile);
const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "blocofy.mjs");
const TOKEN = "bcf_testtoken1234567890abcd";

function themeDir() {
  const dir = mkdtempSync(join(tmpdir(), "blocofy-session-"));
  mkdirSync(join(dir, "section"), { recursive: true });
  writeFileSync(join(dir, "section", "Hero.liquid"), "H");
  mkdirSync(join(dir, ".blocofy"), { recursive: true });
  writeFileSync(join(dir, ".blocofy", "project.json"), JSON.stringify({ schema_version: 1, site_id: 14, site_slug: "ksc", platform_origin: null }));
  return dir;
}

async function runDev(session) {
  const server = createServer((req, res) => {
    const json = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.url.includes("/api/dev/whoami")) return json(200, { site: { id: 14, slug: "ksc", name: "Ksc" }, liveThemeId: "t9live" });
    if (req.url.includes("/api/dev/site")) return json(200, { drafts: [] });
    if (req.url.includes("/api/dev/session")) return session(res, json);
    if (req.url.includes("/api/dev/theme")) return json(200, { files: {}, protocol: 1 });
    res.writeHead(404).end();
  });
  server.listen(0);
  await once(server, "listening");
  try {
    const url = `http://localhost:${server.address().port}`;
    return await execFileP("node", [BIN, "theme", "dev", themeDir(), "--instance", "t43cli", "--dry"], {
      env: { ...process.env, BLOCOFY_URL: url, BLOCOFY_TOKEN: TOKEN },
    }).then(
      (r) => ({ code: 0, ...r }),
      (e) => ({ code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" }),
    );
  } finally {
    server.close();
  }
}

test("theme dev: a retired session (410 with a body) is expected and prints no warning", async () => {
  const r = await runDev((res, json) => json(410, { error: "CLI remote preview has been retired on this server.", code: "cli_remote_preview_retired" }));
  assert.equal(r.code, 0, r.stderr);
  assert.doesNotMatch(r.stdout + r.stderr, /dev session unavailable/);
  assert.doesNotMatch(r.stdout + r.stderr, /retired/);
});

test("theme dev: a retired session (410 without a body) prints no warning either", async () => {
  const r = await runDev((res) => res.writeHead(410).end());
  assert.equal(r.code, 0, r.stderr);
  assert.doesNotMatch(r.stdout + r.stderr, /dev session unavailable/);
});

test("theme dev: any other session failure still warns", async () => {
  const r = await runDev((res, json) => json(500, { error: "boom" }));
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /dev session unavailable \(boom\)/);
});
