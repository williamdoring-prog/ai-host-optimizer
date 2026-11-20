/**
 * Shared environment-variable merging.
 *
 * Both the applier and the accessory generators must group an option's `env`
 * by target runtime identically, so the logic lives here once.
 */

import type { OptimizationOption } from "./types.js";

/** Group env vars across options by target runtime (later options win). */
export function mergeEnvByTarget(
  options: OptimizationOption[],
): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const option of options) {
    for (const [target, vars] of Object.entries(option.env ?? {})) {
      out[target] ??= {};
      Object.assign(out[target]!, vars);
    }
  }
  return out;
}

/** Flatten grouped env into a single map (for `ENV` lines / display). */
export function flattenEnv(options: OptimizationOption[]): Record<string, string> {
  const flat: Record<string, string> = {};
  for (const vars of Object.values(mergeEnvByTarget(options))) Object.assign(flat, vars);
  return flat;
}
