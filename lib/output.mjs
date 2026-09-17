/**
 * CF-T2 (contract C2) — shared output for target display and refusals. Everything here goes to stderr (stdout
 * stays the command's own result, e.g. `--json` payloads). Known secrets are registered once and redacted from
 * every string this module prints, as a last line of defence.
 */

const secrets = new Set();

export function registerSecret(value) {
  if (typeof value === "string" && value.length >= 8) secrets.add(value);
}

export function redact(text) {
  let out = String(text);
  for (const s of secrets) out = out.split(s).join("[redacted]");
  return out;
}

/** The target block as data (used for `--json` and for `blocofy target`). */
export function targetData({ site, url, contextName, bindingLabel, operation }) {
  return {
    site: { id: site.id, slug: site.slug ?? null, name: site.name ?? null, domain: site.domain ?? null },
    url: url ?? null,
    context: contextName,
    binding: bindingLabel,
    operation,
  };
}

export function formatTargetBlock(t) {
  const name = t.site.name ?? t.site.slug ?? String(t.site.id);
  return [
    `Target:    ${name} · ${t.site.id} · ${t.site.domain ?? t.url ?? "?"}`,
    `Context:   ${t.context}`,
    `Binding:   ${t.binding}`,
    `Operation: ${t.operation}`,
  ].join("\n");
}

export function printTarget(t, { json = false, stream = process.stderr } = {}) {
  stream.write(redact(json ? JSON.stringify({ target: t }) : formatTargetBlock(t)) + "\n");
}

/** `{"error":{code,message,details}}` under --json, `error [CODE]: message` otherwise. */
export function printError(error, { json = false, stream = process.stderr } = {}) {
  const envelope = { error: { code: error.code ?? "ERROR", message: error.message ?? String(error), details: error.details ?? {} } };
  stream.write(redact(json ? JSON.stringify(envelope) : `error [${envelope.error.code}]: ${envelope.error.message}`) + "\n");
}
