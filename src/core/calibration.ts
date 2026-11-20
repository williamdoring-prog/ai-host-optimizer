/**
 * Calibration store (P1).
 *
 * Records the *measured* effect of an option on THIS host, so its estimate can
 * be promoted from tier B/C (cited guess) to a measured tier.
 *
 * Tiering (honesty contract):
 *   A  = reproduced / significant — the CI excludes zero;
 *   A- = a significant single-session result (magnitude uncertain);
 *   N  = measured null — no change beyond the interval.
 *
 * Storage: `<managedDir>/calibration.json`. One entry per option id.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { managedDir } from "./paths.js";
import type { BenchmarkParams, BenchmarkProfileId } from "./benchmark.js";

export interface CalibrationEntry {
  optionId: string;
  /** What was measured, e.g. "decode tokens/s". */
  metric: string;
  /** Fractional change (0.14 = +14%); positive = improvement. */
  delta: number;
  /**
   * The host's noise floor at measurement time. A delta below this is not
   * distinguishable from run-to-run noise and must not be claimed.
   */
  noiseFloor?: number;
  /** True only when the change was distinguishable from noise. */
  significant?: boolean;
  /** A = reproduced/significant; A- = single session; N = measured null. */
  tier: "A" | "A-" | "N";
  /** Model the measurement was taken on. */
  model?: string;
  /** Benchmark profile the measurement was taken with. */
  profile?: BenchmarkProfileId;
  /** Fixed generation parameters the measurement used. */
  params?: BenchmarkParams;
  /** Confidence interval on the measured difference. */
  ci?: { low: number; high: number };
  /** True when the result was reproduced across sessions. */
  reproduced?: boolean;
  measuredAt: string;
  /** Number of observations averaged. */
  samples: number;
  /** Method note. */
  method: string;
}

type CalibrationFile = Record<string, CalibrationEntry>;

function calibrationPath(dir: string): string {
  return join(dir, "calibration.json");
}

/** Load all calibration entries (empty object if none). */
export async function loadCalibrations(dir: string = managedDir()): Promise<CalibrationFile> {
  try {
    return JSON.parse(await readFile(calibrationPath(dir), "utf8")) as CalibrationFile;
  } catch {
    return {};
  }
}

/** Get a single option's calibration, if present. */
export async function getCalibration(
  optionId: string,
  dir: string = managedDir(),
): Promise<CalibrationEntry | undefined> {
  return (await loadCalibrations(dir))[optionId];
}

/**
 * Record (or update) a calibration entry. A prior entry is averaged (weighted
 * by sample count) ONLY when it measured the same thing: same metric, same
 * model AND same profile. Measurements from a different model or profile are
 * not blended — they replace the prior entry instead.
 */
export async function recordCalibration(
  entry: CalibrationEntry,
  dir: string = managedDir(),
): Promise<string> {
  await mkdir(dir, { recursive: true });
  const all = await loadCalibrations(dir);
  const prior = all[entry.optionId];
  let merged = entry;
  if (
    prior &&
    prior.metric === entry.metric &&
    prior.model === entry.model &&
    prior.profile === entry.profile
  ) {
    const samples = prior.samples + entry.samples;
    const delta = (prior.delta * prior.samples + entry.delta * entry.samples) / samples;
    merged = {
      ...entry,
      delta: Math.round(delta * 1e6) / 1e6,
      samples,
      method: `${entry.method} (averaged over ${samples} observation(s))`,
    };
  }
  all[entry.optionId] = merged;
  const path = calibrationPath(dir);
  await writeFile(path, JSON.stringify(all, null, 2), "utf8");
  return path;
}

/** Remove all calibration data. */
export async function clearCalibrations(dir: string = managedDir()): Promise<void> {
  const { rm } = await import("node:fs/promises");
  await rm(calibrationPath(dir), { force: true });
}
