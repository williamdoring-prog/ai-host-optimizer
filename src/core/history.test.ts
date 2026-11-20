import { test } from "node:test";
import assert from "node:assert/strict";

import {
  configDigest,
  detectRegressions,
  seriesKey,
  type HistoryRecord,
} from "./history.js";
import type { BenchmarkResult } from "./benchmark.js";

function result(over: Partial<BenchmarkResult>): BenchmarkResult {
  return {
    timestamp: new Date().toISOString(),
    profile: "decode",
    params: { seed: 42, temperature: 0, numCtx: 4096, numBatch: 512, numPredict: 128 },
    memFreeMiB: 1000,
    note: "test",
    ...over,
  };
}

function record(r: BenchmarkResult, key = "k"): HistoryRecord {
  return { key, host: "h", configDigest: "d", recordedAt: r.timestamp, result: r };
}

test("configDigest is stable and order-independent", () => {
  assert.equal(configDigest(["b", "a"]), configDigest(["a", "b"]));
  assert.equal(configDigest(["a", "a", "b"]), configDigest(["a", "b"]));
  assert.notEqual(configDigest(["a"]), configDigest(["b"]));
  assert.match(configDigest([]), /^[0-9a-f]{8}$/);
});

test("seriesKey includes host, runtime, model, profile and config", () => {
  const key = seriesKey(result({ model: "m", runtime: "ollama" }), "host", "abcd1234");
  assert.equal(key, "host | ollama | m | decode | abcd1234");
});

test("detectRegressions flags a significant slowdown", () => {
  const previous = result({ model: "m", tokensPerSec: 200, samples: [198, 200, 202] });
  const latest = result({ model: "m", tokensPerSec: 80, samples: [78, 80, 82] });
  const regressions = detectRegressions([record(previous), record(latest)]);
  assert.equal(regressions.length, 1);
  assert.ok((regressions[0]!.delta ?? 0) < 0);
});

test("detectRegressions ignores an improvement and a single record", () => {
  const slower = result({ model: "m", tokensPerSec: 80, samples: [78, 80, 82] });
  const faster = result({ model: "m", tokensPerSec: 120, samples: [118, 120, 122] });
  assert.equal(detectRegressions([record(slower), record(faster)]).length, 0);
  assert.equal(detectRegressions([record(faster)]).length, 0);
});

test("detectRegressions ignores a change within the interval", () => {
  const a = result({ model: "m", tokensPerSec: 100, samples: [90, 100, 110] });
  const b = result({ model: "m", tokensPerSec: 100, samples: [90, 100, 110] });
  assert.equal(detectRegressions([record(a), record(b)]).length, 0);
});

test("detectRegressions treats different series independently", () => {
  const prev = result({ model: "m", tokensPerSec: 200, samples: [198, 200, 202] });
  const latest = result({ model: "m", tokensPerSec: 80, samples: [78, 80, 82] });
  // Same model, but a different series key (e.g. a different config) → no pair.
  assert.equal(detectRegressions([record(prev, "k1"), record(latest, "k2")]).length, 0);
});
