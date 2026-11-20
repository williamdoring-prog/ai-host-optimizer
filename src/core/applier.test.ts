import { test } from "node:test";
import assert from "node:assert/strict";

import { buildApplyPlan } from "./applier.js";
import { managedDir } from "./paths.js";
import { buildPlan } from "./plan.js";
import type { Plan } from "./plan.js";
import { OPTIONS } from "../registry/options.js";
import type { HostProfile, OptimizationOption } from "./types.js";
import { encodeShDoubleQuoted } from "../render/encoding.js";

const linuxProfile: HostProfile = {
  timestamp: new Date().toISOString(),
  platform: "linux",
  role: "workstation",
  os: { platform: "linux", release: "6.0", arch: "x64" },
  cpu: { model: "test", cores: 8 },
  memory: { totalMiB: 32768, freeMiB: 16384 },
  tooling: [],
};

/** Resolve a conflict-free plan, then build the apply plan from it. */
function planFor(ids: string[]): Plan {
  return buildPlan(ids, linuxProfile, OPTIONS);
}

test("managedDir is an absolute path", () => {
  assert.ok(managedDir().length > 0);
});

test("apply plan collects env from env-applyable options", () => {
  const plan = buildApplyPlan(planFor(["flash-attention", "kv-cache-quant-q8"]));
  assert.equal(plan.envVars["OLLAMA_FLASH_ATTENTION"], "1");
  assert.equal(plan.envVars["OLLAMA_KV_CACHE_TYPE"], "q8_0");
});

test("apply plan groups env by target runtime", () => {
  const plan = buildApplyPlan(planFor(["flash-attention"]));
  assert.equal(plan.envByTarget["ollama"]?.["OLLAMA_FLASH_ATTENTION"], "1");
  assert.equal(plan.envByTarget["llama.cpp"]?.["LLAMA_ARG_FLASH_ATTN"], "1");
  // one env file per target
  const names = plan.files.map((f) => f.path.split(/[\\/]/).pop());
  assert.ok(names.includes("ollama.env"));
  assert.ok(names.includes("llama.cpp.env"));
});

test("apply plan resolves ${MANAGED_DIR} in values", () => {
  const plan = buildApplyPlan(planFor(["hf-cache-location"]));
  const dir = managedDir();
  const file = plan.files.find((f) => f.path.endsWith("huggingface.env"))!;
  assert.ok(file.content.includes(`export HF_HOME="${encodeShDoubleQuoted(`${dir}/hf`)}"`));
  assert.ok(!file.content.includes("${MANAGED_DIR}"));
});

test("apply plan writes only inside the managed directory", () => {
  const plan = buildApplyPlan(planFor(["flash-attention"]));
  const dir = managedDir();
  for (const f of plan.files) {
    assert.ok(f.path.startsWith(dir), `${f.path} must be inside ${dir}`);
  }
});

test("apply plan is empty when no options contribute env", () => {
  const plan = buildApplyPlan(planFor(["provider-prompt-cache"]));
  assert.equal(Object.keys(plan.envVars).length, 0);
  assert.equal(plan.files.length, 0);
  assert.equal(plan.ops.length, 0);
});

test("systemd drop-in op writes a drop-in in the managed dir with install/uninstall notes", () => {
  const plan = buildApplyPlan(planFor(["ollama-systemd-dropin", "flash-attention"]));
  assert.ok(plan.ops.includes("systemd-dropin"));
  const dropin = plan.files.find((f) => f.path.endsWith("10-ai-host-optimizer.conf"));
  assert.ok(dropin, "drop-in file should be in the plan");
  assert.ok(dropin!.path.startsWith(managedDir()));
  assert.match(dropin!.content, /EnvironmentFile=-.*ollama\.env/);
  // The install needs root, so it must be printed, never run.
  assert.ok(plan.notes.some((n) => /sudo systemctl/.test(n)));
  // A documented uninstall must be printed too.
  assert.ok(plan.notes.some((n) => /rm -f/.test(n)));
});

test("vLLM options contribute to the vllm target", () => {
  const plan = buildApplyPlan(planFor(["vllm-long-context"]));
  assert.equal(plan.envByTarget["vllm"]?.["VLLM_ALLOW_LONG_MAX_MODEL_LEN"], "1");
  assert.ok(plan.files.some((f) => f.path.endsWith("vllm.env")));
});

test("a size option contributes env and is recorded as the size op", () => {
  const plan = buildApplyPlan(planFor(["ollama-context-length"]));
  assert.equal(plan.envByTarget["ollama"]?.["OLLAMA_CONTEXT_LENGTH"], "8192");
  assert.ok(plan.ops.includes("size"));
  assert.ok(plan.files.some((f) => f.path.endsWith("ollama.env")));
});

test("llama.cpp size options render into llama.cpp.env", () => {
  const plan = buildApplyPlan(planFor(["llama-batch-size", "llama-ubatch-size"]));
  assert.equal(plan.envByTarget["llama.cpp"]?.["LLAMA_ARG_BATCH"], "4096");
  assert.equal(plan.envByTarget["llama.cpp"]?.["LLAMA_ARG_UBATCH"], "1024");
});

test("a rejected option cannot be materialised by the applier", () => {
  // q4 conflicts (exclusive group) with q8, so the plan rejects it.
  const plan = planFor(["kv-cache-quant-q8", "kv-cache-quant-q4"]);
  const applied = buildApplyPlan(plan);
  assert.equal(applied.envByTarget["ollama"]?.["OLLAMA_KV_CACHE_TYPE"], "q8_0");
  assert.ok(plan.rejections.some((r) => r.id === "kv-cache-quant-q4"));
});

test("the applier refuses a target name that escapes the managed directory", () => {
  const evil: OptimizationOption = {
    id: "evil",
    name: "evil",
    description: "test fixture",
    category: "runtime",
    platforms: ["linux"],
    requiresPrivilege: false,
    risk: "low",
    reversibility: "fully-reversible",
    resourceCost: {},
    expectedImprovement: { metric: "x", tier: "C" },
    conflictsWith: [],
    synergizesWith: [],
    requires: [],
    applyOp: "env",
    env: { "../escape": { EVIL: "1" } },
  };
  const plan: Plan = { steps: [{ option: evil }], rejections: [], notes: [] };
  assert.throws(() => buildApplyPlan(plan), /invalid env target|outside the managed/);
});
