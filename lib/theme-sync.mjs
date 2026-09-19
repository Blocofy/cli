import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";

import { THEME_DIRS, localPathFor, readLocalTemplates } from "./local-theme.mjs";
import { fetchWithRetry } from "./http.mjs";
import { PagesCliError, stagedWrite } from "./page-files.mjs";

/**
 * `blocofy theme pull/push`. Talks to the platform's `/api/dev/theme` endpoint
 * (Bearer token). pull = GET → write to disk (re-adding `.liquid`); push =
 * readLocalTemplates → POST (create/update; no delete).
 *
 * CF-T3: every request goes through `fetchWithRetry` (lib/http.mjs — 429/502/503/504 + network errors, Retry-After).
 * All are safe to resend: reads, a keyed (or naturally idempotent upsert) theme POST, publish (sets a pointer),
 * rename (sets a label). `onRetry` surfaces each retry on stderr.
 */

/**
 * M4 canonical source-write handshake. We declare the protocol version + the full canonical-write
 * capability set; the server is authoritative and fences an under-declaring client (a NEW CLI against an
 * OLD server just sees the headers ignored — forward compatible). Capabilities must match the server's
 * CANONICAL_WRITE_CAPABILITIES exactly, in order.
 */
const CANONICAL_PROTOCOL = "1";
const CANONICAL_CAPABILITIES = "validate,dry-run,diff,idempotency-key,target-instance";

/**
 * CF-T5 review I1 — OPTIONAL capabilities (never part of the required fence above). `theme-locales`: this CLI sends the
 * workspace's `locales/*` files, so a canonical deploy may replace `locales/` like any other theme folder (a server
 * that sees no declaration keeps stored locale rows). Sent on every theme POST; GETs don't need it.
 */
const OPTIONAL_CAPABILITIES = "theme-locales";

function canonicalHeaders(extra = {}) {
  return { "x-blocofy-protocol": CANONICAL_PROTOCOL, "x-blocofy-capabilities": CANONICAL_CAPABILITIES, ...extra };
}

async function errorText(res) {
  const text = await res.text();
  try {
    const parsed = JSON.parse(text).error;
    if (parsed) return parsed;
  } catch {
    /* JSON değil — ham metne düş */
  }
  // İçeriksiz yanıt (ör. 410 tombstone) boş dize döndürüp `Error("")` üretiyordu; kullanıcı
  // `unavailable ()` görüyordu. Gövde yoksa statü tek teşhis kaynağıdır — onu taşı.
  return text || `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`;
}

/** `errorText` as an Error that keeps the HTTP status (exit codes: 4xx → 2, 5xx → 1). */
async function responseError(res) {
  const detail = await errorText(res);
  const err = new Error(typeof detail === "string" ? detail : detail?.message ?? JSON.stringify(detail));
  err.status = res.status;
  if (typeof detail === "object" && detail && typeof detail.code === "string") err.code = detail.code;
  else if (typeof detail === "string" && /^[a-z][a-z0-9_]*$/.test(detail)) err.code = detail;
  return err;
}

/**
 * Yapılandırılmış HTTP hatası (0.5.0): mesajın yanında `code` (sunucunun `error` alanı), `status` ve tam
 * `body` taşınır — 426 `cli_upgrade_required` (fence.missing/requiredVersion) ve 409 `idempotency_conflict`
 * için insan-dili mesajı ÇAĞIRAN kurar; buradaki throw yalnız veriyi kaybetmeden taşır.
 */
async function httpError(res) {
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* düz metin gövde */
  }
  const err = new Error(typeof body?.error === "string" ? body.error : text || `HTTP ${res.status}`);
  err.status = res.status;
  err.code = typeof body?.error === "string" ? body.error : null;
  err.body = body;
  return err;
}

