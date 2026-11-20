/**
 * Runtime adapters (P2) — measure more than one local inference server.
 *
 * Tier-A evidence was Ollama-only; this module adds **llama.cpp server** and
 * **vLLM**, so options on those runtimes can be measured too. No new
 * dependency: llama.cpp returns `timings` in its `/completion` response, and
 * vLLM exposes Prometheus text at `/metrics` which we scrape around a request.
 *
 * All parsing is pure and unit-tested; all egress is loopback-only.
 */

import { isLoopbackHost, remoteAllowed, resolveEndpoint } from "./net.js";

/** Supported local inference runtimes. */
export type RuntimeId = "ollama" | "llamacpp" | "vllm";

/** A resolved runtime endpoint. */
export interface RuntimeEndpoint {
  id: RuntimeId;
  base: string;
  hostname: string;
}

/** One request's raw measurements, runtime-agnostic. */
export interface RawSample {
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

const NS_PER_MS = 1_000_000;
const NS_PER_S = 1_000_000_000;

/** Generation parameters passed to a runtime. */
export interface RuntimeParams {
  seed: number;
  temperature: number;
  numCtx: number;
  numBatch: number;
  numPredict: number;
}

// --- pure parsers ------------------------------------------------------------

/**
 * Parse Prometheus text exposition into a metric→value map, summing across
 * label sets (so `vllm:generation_tokens_total{a="1"}` and `{a="2"}` add up).
 * Histogram `_sum`/`_count` series are summed the same way.
 */
export function parsePrometheus(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?\s+(\S+)/.exec(trimmed);
    if (!match) continue;
    const name = match[1]!;
    const value = Number(match[3]);
    if (!Number.isFinite(value)) continue;
    out[name] = (out[name] ?? 0) + value;
  }
  return out;
}

/** The subset of a llama.cpp `/completion` response we read. */
export interface LlamaCppTimings {
  prompt_n?: number;
  prompt_ms?: number;
  prompt_per_second?: number;
  predicted_n?: number;
  predicted_ms?: number;
  predicted_per_second?: number;
}

/**
 * Convert llama.cpp `/completion` `timings` into a `RawSample`. llama.cpp
 * reports milliseconds directly, so no nanosecond juggling is needed.
 */
export function parseLlamaCppTimings(timings: LlamaCppTimings | undefined): RawSample {
  const t = timings ?? {};
  const predictedN = t.predicted_n ?? 0;
  const predictedMs = t.predicted_ms ?? 0;
  const promptN = t.prompt_n ?? 0;
  const promptMs = t.prompt_ms ?? 0;

  const decodeRate =
    t.predicted_per_second ?? (predictedN > 0 && predictedMs > 0 ? predictedN / (predictedMs / 1000) : undefined);
  const promptEvalRate =
    t.prompt_per_second ?? (promptN > 0 && promptMs > 0 ? promptN / (promptMs / 1000) : undefined);
  const ttftMs = promptMs > 0 ? promptMs : undefined;
  const interTokenMs = predictedN > 0 && predictedMs > 0 ? predictedMs / predictedN : undefined;
  const totalMs = promptMs + predictedMs > 0 ? promptMs + predictedMs : undefined;

  return {
    decodeRate,
    promptEvalRate,
    ttftMs,
    interTokenMs,
    prefixHitRate: undefined,
    loadMs: undefined,
    totalMs,
    evalCount: predictedN,
    evalDurationNs: predictedMs * NS_PER_MS,
    promptCount: promptN,
    promptDurationNs: promptMs * NS_PER_MS,
  };
}

/**
 * Derive a `RawSample` from the delta between two vLLM Prometheus scrapes.
 * vLLM exposes counters (tokens) and histogram sums/counts (seconds).
 */
