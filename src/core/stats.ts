/**
 * Statistics primitives (P1) — pure, deterministic, no I/O.
 *
 * Benchmark headlines are MEDIANS, and every claim of "faster" must be backed
 * by an interval rather than a single point difference. This module provides
 * the robust summaries (median/MAD/IQR) and a percentile bootstrap that turns a
 * handful of noisy samples into an honest confidence interval.
 *
 * Everything here is deterministic: the bootstrap is driven by a seeded
 * mulberry32 PRNG, so the same input and seed always produce the same interval.
 */

/** Options shared by the bootstrap estimators. */
export interface BootstrapOptions {
  /** Confidence level (default 0.95). */
  level?: number;
  /** Resample count (default 2000). More = tighter, slower. */
  iterations?: number;
  /** PRNG seed (default 1) — fixes reproducibility. */
  seed?: number;
}

/** A closed confidence interval. */
export interface Interval {
  low: number;
  high: number;
}

/** A confidence interval for a difference of medians. */
export interface DiffInterval extends Interval {
  /** Point estimate: median(b) − median(a). */
  median: number;
}

/** Only keep finite numbers. */
function finite(values: number[]): number[] {
  return values.filter((v) => Number.isFinite(v));
}

function ascending(a: number, b: number): number {
  return a - b;
}

/** Median of the finite values; `undefined` when there are none. */
export function median(values: number[]): number | undefined {
  const xs = finite(values).sort(ascending);
  const n = xs.length;
  if (n === 0) return undefined;
  const mid = Math.floor(n / 2);
  const hi = xs[mid]!;
  return n % 2 ? hi : (xs[mid - 1]! + hi) / 2;
}

/**
 * Median absolute deviation (raw, unscaled): the median of |x − median(x)|.
 * `undefined` for an empty input.
 */
export function mad(values: number[]): number | undefined {
  const xs = finite(values);
  const center = median(xs);
  if (center === undefined) return undefined;
  return median(xs.map((x) => Math.abs(x - center)));
}

/** Linear-interpolation quantile of an already-sorted array. */
function quantileSorted(xs: number[], p: number): number | undefined {
  const n = xs.length;
  if (n === 0) return undefined;
  if (n === 1) return xs[0];
  const clamped = Math.max(0, Math.min(1, p));
  const pos = (n - 1) * clamped;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return xs[lo];
  return xs[lo]! + (xs[hi]! - xs[lo]!) * (pos - lo);
}

/** Interquartile range (Q3 − Q1) with linear-interpolation quartiles. */
export function iqr(values: number[]): number | undefined {
  const xs = finite(values).sort(ascending);
  const q1 = quantileSorted(xs, 0.25);
  const q3 = quantileSorted(xs, 0.75);
  if (q1 === undefined || q3 === undefined) return undefined;
  return q3 - q1;
}

/**
 * Deterministic mulberry32 PRNG. Returns a function producing values in [0, 1).
 * Exported so callers (and tests) can reproduce a resample stream exactly.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Draw a bootstrap resample (with replacement) from `xs`. */
function resample(xs: number[], rng: () => number): number[] {
  const n = xs.length;
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    // Clamp the index defensively: rng() is in [0, 1) but never trust that.
    const idx = Math.min(n - 1, Math.max(0, Math.floor(rng() * n)));
    out[i] = xs[idx]!;
  }
  return out;
}

/**
 * Percentile-bootstrap confidence interval for the median. Returns `undefined`
 * for an empty input. The returned interval is guaranteed to bracket the point
 * estimate (median of the input) so `low ≤ median ≤ high` always holds.
 */
export function bootstrapMedianCI(
  values: number[],
  opts: BootstrapOptions = {},
): Interval | undefined {
  const xs = finite(values);
  if (xs.length === 0) return undefined;
  const { level = 0.95, iterations = 2000, seed = 1 } = opts;
  const rng = mulberry32(seed);
  const stats = new Array<number>(iterations);
  for (let i = 0; i < iterations; i++) {
    stats[i] = median(resample(xs, rng))!;
  }
  stats.sort(ascending);
  const alpha = (1 - level) / 2;
  const low = quantileSorted(stats, alpha)!;
  const high = quantileSorted(stats, 1 - alpha)!;
  const point = median(xs)!;
  return { low: Math.min(low, point), high: Math.max(high, point) };
}

/**
 * Percentile-bootstrap confidence interval for the difference of medians,
 * `median(b) − median(a)` (positive = `b` is larger). `undefined` when either
 * side is empty. The point estimate is always bracketed by the interval.
 */
export function bootstrapDiffCI(
  a: number[],
  b: number[],
  opts: BootstrapOptions = {},
): DiffInterval | undefined {
  const xs = finite(a);
  const ys = finite(b);
  if (xs.length === 0 || ys.length === 0) return undefined;
  const { level = 0.95, iterations = 2000, seed = 1 } = opts;
  const rng = mulberry32(seed);
  const stats = new Array<number>(iterations);
  for (let i = 0; i < iterations; i++) {
    const medA = median(resample(xs, rng))!;
    const medB = median(resample(ys, rng))!;
    stats[i] = medB - medA;
  }
  stats.sort(ascending);
  const alpha = (1 - level) / 2;
  const low = quantileSorted(stats, alpha)!;
  const high = quantileSorted(stats, 1 - alpha)!;
  const point = median(ys)! - median(xs)!;
  return { low: Math.min(low, point), high: Math.max(high, point), median: point };
}

/** Round to a fixed number of decimal places. */
export function round(n: number, places: number): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}
