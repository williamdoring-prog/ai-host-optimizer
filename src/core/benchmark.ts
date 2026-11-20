/**
 * Benchmark (P1) — an honest, real measurement of local inference.
 *
 * Path: the Ollama HTTP API (`/api/generate`, `stream: false`), which returns
 * `eval_count` / `eval_duration` and therefore a true decode rate (tokens/s)
 * rather than a wall-clock guess. There is NO CLI fallback and NO implicit
 * pull: the model must already be installed, and the runtime must be loopback
 * (or remote access must be explicitly allowed).
 *
 * Headline numbers are MEDIANS of the samples. Every result records the
 * profile, the fixed generation parameters, the raw samples, a robust
 * dispersion (IQR + MAD) and a bootstrap confidence interval, so a later
 * comparison can be judged honestly rather than against an assumed noise floor.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import os from "node:os";

import { managedDir } from "./paths.js";
import {
  bootstrapDiffCI,
  bootstrapMedianCI,
  iqr as iqrOf,
  mad as madOf,
  median,
  round,
} from "./stats.js";

const execFileAsync = promisify(execFile);

/** Default sample count when the caller does not specify one. */
const DEFAULT_SAMPLES = 3;
/** Assumed noise floor when a spread could not be computed. */
export const DEFAULT_NOISE_FLOOR = 0.05;
/** Confidence level for every bootstrap interval this module reports. */
export const CI_LEVEL = 0.95;

const NS_PER_MS = 1_000_000;
const NS_PER_S = 1_000_000_000;

const SHORT_PROMPT = "Write one short sentence about the sky.";
// ~4,000 tokens of filler for the prefill regime (roughly 4 chars/token).
const PREFILL_FILLER =
  "The quick brown fox jumps over the lazy dog while the sun sets slowly behind the distant hills. ";
const PREFILL_PROMPT = PREFILL_FILLER.repeat(160);

/** The four measurement regimes a benchmark can run. */
export type BenchmarkProfileId = "decode" | "prefill" | "throughput" | "load";

/** A measurement profile: what prompt/params to use and how to fire it. */
export interface BenchmarkProfile {
  id: BenchmarkProfileId;
  description: string;
  /** Prompt sent to the runtime. */
  prompt: string;
  /** `num_predict` for this regime. */
  numPredict: number;
  /** Requests fired in parallel per sample (default 1). */
  concurrency?: number;
}

/**
 * The fixed profiles.
 *   decode     — short prompt, 128 tokens: the headline decode rate.
 *   prefill    — a ~4k-token prompt, 16 tokens: the prefill/TTFT regime.
 *   throughput — short prompt, 64 tokens, 4 concurrent: aggregate tokens/s.
 *   load       — short prompt, 1 token, no warm-up: cold load latency.
 */
export const PROFILES: Record<BenchmarkProfileId, BenchmarkProfile> = {
  decode: {
    id: "decode",
    description: "Headline decode rate: short prompt, 128 tokens generated.",
    prompt: SHORT_PROMPT,
    numPredict: 128,
  },
  prefill: {
    id: "prefill",
    description: "Prefill / time-to-first-token regime: ~4k-token prompt, 16 tokens generated.",
    prompt: PREFILL_PROMPT,
    numPredict: 16,
  },
  throughput: {
    id: "throughput",
    description: "Aggregate throughput: 4 concurrent requests, 64 tokens each.",
    prompt: SHORT_PROMPT,
    numPredict: 64,
    concurrency: 4,
  },
  load: {
    id: "load",
    description: "Cold load latency: short prompt, 1 token, no warm-up.",
    prompt: SHORT_PROMPT,
    numPredict: 1,
  },
};

/** The generation parameters a benchmark pins, so runs are comparable. */
export interface BenchmarkParams {
  seed: number;
  temperature: number;
  numCtx: number;
  numBatch: number;
  numPredict: number;
}

/** Fixed defaults, recorded in every result. */
export const DEFAULT_BENCHMARK_PARAMS: BenchmarkParams = {
  seed: 42,
  temperature: 0,
  numCtx: 4096,
  numBatch: 512,
  numPredict: 128,
};

