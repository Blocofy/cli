/**
 * Hidden (non-echoing) secret prompt for `blocofy login --api-key` (0.8.0, D3 §4.7).
 *
 * Reads one line from a TTY in raw mode so the key never echoes to the terminal (and so it is
 * never in argv or shell history — the flag takes no value). On a non-TTY stdin it resolves
 * `null` WITHOUT reading anything: the caller must then use BLOCOFY_API_KEY or fail closed.
 * Backspace edits, Enter finishes, Ctrl-C / Ctrl-D (empty) cancel with `null`. Raw mode is
 * always restored.
 */
export function promptSecret(question, { input = process.stdin, output = process.stdout } = {}) {
  if (!input.isTTY || typeof input.setRawMode !== "function") return Promise.resolve(null);
  return new Promise((resolve) => {
    let buffer = "";
    const finish = (value) => {
      input.removeListener("data", onData);
      input.setRawMode(false);
      input.pause();
      output.write("\n");
      resolve(value);
    };
    const onData = (chunk) => {
      for (const ch of String(chunk)) {
        if (ch === "\r" || ch === "\n") return finish(buffer);
        if (ch === "") return finish(null); // Ctrl-C
        if (ch === "") return finish(buffer.length ? buffer : null); // Ctrl-D
        if (ch === "" || ch === "\b") {
          buffer = buffer.slice(0, -1);
          continue;
        }
        buffer += ch;
      }
    };
    output.write(question);
    input.setRawMode(true);
    input.setEncoding("utf8");
    input.resume();
    input.on("data", onData);
  });
}