/**
 * Sunucu kanonik protokolü konuşuyor mu? (0.5.0 `--dry-run` ön kontrolü.) SORGUSUZ canlı GET — mutasyonsuz
 * (`?draft=1` GET'i sunucuda taslak provizyonlar, o yüzden burada KULLANILMAZ). Eski bir sunucu `protocol`
 * alanını hiç dönmez → false → `--dry-run` reddedilir; aksi hâlde eski sunucu `dryRun`'ı yok sayıp GERÇEK
 * yazım yapardı (0.5.0 öncesi sessiz-yazım regresyonu).
 */
export async function fetchCanonicalSupport({ url, token, onRetry = null }) {
  const base = url.replace(/\/+$/, "");
  const res = await fetchWithRetry(`${base}/api/dev/theme`, {
    headers: canonicalHeaders({ authorization: `Bearer ${token}` }),
  }, { onRetry });
  if (!res.ok) throw await httpError(res);
  const body = await res.json();
  return { supported: body?.protocol === 1 };
}

/**
 * CF-T1/T2 review I1 — a pulled path is accepted only if `readLocalTemplates` would read it back: a top-level theme dir
 * (exact case) with a file below it, or `config/settings_schema.json`. Any `.blocofy`/staging segment (compared
 * case-insensitively: APFS/NTFS fold case, so `.BLOCOFY/project.json` IS the binding) and any dot-directory (`.git`…)
 * is refused. Returns a reason string, or null when the path is acceptable.
 */
/**
 * The flat root files a theme actually HAS. The platform's starter themes ship exactly these two, so exactly
 * these two come down.
 *
 * This is an allowlist on purpose. It was briefly a denylist of tooling filenames, and that inverted the rule
 * the rest of this function is built on: anything the server named that was not a lockfile - `CLAUDE.md`,
 * `AGENTS.md`, `next.config.js` - was written straight into the developer's project root by an ordinary pull.
 * A theme download must never be able to place a file the developer's own tooling then trusts. If a theme
 * legitimately grows another root file, this set is where it is added, deliberately.
 */
const ROOT_FILES_ALLOWED = new Set(["readme.md", "blueprint.json"]);

function pullPathProblem(rel) {
  const segs = rel.split("/");
  if (segs.some((seg) => { const l = seg.toLowerCase(); return l === ".blocofy" || l.startsWith(".blocofy-staging-"); })) return "reserved CLI path";
  if (segs.slice(0, -1).some((seg) => seg.startsWith("."))) return "hidden directory";
  // `config/` — the theme's own configuration rows. `settings_schema.json` is the one a push sends back; the
  // platform serves the others (a starter theme ships `config/theme.json`) and a pull that refused them
  // refused the WHOLE download, so a freshly provisioned site could not be pulled at all. They are written
  // read-only: the push gate accepts only `settings_schema.json` under `config/`, and `pages`/`settings`
  // have their own commands. One flat level, no nesting.
  if (segs[0] === "config") {
    if (segs.length !== 2) return "config files are one level deep";
    // `settings pull` owns this name; a theme row must not shadow the file that command writes.
    return segs[1] === "settings.json" ? "config/settings.json belongs to `settings pull`" : null;
  }
  if (segs.length === 1) {
    // A FLAT FILE AT THE THEME ROOT. The platform stores rows a push does not send (the starter themes ship
    // `README.md` and `blueprint.json`) and serves them on pull; refusing them refused the whole download.
    // Case-folded, because APFS and NTFS fold case: `Readme.MD` and `README.md` are one file on disk.
    if (segs[0].startsWith(".")) return "hidden file";
    return ROOT_FILES_ALLOWED.has(segs[0].toLowerCase()) ? null : "not a theme file at the theme root";
  }
  if (!THEME_DIRS.has(segs[0])) return "not a theme file (would not be pushed back)";
  return null;
}

/**
 * Download a theme to disk. `{ path: content }` (stripped) → `.liquid` files.
 * With `draft`, pulls the "CLI Draft" instance (what `theme dev` syncs into)
 * instead of the live theme — symmetric with `push --draft`.
 */
