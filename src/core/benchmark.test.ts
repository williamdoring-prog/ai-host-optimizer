import { test } from "node:test";
import assert from "node:assert/strict";

import {
  compare,
  DEFAULT_BENCHMARK_PARAMS,
  DEFAULT_NOISE_FLOOR,
  isLoopbackHost,
  PROFILES,
  summarizeBenchmark,
} from "./benchmark.js";
import type { BenchmarkResult } from "./benchmark.js";

function result(over: Partial<BenchmarkResult>): BenchmarkResult {
  return {
    timestamp: new Date().toISOString(),
    profile: "decode",
    params: DEFAULT_BENCHMARK_PARAMS,
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

test("compare uses a bootstrap CI on raw samples and flags a separated change", () => {
  const cmp = compare(
    result({ model: "m", samples: [10, 10.2, 9.8], tokensPerSec: 10 }),
    result({ model: "m", samples: [13, 13.1, 12.9], tokensPerSec: 13 }),
  );
  assert.ok(cmp.ci !== undefined);
  assert.equal(cmp.ci!.level, 0.95);
  assert.equal(cmp.significant, true);
  assert.ok(cmp.diffMedian !== undefined && cmp.diffMedian > 0);
  assert.match(cmp.method, /bootstrap/i);
});

test("compare's CI includes zero for unchanged samples (not significant)", () => {
  const samples = [10, 10.2, 9.8, 10.1];
  const cmp = compare(
    result({ model: "m", samples, tokensPerSec: 10.025 }),
    result({ model: "m", samples, tokensPerSec: 10.025 }),
  );
  assert.ok(cmp.ci !== undefined);
  assert.ok(cmp.ci!.low <= 0 && 0 <= cmp.ci!.high);
  assert.equal(cmp.significant, false);
});

test("isLoopbackHost accepts loopback names/addresses", () => {
  for (const host of [
    "127.0.0.1",
    "127.5.5.5",
    "localhost",
    "LOCALHOST",
    "::1",
    "[::1]",
    "http://127.0.0.1:11434",
    "[::1]:11434",
  ]) {
    assert.equal(isLoopbackHost(host), true, `expected ${host} to be loopback`);
  }
});

test("isLoopbackHost rejects non-loopback hosts", () => {
  for (const host of ["0.0.0.0", "10.0.0.5", "example.com", "192.168.1.10", ""]) {
    assert.equal(isLoopbackHost(host), false, `expected ${host} not to be loopback`);
  }
});

test("PROFILES defines all four regimes with the expected shape", () => {
  assert.deepEqual(Object.keys(PROFILES).sort(), ["decode", "load", "prefill", "throughput"]);
  assert.equal(PROFILES.decode.numPredict, 128);
  assert.equal(PROFILES.prefill.numPredict, 16);
  assert.equal(PROFILES.throughput.numPredict, 64);
  assert.equal(PROFILES.throughput.concurrency, 4);
  assert.equal(PROFILES.load.numPredict, 1);
  assert.equal(PROFILES.load.concurrency, undefined);
  // Prefill uses a long prompt; decode uses a short one.
  assert.ok(PROFILES.prefill.prompt.length > PROFILES.decode.prompt.length);
});

test("summarizeBenchmark records the profile and fixed params", () => {
  const summary = summarizeBenchmark("decode", DEFAULT_BENCHMARK_PARAMS, {
    memFreeMiB: 1234,
    model: "m",
    decodeSamples: [10, 12, 11],
  });
  assert.equal(summary.profile, "decode");
  assert.deepEqual(summary.params, DEFAULT_BENCHMARK_PARAMS);
  assert.equal(summary.params.seed, 42);
  assert.equal(summary.params.temperature, 0);
  assert.equal(summary.params.numCtx, 4096);
  assert.equal(summary.params.numBatch, 512);
  assert.equal(summary.tokensPerSec, 11);
  assert.equal(summary.median, 11);
  assert.equal(summary.sampleCount, 3);
  assert.deepEqual(summary.samples, [10, 12, 11]);
  assert.ok(summary.ci !== undefined && summary.ci.low <= 11 && 11 <= summary.ci.high);
});

test("summarizeBenchmark is deterministic (seeded CI)", () => {
  const input = { memFreeMiB: 1, timestamp: "fixed", decodeSamples: [3, 5, 4, 9, 2] };
  assert.deepEqual(
    summarizeBenchmark("throughput", DEFAULT_BENCHMARK_PARAMS, input),
    summarizeBenchmark("throughput", DEFAULT_BENCHMARK_PARAMS, input),
  );
});
