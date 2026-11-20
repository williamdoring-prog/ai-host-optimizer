/**
 * Paths owned by the tool.
 *
 * `managedDir()` is the one place that decides where managed files live; every
 * module (applier, benchmark, calibration, CLI, engine) imports it from here
 * rather than from the applier, so there is no layering inversion.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import { detectPlatform } from "./profiler.js";

export const MANAGED_DIR_NAME = "ai-host-optimizer";

/** Token replaced by the managed directory inside registry env values. */
export const MANAGED_DIR_TOKEN = "${MANAGED_DIR}";

/** The managed config directory (platform-appropriate). */
export function managedDir(): string {
  const platform = detectPlatform();
  if (platform === "windows") {
    return join(process.env["APPDATA"] ?? homedir(), MANAGED_DIR_NAME);
  }
  if (platform === "macos") {
    return join(homedir(), "Library", "Application Support", MANAGED_DIR_NAME);
  }
  return join(process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config"), MANAGED_DIR_NAME);
}

/** Resolve an explicit override, falling back to the platform managed dir. */
export function resolveManagedDir(dir?: string): string {
  return dir ?? managedDir();
}

/** Substitute `${MANAGED_DIR}` in a value. */
export function resolveManagedToken(value: string, dir: string): string {
  return value.split(MANAGED_DIR_TOKEN).join(dir);
}
