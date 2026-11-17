import { test } from "node:test";
import assert from "node:assert/strict";

import { OPTIONS } from "../registry/options.js";
import { buildChecklist, validateRegistry } from "./checklist.js";
import type { HostProfile } from "./types.js";

const fakeLinux: HostProfile = {
  timestamp: new Date().toISOString(),
  platform: "linux",
  os: { platform: "linux", release: "6.0", arch: "x64" },
  cpu: { model: "test", cores: 8 },
  memory: { totalMiB: 32768, freeMiB: 16384 },
  tooling: [],
};

const fakeWindows: HostProfile = { ...fakeLinux, platform: "windows" };

test("registry is internally consistent", () => {
  assert.deepEqual(validateRegistry(OPTIONS), []);
});

test("every tier-B estimate has a number and a method", () => {
  for (const o of OPTIONS) {
    if (o.expectedImprovement.tier === "B") {
      assert.notEqual(o.expectedImprovement.estimate, undefined, o.id);
      assert.ok(o.expectedImprovement.method, o.id);
    }
  }
});

test("KV-cache q8_0 and q4_0 are in the same exclusive group", () => {
  const q8 = OPTIONS.find((o) => o.id === "kv-cache-quant-q8")!;
  const q4 = OPTIONS.find((o) => o.id === "kv-cache-quant-q4")!;
  assert.equal(q8.exclusiveGroup, q4.exclusiveGroup);
  assert.ok(q8.exclusiveGroup);
});

test("zram and disk swap are exclusive and conflict", () => {
  const zram = OPTIONS.find((o) => o.id === "zram")!;
  const swap = OPTIONS.find((o) => o.id === "disk-swap")!;
  assert.equal(zram.exclusiveGroup, swap.exclusiveGroup);
  assert.ok(zram.conflictsWith.includes("disk-swap"));
});

test("kv-cache quantization requires flash-attention", () => {
  const q8 = OPTIONS.find((o) => o.id === "kv-cache-quant-q8")!;
  assert.ok(q8.requires.includes("flash-attention"));
});

test("linux-only options are marked not applicable on windows", () => {
  const items = buildChecklist(fakeWindows, OPTIONS);
  const numa = items.find((i) => i.option.id === "numa-binding")!;
  assert.equal(numa.applicable, false);
  assert.match(numa.reason ?? "", /windows/);
});

test("checklist covers every option", () => {
  const items = buildChecklist(fakeLinux, OPTIONS);
  assert.equal(items.length, OPTIONS.length);
});

test("container role disables privileged host-level options", () => {
  const items = buildChecklist({ ...fakeLinux, role: "container" }, OPTIONS);
  const zram = items.find((i) => i.option.id === "zram")!;
  assert.equal(zram.applicable, false);
  assert.match(zram.reason ?? "", /container/);
});

test("cluster-node role is advisory-only", () => {
  const items = buildChecklist({ ...fakeLinux, role: "cluster-node" }, OPTIONS);
  assert.ok(items.every((i) => i.advisoryOnly));
});

test("vendor gating: ROCm not applicable without AMD hardware", () => {
  const items = buildChecklist(fakeLinux, OPTIONS); // no gpu in the fake profile
  const rocm = items.find((i) => i.option.id === "rocm-backend")!;
  assert.equal(rocm.applicable, false);
  assert.match(rocm.reason ?? "", /amd/);
});

test("vendor gating: CUDA applicable when an NVIDIA GPU is present", () => {
  const withNvidia: HostProfile = {
    ...fakeLinux,
    gpu: [{ vendor: "nvidia", name: "Test GPU", vramMiB: 8192, source: "test" }],
  };
  const items = buildChecklist(withNvidia, OPTIONS);
  const cuda = items.find((i) => i.option.id === "cuda-backend")!;
  assert.equal(cuda.applicable, true);
});
