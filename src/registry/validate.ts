/**
 * Registry validation entry point.
 *
 * Run in CI (`npm run validate:registry`) so registry-integrity problems fail
 * the build rather than appearing as a runtime CLI warning. The same checks run
 * in the test suite; this exists so the failure is unambiguous and independent
 * of the test runner.
 */

import { validateRegistry } from "../core/checklist.js";
import { OPTIONS } from "./options.js";

const problems = validateRegistry(OPTIONS);

if (problems.length > 0) {
  process.stderr.write(`Registry validation failed (${problems.length} problem(s)):\n`);
  for (const problem of problems) process.stderr.write(`  - ${problem}\n`);
  process.exit(1);
}

process.stdout.write(`Registry OK: ${OPTIONS.length} options validated.\n`);
