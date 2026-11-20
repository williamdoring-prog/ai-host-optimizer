/**
 * The allow-list of apply operations.
 *
 * An option's `applyOp` is a closed union: a typo can no longer silently turn an
 * option into an advisory-only entry (the registry validator rejects anything
 * outside this set). Adding a new capability means adding it here *and* a
 * handler in the applier — a deliberate, reviewable act.
 */

export const APPLY_OP_IDS = ["env", "systemd-dropin", "size"] as const;

export type ApplyOpId = (typeof APPLY_OP_IDS)[number];

/** Type guard for an allow-listed apply op. */
export function isApplyOpId(value: string): value is ApplyOpId {
  return (APPLY_OP_IDS as readonly string[]).includes(value);
}

/** How a stackable option's estimate combines with others. */
export const COMBINE_MODELS = ["additive", "multiplicative", "diminishing"] as const;
