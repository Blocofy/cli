/**
 * Birleşik arg tokenizer. Tek geçişte hem flag'leri hem positional'ları çıkarır —
 * böylece bir flag DEĞERİ (örn. `--port 3035`'in `3035`'i) yanlışlıkla positional
 * (tema dizini) sanılmaz. Boolean flag'ler sonraki token'ı YUTMAZ.
 */

/**
 * Sonraki token'ı değer olarak almayan flag'ler. 0.8.0: `api-key` de boolean'dır — `login --api-key`
 * gizli prompt açar; `--api-key <değer>` sözdizimi bilerek YOKTUR (sır argv'ye ve shell geçmişine girmez).
 * CF-T1: `--keychain` (login) ve `--adopt` (link) de değersizdir. CF-T3: `--force` (pages push) da; gerekçesi `--reason <text>`.
 */
const BOOLEAN_FLAGS = new Set(["draft", "live", "yes", "confirm", "no-sync", "dry", "dry-run", "validate", "diff", "help", "version", "api-key", "json", "strict", "write", "keychain", "adopt", "force"]);

/**
 * `known`: bu komutun kabul ettiği bayrak adları (Set). Verildiğinde bilinmeyen bir `--x`
 * `unknownFlag` olarak döner ve DEĞER YUTMAZ — eskiden `--halp mydir` `mydir`'i değer sanıp
 * hedef dizini sessizce cwd'ye kaydırıyordu (0.5.0: bilinmeyen bayrak = yazımsız çıkış).
 */
export function parseArgs(rest, known = null) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const key = arg.slice(2);
    if (known && !known.has(key)) {
      return { flags, positionals, unknownFlag: `--${key}` };
    }
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
