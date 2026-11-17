/**
 * Benchmark (M1b) — an honest, real measurement of local inference.
 *
 * Preferred path: the Ollama HTTP API (`/api/generate`, `stream: false`), which
 * returns `eval_count` and `eval_duration`, giving a true decode rate
 * (tokens/second) rather than a wall-clock guess. Falls back to the CLI, and
 * says plainly when nothing can be measured.
 *
 * These numbers are the basis of the tier-A (measured) estimates.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import os from "node:os";

import { managedDir } from "./applier.js";

const execFileAsync = promisify(execFile);

const PROMPT = "Write one short sentence about the sky.";
const NUM_PREDICT = 64;
const OLLAMA_HOST = process.env["OLLAMA_HOST"] ?? "http://127.0.0.1:11434";

export interface BenchmarkResult {
  timestamp: string;
  model?: string;
  /** Decode rate in tokens/second — the MEDIAN of the samples. */
  tokensPerSec?: number;
  /** Prompt-eval (prefill) rate in tokens/second. */
  promptEvalRate?: number;
  /** Model load time in ms (from the first, warmed run). */
  loadMs?: number;
  /** Total request time in ms (median). */
  totalMs?: number;
  /** Number of measured samples behind the median. */
  sampleCount?: number;
  /** Relative spread of the samples ((max-min)/median) — the noise floor. */
  spread?: number;
  /** Free system memory in MiB at measurement time. */
  memFreeMiB: number;
  note: string;
}

const DEFAULT_SAMPLES = 3;
/** Assumed noise floor when a spread could not be computed. */
export const DEFAULT_NOISE_FLOOR = 0.05;

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

interface OllamaGenerateResponse {
  eval_count?: number;
  eval_duration?: number; // nanoseconds
  prompt_eval_count?: number;
  prompt_eval_duration?: number; // nanoseconds
  load_duration?: number; // nanoseconds
  total_duration?: number; // nanoseconds
}

const NS_PER_MS = 1_000_000;
const NS_PER_S = 1_000_000_000;

/** One API measurement. */
interface Sample {
  tokensPerSec?: number;
  promptEvalRate?: number;
  loadMs?: number;
  totalMs?: number;
}

/** Take a single measurement via the Ollama HTTP API. */
async function measureViaApi(model: string): Promise<Sample | undefined> {
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        prompt: PROMPT,
        stream: false,
        options: { num_predict: NUM_PREDICT },
      }),
      signal: AbortSignal.timeout(180_000),
    });
    if (!res.ok) return undefined;
    const data = (await res.json()) as OllamaGenerateResponse;

    const tokensPerSec =
      data.eval_count && data.eval_duration
        ? data.eval_count / (data.eval_duration / NS_PER_S)
        : undefined;
    const promptEvalRate =
      data.prompt_eval_count && data.prompt_eval_duration
        ? data.prompt_eval_count / (data.prompt_eval_duration / NS_PER_S)
        : undefined;

    return {
      tokensPerSec: tokensPerSec !== undefined ? round(tokensPerSec, 2) : undefined,
      promptEvalRate: promptEvalRate !== undefined ? round(promptEvalRate, 2) : undefined,
      loadMs: data.load_duration ? round(data.load_duration / NS_PER_MS, 1) : undefined,
      totalMs: data.total_duration ? round(data.total_duration / NS_PER_MS, 1) : undefined,
    };
  } catch {
    return undefined;
  }
}

function round(n: number, places: number): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

/** Median of a numeric list; `undefined` if the list is empty. */
function median(values: number[]): number | undefined {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const n = xs.length;
  if (n === 0) return undefined;
  const mid = Math.floor(n / 2);
  const hi = xs[mid]!;
  return n % 2 ? hi : (xs[mid - 1]! + hi) / 2;
}

/** Relative spread ((max - min) / median) — the run-to-run noise floor. */
function relativeSpread(values: number[]): number | undefined {
  const xs = values.filter((v) => Number.isFinite(v));
  const med = median(xs);
  if (xs.length < 2 || med === undefined || med === 0) return undefined;
  return (Math.max(...xs) - Math.min(...xs)) / med;
}

/**
 * Run a measurement: a warm-up call (loads the model) followed by
 * `DEFAULT_SAMPLES` timed calls. The headline figures are MEDIANS, and the
 * run-to-run `spread` is recorded so a later delta can be judged against the
 * host's own noise floor rather than assumed meaningful.
 */
