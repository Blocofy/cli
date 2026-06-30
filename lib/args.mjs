/**
 * Birleşik arg tokenizer. Tek geçişte hem flag'leri hem positional'ları çıkarır —
 * böylece bir flag DEĞERİ (örn. `--port 3035`'in `3035`'i) yanlışlıkla positional
 * (tema dizini) sanılmaz. Boolean flag'ler sonraki token'ı YUTMAZ.
 */

/** Sonraki token'ı değer olarak almayan flag'ler. */
const BOOLEAN_FLAGS = new Set(["draft", "yes", "confirm", "no-sync", "dry", "help", "version"]);

export function parseArgs(rest) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const key = arg.slice(2);
    if (BOOLEAN_FLAGS.has(key)) {
      flags[key] = true;
      continue;
    }
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }
  return { flags, positionals };
}
