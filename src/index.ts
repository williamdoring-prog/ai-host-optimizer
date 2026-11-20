#!/usr/bin/env node
/**
 * ai-host-optimizer — entry point.
 *
 * Dispatches to the CLI launcher (profile/plan/recommend/apply/benchmark/…).
 * Profiling and planning are read-only; applying is consent-driven, dry-run by
 * default, contained to the managed directory and fully reversible.
 */

import { main } from "./cli/launcher.js";

main(process.argv.slice(2)).catch((err: unknown) => {
  const message = err instanceof Error ? err.stack ?? err.message : String(err);
  process.stderr.write(`ai-host-optimizer: ${message}\n`);
  process.exitCode = 1;
});
