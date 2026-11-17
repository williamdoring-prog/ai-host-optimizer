#!/usr/bin/env node
/**
 * ai-host-optimizer — entry point.
 *
 * M0: read-only. Profiles the host and prints a checklist, or runs as an MCP
 * stdio server. No system changes.
 */

import { main } from "./cli/launcher.js";

main(process.argv.slice(2)).catch((err: unknown) => {
  const message = err instanceof Error ? err.stack ?? err.message : String(err);
  process.stderr.write(`ai-host-optimizer: ${message}\n`);
  process.exitCode = 1;
});