export async function pullTheme({ dir, url, token, draft = false, instance = null, onRetry = null }) {
  const base = url.replace(/\/+$/, "");
  const query = instance ? `?instance=${encodeURIComponent(instance)}` : draft ? "?draft=1" : "";
  const res = await fetchWithRetry(`${base}/api/dev/theme${query}`, {
    headers: canonicalHeaders({ authorization: `Bearer ${token}` }),
  }, { onRetry });
  if (!res.ok) throw await responseError(res);
  const { files } = await res.json();
  // CF-T2: staged + contained (all-or-nothing). Every path is validated before the first byte is written; a
  // server path that escapes the directory, targets the CLI's own `.blocofy/` binding, or would not be read back by
  // the next push refuses the whole pull.
  const entries = Object.entries(files ?? {}).map(([key, content]) => [localPathFor(key), content]);
  const rejected = entries.map(([rel]) => [rel, pullPathProblem(rel)]).filter(([, problem]) => problem);
  if (rejected.length) {
    throw new PagesCliError("PAGES_PATH_ESCAPE", "The server sent a path this CLI does not write; nothing was written.", {
      diagnostics: rejected.map(([rel, problem]) => ({ level: "error", code: "PAGES_PATH_ESCAPE", message: problem, path: rel })),
    });
  }
  const created = !existsSync(dir);
  mkdirSync(dir, { recursive: true });
  try {
    return { count: stagedWrite(realpathSync(dir), entries) };
  } catch (error) {
    if (created) rmSync(dir, { recursive: true, force: true }); // no empty directory left behind
    throw error;
  }
}

/**
 * Token'ın GERÇEK site'ını çözer (`GET /api/dev/whoami`). Site sunucuda TOKEN'dan
 * çözülür — login URL'i kozmetik. CLI bunu `login`'de (doğrula+göster) ve `push`
 * öncesi (hedef tenant'ı yaz) çağırır; yanlış-tenant'a yazımı görünür kılar.
 * `{ site: { id, slug, name }, liveThemeId }`.
 */
export async function fetchWhoami({ url, token, onRetry = null }) {
  const base = url.replace(/\/+$/, "");
  const res = await fetchWithRetry(`${base}/api/dev/whoami`, {
    headers: { authorization: `Bearer ${token}` },
  }, { onRetry });
  if (!res.ok) throw await responseError(res);
  return res.json();
}

/**
 * Dev session bilgisi (#119 `theme dev`): platform draft instance'ı hazırlar ve
 * 3 görünümün URL'lerini döner — `{ draftInstanceId, previewUrl, editorUrl, site }`.
 */
export async function fetchDevSession({ url, token, name = null, onRetry = null }) {
  const base = url.replace(/\/+$/, "");
  const query = name ? `?name=${encodeURIComponent(name)}` : "";
  const res = await fetchWithRetry(`${base}/api/dev/session${query}`, {
    headers: { authorization: `Bearer ${token}` },
  }, { onRetry });
  if (!res.ok) {
    const detail = await errorText(res);
    // Yeni sunucular 410'da açıklayıcı bir gövde döndürür — onu olduğu gibi göster, o otoritedir.
    // Gövdesiz 410 (eski sunucu) `errorText`'ten "HTTP 410 …" olarak gelir; o durumda teşhisi
    // biz veririz, yoksa kullanıcı yalnız bir statü kodu görür.
    if (res.status === 410 && /^HTTP 410\b/.test(detail)) {
      throw new Error(
        "CLI remote preview (the signed preview URL and the editor view) is retired on this server " +
          "(HTTP 410). Draft sync and `theme publish` are unaffected — they use different endpoints.",
      );
    }
    throw Object.assign(new Error(detail), { status: res.status });
  }
  return res.json();
}

/**
 * Write the local theme to the site (create/update; no delete). With `draft`,
 * writes to a draft theme instance instead of the live theme — preview & publish
 * it from the admin panel without affecting the live site.
 */
