import { test } from "node:test";
import assert from "node:assert/strict";

import { buildPlan, combineEstimates } from "./plan.js";
import { OPTIONS } from "../registry/options.js";
import type { HostProfile } from "./types.js";

const linuxProfile: HostProfile = {
  timestamp: new Date().toISOString(),
  platform: "linux",
  role: "workstation",
  os: { platform: "linux", release: "6.0", arch: "x64" },
  cpu: { model: "test", cores: 8 },
  memory: { totalMiB: 32768, freeMiB: 16384 },
  gpu: [{ vendor: "nvidia", name: "Test GPU", vramMiB: 24576, source: "test" }],
  tooling: [],
};

test("combineEstimates compounds, not sums", () => {
  // two 20% wins => 36%, not 40%
  assert.ok(Math.abs(combineEstimates([0.2, 0.2]) - 0.36) < 1e-9);
});

test("combineEstimates is clamped and safe", () => {
  assert.equal(combineEstimates([0]), 0);
  assert.ok(combineEstimates([0.9, 0.9]) <= 0.99);
});

test("plan pulls in prerequisites automatically", () => {
  const plan = buildPlan(["kv-cache-quant-q8"], linuxProfile, OPTIONS);
  const ids = plan.steps.map((s) => s.option.id);
  assert.ok(ids.includes("kv-cache-quant-q8"));
  assert.ok(ids.includes("flash-attention"), "flash-attention should be pulled in");
  const fa = plan.steps.find((s) => s.option.id === "flash-attention")!;
  assert.equal(fa.implicit, true);
});

test("plan rejects exclusive-group rivals (one-of)", () => {
  const plan = buildPlan(["kv-cache-quant-q8", "kv-cache-quant-q4"], linuxProfile, OPTIONS);
  const ids = plan.steps.map((s) => s.option.id);
  assert.ok(ids.includes("kv-cache-quant-q8"));
  assert.ok(!ids.includes("kv-cache-quant-q4"));
  assert.ok(plan.rejections.some((r) => r.id === "kv-cache-quant-q4" && /exclusive/.test(r.reason)));
});

test("plan rejects hard conflicts (mlock vs zram)", () => {
  const plan = buildPlan(["zram", "mlock"], linuxProfile, OPTIONS);
  assert.ok(plan.rejections.some((r) => /conflicts/.test(r.reason)));
});

test("plan reports a combined estimate with the weakest tier", () => {
  const plan = buildPlan(["kv-cache-quant-q8"], linuxProfile, OPTIONS);
  assert.ok(plan.combined);
  assert.equal(plan.combined!.tier, "B"); // q8_0 is a tier-B estimate
  assert.ok(plan.combined!.estimate > 0);
});

test("plan rejects unknown ids", () => {
  const plan = buildPlan(["does-not-exist"], linuxProfile, OPTIONS);
  assert.equal(plan.steps.length, 0);
  assert.ok(plan.rejections.some((r) => r.id === "does-not-exist"));
});

test("calibration promotes an option to tier A and replaces the estimate", () => {
  const calibrations = {
    "kv-cache-quant-q8": {
      optionId: "kv-cache-quant-q8",
      metric: "decode tokens/s",
      delta: 0.17,
      tier: "A" as const,
      measuredAt: new Date().toISOString(),
      samples: 1,
      method: "test",
    },
  };
  const plan = buildPlan(["kv-cache-quant-q8"], linuxProfile, OPTIONS, calibrations);
  const step = plan.steps.find((s) => s.option.id === "kv-cache-quant-q8")!;
  assert.equal(step.option.expectedImprovement.tier, "A");
  assert.equal(step.option.expectedImprovement.estimate, 0.17);
  assert.equal(plan.combined!.tier, "A");
  assert.match(step.option.expectedImprovement.method ?? "", /measured/i);
});

test("without calibration the estimate stays tier B", () => {
  const plan = buildPlan(["kv-cache-quant-q8"], linuxProfile, OPTIONS);
  const step = plan.steps.find((s) => s.option.id === "kv-cache-quant-q8")!;
  assert.equal(step.option.expectedImprovement.tier, "B");
});

test("a null calibration result does NOT promote or inflate the estimate", () => {
  const calibrations = {
    "kv-cache-quant-q8": {
      optionId: "kv-cache-quant-q8",
      metric: "decode tokens/s",
      delta: 0.02,
      noiseFloor: 0.05,
      significant: false,
      tier: "C" as const,
      measuredAt: new Date().toISOString(),
      samples: 3,
      method: "test",
    },
  };
  const plan = buildPlan(["kv-cache-quant-q8"], linuxProfile, OPTIONS, calibrations);
  const step = plan.steps.find((s) => s.option.id === "kv-cache-quant-q8")!;
  // The original tier-B estimate survives; the null result is only a note.
  assert.equal(step.option.expectedImprovement.tier, "B");
  assert.equal(step.option.expectedImprovement.estimate, 0.5);
  assert.match(step.option.expectedImprovement.method ?? "", /no change beyond the noise floor/i);
});
