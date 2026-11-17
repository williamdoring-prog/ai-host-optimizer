/**
 * Calibration store (M1b).
 *
 * Records the *measured* effect of an option on THIS host, so its estimate can be
 * promoted from tier B/C (cited guess) to **tier A (measured)**.
 *
 * Storage: `<managedDir>/calibration.json`. One entry per option id.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { managedDir } from "./applier.js";

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
  /** True only when |delta| exceeded the noise floor. */
  significant?: boolean;
  /** Tier A only when the change was significant; otherwise tier C. */
  tier: "A" | "C";
  model?: string;
  measuredAt: string;
  /** Number of observations averaged. */
  samples: number;
  /** Method note. */
  method: string;
}

type CalibrationFile = Record<string, CalibrationEntry>;

function calibrationPath(): string {
  return join(managedDir(), "calibration.json");
}

/** Load all calibration entries (empty object if none). */
export async function loadCalibrations(): Promise<CalibrationFile> {
  try {
    return JSON.parse(await readFile(calibrationPath(), "utf8")) as CalibrationFile;
  } catch {
    return {};
  }
}

/** Get a single option's calibration, if present. */
export async function getCalibration(optionId: string): Promise<CalibrationEntry | undefined> {
  return (await loadCalibrations())[optionId];
}

/**
 * Record (or update) a calibration entry. If an entry already exists for the
 * option, the delta is averaged (weighted by sample count) so repeated
 * measurements converge.
 */
export async function recordCalibration(entry: CalibrationEntry): Promise<string> {
  const dir = managedDir();
  await mkdir(dir, { recursive: true });
  const all = await loadCalibrations();
  const prior = all[entry.optionId];
  let merged = entry;
  if (prior && prior.metric === entry.metric) {
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
  const path = calibrationPath();
  await writeFile(path, JSON.stringify(all, null, 2), "utf8");
  return path;
}

/** Remove all calibration data. */
export async function clearCalibrations(): Promise<void> {
  const { rm } = await import("node:fs/promises");
  await rm(calibrationPath(), { force: true });
}