export interface BenchmarkResult {
  timestamp: string;
  /** The measurement regime that produced this result. */
  profile: BenchmarkProfileId;
  /** The fixed generation parameters used. */
  params: BenchmarkParams;
  model?: string;
  /** Content digest of the measured model (from `/api/tags`), when known. */
  modelDigest?: string;
  /** Decode rate in tokens/second — the MEDIAN of `samples`. */
  tokensPerSec?: number;
  /** Prompt-eval (prefill) rate in tokens/second (median). */
  promptEvalRate?: number;
  /** Model load time in ms (warm-up load, or the cold load for `load`). */
  loadMs?: number;
  /** Total request time in ms (median). */
  totalMs?: number;
  /** Number of measured samples behind the median. */
  sampleCount?: number;
  /** Raw decode rates (tokens/s), one per sample. */
  samples?: number[];
  /** Median decode rate (tokens/s) — same value as `tokensPerSec`. */
  median?: number;
  /** Robust dispersion of the samples. */
  dispersion?: { iqr?: number; mad?: number };
  /** Bootstrap confidence interval for the median decode rate. */
  ci?: { low: number; high: number; level: number };
  /** Time to first token in ms (median). */
  ttftMs?: number;
  /** Mean inter-token latency in ms (median). */
  interTokenMs?: number;
  /** Fraction of prompt tokens served from cache (median), when reported. */
  prefixHitRate?: number;
  /** GPU memory in use in MiB (best-effort), when sampled. */
  vramMiB?: number;
  /** Relative spread of the samples ((max-min)/median) — kept for back-compat. */
  spread?: number;
  /** Free system memory in MiB at measurement time. */
  memFreeMiB: number;
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

/**
 * Is `host` a loopback address? Accepts `127.0.0.1`, `localhost`, `::1`,
 * `[::1]`, any `127.x.x.x`, and tolerates a scheme, a path or a `:port`.
 */
export function isLoopbackHost(host: string): boolean {
  let h = host.trim().toLowerCase();
  if (!h) return false;
  const scheme = h.match(/^[a-z][a-z0-9+.-]*:\/\/(.*)$/);
  if (scheme) h = scheme[1]!;
  h = h.split("/")[0]!;
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    if (end === -1) return false;
    h = h.slice(1, end);
  } else {
    const colons = (h.match(/:/g) ?? []).length;
    // A single colon means host:port; more than one means a bare IPv6 literal.
    if (colons === 1) h = h.slice(0, h.indexOf(":"));
  }
  if (h === "localhost" || h === "::1") return true;
  const parts = h.split(".");
  if (parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p))) {
    return parts[0] === "127";
  }
  return false;
}

/** Resolve the Ollama base URL + hostname from `OLLAMA_HOST`. */
function ollamaHost(): { base: string; hostname: string } {
  const raw = process.env["OLLAMA_HOST"]?.trim() || "http://127.0.0.1:11434";
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  try {
    const url = new URL(withScheme);
    return { base: url.origin, hostname: url.hostname };
  } catch {
    return { base: withScheme.replace(/\/+$/, ""), hostname: raw };
  }
}

interface OllamaTag {
  name?: string;
  model?: string;
  digest?: string;
}

interface OllamaTagsResponse {
  models?: OllamaTag[];
}

interface OllamaGenerateResponse {
  eval_count?: number;
  eval_duration?: number; // nanoseconds
  prompt_eval_count?: number;
  prompt_eval_duration?: number; // nanoseconds
  prompt_eval_cached_count?: number;
  load_duration?: number; // nanoseconds
  total_duration?: number; // nanoseconds
}

/** One request's parsed measurements. */
interface RawSample {
  decodeRate?: number;
  promptEvalRate?: number;
  ttftMs?: number;
  interTokenMs?: number;
  prefixHitRate?: number;
  loadMs?: number;
  totalMs?: number;
  evalCount: number;
  evalDurationNs: number;
  promptCount: number;
  promptDurationNs: number;
}

