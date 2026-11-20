import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  clearCalibrations,
  getCalibration,
  loadCalibrations,
  recordCalibration,
} from "./calibration.js";
import type { CalibrationEntry } from "./calibration.js";
import { DEFAULT_BENCHMARK_PARAMS } from "./benchmark.js";

/** Run a test body against a fresh temp managed directory, always cleaned up. */
async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "aiho-cal-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function entry(over: Partial<CalibrationEntry>): CalibrationEntry {
  return {
    optionId: "kv-cache-quant-q8",
    metric: "decode tokens/s",
    delta: 0.15,
    tier: "A",
    measuredAt: new Date().toISOString(),
    samples: 1,
    method: "test",
    ...over,
  };
}

test("loadCalibrations returns an empty object for an empty dir", async () => {
  await withTempDir(async (dir) => {
    assert.deepEqual(await loadCalibrations(dir), {});
    assert.equal(await getCalibration("kv-cache-quant-q8", dir), undefined);
  });
});

test("recordCalibration then getCalibration round-trips the full entry", async () => {
  await withTempDir(async (dir) => {
    const written = entry({
      optionId: "flash-attn",
      metric: "decode tokens/s",
      delta: 0.22,
      noiseFloor: 0.05,
      significant: true,
      tier: "A-",
      model: "llama3:8b",
      profile: "decode",
      params: { ...DEFAULT_BENCHMARK_PARAMS, numPredict: 128 },
      ci: { low: 0.11, high: 0.33 },
      reproduced: true,
      samples: 5,
      method: "before/after measurement on this host",
    });
    const path = await recordCalibration(written, dir);
    assert.equal(path, join(dir, "calibration.json"));

    const got = await getCalibration("flash-attn", dir);
    assert.ok(got !== undefined);
    assert.equal(got!.tier, "A-");
    assert.equal(got!.profile, "decode");
    assert.deepEqual(got!.params, { ...DEFAULT_BENCHMARK_PARAMS, numPredict: 128 });
    assert.deepEqual(got!.ci, { low: 0.11, high: 0.33 });
    assert.equal(got!.model, "llama3:8b");
    assert.equal(got!.reproduced, true);

    const all = await loadCalibrations(dir);
    assert.deepEqual(Object.keys(all), ["flash-attn"]);
  });
});

test("a prior entry with the same metric+model+profile is averaged (samples summed)", async () => {
  await withTempDir(async (dir) => {
    await recordCalibration(
      entry({ optionId: "opt", delta: 0.1, model: "m", profile: "decode", samples: 1 }),
      dir,
    );
    await recordCalibration(
      entry({ optionId: "opt", delta: 0.3, model: "m", profile: "decode", samples: 3 }),
      dir,
    );

    const got = await getCalibration("opt", dir);
    assert.ok(got !== undefined);
    // Weighted by sample count: (0.1*1 + 0.3*3) / 4 = 0.25.
    assert.equal(got!.delta, 0.25);
    assert.equal(got!.samples, 4);
    assert.match(got!.method, /averaged over 4 observation/);
  });
});

test("a prior entry with a different model replaces rather than blending", async () => {
  await withTempDir(async (dir) => {
    await recordCalibration(
      entry({ optionId: "opt", delta: 0.1, model: "m1", profile: "decode", samples: 1 }),
      dir,
    );
    await recordCalibration(
      entry({ optionId: "opt", delta: 0.5, model: "m2", profile: "decode", samples: 2 }),
      dir,
    );

    const got = await getCalibration("opt", dir);
    assert.ok(got !== undefined);
    assert.equal(got!.delta, 0.5);
    assert.equal(got!.samples, 2);
    assert.equal(got!.model, "m2");
  });
});

test("a prior entry with a different profile replaces rather than blending", async () => {
  await withTempDir(async (dir) => {
    await recordCalibration(
      entry({ optionId: "opt", delta: 0.1, model: "m", profile: "decode", samples: 1 }),
      dir,
    );
    await recordCalibration(
      entry({ optionId: "opt", delta: 0.4, model: "m", profile: "prefill", samples: 2 }),
      dir,
    );

    const got = await getCalibration("opt", dir);
    assert.ok(got !== undefined);
    assert.equal(got!.delta, 0.4);
    assert.equal(got!.samples, 2);
    assert.equal(got!.profile, "prefill");
  });
});

test("clearCalibrations removes the file and the store reloads empty", async () => {
  await withTempDir(async (dir) => {
    await recordCalibration(entry({ optionId: "opt" }), dir);
    assert.notDeepEqual(await loadCalibrations(dir), {});

    await clearCalibrations(dir);
    assert.deepEqual(await loadCalibrations(dir), {});
    assert.equal(await getCalibration("opt", dir), undefined);
  });
});
