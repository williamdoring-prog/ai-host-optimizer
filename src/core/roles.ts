/**
 * The set of system roles the user can declare (D-036).
 * Kept in one place so the CLI and the MCP server agree.
 *
 * Curation rule: every role must be **unique** (it changes what advice is
 * appropriate) and **professional** (a term an engineer would recognise).
 */

/** Literal tuple (usable with zod's `z.enum`). */
export const ROLE_NAMES = [
  "workstation",
  "laptop",
  "server",
  "vm-host",
  "container",
  "sandbox",
  "cluster-node",
  "ci-runner",
] as const;

/**
 * The system role type, derived from the canonical tuple so it can never drift
 * from `ROLE_NAMES`. `core/types.ts` re-exports it for convenience.
 */
export type SystemRole = (typeof ROLE_NAMES)[number];

/** The same roles as a mutable array. */
export const ROLES: SystemRole[] = [...ROLE_NAMES];

/**
 * A one-line descriptor for each role, explaining what makes it unique
 * (i.e. why the role changes the advice). Shown in the prompt and `--help`.
 */
export const ROLE_DESCRIPTORS: Record<SystemRole, string> = {
  workstation: "single-user local machine (default)",
  laptop: "single-user, power/thermal constrained",
  server: "headless, no local console",
  "vm-host": "hypervisor - tuning also affects guests",
  container: "no host-kernel access",
  sandbox: "disposable - experimentation expected",
  "cluster-node": "part of a cluster - advisory only",
  "ci-runner": "ephemeral - advisory only",
};
