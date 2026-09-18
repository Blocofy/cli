import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { localPathFor } from "../lib/local-theme.mjs";
import {
  fetchDevSession,
  fetchSiteStatus,
  publishInstance,
  pullTheme,
  pushTheme,
  renameInstance,
} from "../lib/theme-sync.mjs";

test("pushTheme: retries a transient 503 then succeeds; onRetry fired", async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  const retries = [];
  globalThis.fetch = async () => {
    calls += 1;
    return calls === 1
      ? new Response("busy", { status: 503 })
      : new Response(JSON.stringify({ ok: true, created: 1, updated: 0 }), { status: 200 });
  };
  const dir = mkdtempSync(join(tmpdir(), "blocofy-retry-"));
  mkdirSync(join(dir, "section"), { recursive: true });
  writeFileSync(join(dir, "section", "Hero.liquid"), "H");
  after(() => {
    globalThis.fetch = realFetch;
    rmSync(dir, { recursive: true, force: true });
  });

  const result = await pushTheme({
    dir,
    url: "http://localhost:1",
    token: "bcf_t",
    onRetry: (i) => retries.push(i),
  });
  assert.equal(result.created, 1);
  assert.equal(calls, 2);
  assert.equal(retries.length, 1);
});

test("publishInstance: POST /api/dev/publish {instanceId} → result (Bearer)", async () => {
  let seen = null;
  const fake = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      seen = { method: req.method, auth: req.headers.authorization, url: req.url, body: JSON.parse(body || "{}") };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, published: 20, cloned: true }));
    });
  });
  fake.listen(0);
  await once(fake, "listening");
  after(() => fake.close());

  const r = await publishInstance({ url: `http://localhost:${fake.address().port}`, token: "bcf_t", instanceId: 20 });
  assert.equal(r.published, 20);
  assert.equal(r.cloned, true);
  assert.equal(seen.method, "POST");
  assert.ok(seen.url.endsWith("/api/dev/publish"));
  assert.equal(seen.auth, "Bearer bcf_t");
  assert.equal(seen.body.instanceId, 20);
});

test("publishInstance: sunucu 409 → throw (error metni)", async () => {
  const fake = createServer((req, res) => {
    res.writeHead(409, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Yayınlanacak temada sayfa yok." }));
  });
  fake.listen(0);
  await once(fake, "listening");
  after(() => fake.close());
  await assert.rejects(
    publishInstance({ url: `http://localhost:${fake.address().port}`, token: "bcf_t", instanceId: 20 }),
    /sayfa yok/,
  );
});

test("fetchSiteStatus: GET /api/dev/site → health JSON", async () => {
  const fake = createServer((req, res) => {
    assert.equal(req.method, "GET");
    assert.ok(req.url.endsWith("/api/dev/site"));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        site: { id: 14, slug: "testsite" }, health: "ok", pages_on_live: 12,
        live_theme_instance: { id: 19, name: "Canlı", template_count: 5 }, drafts: [],
      }),
    );
  });
  fake.listen(0);
  await once(fake, "listening");
  after(() => fake.close());
  const s = await fetchSiteStatus({ url: `http://localhost:${fake.address().port}`, token: "bcf_t" });
  assert.equal(s.health, "ok");
  assert.equal(s.pages_on_live, 12);
  assert.equal(s.live_theme_instance.id, 19);
});

test("fetchDevSession: GET /api/dev/session → session JSON (Bearer)", async () => {
  const fake = createServer((req, res) => {
    assert.equal(req.method, "GET");
    assert.equal(req.headers.authorization, "Bearer bcf_t");
    assert.ok(req.url.endsWith("/api/dev/session"));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        draftInstanceId: 77,
        previewUrl: "https://testsite.myblocofy.com/?preview=TOK",
        editorUrl: "https://app.blocofy.com/editor/5?instance=77",
        site: { id: 14, slug: "testsite" },
      }),
    );
  });
  fake.listen(0);
  await once(fake, "listening");
  after(() => fake.close());

  const s = await fetchDevSession({
    url: `http://localhost:${fake.address().port}`,
    token: "bcf_t",
  });
  assert.equal(s.draftInstanceId, 77);
  assert.equal(s.previewUrl, "https://testsite.myblocofy.com/?preview=TOK");
  assert.equal(s.editorUrl, "https://app.blocofy.com/editor/5?instance=77");
});

