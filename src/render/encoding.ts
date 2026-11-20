/**
 * Sink-aware encoders.
 *
 * Registry values are interpolated into generated artifacts that are later
 * *parsed or executed* (a sourced shell file, a PowerShell profile, a Dockerfile
 * `ENV`, an Ansible `copy` block). Interpolating them verbatim is a latent
 * injection surface via the deliberately community-editable registry, so every
 * value passes through the encoder for its sink first.
 *
 * `validateRegistry` additionally rejects values these encoders cannot represent
 * faithfully (embedded newlines, NUL, Ansible/Jinja template markers).
 */

/** POSIX shell, inside double quotes: escape `\`, `"`, `$` and backtick. */
export function encodeShDoubleQuoted(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\$/g, "\\$")
    .replace(/`/g, "\\`");
}

/** PowerShell, inside double quotes: escape backtick, `$` and `"`. */
export function encodePowerShellDoubleQuoted(value: string): string {
  return value.replace(/`/g, "``").replace(/\$/g, "`$").replace(/"/g, '`"');
}

/** Dockerfile `ENV`: escape `\`, `"` and `$` so the value is taken literally. */
export function encodeDockerfileEnv(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "\\$");
}

/** Characters that cannot be represented in the line-oriented generated files. */
export function findUnencodable(value: string): string | undefined {
  if (/[\r\n]/.test(value)) return "must not contain a newline";
  if (value.includes("\0")) return "must not contain a NUL byte";
  if (value.includes("{{") || value.includes("{%")) {
    return "must not contain Ansible/Jinja template markers";
  }
  return undefined;
}
