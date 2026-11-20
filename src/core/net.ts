/**
 * Network helpers shared by the runtime adapters.
 *
 * The security invariant is loopback-only egress unless the user explicitly
 * opts in (`AIHO_ALLOW_REMOTE_RUNTIME=1`), so the loopback check lives here and
 * every runtime goes through it.
 */

/** Is `host` a loopback address? Accepts `127.0.0.1`, `localhost`, `::1`, `[::1]`, any `127.x.x.x`. */
export function isLoopbackHost(host: string): boolean {
  let h = host.trim().toLowerCase();
  if (!h) return false;
  const scheme = h.match(/^[a-z][a-z0-9+.-]*:\/\/(.*)$/);
  if (scheme) h = scheme[1]!;
  h = h.split("/")[0]!;
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    if (end === -1) return false;
    h = h.slice(1, end);
  } else {
    const colons = (h.match(/:/g) ?? []).length;
    // A single colon means host:port; more than one means a bare IPv6 literal.
    if (colons === 1) h = h.slice(0, h.indexOf(":"));
  }
  if (h === "localhost" || h === "::1") return true;
  const parts = h.split(".");
  if (parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p))) {
    return parts[0] === "127";
  }
  return false;
}

/** Resolve a base URL + hostname from an env var, with a sensible default. */
export function resolveEndpoint(
  raw: string | undefined,
  fallback: string,
): { base: string; hostname: string } {
  const value = raw?.trim() || fallback;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`;
  try {
    const url = new URL(withScheme);
    return { base: url.origin, hostname: url.hostname };
  } catch {
    return { base: withScheme.replace(/\/+$/, ""), hostname: value };
  }
}

/** Whether remote (non-loopback) runtimes are permitted. */
export function remoteAllowed(): boolean {
  return process.env["AIHO_ALLOW_REMOTE_RUNTIME"] === "1";
}