test("localPathFor: adds .liquid for Liquid kinds, leaves assets raw", () => {
  assert.equal(localPathFor("section/Hero"), "section/Hero.liquid");
  // 0.5.0: uzantılı anahtarlar AYNEN — template/index.json diske .json.liquid ikizi olarak düşmez.
  assert.equal(localPathFor("template/index.json"), "template/index.json");
  assert.equal(localPathFor("layout/theme"), "layout/theme.liquid");
  assert.equal(localPathFor("asset/theme.css"), "asset/theme.css");
  assert.equal(localPathFor("section/Hero.liquid"), "section/Hero.liquid"); // no double extension
});

test("pullTheme: GET /api/dev/theme → writes to disk with .liquid re-added", async () => {
  const fake = createServer((req, res) => {
    assert.equal(req.method, "GET");
    assert.equal(req.headers.authorization, "Bearer bcf_t");
    assert.ok(req.url.endsWith("/api/dev/theme"));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ files: { "section/Hero": "H", "asset/theme.css": ".x{}" } }));
  });
  fake.listen(0);
  await once(fake, "listening");
  const dir = mkdtempSync(join(tmpdir(), "blocofy-pull-"));
  after(() => {
    fake.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const { count } = await pullTheme({
    dir,
    url: `http://localhost:${fake.address().port}`,
    token: "bcf_t",
  });
  assert.equal(count, 2);
  assert.equal(readFileSync(join(dir, "section", "Hero.liquid"), "utf8"), "H");
  assert.equal(readFileSync(join(dir, "asset", "theme.css"), "utf8"), ".x{}");
});

test("pushTheme: readLocalTemplates → POST {files} (stripped keys); returns result", async () => {
  let received = null;
  const fake = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      assert.equal(req.method, "POST");
      assert.equal(req.headers.authorization, "Bearer bcf_t");
      received = JSON.parse(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, created: 1, updated: 0, skippedDeletes: 2 }));
    });
  });
  fake.listen(0);
  await once(fake, "listening");
  const dir = mkdtempSync(join(tmpdir(), "blocofy-push-"));
  mkdirSync(join(dir, "section"), { recursive: true });
  writeFileSync(join(dir, "section", "Hero.liquid"), "H");
  after(() => {
    fake.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const result = await pushTheme({
    dir,
    url: `http://localhost:${fake.address().port}`,
    token: "bcf_t",
  });
  assert.deepEqual(result, { ok: true, created: 1, updated: 0, skippedDeletes: 2 });
  assert.equal(received.files["section/Hero"], "H"); // stripped key sent
});

test("pullTheme --instance → GET ?instance=<handle>", async () => {
  let seenUrl = null;
  const server = createServer((req, res) => {
    seenUrl = req.url;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ files: {} }));
  });
  server.listen(0);
  await once(server, "listening");
  try {
    const url = `http://localhost:${server.address().port}`;
    await pullTheme({ dir: mkdtempSync(join(tmpdir(), "p-")), url, token: "bcf_t", instance: "t7k2p9" });
    assert.match(seenUrl, /\/api\/dev\/theme\?instance=t7k2p9/);
  } finally {
    server.close();
  }
});

test("pushTheme --instance → POST body.instance", async () => {
  let body = null;
  const server = createServer((req, res) => {
    let b = "";
    req.on("data", (d) => (b += d));
    req.on("end", () => {
      body = JSON.parse(b || "{}");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, instanceId: "t7k2p9", created: 0, updated: 0 }));
    });
  });
  server.listen(0);
  await once(server, "listening");
  const dir = mkdtempSync(join(tmpdir(), "u-"));
  mkdirSync(join(dir, "layout"), { recursive: true });
  writeFileSync(join(dir, "layout", "theme.liquid"), "<html></html>");
  try {
    const url = `http://localhost:${server.address().port}`;
    await pushTheme({ dir, url, token: "bcf_t", instance: "t7k2p9" });
    assert.equal(body.instance, "t7k2p9");
  } finally {
    server.close();
  }
});

