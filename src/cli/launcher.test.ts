import { test } from "node:test";
import assert from "node:assert/strict";

import { parseArgs, runApply, runList, runRecommend } from "./launcher.js";
import { createEngine, type Engine } from "../core/engine.js";
import { OPTIONS } from "../registry/options.js";
import type { HostProfile } from "../core/types.js";

const profile: HostProfile = {
  timestamp: new Date().toISOString(),
  platform: "linux",
  role: "workstation",
  os: { platform: "linux", release: "6.0", arch: "x64" },
  cpu: { model: "test", cores: 8 },
  memory: { totalMiB: 32768, freeMiB: 16384 },
  tooling: [],
};

function fakeEngine(): Engine {
  return createEngine({
    options: OPTIONS,
    profileHost: async (role) => ({ ...profile, role }),
    loadCalibrations: async () => ({}),
    managedDir: () => "/tmp/aiho-cli-test",
    applyPlan: async (_plan, dryRun) => ({ dryRun: dryRun ?? true, written: [] }),
    readState: async () => undefined,
    loadHistory: async () => [],
    appendHistory: async () => "path",
    env: {},
  });
}

/** Run a function while capturing everything it writes to stdout. */
async function capture(fn: () => Promise<void> | void): Promise<string> {
  const stream = process.stdout as unknown as { write: (chunk: string) => boolean };
  const original = stream.write;
  let out = "";
  stream.write = (chunk: string) => {
    out += chunk;
    return true;
  };
  try {
    await fn();
  } finally {
    stream.write = original;
  }
  return out;
}

test("parseArgs reads commands, role and bounds", () => {
  const args = parseArgs([
    "--recommend",
    "--role",
    "ci-runner",
    "--json",
    "--force-advisory",
    "--select",
    "a, b ,c",
  ]);
  assert.equal(args.recommend, true);
  assert.equal(args.role, "ci-runner");
  assert.equal(args.json, true);
  assert.equal(args.forceAdvisory, true);
  assert.deepEqual(args.select, ["a", "b", "c"]);
});

test("parseArgs bounds --samples and ignores unknown flags", () => {
  assert.equal(parseArgs(["--samples", "0"]).samples, undefined);
  assert.equal(parseArgs(["--samples", "999"]).samples, undefined);
  assert.equal(parseArgs(["--samples", "5"]).samples, 5);
  assert.equal(parseArgs(["--nonsense"]).samples, undefined);
  // An invalid role is ignored (falls back to prompting/default downstream).
  assert.equal(parseArgs(["--role", "wizard"]).role, undefined);
});

test("runList labels options as applyable or advisory", async () => {
  const out = await capture(() => runList(false));
  assert.match(out, /\[applyable\]/);
  assert.match(out, /\[advisory\]/);
});

test("runRecommend prints a plan and an apply hint", async () => {
  const out = await capture(() => runRecommend(fakeEngine(), "workstation"));
  assert.match(out, /Recommended plan/);
  assert.match(out, /Apply with: --apply --select/);
});

test("runApply dry-run reports DRY-RUN and writes nothing", async () => {
  const out = await capture(() =>
    runApply(fakeEngine(), "workstation", ["flash-attention"], false),
  );
  assert.match(out, /DRY-RUN/);
  assert.match(out, /Re-run with --yes/);
});

test("runApply refuses an advisory role with a clear message", async () => {
  const out = await capture(() => runApply(fakeEngine(), "ci-runner", ["flash-attention"], true));
  assert.match(out, /advisory only/i);
});
