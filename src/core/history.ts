/**
 * Benchmark history and regression detection (P3).
 *
 * Every benchmark run is appended to `<managedDir>/benchmark-history.json`,
 * keyed by (host, runtime, model, profile, config digest). Regression detection
 * compares the newest record of a series to the one before it and flags a
 * slowdown only when the difference is **significant** by the same interval used
 * everywhere else (bootstrap CI, or the combined noise floor) — so a drop within
 * run-to-run noise is never called a regression.
 *
 * Storage and detection are separate: `detectRegressions` is pure and unit-tested
 * without touching disk.
 */

import { hostname } from "node:os";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { managedDir } from "./paths.js";
import { compare, type BenchmarkComparison, type BenchmarkResult } from "./benchmark.js";

/** One recorded benchmark run. */
export interface HistoryRecord {
  /** Series key: host | runtime | model | profile | configDigest. */
  key: string;
  host: string;
  configDigest: string;
  recordedAt: string;
  result: BenchmarkResult;
}

/** Cap the stored history so the file cannot grow without bound. */
const MAX_RECORDS = 500;

export function historyPath(dir: string = managedDir()): string {
  return join(dir, "benchmark-history.json");
}

/** A stable host identity for the series key. */
export function hostIdentity(): string {
  return `${hostname() || "unknown"}|${process.platform}|${process.arch}`;
}

/** A short, stable digest of an applied configuration (order-independent). */
export function configDigest(optionIds: string[]): string {
  const sorted = [...new Set(optionIds)].sort();
  let h = 0x811c9dc5; // FNV-1a
  for (const ch of sorted.join(",")) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** The series key for a result: host + runtime + model + profile + config. */
export function seriesKey(result: BenchmarkResult, host: string, digest: string): string {
  return [host, result.runtime ?? "?", result.model ?? "?", result.profile, digest].join(" | ");
}

/** Load the recorded history (empty array if none). */
export async function loadHistory(dir: string = managedDir()): Promise<HistoryRecord[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(historyPath(dir), "utf8"));
    return Array.isArray(parsed) ? (parsed as HistoryRecord[]) : [];
  } catch {
    return [];
  }
}

/** Append a record (best-effort; caps the file at `MAX_RECORDS`). */
export async function appendHistory(record: HistoryRecord, dir: string = managedDir()): Promise<string> {
  const all = await loadHistory(dir);
  all.push(record);
  const trimmed = all.slice(-MAX_RECORDS);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = historyPath(dir);
  await writeFile(path, JSON.stringify(trimmed, null, 2), { encoding: "utf8", mode: 0o600 });
  return path;
}

/** Remove all recorded history. */
export async function clearHistory(dir: string = managedDir()): Promise<void> {
  await rm(historyPath(dir), { force: true });
}

/** A detected regression: the newest run of a series is significantly slower. */
export interface Regression {
  key: string;
  previous: HistoryRecord;
  latest: HistoryRecord;
  comparison: BenchmarkComparison;
  /** Fractional change in decode rate (negative = slower). */
  delta?: number;
}

/**
 * Find regressions: for each series, compare the newest record to the one before
 * it, and flag it only when the decode rate dropped by more than the interval.
 * Pure.
 */
export function detectRegressions(records: HistoryRecord[]): Regression[] {
  const byKey = new Map<string, HistoryRecord[]>();
  for (const record of records) {
    const series = byKey.get(record.key) ?? [];
    series.push(record);
    byKey.set(record.key, series);
  }

  const regressions: Regression[] = [];
  for (const [key, series] of byKey) {
    if (series.length < 2) continue;
    const latest = series[series.length - 1]!;
    const previous = series[series.length - 2]!;
    const comparison = compare(previous.result, latest.result);
    const delta = comparison.tokensPerSecDelta;
    if (comparison.significant && delta !== undefined && delta < 0) {
      regressions.push({ key, previous, latest, comparison, delta });
    }
  }
  return regressions;
}
