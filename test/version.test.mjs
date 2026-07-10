import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const root = fileURLToPath(new URL("..", import.meta.url));
const pkgVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

test("--version matches package.json version", async () => {
  const { stdout } = await promisify(execFile)(process.execPath, [join(root, "bin", "blocofy.mjs"), "--version"]);
  assert.equal(stdout.trim(), pkgVersion);
});
