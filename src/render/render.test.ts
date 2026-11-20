import { test } from "node:test";
import assert from "node:assert/strict";

import { applyabilityLabel, improvementSummary, renderChecklist, renderProfile } from "./checklist.js";
import { renderPlan } from "./plan.js";
import type { ChecklistItem, HostProfile, OptimizationOption } from "../core/types.js";
import type { Plan } from "../core/plan.js";

function option(over: Partial<OptimizationOption> = {}): OptimizationOption {
  return {
    id: "demo",
    name: "Demo option",
    description: "d",
    category: "runtime",
    platforms: ["linux"],
    requiresPrivilege: false,
    risk: "low",
    reversibility: "fully-reversible",
    resourceCost: {},
    expectedImprovement: { metric: "decode tokens/s", estimate: 0.5, tier: "B" },
    conflictsWith: [],
    synergizesWith: [],
    requires: [],
    ...over,
  };
}

const profile: HostProfile = {
  timestamp: new Date().toISOString(),
  platform: "linux",
  role: "workstation",
  os: { platform: "linux", release: "6.0", arch: "x64", distro: "Test Linux" },
  cpu: { model: "Test CPU", cores: 8 },
  memory: { totalMiB: 32768, freeMiB: 16384 },
  gpu: [{ vendor: "nvidia", name: "Test GPU", vramMiB: 8192, source: "test" }],
  context: { container: "docker", visibleGpus: [], numaNodes: 2 },
  tooling: [{ name: "ollama", detected: true, version: "0.1" }],
};

test("applyabilityLabel distinguishes applyable from advisory", () => {
  assert.equal(applyabilityLabel(option({ applyOp: "env" })), "[applyable]");
  assert.equal(applyabilityLabel(option()), "[advisory]");
});

test("improvementSummary formats numbers and qualitative estimates", () => {
  assert.equal(improvementSummary(option()), "decode tokens/s: 50% (tier B)");
  assert.equal(
    improvementSummary(option({ expectedImprovement: { metric: "m", tier: "C" } })),
    "m: qualitative (tier C)",
  );
});

test("renderProfile includes platform, cpu, memory, gpu and context", () => {
  const out = renderProfile(profile);
  assert.match(out, /linux/);
  assert.match(out, /Test CPU/);
  assert.match(out, /GiB total/);
  assert.match(out, /nvidia Test GPU/);
  assert.match(out, /container docker/);
  assert.match(out, /visible GPUs: none/);
  assert.match(out, /2 NUMA node/);
});

test("renderChecklist labels options and shows role/advisory notes", () => {
  const items: ChecklistItem[] = [
    { option: option({ applyOp: "env" }), applicable: true, blockedBy: [], advisoryOnly: true, roleNote: "advisory role" },
    { option: option({ id: "n/a-opt", platforms: ["windows"] }), applicable: false, reason: "not supported on linux", blockedBy: [] },
  ];
  const out = renderChecklist(profile, items);
  assert.match(out, /\[applyable\]/);
  assert.match(out, /ADVISORY ONLY/);
  assert.match(out, /n\/a: not supported on linux/);
});

test("renderPlan shows steps, rejections, combined estimate and notes", () => {
  const plan: Plan = {
    steps: [{ option: option({ applyOp: "env" }), implicit: true }],
    rejections: [{ id: "bad", reason: "unknown option id" }],
    combined: { metric: "decode tokens/s", estimate: 0.5, tier: "B", method: "compounded", contributors: 1 },
    notes: ["a note"],
  };
  const out = renderPlan(plan, "My plan");
  assert.match(out, /My plan/);
  assert.match(out, /\[prerequisite\]/);
  assert.match(out, /Rejected:/);
  assert.match(out, /bad: unknown option id/);
  assert.match(out, /Combined estimate: 50%/);
  assert.match(out, /note: a note/);
});
