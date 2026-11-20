// Cross-version test runner.
//
// `node --test <glob>` only works on Node >= 21, and passing a directory has
// different discovery semantics across versions (Node 25 will even execute a
// non-test `index.js`). So enumerate the compiled test files ourselves and pass
// explicit paths to the runner — identical behaviour on Node 20/22/24/25 and on
// Windows/macOS/Linux (no shell globbing involved).

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

function collectTests(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...collectTests(path));
    else if (entry.name.endsWith(".test.js")) files.push(path);
  }
  return files;
}

const files = collectTests("dist").sort();
if (files.length === 0) {
  process.stderr.write("No compiled test files found under dist/ — run `npm run build` first.\n");
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
process.exit(result.status ?? 1);