export function parseVllmDelta(
  before: Record<string, number>,
  after: Record<string, number>,
): RawSample {
  const delta = (metric: string): number => (after[metric] ?? 0) - (before[metric] ?? 0);
  const genTokens = delta("vllm:generation_tokens_total");
  const promptTokens = delta("vllm:prompt_tokens_total");
  const decodeSeconds = delta("vllm:request_decode_time_seconds_sum");
  const prefillSeconds = delta("vllm:request_prefill_time_seconds_sum");
  const ttftSum = delta("vllm:time_to_first_token_seconds_sum");
  const ttftCount = delta("vllm:time_to_first_token_seconds_count");
  const prefixHits = delta("vllm:prefix_cache_hits_total");
  const prefixQueries = delta("vllm:prefix_cache_queries_total");

  const decodeRate = genTokens > 0 && decodeSeconds > 0 ? genTokens / decodeSeconds : undefined;
  const promptEvalRate = promptTokens > 0 && prefillSeconds > 0 ? promptTokens / prefillSeconds : undefined;
  const ttftMs = ttftCount > 0 && ttftSum > 0 ? (ttftSum / ttftCount) * 1000 : undefined;
  const interTokenMs = genTokens > 0 && decodeSeconds > 0 ? (decodeSeconds / genTokens) * 1000 : undefined;
  const prefixHitRate = prefixQueries > 0 ? prefixHits / prefixQueries : undefined;

  return {
    decodeRate,
    promptEvalRate,
    ttftMs,
    interTokenMs,
    prefixHitRate,
    loadMs: undefined,
    totalMs: (prefillSeconds + decodeSeconds) * 1000 || undefined,
    evalCount: genTokens,
    evalDurationNs: decodeSeconds * NS_PER_S,
    promptCount: promptTokens,
    promptDurationNs: prefillSeconds * NS_PER_S,
  };
}

// --- runtime discovery -------------------------------------------------------

/** The candidate endpoints, in detection order, from env with loopback defaults. */
export function runtimeCandidates(): RuntimeEndpoint[] {
  const ollama = resolveEndpoint(process.env["OLLAMA_HOST"], "http://127.0.0.1:11434");
  const llamacpp = resolveEndpoint(process.env["AIHO_LLAMACPP_URL"], "http://127.0.0.1:8080");
  const vllm = resolveEndpoint(process.env["AIHO_VLLM_URL"], "http://127.0.0.1:8000");
  return [
    { id: "ollama", ...ollama },
    { id: "llamacpp", ...llamacpp },
    { id: "vllm", ...vllm },
  ];
}

