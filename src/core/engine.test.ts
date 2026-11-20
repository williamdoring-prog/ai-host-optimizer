import { test } from "node:test";
import assert from "node:assert/strict";

import { createEngine, type Engine, type EngineDeps } from "./engine.js";
import { OPTIONS } from "../registry/options.js";
import type { HostProfile } from "./types.js";

const profile: HostProfile = {
  timestamp: new Date().toISOString(),
  platform: "linux",
  role: "workstation",
  os: { platform: "linux", release: "6.0", arch: "x64" },
  cpu: { model: "test", cores: 8 },
  memory: { totalMiB: 32768, freeMiB: 16384 },
  gpu: [{ vendor: "nvidia", name: "Test GPU", vramMiB: 24576, source: "test" }],
  tooling: [],
};

function engineWith(overrides: Partial<EngineDeps> = {}): Engine {
  return createEngine({
    options: OPTIONS,
    profileHost: async (role) => ({ ...profile, role }),
    loadCalibrations: async () => ({}),
    managedDir: () => "/tmp/aiho-engine-test",
    applyPlan: async (_plan, dryRun) => ({ dryRun: dryRun ?? true, written: [] }),
    readState: async () => undefined,
    env: {},
    ...overrides,
  });
}

test("recommend picks applyable, conflict-free options and pulls prerequisites", async () => {
  const engine = engineWith();
  const plan = await engine.recommend("workstation");
  const ids = plan.steps.map((s) => s.option.id);
  assert.ok(ids.includes("flash-attention"), "prerequisite should be pulled in");
  assert.ok(ids.includes("kv-cache-quant-q8"), "applyable option should be selected");
  assert.ok(!ids.includes("kv-cache-quant-q4"), "exclusive rival must not be selected");
  // Nothing advisory-only should appear by default.
  for (const step of plan.steps) {
    assert.ok(step.option.applyOp, `${step.option.id} should be applyable`);
  }
});

test("recommend can include advisory options on request", async () => {
  const engine = engineWith();
  const plan = await engine.recommend("workstation", { includeAdvisory: true });
  assert.ok(plan.steps.some((s) => s.option.applyOp === undefined));
});

test("recommend skips options that are already implemented", async () => {
  const plan = await engineWith({ env: { OLLAMA_CONTEXT_LENGTH: "8192" } }).recommend("workstation");
  const ids = plan.steps.map((s) => s.option.id);
  assert.ok(!ids.includes("ollama-context-length"), "already-implemented option must be skipped");
  assert.ok(ids.includes("flash-attention"), "unimplemented options are still recommended");
});

test("recommend skips an option whose set targets are already satisfied", async () => {
  // Only the Ollama target is set; it satisfies its desired value, so the
  // improvement is already in effect and must not be recommended.
  const plan = await engineWith({ env: { OLLAMA_MAX_QUEUE: "1024" } }).recommend("workstation");
  assert.ok(!plan.steps.map((s) => s.option.id).includes("ollama-max-queue"));
});

test("recommend does not suggest an exclusive alternative when a sibling is implemented", async () => {
  // q8_0 is implemented; q4_0 is an alternative, not an outstanding improvement.
  const plan = await engineWith({ env: { OLLAMA_KV_CACHE_TYPE: "q8_0" } }).recommend("workstation");
  const ids = plan.steps.map((s) => s.option.id);
  assert.ok(!ids.includes("kv-cache-quant-q4"));
  assert.ok(!ids.includes("kv-cache-quant-q8"));
});

test("checklist marks options the tool applied (from state)", async () => {
  const engine = engineWith({ readState: async () => ({ optionIds: ["flash-attention"] }) });
  const items = await engine.checklist("workstation");
  const fa = items.find((i) => i.option.id === "flash-attention")!;
  assert.equal(fa.appliedByTool, true);
  const kv = items.find((i) => i.option.id === "kv-cache-quant-q8")!;
  assert.notEqual(kv.appliedByTool, true);
});

test("apply allows a dry run without consent but refuses a real write", async () => {
  const engine = engineWith();
  const plan = await engine.plan(["flash-attention"], "workstation");
  const dry = await engine.apply(plan, { consent: false, dryRun: true, role: "workstation" });
  assert.equal(dry.result.dryRun, true);
  await assert.rejects(
    () => engine.apply(plan, { consent: false, dryRun: false, role: "workstation" }),
    /consent/,
  );
});

test("apply refuses an advisory role unless forced", async () => {
  const engine = engineWith();
  const plan = await engine.plan(["flash-attention"], "ci-runner");
  await assert.rejects(
    () => engine.apply(plan, { consent: true, dryRun: true, role: "ci-runner" }),
    /advisory/,
  );
  const forced = await engine.apply(plan, {
    consent: true,
    dryRun: true,
    role: "ci-runner",
    forceAdvisory: true,
  });
  assert.equal(forced.result.dryRun, true);
});

test("calibrate without a baseline records nothing and says so", async () => {
  const engine = engineWith({ loadBaseline: async () => undefined });
  const report = await engine.calibrate(["flash-attention"]);
  assert.equal(report.recorded.length, 0);
  assert.match(report.note, /no baseline/i);
});

test("calibrate does not benchmark when everything selected is already implemented", async () => {
  let benchmarked = false;
  const engine = engineWith({
    env: { OLLAMA_CONTEXT_LENGTH: "8192" },
    runBenchmark: async () => {
      benchmarked = true;
      throw new Error("benchmark should not run");
    },
  });
  const report = await engine.calibrate(["ollama-context-length"]);
  assert.equal(report.recorded.length, 0);
  assert.match(report.note, /already implemented/i);
  assert.equal(benchmarked, false);
});

test("generate produces registry-derived output", () => {
  const engine = engineWith();
  const dockerfile = engine.generate("dockerfile", ["hf-cache-location"]);
  assert.match(dockerfile, /ENV HF_HOME=/);
  const sizeDockerfile = engine.generate("dockerfile", ["ollama-context-length"]);
  assert.match(sizeDockerfile, /ENV OLLAMA_CONTEXT_LENGTH="8192"/);
});
