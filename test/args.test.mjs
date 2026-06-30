import assert from "node:assert/strict";
import { test } from "node:test";
import { parseArgs } from "../lib/args.mjs";

test("value flag tüketir, positional kalmaz: --port 3035", () => {
  const { flags, positionals } = parseArgs(["--port", "3035"]);
  assert.equal(flags.port, "3035");
  assert.deepEqual(positionals, []); // 3035 dizin sanılmaz (asıl bug)
});

test("positional + value flag birlikte: dir --port 3035", () => {
  const { flags, positionals } = parseArgs(["mydir", "--port", "3035"]);
  assert.equal(flags.port, "3035");
  assert.deepEqual(positionals, ["mydir"]);
});

test("boolean flag değer yutmaz: --draft mydir", () => {
  const { flags, positionals } = parseArgs(["--draft", "mydir"]);
  assert.equal(flags.draft, true);
  assert.deepEqual(positionals, ["mydir"]); // mydir flag değeri DEĞİL
});

test("instance value flag: --instance t7k2p9", () => {
  const { flags } = parseArgs(["--instance", "t7k2p9"]);
  assert.equal(flags.instance, "t7k2p9");
});

test("sondaki value flag değersizse boolean olur", () => {
  const { flags } = parseArgs(["--port"]);
  assert.equal(flags.port, true);
});