test("pushTheme --draft: sends body.draft true; returns draft result", async () => {
  let received = null;
  const fake = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      received = JSON.parse(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, draft: true, instanceId: 77, created: 2, updated: 0, skippedDeletes: 0 }));
    });
  });
  fake.listen(0);
  await once(fake, "listening");
  const dir = mkdtempSync(join(tmpdir(), "blocofy-draft-"));
  mkdirSync(join(dir, "section"), { recursive: true });
  writeFileSync(join(dir, "section", "Hero.liquid"), "H");
  after(() => {
    fake.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const result = await pushTheme({
    dir,
    url: `http://localhost:${fake.address().port}`,
    token: "bcf_t",
    draft: true,
  });
  assert.equal(received.draft, true);
  assert.equal(result.instanceId, 77);
});

test("pushTheme --draft --name: includes name in the draft payload", async () => {
  let received = null;
  const fake = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      received = JSON.parse(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, draft: true, instanceId: 77, created: 1, updated: 0 }));
    });
  });
  fake.listen(0);
  await once(fake, "listening");
  const dir = mkdtempSync(join(tmpdir(), "blocofy-name-"));
  mkdirSync(join(dir, "section"), { recursive: true });
  writeFileSync(join(dir, "section", "Hero.liquid"), "H");
  after(() => {
    fake.close();
    rmSync(dir, { recursive: true, force: true });
  });

  await pushTheme({
    dir,
    url: `http://localhost:${fake.address().port}`,
    token: "bcf_t",
    draft: true,
    name: "Kış Kampanyası",
  });
  assert.equal(received.draft, true);
  assert.equal(received.name, "Kış Kampanyası");
});

test("pushTheme: omits name key when not set", async () => {
  let received = null;
  const fake = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      received = JSON.parse(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, created: 1, updated: 0 }));
    });
  });
  fake.listen(0);
  await once(fake, "listening");
  const dir = mkdtempSync(join(tmpdir(), "blocofy-noname-"));
  mkdirSync(join(dir, "section"), { recursive: true });
  writeFileSync(join(dir, "section", "Hero.liquid"), "H");
  after(() => {
    fake.close();
    rmSync(dir, { recursive: true, force: true });
  });

  await pushTheme({ dir, url: `http://localhost:${fake.address().port}`, token: "bcf_t", draft: true });
  assert.ok(!("name" in received));
});

test("fetchDevSession --name: appends ?name=<encoded> to /api/dev/session", async () => {
  let seenUrl = null;
  const fake = createServer((req, res) => {
    seenUrl = req.url;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ draftInstanceId: 77, previewUrl: "x", editorUrl: "y", site: { id: 1, slug: "s" } }));
  });
  fake.listen(0);
  await once(fake, "listening");
  after(() => fake.close());

  await fetchDevSession({ url: `http://localhost:${fake.address().port}`, token: "bcf_t", name: "Yaz Teması" });
  assert.ok(seenUrl.startsWith("/api/dev/session?name="));
  assert.match(seenUrl, new RegExp(`name=${encodeURIComponent("Yaz Teması")}`));
});

test("fetchDevSession: no ?name when name omitted", async () => {
  let seenUrl = null;
  const fake = createServer((req, res) => {
    seenUrl = req.url;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ draftInstanceId: 77, previewUrl: "x", editorUrl: "y", site: { id: 1, slug: "s" } }));
  });
  fake.listen(0);
  await once(fake, "listening");
  after(() => fake.close());

  await fetchDevSession({ url: `http://localhost:${fake.address().port}`, token: "bcf_t" });
  assert.equal(seenUrl, "/api/dev/session");
});

