import { spawn } from "node:child_process";

/**
 * Terminal yardımcıları: URL'leri varsayılan tarayıcıda açma + tıklanabilir
 * (OSC 8) hyperlink. `theme dev` 3 görünümü tıklanabilir + l/p/e kısayollarıyla açar.
 */

/** Platforma göre URL açma komutu (saf → test edilebilir). */
export function openCommand(url, platform = process.platform) {
  if (platform === "darwin") return { cmd: "open", args: [url] };
  if (platform === "win32") return { cmd: "cmd", args: ["/c", "start", "", url] };
  return { cmd: "xdg-open", args: [url] };
}

/** URL'i varsayılan tarayıcıda aç (detached, sessiz — opener yoksa yutulur). */
export function openUrl(url) {
  const { cmd, args } = openCommand(url);
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    /* opener yok → sessiz */
  }
}

const OSC = "]8;;";
const BEL = "";

/**
 * OSC 8 terminal hyperlink: destekleyen terminalde (iTerm2, GNOME Terminal, …)
 * tıklanabilir; desteklemeyende `label` düz metin olarak görünür.
 */
export function hyperlink(url, label = url) {
  return `${OSC}${url}${BEL}${label}${OSC}${BEL}`;
}
