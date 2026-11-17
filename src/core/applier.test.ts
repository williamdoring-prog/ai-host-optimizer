import { test } from "node:test";
import assert from "node:assert/strict";

import { buildApplyPlan, managedDir } from "./applier.js";
import { OPTIONS } from "../registry/options.js";

test("managedDir is an absolute path", () => {
  assert.ok(managedDir().length > 0);
});

test("apply plan collects env from env-applyable options", () => {
  const plan = buildApplyPlan(["flash-attention", "kv-cache-quant-q8"], OPTIONS);
  assert.equal(plan.envVars["OLLAMA_FLASH_ATTENTION"], "1");
  assert.equal(plan.envVars["OLLAMA_KV_CACHE_TYPE"], "q8_0");
});

test("apply plan groups env by target runtime", () => {
  const plan = buildApplyPlan(["flash-attention"], OPTIONS);
  assert.equal(plan.envByTarget["ollama"]?.["OLLAMA_FLASH_ATTENTION"], "1");
  assert.equal(plan.envByTarget["llama.cpp"]?.["LLAMA_ARG_FLASH_ATTN"], "1");
  // one env file per target
  const names = plan.files.map((f) => f.path.split(/[\\/]/).pop());
  assert.ok(names.includes("ollama.env"));
  assert.ok(names.includes("llama.cpp.env"));
});

test("apply plan resolves ${MANAGED_DIR} in values", () => {
  const plan = buildApplyPlan(["hf-cache-location"], OPTIONS);
  const dir = managedDir();
  const file = plan.files.find((f) => f.path.endsWith("huggingface.env"))!;
  assert.ok(file.content.includes(`export HF_HOME="${dir}/hf"`));
  assert.ok(!file.content.includes("${MANAGED_DIR}"));
});

test("apply plan writes only inside the managed directory", () => {
  const plan = buildApplyPlan(["flash-attention"], OPTIONS);
  const dir = managedDir();
  for (const f of plan.files) {
    assert.ok(f.path.startsWith(dir), `${f.path} must be inside ${dir}`);
  }
});

test("apply plan is empty when no options contribute env", () => {
  const plan = buildApplyPlan(["provider-prompt-cache"], OPTIONS);
  assert.equal(Object.keys(plan.envVars).length, 0);
  assert.equal(plan.files.length, 0);
});
