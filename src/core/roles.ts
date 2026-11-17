/**
 * The set of system roles the user can declare (D-036).
 * Kept in one place so the CLI and the MCP server agree.
 *
 * Curation rule: every role must be **unique** (it changes what advice is
 * appropriate) and **professional** (a term an engineer would recognise).
 */

import type { SystemRole } from "./types.js";

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

/** The same roles as a mutable array. */
export const ROLES: SystemRole[] = [...ROLE_NAMES];