export async function pushTheme({ dir, url, token, draft = false, instance = null, name = null, dryRun = false, idempotencyKey = null, onRetry = null, prune = false, confirmPrune = null }) {
  const base = url.replace(/\/+$/, "");
  const files = readLocalTemplates(dir);
  const headersFor = (extra = {}) => canonicalHeaders({ authorization: `Bearer ${token}`, ...extra });
  const postHeaders = (extra = {}) => headersFor({ "content-type": "application/json", "x-blocofy-optional-capabilities": OPTIONAL_CAPABILITIES, ...extra });
  const remoteOnlyKept = [];
  const remoteOnlyRemoved = [];
  if (idempotencyKey && !dryRun) {
    // 0.5.0 kanonik push üç aşamadır (denetim düzeltmeleri):
    //  1) PREFLIGHT dry-run POST (yalnız yerel küme): 422/426 sınıfı hatalar SUNUCUDA HİÇBİR ŞEY
    //     provizyonlanmadan yakalanır — probe GET'i taslak yaratabildiği için başarısız bir push
    //     arkada instance + sayfa klonu bırakıyordu.
    //  2) MERGE PROBE GET: "push silmez" garantisi — uzakta olup yerelde olmayan, kapı-kabul-eden
    //     dosyalar payload'a aynen eklenir; kapı-dışı satırları (README.md vb.) sunucunun
    //     retained-rows kuralı korur. `--prune` bu dosyaları EKLEMEZ (kanonik deploy klasörleri
    //     atomik değiştirir → silinirler) ve yazımdan ÖNCE `confirmPrune(liste)`'ye bildirir.
    //     PS-09: taslak hedefte taslak-bayraklı GET KULLANILMAZ — sunucuda taslak provizyonlar (yan
    //     etki; yarıda kalırsa boş taslak bırakırdı). Mevcut CLI taslağı `/api/dev/site`'tan
    //     (`source === "import"`, sunucunun ensureDraftInstance seçimiyle aynı: id sıralı ilk) bulunup
    //     `?instance=` ile yoklanır; yoksa yoklanacak uzak dosya da yoktur → probe atlanır.
    //  3) Gerçek POST. Dev-sync key göndermediği için bu aşamaların hiçbirini ödemez.
    const pre = await fetchWithRetry(
      `${base}/api/dev/theme`,
      { method: "POST", headers: postHeaders({ "x-idempotency-key": idempotencyKey }), body: JSON.stringify({ ...(instance ? { files, instance } : { files, draft, ...(name ? { name } : {}) }), dryRun: true }) },
      { onRetry },
    );
    if (!pre.ok) throw await httpError(pre);

    let probeInstance = instance;
    if (!instance && draft) {
      const status = await fetchSiteStatus({ url, token, onRetry });
      probeInstance = (status?.drafts ?? []).find((d) => d.source === "import")?.id ?? null;
    }
    let remote = {};
    if (probeInstance || !draft) {
      const query = probeInstance ? `?instance=${encodeURIComponent(probeInstance)}` : "";
      const probe = await fetchWithRetry(`${base}/api/dev/theme${query}`, { headers: headersFor() }, { onRetry });
      if (!probe.ok) throw await httpError(probe);
      remote = (await probe.json()).files ?? {};
    }
    for (const [key, content] of Object.entries(remote)) {
      if (key in files) continue;
      const top = key.split("/")[0] ?? "";
      // Sunucu kapı-kabul kümesinin birebir aynası: THEME_DIRS altı ÇOK-SEGMENTLİ path'ler + tek
      // config istisnası (çıplak `layout` gibi slash'sız bir uzak anahtar sunucuda 422 olurdu).
      if ((key.includes("/") && THEME_DIRS.has(top)) || key === "config/settings_schema.json") {
        if (prune) {
          remoteOnlyRemoved.push(key);
        } else {
          files[key] = typeof content === "string" ? content : "";
          remoteOnlyKept.push(key);
        }
      }
    }
    remoteOnlyKept.sort();
    remoteOnlyRemoved.sort();
    if (remoteOnlyRemoved.length && confirmPrune && !(await confirmPrune(remoteOnlyRemoved))) {
      return { aborted: true, remoteOnlyRemoved };
    }
  }
  const target = instance ? { files, instance } : name ? { files, draft, name } : { files, draft };
  // dryRun asks the server to validate (auth + snapshot + hostile-Liquid worker) WITHOUT writing.
  const payload = dryRun ? { ...target, dryRun: true } : target;
  const headers = postHeaders();
  if (idempotencyKey) headers["x-idempotency-key"] = idempotencyKey;
  const res = await fetchWithRetry(
    `${base}/api/dev/theme`,
    { method: "POST", headers, body: JSON.stringify(payload) },
    { onRetry },
  );
  if (!res.ok) throw await httpError(res);
  const json = await res.json();
  return {
    ...json,
    ...(remoteOnlyKept.length ? { remoteOnlyKept } : {}),
    ...(remoteOnlyRemoved.length ? { remoteOnlyRemoved } : {}),
  };
}

