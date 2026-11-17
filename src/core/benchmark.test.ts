import { test } from "node:test";
import assert from "node:assert/strict";

import { compare, DEFAULT_NOISE_FLOOR } from "./benchmark.js";
import type { BenchmarkResult } from "./benchmark.js";

function result(over: Partial<BenchmarkResult>): BenchmarkResult {
  return {
    timestamp: new Date().toISOString(),
    memFreeMiB: 1000,
    note: "test",
    ...over,
  };
}

test("compare reports the decode delta and flags significance above the noise floor", () => {
  const cmp = compare(
    result({ tokensPerSec: 10, totalMs: 5000, spread: 0.05 }),
    result({ tokensPerSec: 12, totalMs: 4000, spread: 0.05 }),
  );
  assert.ok(Math.abs((cmp.tokensPerSecDelta ?? 0) - 0.2) < 1e-9);
  assert.equal(cmp.significant, true);
  // The noise floor is the COMBINED range of the two measurements.
  assert.ok(Math.abs(cmp.noiseFloor - 0.1) < 1e-9);
});

test("a delta inside the combined noise floor is not significant", () => {
  const cmp = compare(
    result({ tokensPerSec: 10, totalMs: 5000, spread: 0.07 }),
    result({ tokensPerSec: 10.7, totalMs: 4900, spread: 0.07 }),
  );
  // 7% change is inside a combined ±14% floor: must not be claimed.
  assert.equal(cmp.significant, false);
  assert.ok(Math.abs(cmp.noiseFloor - 0.14) < 1e-9);
});

test("compare falls back to DEFAULT_NOISE_FLOOR when spreads are absent", () => {
  const cmp = compare(
    result({ tokensPerSec: 10, totalMs: 5000 }),
    result({ tokensPerSec: 10.1, totalMs: 4950 }),
  );
  assert.equal(cmp.noiseFloor, DEFAULT_NOISE_FLOOR);
  assert.equal(cmp.significant, false);
});

test("compare handles measurements with no comparable metric", () => {
  const cmp = compare(result({ memFreeMiB: 900 }), result({ memFreeMiB: 800 }));
  assert.equal(cmp.tokensPerSecDelta, undefined);
  assert.equal(cmp.latencyDelta, undefined);
  assert.equal(cmp.significant, false);
  assert.equal(cmp.memFreeDeltaMiB, -100);
});
