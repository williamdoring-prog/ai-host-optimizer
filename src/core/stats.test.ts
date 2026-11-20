import { test } from "node:test";
import assert from "node:assert/strict";

import {
  bootstrapDiffCI,
  bootstrapMedianCI,
  iqr,
  mad,
  median,
} from "./stats.js";

test("median returns the middle value and averages the two middles", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([]), undefined);
  // Non-finite values are ignored.
  assert.equal(median([1, Number.NaN, 3, Number.POSITIVE_INFINITY]), 2);
});

test("mad is the raw median absolute deviation", () => {
  assert.equal(mad([1, 2, 3, 4, 5]), 1);
  assert.equal(mad([2, 2, 2]), 0);
  assert.equal(mad([]), undefined);
});

test("iqr uses linear-interpolation quartiles (Q3 - Q1)", () => {
  assert.equal(iqr([1, 2, 3, 4, 5]), 2);
  assert.equal(iqr([1, 2, 3, 4]), 1.5);
  assert.equal(iqr([1]), 0);
  assert.equal(iqr([]), undefined);
});

test("bootstrapMedianCI is deterministic for a fixed seed and brackets the median", () => {
  const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const a = bootstrapMedianCI(values, { seed: 7, iterations: 500 });
  const b = bootstrapMedianCI(values, { seed: 7, iterations: 500 });
  assert.deepEqual(a, b);
  const point = median(values)!;
  assert.ok(a !== undefined);
  assert.ok(a!.low <= point, `${a!.low} <= ${point}`);
  assert.ok(point <= a!.high, `${point} <= ${a!.high}`);
  // A different seed still brackets the point estimate.
  const c = bootstrapMedianCI(values, { seed: 99, iterations: 500 })!;
  assert.ok(c.low <= point && point <= c.high);
  assert.equal(bootstrapMedianCI([]), undefined);
});

test("bootstrapDiffCI excludes zero for clearly separated distributions", () => {
  const diff = bootstrapDiffCI([1, 2, 3, 4, 5], [100, 101, 102, 103, 104], {
    seed: 3,
    iterations: 500,
  });
  assert.ok(diff !== undefined);
  assert.ok(diff!.low > 0, `low=${diff!.low} should exceed 0`);
  assert.ok(diff!.median > 0);
});

test("bootstrapDiffCI includes zero for identical distributions", () => {
  const same = [4, 5, 6, 7, 8];
  const diff = bootstrapDiffCI(same, same, { seed: 3, iterations: 500 });
  assert.ok(diff !== undefined);
  assert.ok(diff!.low <= 0 && 0 <= diff!.high, `[${diff!.low}, ${diff!.high}] should contain 0`);
  assert.equal(diff!.median, 0);
});

test("bootstrapDiffCI is deterministic and undefined on empty input", () => {
  const a = bootstrapDiffCI([1, 2, 3], [4, 5, 6], { seed: 11 });
  const b = bootstrapDiffCI([1, 2, 3], [4, 5, 6], { seed: 11 });
  assert.deepEqual(a, b);
  assert.equal(bootstrapDiffCI([], [1]), undefined);
  assert.equal(bootstrapDiffCI([1], []), undefined);
});
