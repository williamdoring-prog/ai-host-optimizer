import { test } from "node:test";
import assert from "node:assert/strict";

import { OPTIONS } from "../registry/options.js";
import { buildChecklist, isAdvisoryRole, validateRegistry } from "./checklist.js";
import type { HostProfile, OptimizationOption } from "./types.js";

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

test("detected container context (no role) disables privileged options", () => {
  const items = buildChecklist({ ...fakeLinux, context: { container: "docker" } }, OPTIONS);
  const zram = items.find((i) => i.option.id === "zram")!;
  assert.equal(zram.applicable, false);
  assert.match(zram.reason ?? "", /container/);
});

test("explicit non-container role wins over a detected container context", () => {
  const items = buildChecklist(
    { ...fakeLinux, role: "workstation", context: { container: "docker" } },
    OPTIONS,
  );
  const zram = items.find((i) => i.option.id === "zram")!;
  assert.equal(zram.applicable, true);
});

test("explicitly empty visibleGpus gates vendor options but not others", () => {
  const items = buildChecklist({ ...fakeLinux, context: { visibleGpus: [] } }, OPTIONS);
  const rocm = items.find((i) => i.option.id === "rocm-backend")!;
  assert.equal(rocm.applicable, false);
  assert.match(rocm.reason ?? "", /no GPU visible/);
  const flash = items.find((i) => i.option.id === "flash-attention")!;
  assert.equal(flash.applicable, true);
});

test("non-empty visibleGpus does not gate vendor logic", () => {
  const items = buildChecklist({ ...fakeLinux, context: { visibleGpus: ["0"] } }, OPTIONS);
  const rocm = items.find((i) => i.option.id === "rocm-backend")!;
  assert.equal(rocm.applicable, false);
  assert.match(rocm.reason ?? "", /amd/);
});

// --- registry validation -----------------------------------------------------

function option(over: Partial<OptimizationOption> = {}): OptimizationOption {
  return {
    id: "test-opt",
    name: "Test option",
    description: "fixture",
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
    source: "https://example.com/docs",
    ...over,
  };
}

test("validation rejects duplicate ids", () => {
  const problems = validateRegistry([option({ id: "a" }), option({ id: "a" })]);
  assert.ok(problems.some((p) => /duplicate option id/.test(p)));
});

test("validation rejects an unknown applyOp", () => {
  const problems = validateRegistry([option({ applyOp: "bogus" as never })]);
  assert.ok(problems.some((p) => /unknown applyOp/.test(p)));
});

test("validation rejects env declared without the env op and vice versa", () => {
  assert.ok(
    validateRegistry([option({ applyOp: "env" })]).some((p) => /no env variables/.test(p)),
  );
  assert.ok(
    validateRegistry([option({ env: { ollama: { X: "1" } } })]).some((p) =>
      /applyOp is not "env"/.test(p),
    ),
  );
});

test("validation rejects malformed env names, targets and values", () => {
  const badName = validateRegistry([option({ applyOp: "env", env: { ollama: { "bad-name": "1" } } })]);
  assert.ok(badName.some((p) => /invalid env variable name/.test(p)));

  const badTarget = validateRegistry([option({ applyOp: "env", env: { "../evil": { X: "1" } } })]);
  assert.ok(badTarget.some((p) => /invalid env target name/.test(p)));

  const newline = validateRegistry([option({ applyOp: "env", env: { ollama: { X: "a\nb" } } })]);
  assert.ok(newline.some((p) => /newline/.test(p)));

  const template = validateRegistry([
    option({ applyOp: "env", env: { ollama: { X: "{{ lookup('pipe','id') }}" } } }),
  ]);
  assert.ok(template.some((p) => /template markers/.test(p)));
});

test("validation rejects invalid combine models", () => {
  const problems = validateRegistry([option({ combine: "bogus" as never })]);
  assert.ok(problems.some((p) => /invalid combine/.test(p)));
});

