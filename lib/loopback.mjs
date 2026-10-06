import { createServer } from "node:http";

/**
 * ADR-0014 §5.1/§5.2 (wave P4) — the browser login's loopback redirect (RFC 8252 §7.3).
 *
 * The CLI listens on `127.0.0.1` (or `[::1]`) on an ephemeral port and registers `http://<host>:<port>/callback`.
 * `localhost` is refused (RFC 8252 §8.3: it may not resolve to the loopback), as the platform refuses it. Exactly one
 * GET `/callback` is accepted; every other path is 404 and does not end the wait. The listener closes after that one
 * callback or after the timeout (5 minutes by default). The page it answers never echoes the code.
 */

export const CALLBACK_PATH = "/callback";
export const LOGIN_TIMEOUT_MS = 5 * 60_000;
const HOSTS = new Set(["127.0.0.1", "::1"]);

export class LoopbackError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LoopbackError";
    this.code = code;
    this.exitCode = 1;
  }
}

/** The redirect URI for `host` + `port`, or LOGIN_LOOPBACK_REFUSED (anything but 127.0.0.1 / ::1, a port < 1024). */
export function loopbackRedirectUri(host, port) {
  if (!HOSTS.has(host)) {
    throw new LoopbackError("LOGIN_LOOPBACK_REFUSED", `The login callback must listen on 127.0.0.1 or [::1], not "${host}" (localhost is not accepted: it may not resolve to this machine).`);
  }
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new LoopbackError("LOGIN_LOOPBACK_REFUSED", `The login callback port must be between 1024 and 65535 (got ${port}).`);
  }
  return `http://${host === "::1" ? "[::1]" : host}:${port}${CALLBACK_PATH}`;
}

/** The platform's rule for the first-party client's redirect, mirrored (canonical form, exact path, no query). */
export function isLoopbackCallback(uri) {
  let url;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.href !== uri || url.protocol !== "http:" || url.username || url.password || url.search || url.hash) return false;
  if (url.hostname !== "127.0.0.1" && url.hostname !== "[::1]") return false;
  const port = Number(url.port);
  return url.pathname === CALLBACK_PATH && url.port !== "" && port >= 1024 && port <= 65535;
}

const PAGE = (ok) =>
  `<!doctype html><html lang="tr"><meta charset="utf-8"><title>Blocofy CLI</title><body style="font-family:system-ui;margin:3rem">` +
  (ok
    ? "<h1>Blocofy CLI</h1><p>Tarayıcı adımı tamamlandı. Bu sekmeyi kapatıp terminale dönebilirsin.</p><p>The browser step is done; you can close this tab and return to the terminal.</p>"
    : "<h1>Blocofy CLI</h1><p>Bu adres bir giriş yanıtı değil.</p>") +
  "</body></html>";

/**
 * Listen on `host` (127.0.0.1 | ::1). Returns `{ redirectUri, wait(), close() }`: `wait()` resolves with the
 * callback's URLSearchParams (the first GET /callback) or rejects LOGIN_TIMEOUT; the server is closed either way.
 */
export async function startLoopbackListener({ host = "127.0.0.1", timeoutMs = LOGIN_TIMEOUT_MS } = {}) {
  if (!HOSTS.has(host)) loopbackRedirectUri(host, 1024); // throws LOGIN_LOOPBACK_REFUSED
  let settle;
  const result = new Promise((resolve, reject) => {
    settle = { resolve, reject };
  });
  result.catch(() => {}); // observed through wait()
  let done = false;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://loopback");
    if (done || req.method !== "GET" || url.pathname !== CALLBACK_PATH) {
      res.writeHead(404, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(PAGE(false));
      return;
    }
    done = true;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", connection: "close" });
    res.end(PAGE(true));
    finish(() => settle.resolve(url.searchParams));
  });
  let timer = null;
  const finish = (fn) => {
    clearTimeout(timer);
    server.close();
    server.closeAllConnections?.();
    fn();
  };
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const redirectUri = loopbackRedirectUri(host, server.address().port);
  timer = setTimeout(() => {
    if (done) return;
    done = true;
    finish(() => settle.reject(new LoopbackError("LOGIN_TIMEOUT", `No answer from the browser within ${Math.round(timeoutMs / 1000)} s; the login was not completed. Nothing was saved. Run \`blocofy login\` again.`)));
  }, timeoutMs);
  timer.unref?.();
  return {
    redirectUri,
    wait: () => result,
    close() {
      if (done) return;
      done = true;
      finish(() => settle.reject(new LoopbackError("LOGIN_CANCELLED", "The login was cancelled.")));
    },
  };
}