test("renameInstance: POST /api/dev/theme/rename {instance,name} → result (Bearer)", async () => {
  let seen = null;
  const fake = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      seen = { method: req.method, auth: req.headers.authorization, url: req.url, body: JSON.parse(body || "{}") };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, id: "t7k2p9", name: "Yeni Ad" }));
    });
  });
  fake.listen(0);
  await once(fake, "listening");
  after(() => fake.close());

  const r = await renameInstance({
    url: `http://localhost:${fake.address().port}`,
    token: "bcf_t",
    instance: "t7k2p9",
    name: "Yeni Ad",
  });
  assert.equal(r.id, "t7k2p9");
  assert.equal(r.name, "Yeni Ad");
  assert.equal(seen.method, "POST");
  assert.ok(seen.url.endsWith("/api/dev/theme/rename"));
  assert.equal(seen.auth, "Bearer bcf_t");
  assert.equal(seen.body.instance, "t7k2p9");
  assert.equal(seen.body.name, "Yeni Ad");
});

test("renameInstance: server 404 → throws (error text)", async () => {
  const fake = createServer((req, res) => {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });
  fake.listen(0);
  await once(fake, "listening");
  after(() => fake.close());
  await assert.rejects(
    renameInstance({ url: `http://localhost:${fake.address().port}`, token: "bcf_t", instance: "t7k2p9", name: "X" }),
    /Not found/,
  );
});

test("fetchDevSession: içeriksiz 410 → boş değil, teşhis edilebilir mesaj", async () => {
  const fake = createServer((req, res) => {
    res.writeHead(410);
    res.end();
  });
  fake.listen(0);
  await once(fake, "listening");
  after(() => fake.close());

  await assert.rejects(
    () => fetchDevSession({ url: `http://localhost:${fake.address().port}`, token: "bcf_t" }),
    (err) => {
      assert.notEqual(err.message, "");
      assert.match(err.message, /410/);
      return true;
    },
  );
});

test("fetchDevSession: JSON gövdeli hata mesajı korunur (regresyon)", async () => {
  const fake = createServer((req, res) => {
    res.writeHead(422, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "şema geçersiz" }));
  });
  fake.listen(0);
  await once(fake, "listening");
  after(() => fake.close());

  await assert.rejects(
    () => fetchDevSession({ url: `http://localhost:${fake.address().port}`, token: "bcf_t" }),
    (err) => {
      assert.equal(err.message, "şema geçersiz");
      return true;
    },
  );
});

test("fetchDevSession: 410 gövdeli ise SUNUCUNUN mesajı gösterilir (otorite sunucudur)", async () => {
  const fake = createServer((req, res) => {
    res.writeHead(410, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "CLI remote preview has been retired on this server.", code: "cli_remote_preview_retired" }));
  });
  fake.listen(0);
  await once(fake, "listening");
  after(() => fake.close());

  await assert.rejects(
    () => fetchDevSession({ url: `http://localhost:${fake.address().port}`, token: "bcf_t" }),
    (err) => {
      assert.equal(err.message, "CLI remote preview has been retired on this server.");
      return true;
    },
  );
});

// CF-T5: the platform accepts legacy theme locale files at `locales/<tag>.json` /
// `locales/<tag>.default.json`. `locales` is a plain THEME_DIRS entry (not a Liquid kind), so
// push/pull/diff treat it exactly like `asset`: raw content, no `.liquid` stripped/re-added.

test("pushTheme: readLocalTemplates picks up locales/ (legacy locale files) and sends them", async () => {
  let received = null;
  const fake = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      received = JSON.parse(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, created: 2, updated: 0 }));
    });
  });
  fake.listen(0);
  await once(fake, "listening");
  const dir = mkdtempSync(join(tmpdir(), "blocofy-locales-push-"));
  mkdirSync(join(dir, "locales"), { recursive: true });
  writeFileSync(join(dir, "locales", "en-US.json"), '{"hello":"world"}');
  writeFileSync(join(dir, "locales", "en-US.default.json"), '{"hello":"world"}');
  after(() => {
    fake.close();
    rmSync(dir, { recursive: true, force: true });
  });

  await pushTheme({ dir, url: `http://localhost:${fake.address().port}`, token: "bcf_t" });
  assert.equal(received.files["locales/en-US.json"], '{"hello":"world"}');
  assert.equal(received.files["locales/en-US.default.json"], '{"hello":"world"}');
});

