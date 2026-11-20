import { test } from "node:test";
import assert from "node:assert/strict";

import { flattenEnv, mergeEnvByTarget } from "./env.js";
import type { OptimizationOption } from "./types.js";

function option(env: OptimizationOption["env"]): OptimizationOption {
  return {
    id: "x",
    name: "x",
    description: "d",
    category: "runtime",
    platforms: ["linux"],
    requiresPrivilege: false,
    risk: "low",
    reversibility: "fully-reversible",
    resourceCost: {},
    expectedImprovement: { metric: "m", tier: "C" },
    conflictsWith: [],
    synergizesWith: [],
    requires: [],
    env,
  };
}

test("mergeEnvByTarget groups by target and later options win", () => {
  const merged = mergeEnvByTarget([
    option({ ollama: { A: "1" }, "llama.cpp": { X: "1" } }),
    option({ ollama: { B: "2", A: "9" } }),
  ]);
  assert.deepEqual(merged["ollama"], { A: "9", B: "2" });
  assert.deepEqual(merged["llama.cpp"], { X: "1" });
});

test("mergeEnvByTarget tolerates options with no env", () => {
  assert.deepEqual(mergeEnvByTarget([option(undefined)]), {});
});

test("flattenEnv flattens all targets into one map", () => {
  const flat = flattenEnv([option({ ollama: { A: "1" }, vllm: { V: "1" } })]);
  assert.deepEqual(flat, { A: "1", V: "1" });
});
