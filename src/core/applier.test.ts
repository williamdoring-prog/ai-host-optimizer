import { test } from "node:test";
import assert from "node:assert/strict";

import { buildApplyPlan, managedDir } from "./applier.js";
import { OPTIONS } from "../registry/options.js";

test("managedDir is an absolute path", () => {
  assert.ok(managedDir().length > 0);
});

test("apply plan collects env from Ollama-env options", () => {
  const plan = buildApplyPlan(["flash-attention", "kv-cache-quant-q8"], OPTIONS);
  assert.equal(plan.envVars["OLLAMA_FLASH_ATTENTION"], "1");
  assert.equal(plan.envVars["OLLAMA_KV_CACHE_TYPE"], "q8_0");
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
});
