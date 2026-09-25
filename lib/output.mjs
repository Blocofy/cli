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

const SOURCE_LABELS = {
  env: "env credentials",
  binding: "the one saved context for this project's site",
  prompt: "picked at the prompt",
  current_context: "default context (blocofy use)",
};

/**
 * The target block as data (used for `--json` and for `blocofy target`). 1.8: it names the platform the site was
 * verified on (`platform_origin`, the environment), where the context choice came from (`context_source`) and every
 * stated choice an explicit `--context` overrode (`context_overrides`), plus the command and its mode.
 */
export function targetData({ site, url, platformOrigin = null, contextName, contextSource = null, contextOverrides = [], bindingLabel, command, mode }) {
  return {
    site: { id: site.id, slug: site.slug ?? null, name: site.name ?? null, domain: site.domain ?? null },
    url: url ?? null,
    platform_origin: platformOrigin ?? null,
    context: contextName,
    context_source: contextSource,
    context_overrides: contextOverrides.map((a) => ({ source: a.source, context: a.name })),
    binding: bindingLabel,
    command,
    mode,
    operation: `${command} · ${mode}`,
  };
}

export function formatTargetBlock(t) {
  const name = t.site.name ?? t.site.slug ?? String(t.site.id);
  const overrides = (t.context_overrides ?? []).map((a) => (a.source === "env" ? "env credentials" : `${a.source}=${a.context}`));
  const source = t.context_source ? ` (from ${SOURCE_LABELS[t.context_source] ?? t.context_source}${overrides.length ? `; overrides ${overrides.join(", ")}` : ""})` : "";
  return [
    `Target:    ${name} · ${t.site.id} · ${t.site.domain ?? t.url ?? "?"}`,
    `Platform:  ${t.platform_origin ?? "(not reported by the server)"}`,
    `Context:   ${t.context}${source}`,
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

/** One warning line: `{"warning":{code,message}}` under --json, `warning [CODE]: message` otherwise. */
export function printWarning(warning, { json = false, stream = process.stderr } = {}) {
  stream.write(redact(json ? JSON.stringify({ warning: { code: warning.code, message: warning.message } }) : `warning [${warning.code}]: ${warning.message}`) + "\n");
}