/** One measured sample (a single request, or a batch of concurrent requests). */
interface Sample {
  decodeRate?: number;
  promptEvalRate?: number;
  ttftMs?: number;
  interTokenMs?: number;
  prefixHitRate?: number;
  loadMs?: number;
  totalMs?: number;
}

/** List installed models via `GET /api/tags`; `undefined` if unreachable. */
async function listModels(base: string): Promise<OllamaTag[] | undefined> {
  try {
    const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return undefined;
    const data = (await res.json()) as OllamaTagsResponse;
    return Array.isArray(data.models) ? data.models : [];
  } catch {
    return undefined;
  }
}

function parseGenerate(data: OllamaGenerateResponse): RawSample {
  const evalCount = data.eval_count ?? 0;
  const evalDurationNs = data.eval_duration ?? 0;
  const promptCount = data.prompt_eval_count ?? 0;
  const promptDurationNs = data.prompt_eval_duration ?? 0;
  const cached = data.prompt_eval_cached_count ?? 0;
  const loadNs = data.load_duration ?? 0;

  const decodeRate =
    evalCount > 0 && evalDurationNs > 0 ? evalCount / (evalDurationNs / NS_PER_S) : undefined;
  const promptEvalRate =
    promptCount > 0 && promptDurationNs > 0
      ? promptCount / (promptDurationNs / NS_PER_S)
      : undefined;
  const ttftMs = loadNs + promptDurationNs > 0 ? (loadNs + promptDurationNs) / NS_PER_MS : undefined;
  const interTokenMs =
    evalCount > 0 && evalDurationNs > 0 ? evalDurationNs / evalCount / NS_PER_MS : undefined;
  const prefixHitRate = cached + promptCount > 0 ? cached / (cached + promptCount) : undefined;

  return {
    decodeRate,
    promptEvalRate,
    ttftMs,
    interTokenMs,
    prefixHitRate,
    loadMs: loadNs > 0 ? loadNs / NS_PER_MS : undefined,
    totalMs: data.total_duration ? data.total_duration / NS_PER_MS : undefined,
    evalCount,
    evalDurationNs,
    promptCount,
    promptDurationNs,
  };
}

