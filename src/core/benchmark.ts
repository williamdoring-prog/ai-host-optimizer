/**
 * Benchmark (M1) — a best-effort, honest on-host measurement.
 *
 * It measures what it can actually measure: with Ollama present, the wall-clock
 * time for a fixed prompt against a chosen model; always, the free system memory.
 * This gives a real baseline so that a before/after comparison can be reported as
 * a tier-A (measured) result — rather than an estimate.
 *
 * If no runtime is available, it says so plainly instead of inventing numbers.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import os from "node:os";

import { managedDir } from "./applier.js";

const execFileAsync = promisify(execFile);

const PROMPT = "Reply with the single word: ok";

export interface BenchmarkResult {
  timestamp: string;
  /** The model used, when a runtime is available. */
  model?: string;
  /** Wall-clock milliseconds for the fixed prompt (undefined if not measurable). */
  totalMs?: number;
  /** Free system memory in MiB at measurement time. */
  memFreeMiB: number;
  /** Human-readable note about what was and was not measured. */
  note: string;
}

async function tryRun(file: string, args: string[], timeoutMs: number): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(file, args, { timeout: timeoutMs, windowsHide: true });
    return stdout.trim();
  } catch {
    return undefined;
  }
}

/** First model name reported by `ollama list`, if any. */
async function firstModel(): Promise<string | undefined> {
  const out = await tryRun("ollama", ["list"], 5000);
  if (!out) return undefined;
  const lines = out.split("\n").slice(1).map((l) => l.trim()).filter(Boolean);
  const first = lines[0];
  return first ? first.split(/\s+/)[0] : undefined;
}

/** Run one measurement. */
export async function runBenchmark(): Promise<BenchmarkResult> {
  const memFreeMiB = Math.round(os.freemem() / 1024 / 1024);
  const model = await firstModel();

  if (!model) {
    return {
      timestamp: new Date().toISOString(),
      memFreeMiB,
      note:
        "No local runtime/model detected (ollama not installed or no models). " +
        "Measured free memory only; inference timings are unavailable.",
    };
  }

  const start = Date.now();
  const out = await tryRun("ollama", ["run", model, PROMPT], 120000);
  const totalMs = Date.now() - start;

  if (out === undefined) {
    return {
      timestamp: new Date().toISOString(),
      model,
      memFreeMiB,
      note: `Detected model "${model}" but the timed run did not complete (timeout or error).`,
    };
  }

  return {
    timestamp: new Date().toISOString(),
    model,
    totalMs,
    memFreeMiB,
    note:
      `Measured wall-clock for a fixed prompt on "${model}". ` +
      "This is a real (tier A) measurement of total latency, not of any single option.",
  };
}

function baselinePath(): string {
  return join(managedDir(), "benchmark-baseline.json");
}

/** Persist a baseline measurement. */
export async function saveBaseline(result: BenchmarkResult): Promise<string> {
  const dir = managedDir();
  const { mkdir } = await import("node:fs/promises");
  await mkdir(dir, { recursive: true });
  const path = baselinePath();
  await writeFile(path, JSON.stringify(result, null, 2), "utf8");
  return path;
}

/** Load a previously saved baseline. */
export async function loadBaseline(): Promise<BenchmarkResult | undefined> {
  try {
    return JSON.parse(await readFile(baselinePath(), "utf8")) as BenchmarkResult;
  } catch {
    return undefined;
  }
}

export interface BenchmarkComparison {
  baseline: BenchmarkResult;
  current: BenchmarkResult;
  /** Fractional change in total latency (negative = faster). */
  latencyDelta?: number;
  memFreeDeltaMiB: number;
}

/** Compare a baseline to a current measurement. */
export function compare(
  baseline: BenchmarkResult,
  current: BenchmarkResult,
): BenchmarkComparison {
  const latencyDelta =
    baseline.totalMs !== undefined && current.totalMs !== undefined && baseline.totalMs > 0
      ? (current.totalMs - baseline.totalMs) / baseline.totalMs
      : undefined;
  return {
    baseline,
    current,
    latencyDelta,
    memFreeDeltaMiB: current.memFreeMiB - baseline.memFreeMiB,
  };
}
