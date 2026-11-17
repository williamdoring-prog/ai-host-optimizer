/**
 * The set of system roles the user can declare (D-036).
 * Kept in one place so the CLI and the MCP server agree.
 */

import type { SystemRole } from "./types.js";

/** Literal tuple (usable with zod's `z.enum`). */
export const ROLE_NAMES = [
  "workstation",
  "laptop",
  "sandbox",
  "vm-host",
  "remote-singleton",
  "cluster-node",
  "container",
  "ci-runner",
] as const;

/** The same roles as a mutable array. */
export const ROLES: SystemRole[] = [...ROLE_NAMES];
