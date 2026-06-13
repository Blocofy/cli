import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Blocofy CLI kimlik bilgileri (#119 Faz 3d). `blocofy login` platform URL'i +
 * dev token'ı `~/.blocofy/credentials.json`'a (0600) yazar; `blocofy theme dev`
 * standalone modu bunu okur. Env (BLOCOFY_URL/BLOCOFY_TOKEN) dosyayı geçersiz
 * kılar (CI/agent). Token plaintext diskte tutulur (Shopify/gh CLI deseni) →
 * dosya izni 0600.
 */

const DIR = join(homedir(), ".blocofy");
const FILE = join(DIR, "credentials.json");

export function credentialsPath() {
  return FILE;
}

/** URL + token'ı 0600 izniyle yaz. */
export function saveCredentials({ url, token }) {
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  writeFileSync(FILE, JSON.stringify({ url, token }, null, 2) + "\n", { mode: 0o600 });
  chmodSync(FILE, 0o600); // dosya zaten varsa create-mode uygulanmaz → zorla
}

/**
 * Kimlik bilgisi çöz: önce env (tam çift), sonra dosya. `{ url, token, source }`
 * ya da null. URL sondaki `/`'lardan arındırılır.
 */
export function loadCredentials() {
  const envUrl = process.env.BLOCOFY_URL;
  const envToken = process.env.BLOCOFY_TOKEN;
  if (envUrl && envToken) {
    return { url: stripSlash(envUrl), token: envToken, source: "env" };
  }
  try {
    const data = JSON.parse(readFileSync(FILE, "utf8"));
    if (data && typeof data.url === "string" && typeof data.token === "string") {
      return { url: stripSlash(data.url), token: data.token, source: "file" };
    }
  } catch {
    // dosya yok/bozuk → null
  }
  return null;
}

function stripSlash(url) {
  return url.replace(/\/+$/, "");
}
