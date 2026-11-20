/**
 * Safety primitives shared by the applier and the registry validator.
 *
 * These enforce two of the project's security invariants (see SECURITY.md):
 *   1. every path written or removed lives inside the managed directory, and
 *   2. registry-controlled names cannot contain path separators or traversal.
 *
 * `path.relative` is used for containment — never `String.prototype.startsWith`
 * (which is fooled by sibling prefixes like `<dir>-old` and by case differences
 * on case-insensitive filesystems).
 */

import { isAbsolute, relative, resolve, sep } from "node:path";

/** Allowed characters for a registry target (runtime) name, e.g. `llama.cpp`. */
export const TARGET_NAME_RE = /^[a-zA-Z0-9._-]+$/;

/** Allowed characters for an environment variable name. */
export const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;

/**
 * True when `p` resolves strictly inside `base`.
 *
 * Rejects `..` traversal, sibling-prefix collisions (`<base>-old`), absolute
 * escapes, and (on Windows) case-variant escapes, because `path.relative`
 * normalises and compares correctly per platform.
 */
export function isContained(base: string, p: string): boolean {
  const rel = relative(resolve(base), resolve(p));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Throw when `p` is not strictly inside `base`. */
export function assertContained(base: string, p: string): void {
  if (!isContained(base, p)) {
    throw new Error(`refusing to touch "${p}": outside the managed directory "${base}"`);
  }
}