/** One HTTP generation request. */
async function requestOnce(
  base: string,
  model: string,
  prompt: string,
  params: BenchmarkParams,
): Promise<RawSample | undefined> {
  try {
    const res = await fetch(`${base}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        options: {
          seed: params.seed,
          temperature: params.temperature,
          num_ctx: params.numCtx,
          num_batch: params.numBatch,
          num_predict: params.numPredict,
        },
      }),
      signal: AbortSignal.timeout(180_000),
    });
    if (!res.ok) return undefined;
    return parseGenerate((await res.json()) as OllamaGenerateResponse);
  } catch {
    return undefined;
  }
}

function medianOf(values: (number | undefined)[]): number | undefined {
  return median(values.filter((v): v is number => v !== undefined));
}

/**
 * Collapse a batch of concurrent requests into a single sample. Decode rate is
 * AGGREGATE: total tokens over the longest request duration.
 */
function aggregate(raws: RawSample[]): Sample | undefined {
  const valid = raws.filter((r) => r.evalCount > 0 || r.decodeRate !== undefined);
  if (valid.length === 0) return undefined;

  const totalTokens = valid.reduce((acc, r) => acc + r.evalCount, 0);
  const maxEvalNs = Math.max(...valid.map((r) => r.evalDurationNs));
  const decodeRate =
    maxEvalNs > 0 && totalTokens > 0 ? totalTokens / (maxEvalNs / NS_PER_S) : undefined;

  const totalPrompt = valid.reduce((acc, r) => acc + r.promptCount, 0);
  const maxPromptNs = Math.max(...valid.map((r) => r.promptDurationNs));
  const promptEvalRate =
    maxPromptNs > 0 && totalPrompt > 0 ? totalPrompt / (maxPromptNs / NS_PER_S) : undefined;

  const maxOf = (vals: (number | undefined)[]): number | undefined => {
    const nums = vals.filter((v): v is number => v !== undefined);
    return nums.length ? Math.max(...nums) : undefined;
  };

  return {
    decodeRate,
    promptEvalRate,
    ttftMs: medianOf(valid.map((r) => r.ttftMs)),
    interTokenMs: medianOf(valid.map((r) => r.interTokenMs)),
    prefixHitRate: medianOf(valid.map((r) => r.prefixHitRate)),
    loadMs: maxOf(valid.map((r) => r.loadMs)),
    totalMs: maxOf(valid.map((r) => r.totalMs)),
  };
}

/** Fire one sample: `concurrency` requests in parallel, aggregated. */
async function measureOnce(
  base: string,
  model: string,
  profile: BenchmarkProfile,
  params: BenchmarkParams,
): Promise<Sample | undefined> {
  const concurrency = Math.max(1, profile.concurrency ?? 1);
  const requests = Array.from({ length: concurrency }, () =>
    requestOnce(base, model, profile.prompt, params),
  );
  const raws = (await Promise.all(requests)).filter((r): r is RawSample => r !== undefined);
  if (raws.length === 0) return undefined;
  return aggregate(raws);
}

/** Best-effort VRAM reading via nvidia-smi. */
async function sampleVram(): Promise<number | undefined> {
  const out = await tryRun(
    "nvidia-smi",
    ["--query-gpu=memory.used", "--format=csv,noheader,nounits"],
    5000,
  );
  if (!out) return undefined;
  const first = out.split("\n")[0]?.trim();
  if (!first) return undefined;
  const used = Number.parseInt(first, 10);
  return Number.isFinite(used) ? used : undefined;
}

/** Raw per-metric samples fed into `summarizeBenchmark`. */
export interface BenchmarkMeasurements {
  timestamp?: string;
  model?: string;
  modelDigest?: string;
  memFreeMiB: number;
  note?: string;
  /** Raw decode rates (tokens/s), one per sample. Required. */
  decodeSamples: number[];
  promptEvalRateSamples?: number[];
  ttftSamples?: number[];
  interTokenSamples?: number[];
  loadSamples?: number[];
  totalSamples?: number[];
  prefixHitRateSamples?: number[];
  vramMiB?: number;
}

function medianRounded(
  values: number[] | undefined,
  places: number,
): number | undefined {
  if (!values) return undefined;
  const m = median(values);
  return m === undefined ? undefined : round(m, places);
}

/**
 * Pure assembly of a `BenchmarkResult` from raw samples. Deterministic: the
 * same measurements always yield the same result (including the bootstrap CI,
 * which is seeded). Exported so it can be unit-tested without a runtime.
 */
export function summarizeBenchmark(
  profile: BenchmarkProfileId,
  params: BenchmarkParams,
  m: BenchmarkMeasurements,
): BenchmarkResult {
  const decodeSamples = m.decodeSamples.filter((v) => Number.isFinite(v));
  const medianDecode = median(decodeSamples);
  const iqrValue = iqrOf(decodeSamples);
  const madValue = madOf(decodeSamples);
  const ciRaw = bootstrapMedianCI(decodeSamples, { level: CI_LEVEL, seed: 1 });
  const spread = relativeSpread(decodeSamples);

  const dispersion =
    iqrValue !== undefined || madValue !== undefined
      ? {
          iqr: iqrValue !== undefined ? round(iqrValue, 3) : undefined,
          mad: madValue !== undefined ? round(madValue, 3) : undefined,
        }
      : undefined;

  const count = decodeSamples.length;
  const spreadPct = spread !== undefined ? `${(spread * 100).toFixed(1)}%` : "n/a";

  return {
    timestamp: m.timestamp ?? new Date().toISOString(),
    profile,
    params,
    model: m.model,
    modelDigest: m.modelDigest,
    tokensPerSec: medianDecode !== undefined ? round(medianDecode, 2) : undefined,
    promptEvalRate: medianRounded(m.promptEvalRateSamples, 2),
    loadMs: medianRounded(m.loadSamples, 1),
    totalMs: medianRounded(m.totalSamples, 1),
    sampleCount: count,
    samples: count ? decodeSamples.map((v) => round(v, 3)) : undefined,
    median: medianDecode !== undefined ? round(medianDecode, 2) : undefined,
    dispersion,
    ci: ciRaw ? { low: round(ciRaw.low, 2), high: round(ciRaw.high, 2), level: CI_LEVEL } : undefined,
    ttftMs: medianRounded(m.ttftSamples, 1),
    interTokenMs: medianRounded(m.interTokenSamples, 4),
    prefixHitRate: medianRounded(m.prefixHitRateSamples, 4),
    vramMiB: m.vramMiB,
    spread: spread !== undefined ? round(spread, 4) : undefined,
    memFreeMiB: m.memFreeMiB,
    note:
      m.note ??
      `Measured via the Ollama API (profile ${profile}, tier A): ` +
        `median of ${count} sample(s), spread ${spreadPct}.`,
  };
}

/** Relative spread ((max - min) / median) — the run-to-run noise floor. */
function relativeSpread(values: number[]): number | undefined {
  const xs = values.filter((v) => Number.isFinite(v));
  const med = median(xs);
  if (xs.length < 2 || med === undefined || med === 0) return undefined;
  return (Math.max(...xs) - Math.min(...xs)) / med;
}

/**
 * Run a measurement. Resolves the model from the installed list (never pulling),
 * warms up once (except `load`), then takes `samples` measurements. Headline
 * numbers are medians; raw samples, dispersion and a bootstrap CI are recorded.
 */
export async function runBenchmark(
  model?: string,
  samples = DEFAULT_SAMPLES,
  profile: BenchmarkProfileId = "decode",
): Promise<BenchmarkResult> {
  const memFreeMiB = Math.round(os.freemem() / 1024 / 1024);
  const timestamp = new Date().toISOString();
  const prof = PROFILES[profile];
  const params: BenchmarkParams = { ...DEFAULT_BENCHMARK_PARAMS, numPredict: prof.numPredict };

  const { base, hostname } = ollamaHost();
  if (!isLoopbackHost(hostname) && process.env["AIHO_ALLOW_REMOTE_RUNTIME"] !== "1") {
    return {
      timestamp,
      profile,
      params,
      memFreeMiB,
      note:
        `Refused: OLLAMA_HOST "${hostname}" is not a loopback address, so no benchmark was run. ` +
        "Set AIHO_ALLOW_REMOTE_RUNTIME=1 to allow measuring a remote runtime.",
    };
  }

  const installed = await listModels(base);
  if (installed === undefined) {
    return {
      timestamp,
      profile,
      params,
      memFreeMiB,
      note:
        `The Ollama HTTP API at ${base} was unreachable, so nothing could be measured ` +
        "(no CLI fallback: it could pull a model).",
    };
  }
  if (installed.length === 0) {
    return {
      timestamp,
      profile,
      params,
      memFreeMiB,
      note: "Ollama is reachable but no models are installed; nothing to measure.",
    };
  }

  const wanted = model?.trim();
  const entry = wanted
    ? installed.find((t) => t.name === wanted || t.model === wanted)
    : installed[0];
  if (!entry) {
    return {
      timestamp,
      profile,
      params,
      memFreeMiB,
      note:
        `Model "${wanted}" is not installed; refusing to pull it implicitly. ` +
        `Run \`ollama pull ${wanted}\` yourself, then benchmark again.`,
    };
  }

  const modelName = entry.name ?? entry.model ?? wanted ?? "unknown";
  const modelDigest = entry.digest;

  // Warm-up loads the model so the timed samples exclude load time. The `load`
  // profile deliberately skips it: cold load latency is the thing being measured.
  let warmup: Sample | undefined;
  if (profile !== "load") {
    warmup = await measureOnce(base, modelName, prof, params);
  }

  const taken: Sample[] = [];
  const n = Math.max(1, samples);
  for (let i = 0; i < n; i++) {
    const s = await measureOnce(base, modelName, prof, params);
    if (!s) break;
    taken.push(s);
  }

  const decodeSamples = taken
    .map((s) => s.decodeRate)
    .filter((v): v is number => v !== undefined);
  if (decodeSamples.length === 0) {
    return {
      timestamp,
      profile,
      params,
      model: modelName,
      modelDigest,
      memFreeMiB,
      note: `Detected model "${modelName}" but no timed run returned token counts.`,
    };
  }

  const vramMiB = await sampleVram();
  const loadSamples =
    profile === "load"
      ? taken.map((s) => s.loadMs).filter((v): v is number => v !== undefined)
      : warmup?.loadMs !== undefined
        ? [warmup.loadMs]
        : [];

  return summarizeBenchmark(profile, params, {
    timestamp,
    model: modelName,
    modelDigest,
    memFreeMiB,
    decodeSamples,
    promptEvalRateSamples: taken
      .map((s) => s.promptEvalRate)
      .filter((v): v is number => v !== undefined),
    ttftSamples: taken.map((s) => s.ttftMs).filter((v): v is number => v !== undefined),
    interTokenSamples: taken
      .map((s) => s.interTokenMs)
      .filter((v): v is number => v !== undefined),
    loadSamples,
    totalSamples: taken.map((s) => s.totalMs).filter((v): v is number => v !== undefined),
    prefixHitRateSamples: taken
      .map((s) => s.prefixHitRate)
      .filter((v): v is number => v !== undefined),
    vramMiB,
  });
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
  /** True only when the change is real: CI excludes zero, or it beats the floor. */
  significant: boolean;
  /** Bootstrap CI on the difference of decode medians, when computable. */
  ci?: { low: number; high: number; level: number };
  /** Point estimate behind `ci`: median(current) − median(baseline). */
  diffMedian?: number;
  /** How `significant` was decided. */
  method: string;
}

