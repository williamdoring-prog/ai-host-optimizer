import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseLlamaCppTimings,
  parseOllamaGenerate,
  parsePrometheus,
  parseVllmDelta,
  runtimeCandidates,
} from "./runtimes.js";

/** Assert two floats are equal within a small tolerance. */
function approx(actual: number | undefined, expected: number, eps = 1e-9): void {
  assert.ok(actual !== undefined, `expected ${expected}, got undefined`);
  assert.ok(Math.abs(actual - expected) < eps, `expected ~${expected}, got ${actual}`);
}

test("parsePrometheus sums counters across label sets and ignores comments", () => {
  const text = [
    "# HELP vllm:generation_tokens_total Number of generation tokens.",
    "# TYPE vllm:generation_tokens_total counter",
    'vllm:generation_tokens_total{model_name="a"} 100',
    'vllm:generation_tokens_total{model_name="b"} 50',
    'vllm:prompt_tokens_total{model_name="a"} 20',
    "",
    "# a histogram sum/count pair",
    'vllm:time_to_first_token_seconds_sum{model_name="a"} 0.6',
    'vllm:time_to_first_token_seconds_count{model_name="a"} 2',
    "not a metric line",
  ].join("\n");
  const m = parsePrometheus(text);
  assert.equal(m["vllm:generation_tokens_total"], 150);
  assert.equal(m["vllm:prompt_tokens_total"], 20);
  assert.equal(m["vllm:time_to_first_token_seconds_sum"], 0.6);
  assert.equal(m["vllm:time_to_first_token_seconds_count"], 2);
  assert.equal(m["not a metric line"], undefined);
});

test("parseLlamaCppTimings derives rate, TTFT and ITL", () => {
  const s = parseLlamaCppTimings({
    prompt_n: 10,
    prompt_ms: 100,
    prompt_per_second: 100,
    predicted_n: 50,
    predicted_ms: 500,
    predicted_per_second: 100,
  });
  assert.equal(s.decodeRate, 100);
  assert.equal(s.promptEvalRate, 100);
  assert.equal(s.ttftMs, 100);
  assert.equal(s.interTokenMs, 10);
  assert.equal(s.totalMs, 600);
  assert.equal(s.evalCount, 50);
  assert.equal(s.promptCount, 10);
});

test("parseLlamaCppTimings tolerates a missing timings block", () => {
  const s = parseLlamaCppTimings(undefined);
  assert.equal(s.decodeRate, undefined);
  assert.equal(s.evalCount, 0);
});

test("parseVllmDelta derives rates from counter deltas", () => {
  const before = {
    "vllm:generation_tokens_total": 1000,
    "vllm:prompt_tokens_total": 200,
    "vllm:request_decode_time_seconds_sum": 10,
    "vllm:request_prefill_time_seconds_sum": 1,
    "vllm:time_to_first_token_seconds_sum": 2,
    "vllm:time_to_first_token_seconds_count": 4,
  };
  const after = {
    "vllm:generation_tokens_total": 1128,
    "vllm:prompt_tokens_total": 210,
    "vllm:request_decode_time_seconds_sum": 12,
    "vllm:request_prefill_time_seconds_sum": 1.1,
    "vllm:time_to_first_token_seconds_sum": 2.6,
    "vllm:time_to_first_token_seconds_count": 5,
  };
  const s = parseVllmDelta(before, after);
  assert.equal(s.evalCount, 128);
  assert.equal(s.promptCount, 10);
  assert.equal(s.decodeRate, 64); // 128 tokens / 2 s
  approx(s.promptEvalRate, 100); // 10 tokens / 0.1 s
  approx(s.ttftMs, 600); // (0.6 s / 1)
  assert.equal(s.interTokenMs, 15.625);
});

test("parseOllamaGenerate converts nanoseconds to rates", () => {
  const s = parseOllamaGenerate({
    eval_count: 128,
    eval_duration: 2_000_000_000,
    prompt_eval_count: 10,
    prompt_eval_duration: 100_000_000,
    load_duration: 50_000_000,
    total_duration: 2_150_000_000,
  });
  assert.equal(s.decodeRate, 64);
  approx(s.promptEvalRate, 100);
  assert.equal(s.ttftMs, 150);
  assert.equal(s.interTokenMs, 15.625);
  assert.equal(s.prefixHitRate, 0);
});

test("runtimeCandidates defaults to the three loopback runtimes", () => {
  const saved = { ...process.env };
  delete process.env["OLLAMA_HOST"];
  delete process.env["AIHO_LLAMACPP_URL"];
  delete process.env["AIHO_VLLM_URL"];
  try {
    const candidates = runtimeCandidates();
    assert.deepEqual(
      candidates.map((c) => c.id),
      ["ollama", "llamacpp", "vllm"],
    );
    for (const c of candidates) {
      assert.match(c.base, /^http:\/\/127\.0\.0\.1:\d+$/);
    }
  } finally {
    process.env = saved;
  }
});
