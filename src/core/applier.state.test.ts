import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyPlan, buildApplyPlan, readState, revert } from "./applier.js";
import { buildPlan } from "./plan.js";
import { OPTIONS } from "../registry/options.js";
import type { HostProfile } from "./types.js";

const linuxProfile: HostProfile = {
  timestamp: new Date().toISOString(),
  platform: "linux",
  role: "workstation",
  os: { platform: "linux", release: "6.0", arch: "x64" },
  cpu: { model: "test", cores: 8 },
  memory: { totalMiB: 32768, freeMiB: 16384 },
  tooling: [],
};

function applyPlanFor(ids: string[], dir: string) {
  return buildApplyPlan(buildPlan(ids, linuxProfile, OPTIONS), dir);
}

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "aiho-state-"));
}

test("apply then revert removes the written files and clears state", async () => {
  const dir = await tempDir();
  try {
    const plan = applyPlanFor(["flash-attention"], dir);
    await applyPlan(plan, false, dir);
    assert.ok((await readState(dir))?.files.length);

    const result = await revert(dir);
    assert.ok(result.removed.length > 0);
    assert.equal(await readState(dir), undefined);
    for (const f of plan.files) {
      await assert.rejects(readFile(f.path, "utf8"));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("two sequential applies then one revert removes the union", async () => {
  const dir = await tempDir();
  try {
    const first = applyPlanFor(["flash-attention"], dir);
    await applyPlan(first, false, dir);
    const second = applyPlanFor(["hf-cache-location"], dir);
    await applyPlan(second, false, dir);

    const state = await readState(dir);
    assert.ok(state);
    // The state accumulates the union of both applies, not just the last one.
    for (const f of [...first.files, ...second.files]) {
      assert.ok(state.files.some((e) => e.path === f.path), `${f.path} should be tracked`);
    }

    await revert(dir);
    for (const f of [...first.files, ...second.files]) {
      await assert.rejects(readFile(f.path, "utf8"));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a pre-existing file is backed up and restored on revert", async () => {
  const dir = await tempDir();
  try {
    await mkdir(dir, { recursive: true });
    const target = join(dir, "ollama.env");
    await writeFile(target, "ORIGINAL CONTENT\n", "utf8");

    await applyPlan(applyPlanFor(["flash-attention"], dir), false, dir);
    assert.notEqual(await readFile(target, "utf8"), "ORIGINAL CONTENT\n");

    await revert(dir);
    assert.equal(await readFile(target, "utf8"), "ORIGINAL CONTENT\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a corrupt state file is a hard error (never silently ignored)", async () => {
  const dir = await tempDir();
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "state.json"), "{ this is not json", "utf8");
    const plan = applyPlanFor(["flash-attention"], dir);
    await assert.rejects(() => applyPlan(plan, false, dir), /corrupt/);
    await assert.rejects(() => revert(dir), /corrupt/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("dry-run writes nothing", async () => {
  const dir = await tempDir();
  try {
    const plan = applyPlanFor(["flash-attention"], dir);
    const result = await applyPlan(plan, true, dir);
    assert.equal(result.dryRun, true);
    assert.equal(await readState(dir), undefined);
    await assert.rejects(readFile(plan.files[0]!.path, "utf8"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("revert understands a v1 state file (files as string[])", async () => {
  const dir = await tempDir();
  try {
    await mkdir(dir, { recursive: true });
    const target = join(dir, "ollama.env");
    await writeFile(target, "old\n", "utf8");
    await writeFile(
      join(dir, "state.json"),
      JSON.stringify({
        version: 1,
        appliedAt: new Date().toISOString(),
        ops: ["env"],
        optionIds: ["flash-attention"],
        files: [target],
      }),
      "utf8",
    );
    const result = await revert(dir);
    assert.ok(result.removed.includes(target));
    await assert.rejects(readFile(target, "utf8"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