/** True when both sides are directly comparable decode measurements. */
function comparableDecode(baseline: BenchmarkResult, current: BenchmarkResult): boolean {
  return (
    baseline.profile === current.profile &&
    baseline.model !== undefined &&
    baseline.model === current.model &&
    baseline.tokensPerSec !== undefined &&
    current.tokensPerSec !== undefined &&
    (baseline.samples?.length ?? 0) > 0 &&
    (current.samples?.length ?? 0) > 0
  );
}

/**
 * Compare a baseline to a current measurement.
 *
 * When both sides carry raw decode samples for the same model/profile, the
 * verdict is a bootstrap CI on the difference of medians: `significant` only
 * when that interval EXCLUDES zero. Otherwise it falls back to the point delta
 * judged against the combined run-to-run noise floor (deliberately conservative).
 */
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

  const combined = (baseline.spread ?? 0) + (current.spread ?? 0);
  const noiseFloor = Math.max(combined, DEFAULT_NOISE_FLOOR);
  const memFreeDeltaMiB = current.memFreeMiB - baseline.memFreeMiB;

  if (comparableDecode(baseline, current)) {
    const diff = bootstrapDiffCI(baseline.samples!, current.samples!, {
      level: CI_LEVEL,
      seed: 1,
    });
    if (diff) {
      const ci = { low: round(diff.low, 3), high: round(diff.high, 3), level: CI_LEVEL };
      const significant = diff.low > 0 || diff.high < 0;
      return {
        baseline,
        current,
        tokensPerSecDelta,
        latencyDelta,
        memFreeDeltaMiB,
        noiseFloor,
        significant,
        ci,
        diffMedian: round(diff.median, 3),
        method: "bootstrap CI on the difference of decode medians (significant iff it excludes 0)",
      };
    }
  }

  const primaryDelta =
    tokensPerSecDelta ?? (latencyDelta !== undefined ? -latencyDelta : undefined);
  const significant = primaryDelta !== undefined && Math.abs(primaryDelta) >= noiseFloor;
  return {
    baseline,
    current,
    tokensPerSecDelta,
    latencyDelta,
    memFreeDeltaMiB,
    noiseFloor,
    significant,
    method: "point delta vs the combined run-to-run noise floor",
  };
}