/**
 * `blocofy theme push --diff` — compare the LOCAL theme with the LIVE theme (or an explicit `--instance`).
 * Read-only: the draft target is deliberately NOT diffable — `?draft=1` GET'i sunucuda taslak PROVİZYONLAR
 * (sayfa klonları dahil), read-only bir komut mutasyon tetikleyemez (0.5.0 denetim düzeltmesi). Çağıran
 * çıktıyı "canlıya göre fark" diye etiketler. Returns `{ added, changed, removed }` (stripped keys).
 */
export async function diffTheme({ dir, url, token, instance = null, onRetry = null }) {
  const base = url.replace(/\/+$/, "");
  const query = instance ? `?instance=${encodeURIComponent(instance)}` : "";
  const res = await fetchWithRetry(`${base}/api/dev/theme${query}`, {
    headers: canonicalHeaders({ authorization: `Bearer ${token}` }),
  }, { onRetry });
  if (!res.ok) throw await responseError(res);
  const { files: remote = {} } = await res.json();
  const local = readLocalTemplates(dir);
  const added = [];
  const changed = [];
  for (const [key, content] of Object.entries(local)) {
    if (!(key in remote)) added.push(key);
    else if (remote[key] !== content) changed.push(key);
  }
  const removed = Object.keys(remote).filter((k) => !(k in local));
  return { added: added.sort(), changed: changed.sort(), removed: removed.sort() };
}

/**
 * Bir taslak tema instance'ını CANLIYA al (`POST /api/dev/publish`). Sunucu guard'ı
 * içi-sayfasız bir instance'ı reddeder ya da canlının sayfalarını klonlar (#431) —
 * yayın sonrası site asla 404'e düşmez. `{ ok, published, cloned }` döner.
 */
export async function publishInstance({ url, token, instanceId, onRetry = null }) {
  const base = url.replace(/\/+$/, "");
  const res = await fetchWithRetry(`${base}/api/dev/publish`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ instanceId }),
  }, { onRetry });
  if (!res.ok) throw await responseError(res);
  return res.json();
}

/**
 * Bir tema instance'ının adını değiştir (`POST /api/dev/theme/rename`). Ad yalnızca
 * bir etiket — canlı instance dahil sahip olunan her instance yeniden adlandırılabilir.
 * `{ ok, id, name }` döner.
 */
export async function renameInstance({ url, token, instance, name, onRetry = null }) {
  const base = url.replace(/\/+$/, "");
  const res = await fetchWithRetry(`${base}/api/dev/theme/rename`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ instance, name }),
  }, { onRetry });
  if (!res.ok) throw await responseError(res);
  return res.json();
}

/**
 * Site sağlık/durum özeti (`GET /api/dev/site`) — `blocofy status`. Canlı tema instance'ı,
 * instance-başına sayfa dağılımı, taslaklar ve health döner.
 */
export async function fetchSiteStatus({ url, token, onRetry = null }) {
  const base = url.replace(/\/+$/, "");
  const res = await fetchWithRetry(`${base}/api/dev/site`, { headers: { authorization: `Bearer ${token}` } }, { onRetry });
  if (!res.ok) throw await responseError(res);
  return res.json();
}