test("validation detects requires self-reference and cycles", () => {
  assert.ok(
    validateRegistry([option({ id: "a", requires: ["a"] })]).some((p) => /requires itself/.test(p)),
  );
  const cyclic = validateRegistry([
    option({ id: "a", requires: ["b"] }),
    option({ id: "b", requires: ["a"] }),
  ]);
  assert.ok(cyclic.some((p) => /requires cycle/.test(p)));
});

test("validation rejects dangling path-like citations but allows prose", () => {
  assert.ok(
    validateRegistry([option({ source: "research/mcp/does-not-exist.md" })]).some((p) =>
      /neither a URL nor an existing file/.test(p),
    ),
  );
  assert.deepEqual(validateRegistry([option({ source: "Ollama documentation." })]), []);
});

test("validation rejects a tier-B estimate without a method or number", () => {
  const problems = validateRegistry([
    option({ expectedImprovement: { metric: "m", tier: "B", estimate: 0.1 } }),
  ]);
  assert.ok(problems.some((p) => /tier B estimate requires a method/.test(p)));
});

test("validation accepts a well-formed size option", () => {
  const problems = validateRegistry([
    option({
      applyOp: "size",
      env: { ollama: { OLLAMA_CONTEXT_LENGTH: "8192" } },
      size: { defaultValue: 4096, unit: "tokens" },
    }),
  ]);
  assert.deepEqual(problems, []);
});

test("validation rejects a size option whose value is not an improvement", () => {
  const tooLow = validateRegistry([
    option({
      applyOp: "size",
      env: { ollama: { X: "2048" } },
      size: { defaultValue: 4096 },
    }),
  ]);
  assert.ok(tooLow.some((p) => /must exceed the default 4096/.test(p)));

  const wrongDirection = validateRegistry([
    option({
      applyOp: "size",
      env: { ollama: { X: "8192" } },
      size: { defaultValue: 4096, direction: "lower" },
    }),
  ]);
  assert.ok(wrongDirection.some((p) => /must be below the default 4096/.test(p)));
});

test("validation rejects malformed size guards", () => {
  assert.ok(
    validateRegistry([
      option({ applyOp: "size", env: { ollama: { X: "8192" } } }),
    ]).some((p) => /requires a size guard/.test(p)),
  );
  assert.ok(
    validateRegistry([
      option({
        applyOp: "size",
        env: { ollama: { X: "8g" } },
        size: { defaultValue: 4096 },
      }),
    ]).some((p) => /must be an integer/.test(p)),
  );
  assert.ok(
    validateRegistry([
      option({
        applyOp: "size",
        env: { ollama: { X: "8192" }, "llama.cpp": { Y: "8192" } },
        size: { defaultValue: 4096 },
      }),
    ]).some((p) => /exactly one env variable/.test(p)),
  );
  assert.ok(
    validateRegistry([
      option({ applyOp: "env", env: { ollama: { X: "1" } }, size: { defaultValue: 0 } }),
    ]).some((p) => /size guard but applyOp is not "size"/.test(p)),
  );
});

test("isAdvisoryRole is true only for governed/ephemeral roles", () => {
  assert.equal(isAdvisoryRole("cluster-node"), true);
  assert.equal(isAdvisoryRole("ci-runner"), true);
  assert.equal(isAdvisoryRole("workstation"), false);
  assert.equal(isAdvisoryRole(undefined), false);
});

test("numeric levers use the guarded size op", () => {
  for (const id of [
    "ollama-context-length",
    "llama-ctx-size",
    "llama-batch-size",
    "llama-ubatch-size",
    "ollama-max-queue",
    "ollama-num-parallel",
  ]) {
    const option = OPTIONS.find((o) => o.id === id)!;
    assert.equal(option.applyOp, "size", `${id} should use the size op`);
    assert.ok(option.size, `${id} should declare a size guard`);
  }
});