async function reachable(base: string, path: string, timeoutMs = 3000): Promise<boolean> {
  try {
    const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Choose the runtime to measure. `AIHO_RUNTIME` forces one; otherwise the first
 * reachable candidate wins. Non-loopback candidates are skipped unless remote
 * access is explicitly allowed.
 */
export async function detectRuntime(): Promise<RuntimeEndpoint | undefined> {
  const forced = process.env["AIHO_RUNTIME"]?.trim().toLowerCase();
  const candidates = runtimeCandidates().filter(
    (c) => c.id === forced || forced === undefined ? true : false,
  );
  const allowed = candidates.filter((c) => isLoopbackHost(c.hostname) || remoteAllowed());
  for (const candidate of allowed) {
    const path = candidate.id === "ollama" ? "/api/tags" : "/v1/models";
    if (await reachable(candidate.base, path)) return candidate;
  }
  return undefined;
}

/** An installed model. */
export interface RuntimeModel {
  name: string;
  digest?: string;
}

/** List installed models for a runtime; `undefined` if unreachable. */
export async function listRuntimeModels(ep: RuntimeEndpoint): Promise<RuntimeModel[] | undefined> {
  if (ep.id === "ollama") {
    try {
      const res = await fetch(`${ep.base}/api/tags`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return undefined;
      const data = (await res.json()) as { models?: Array<{ name?: string; model?: string; digest?: string }> };
      if (!Array.isArray(data.models)) return [];
      return data.models
        .map((m) => ({ name: m.name ?? m.model ?? "", digest: m.digest }))
        .filter((m) => m.name);
    } catch {
      return undefined;
    }
  }
  // OpenAI-compatible: llama.cpp server and vLLM both expose /v1/models.
  try {
    const res = await fetch(`${ep.base}/v1/models`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return undefined;
    const data = (await res.json()) as { data?: Array<{ id?: string }> };
    if (!Array.isArray(data.data)) return [];
    return data.data.map((m) => ({ name: m.id ?? "" })).filter((m) => m.name);
  } catch {
    return undefined;
  }
}

// --- request adapters --------------------------------------------------------

interface OllamaGenerateResponse {
  eval_count?: number;
  eval_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  prompt_eval_cached_count?: number;
  load_duration?: number;
  total_duration?: number;
}

/** Parse an Ollama `/api/generate` response. Exported for testing. */
export function parseOllamaGenerate(data: OllamaGenerateResponse): RawSample {
  const evalCount = data.eval_count ?? 0;
  const evalDurationNs = data.eval_duration ?? 0;
  const promptCount = data.prompt_eval_count ?? 0;
  const promptDurationNs = data.prompt_eval_duration ?? 0;
  const cached = data.prompt_eval_cached_count ?? 0;
  const loadNs = data.load_duration ?? 0;

  const decodeRate = evalCount > 0 && evalDurationNs > 0 ? evalCount / (evalDurationNs / NS_PER_S) : undefined;
  const promptEvalRate =
    promptCount > 0 && promptDurationNs > 0 ? promptCount / (promptDurationNs / NS_PER_S) : undefined;
  const ttftMs = loadNs + promptDurationNs > 0 ? (loadNs + promptDurationNs) / NS_PER_MS : undefined;
  const interTokenMs = evalCount > 0 && evalDurationNs > 0 ? evalDurationNs / evalCount / NS_PER_MS : undefined;
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

async function ollamaRequest(
  ep: RuntimeEndpoint,
  model: string,
  prompt: string,
  params: RuntimeParams,
): Promise<RawSample | undefined> {
  try {
    const res = await fetch(`${ep.base}/api/generate`, {
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
    return parseOllamaGenerate((await res.json()) as OllamaGenerateResponse);
  } catch {
    return undefined;
  }
}

async function llamacppRequest(
  ep: RuntimeEndpoint,
  model: string,
  prompt: string,
  params: RuntimeParams,
): Promise<RawSample | undefined> {
  try {
    const res = await fetch(`${ep.base}/completion`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt,
        n_predict: params.numPredict,
        temperature: params.temperature,
        seed: params.seed,
        cache_prompt: false,
        stream: false,
      }),
      signal: AbortSignal.timeout(180_000),
    });
    if (!res.ok) return undefined;
    const data = (await res.json()) as { timings?: LlamaCppTimings };
    void model; // llama.cpp serves a single model; the id is informational.
    return parseLlamaCppTimings(data.timings);
  } catch {
    return undefined;
  }
}

async function scrapeMetrics(base: string): Promise<Record<string, number> | undefined> {
  try {
    const res = await fetch(`${base}/metrics`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return undefined;
    return parsePrometheus(await res.text());
  } catch {
    return undefined;
  }
}

async function vllmRequest(
  ep: RuntimeEndpoint,
  model: string,
  prompt: string,
  params: RuntimeParams,
): Promise<RawSample | undefined> {
  const before = await scrapeMetrics(ep.base);
  if (!before) return undefined;
  try {
    const res = await fetch(`${ep.base}/v1/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        prompt,
        max_tokens: params.numPredict,
        temperature: params.temperature,
        seed: params.seed,
        stream: false,
      }),
      signal: AbortSignal.timeout(180_000),
    });
    if (!res.ok) return undefined;
    await res.json();
    const after = await scrapeMetrics(ep.base);
    if (!after) return undefined;
    return parseVllmDelta(before, after);
  } catch {
    return undefined;
  }
}

/** Take one measurement from a runtime. */
export async function requestSample(
  ep: RuntimeEndpoint,
  model: string,
  prompt: string,
  params: RuntimeParams,
): Promise<RawSample | undefined> {
  switch (ep.id) {
    case "ollama":
      return ollamaRequest(ep, model, prompt, params);
    case "llamacpp":
      return llamacppRequest(ep, model, prompt, params);
    case "vllm":
      return vllmRequest(ep, model, prompt, params);
  }
}