test("pullTheme: writes locales/<tag>.json to disk raw (no .liquid re-added, unlike Liquid kinds)", async () => {
  const fake = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ files: { "locales/en-US.json": '{"hello":"world"}' } }));
  });
  fake.listen(0);
  await once(fake, "listening");
  const dir = mkdtempSync(join(tmpdir(), "blocofy-locales-pull-"));
  after(() => {
    fake.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const { count } = await pullTheme({ dir, url: `http://localhost:${fake.address().port}`, token: "bcf_t" });
  assert.equal(count, 1);
  assert.equal(readFileSync(join(dir, "locales", "en-US.json"), "utf8"), '{"hello":"world"}');
});

test("pullTheme: a locales/ file among the response does not weaken the path-escape gate — `locales/../x.json` and `.BLOCOFY/…` are still refused (all-or-nothing)", async () => {
  const fake = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      files: {
        "locales/en-US.json": "{}",
        "locales/../x.json": "escape",
        ".BLOCOFY/project.json": "binding",
      },
    }));
  });
  fake.listen(0);
  await once(fake, "listening");
  const dir = mkdtempSync(join(tmpdir(), "blocofy-locales-escape-"));
  after(() => {
    fake.close();
    rmSync(dir, { recursive: true, force: true });
  });

  await assert.rejects(
    pullTheme({ dir, url: `http://localhost:${fake.address().port}`, token: "bcf_t" }),
    (err) => {
      assert.equal(err.code, "PAGES_PATH_ESCAPE");
      return true;
    },
  );
  assert.equal(existsSync(join(dir, "locales", "en-US.json")), false, "all-or-nothing: even the valid file is not written");
});

test("pushTheme: a non-JSON filename under locales/ (e.g. locales/readme.md) is sent as-is — the CLI does not duplicate the server's tag/extension validation", async () => {
  let received = null;
  const fake = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      received = JSON.parse(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, created: 1, updated: 0 }));
    });
  });
  fake.listen(0);
  await once(fake, "listening");
  const dir = mkdtempSync(join(tmpdir(), "blocofy-locales-nonjson-"));
  mkdirSync(join(dir, "locales"), { recursive: true });
  writeFileSync(join(dir, "locales", "readme.md"), "not a locale file");
  after(() => {
    fake.close();
    rmSync(dir, { recursive: true, force: true });
  });

  await pushTheme({ dir, url: `http://localhost:${fake.address().port}`, token: "bcf_t" });
  assert.equal(received.files["locales/readme.md"], "not a locale file");
});

test("pullTheme: the theme's own config rows come down (a starter theme ships config/theme.json), nested config paths do not", async () => {
  // CROSS-REPO GAP, found by the real-platform smoke: `GET /api/dev/theme` serves every `config`-kind row,
  // and refusing them refused the WHOLE pull — a freshly provisioned Klaros-themed site could not be pulled.
  const fake = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      files: {
        "layout/theme": "<html></html>",
        "config/settings_schema.json": "[]",
        "config/theme.json": '{"name":"Klaros"}',
      },
    }));
  });
  fake.listen(0);
  await once(fake, "listening");
  const dir = mkdtempSync(join(tmpdir(), "blocofy-config-pull-"));
  after(() => {
    fake.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const { count } = await pullTheme({ dir, url: `http://localhost:${fake.address().port}`, token: "bcf_t" });
  assert.equal(count, 3);
  assert.equal(readFileSync(join(dir, "config", "theme.json"), "utf8"), '{"name":"Klaros"}');
  assert.equal(readFileSync(join(dir, "config", "settings_schema.json"), "utf8"), "[]");
});

test("pullTheme: a nested config path is still refused, and nothing is written", async () => {
  const fake = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ files: { "layout/theme": "<html></html>", "config/nested/evil.json": "{}" } }));
  });
  fake.listen(0);
  await once(fake, "listening");
  const dir = mkdtempSync(join(tmpdir(), "blocofy-config-nested-"));
  after(() => {
    fake.close();
    rmSync(dir, { recursive: true, force: true });
  });

  await assert.rejects(
    pullTheme({ dir, url: `http://localhost:${fake.address().port}`, token: "bcf_t" }),
    (err) => {
      assert.equal(err.code, "PAGES_PATH_ESCAPE");
      return true;
    },
  );
  assert.equal(existsSync(join(dir, "layout", "theme.liquid")), false);
});