export async function runBenchmark(model?: string, samples = DEFAULT_SAMPLES): Promise<BenchmarkResult> {
  const memFreeMiB = Math.round(os.freemem() / 1024 / 1024);
  const resolvedModel = model ?? (await firstModel());

  if (!resolvedModel) {
    return {
      timestamp: new Date().toISOString(),
      memFreeMiB,
      note:
        "No local runtime/model detected (ollama not installed or no models). " +
        "Measured free memory only; inference rates are unavailable.",
    };
  }

  // Warm-up: load the model so the timed samples exclude load time.
  const warmup = await measureViaApi(resolvedModel);

  const taken: Sample[] = [];
  for (let i = 0; i < Math.max(1, samples); i++) {
    const s = await measureViaApi(resolvedModel);
    if (!s) break;
    taken.push(s);
  }

  const decodeRates = taken.map((s) => s.tokensPerSec).filter((v): v is number => v !== undefined);
  if (decodeRates.length > 0) {
    const tokensPerSec = round(median(decodeRates)!, 2);
    const promptRates = taken
      .map((s) => s.promptEvalRate)
      .filter((v): v is number => v !== undefined);
    const totals = taken.map((s) => s.totalMs).filter((v): v is number => v !== undefined);
    const spread = relativeSpread(decodeRates);
    const spreadPct = spread !== undefined ? `${(spread * 100).toFixed(1)}%` : "n/a";
    return {
      timestamp: new Date().toISOString(),
      model: resolvedModel,
      tokensPerSec,
      promptEvalRate: promptRates.length ? round(median(promptRates)!, 2) : undefined,
      loadMs: warmup?.loadMs,
      totalMs: totals.length ? round(median(totals)!, 1) : undefined,
      sampleCount: decodeRates.length,
      spread: spread !== undefined ? round(spread, 4) : undefined,
      memFreeMiB,
      note:
        `Measured via the Ollama API on "${resolvedModel}" (tier A): ` +
        `median of ${decodeRates.length} sample(s), spread ${spreadPct}.`,
    };
  }

  // Fallback: CLI wall-clock only (no token counts).
  const start = Date.now();
  const out = await tryRun("ollama", ["run", resolvedModel, PROMPT], 180_000);
  const totalMs = Date.now() - start;
  if (out === undefined) {
    return {
      timestamp: new Date().toISOString(),
      model: resolvedModel,
      memFreeMiB,
      note: `Detected model "${resolvedModel}" but the timed run did not complete.`,
    };
  }
  return {
    timestamp: new Date().toISOString(),
    model: resolvedModel,
    totalMs,
    memFreeMiB,
    note:
      `Measured wall-clock only on "${resolvedModel}" (the HTTP API was unavailable, ` +
      "so no tokens/second figure was obtained).",
  };
}

function baselinePath(): string {
  return join(managedDir(), "benchmark-baseline.json");
}

/** Persist a baseline measurement. */
export async function saveBaseline(result: BenchmarkResult): Promise<string> {
  const dir = managedDir();
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
  /** Fractional change in decode rate (positive = faster). */
  tokensPerSecDelta?: number;
  /** Fractional change in total latency (negative = faster). */
  latencyDelta?: number;
  memFreeDeltaMiB: number;
  /**
   * The host's own run-to-run noise floor (relative). A delta smaller than this
   * is indistinguishable from measurement noise and must NOT be claimed.
   */
  noiseFloor: number;
  /** True only when the delta exceeds the noise floor. */
  significant: boolean;
}

/** Compare a baseline to a current measurement. */
export function compare(
  baseline: BenchmarkResult,
  current: BenchmarkResult,
): BenchmarkComparison {
  const tokensPerSecDelta =
    baseline.tokensPerSec && current.tokensPerSec
      ? (current.tokensPerSec - baseline.tokensPerSec) / baseline.tokensPerSec
      : undefined;
  const latencyDelta =
    baseline.totalMs !== undefined && current.totalMs !== undefined && baseline.totalMs > 0
      ? (current.totalMs - baseline.totalMs) / baseline.totalMs
      : undefined;

  // Two independent measurements each carry their own run-to-run range, so a
  // difference between them is only meaningful if it exceeds the COMBINED
  // range. This deliberately over-estimates the noise floor: under-claiming is
  // the honest failure mode here.
  const combined = (baseline.spread ?? 0) + (current.spread ?? 0);
  const noiseFloor = Math.max(combined, DEFAULT_NOISE_FLOOR);
  const primaryDelta =
    tokensPerSecDelta ?? (latencyDelta !== undefined ? -latencyDelta : undefined);
  const significant = primaryDelta !== undefined && Math.abs(primaryDelta) >= noiseFloor;

  return {
    baseline,
    current,
    tokensPerSecDelta,
    latencyDelta,
    memFreeDeltaMiB: current.memFreeMiB - baseline.memFreeMiB,
    noiseFloor,
    significant,
  };
}
