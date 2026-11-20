# ai-host-optimizer

[![npm](https://img.shields.io/npm/v/ai-host-optimizer.svg)](https://www.npmjs.com/package/ai-host-optimizer)
[![CI](https://github.com/williamdoring-prog/ai-host-optimizer/actions/workflows/ci.yml/badge.svg)](https://github.com/williamdoring-prog/ai-host-optimizer/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![MCP Registry](https://img.shields.io/badge/MCP%20Registry-listed-2ea44f)](https://registry.modelcontextprotocol.io/v0.1/servers?search=ai-host-optimizer)

**Profile a host, plan AI-model optimizations, and apply them — reversibly, with consent.**

Every "speed up your local LLM" guide lists the same tweaks (Flash Attention,
KV-cache quantization, keep-alive, NUMA). The lists are mostly right — they just
never tell you **which of them helps on *your* machine**, or by how much.

This tool profiles the host, presents the checklist with an **honest confidence
tier** on every number, resolves a **conflict-free plan**, and — the part that
matters — **measures** the options you apply, with a noise floor, so a null result
is reported as a null result instead of a fake win.

It is an MCP server *and* a CLI. Applying is **dry-run by default**, writes only
into a **managed config directory**, and is **reversible**.

> **Status: 1.2.** Profiling and planning are read-only. The applier writes only
> inside `~/.config/ai-host-optimizer` (platform-appropriate), never touches
> system files, never runs a shell, and never escalates privilege.

## Quickstart

```bash
npx -y ai-host-optimizer --cli
```

That prints a read-only profile and the checklist for your machine (trimmed):

```
Host profile (read-only)
  role     : workstation
  platform : windows — x64
  cpu      : Intel(R) Core(TM) i7-10700K CPU @ 3.80GHz (16 cores)
  memory   : 16 GiB total, 8 GiB free
  gpu      : nvidia NVIDIA GeForce RTX 3080 (10240 MiB VRAM)
  cluster  : 1 GPU(s)
  tooling  : ollama, python3, docker

Optimization checklist (read-only)

[ ] Enable Flash Attention  (flash-attention)
      improves decode tokens/s: qualitative (tier C)
      risk low; fully-reversible; privilege false
      stackable: throughput-stack
      synergy: kv-cache-quant-q8

[ ] Quantize KV cache to q8_0  (kv-cache-quant-q8)
      improves KV cache memory: 50% (tier B)
      risk low; fully-reversible; privilege false
      ...
```

Then measure whether a change actually helped:

```bash
ai-host-optimizer --benchmark --save-baseline --samples 5   # before
ai-host-optimizer --apply --select flash-attention --yes    # then restart the runtime
ai-host-optimizer --calibrate --select flash-attention       # after → tier A, or "no change"
```

## Why

Running local models well depends on host configuration (KV-cache size, Flash
Attention, prefix caching, memory/NUMA/swap behaviour, provider prompt caching).
The knowledge is scattered across guides. This tool profiles *your* host and tells
you what is worth doing — **honestly**, labelling each estimate by confidence.

## Install

```bash
# zero-install (downloads and runs)
npx -y ai-host-optimizer --cli

# or globally
npm install -g ai-host-optimizer
ai-host-optimizer --cli        # or the short alias:  aiho --cli
```

## Usage

```bash
# report (read-only)
ai-host-optimizer --cli
ai-host-optimizer --cli --role container

# plan and apply
ai-host-optimizer --plan  --select kv-cache-quant-q8,keep-alive-preload
ai-host-optimizer --apply --select kv-cache-quant-q8,keep-alive-preload          # dry-run
ai-host-optimizer --apply --select kv-cache-quant-q8,keep-alive-preload --yes    # apply
ai-host-optimizer --revert

# measure (tier A)
ai-host-optimizer --benchmark --save-baseline   # before
ai-host-optimizer --benchmark                   # after (compares to baseline)

# calibrate: measure an option's real effect on THIS host and promote it to tier A
ai-host-optimizer --benchmark --save-baseline --samples 5
ai-host-optimizer --apply --select flash-attention --yes     # then restart the runtime
ai-host-optimizer --calibrate --select flash-attention --samples 5
ai-host-optimizer --plan --select flash-attention            # now shows [measured]

# generate declarative accessories from the same registry
ai-host-optimizer --generate ansible
ai-host-optimizer --generate dockerfile
ai-host-optimizer --generate checklist

# interfaces
ai-host-optimizer --mcp
ai-host-optimizer --browser     # browser UI (not yet)
ai-host-optimizer --desktop     # desktop UI (not yet)
```

Applying writes only into the **managed directory** and prints the `source` line to
activate it. Undo any time with `--revert`.

**What is automated:** options with an `applyOp`. The applier writes one
`<runtime>.env` file per target — `ollama.env`, `llama.cpp.env`,
`huggingface.env`, `vllm.env` — plus a single `activate.sh` / `activate.ps1`. On
Linux, the `ollama-systemd-dropin` option additionally writes a systemd drop-in
(so the Ollama service actually reads that environment) and **prints** the root
install commands rather than running them. Numeric options use the `size` op,
which declares the runtime's documented default so the applied value is proven to
be an improvement (it can never set a value worse than the default). Everything
else is **advisory**: `--apply` says so plainly rather than doing nothing
silently.

## Use as an MCP server

Add to your MCP client (e.g. Claude Desktop):

```json
{
  "mcpServers": {
    "ai-host-optimizer": {
      "command": "npx",
      "args": ["-y", "ai-host-optimizer", "--mcp"]
    }
  }
}
```

Tools exposed (all **read-only**, returning structured data plus a text fallback):

| Tool | Purpose |
|---|---|
| `profile` | Read-only host profile (OS, CPU, memory, GPU, context, detected tooling) |
| `checklist` | Optimization options with estimated improvement, footprint and applicability |
| `plan` | Conflict-free plan for selected ids, with a combined estimate (uses tier-A calibrations when present) |
| `recommend` | Auto-select a safe, conflict-free set of applyable options |
| `benchmark` | Measure local inference (decode/prefill/TTFT/ITL) + the run-to-run interval — tier-A evidence |

Published to the **official MCP Registry** as
`io.github.williamdoring-prog/ai-host-optimizer` (see `server.json`).

## Honesty contract

Every estimate carries a confidence tier:

- **A — measured** on your host, CI excludes zero (via `--benchmark` / `--calibrate`).
- **A− — measured**, single session: direction consistent, magnitude uncertain.
- **B — labelled estimate** with a cited method.
- **C — qualitative** (direction only, no number).
- **N — measured null**: no change beyond the interval, persisted so it is not re-claimed.

Tier B/C estimates are **never** presented as measurements, and a combined estimate
is **withheld** when a contributor is single-session A−.

**Calibration is honest about noise.** `--benchmark` takes several samples and
reports **IQR/MAD plus a bootstrap confidence interval**; `--calibrate` compares
before/after and only promotes an option to tier A when the CI **excludes zero**.
A null result is reported as a null result (tier N) — a difference inside the
interval is not claimed as a win. Use `--samples <n>` to tighten the interval.

## What the benchmark measures

`--benchmark` auto-detects a local inference server — **Ollama** (`/api/generate`),
**llama.cpp server** (`/completion` `timings`) or **vLLM** (Prometheus `/metrics`) —
and reads exact token counts and durations rather than a wall-clock guess. Point it
with `OLLAMA_HOST`, `AIHO_LLAMACPP_URL` or `AIHO_VLLM_URL` (or force one with
`AIHO_RUNTIME`). It fixes and **records** the parameters (`seed`, `temperature`,
`num_ctx`, `num_batch`, `num_predict`) and the model digest, takes several samples
after a warm-up, and reports the **median** with a bootstrap confidence interval.

Separate **profiles** measure separate regimes, because decode is
memory-bandwidth-bound and prefill is compute-bound:

| Profile | Measures |
|---|---|
| `decode` (default) | decode tokens/second — the headline |
| `prefill` | a long-prompt prefill run (TTFT regime) |
| `throughput` | aggregate rate under concurrent requests |
| `load` | cold model-load latency |

It also reports **TTFT**, **inter-token latency**, a **prefix-cache hit rate**
(when the runtime exposes it) and **VRAM** used.

That interval is the whole point. Inference timing on a desktop is noisy, so a
single before/after comparison can show a "15% improvement" that is pure noise.
`--calibrate` refuses to claim a change whose bootstrap CI straddles zero, and
prints a null result as a null result:

```
  baseline: qwen2.5-coder:14b, 10.29 tok/s, 2638.9 ms, 5549 MiB free
  current : qwen2.5-coder:14b, 10.16 tok/s, 2860.5 ms, 5541 MiB free
  noise floor: ±13.9%

No significant change: decode tokens/s -1.3% is within the interval of this host.
Nothing recorded — a null result is not evidence of an improvement.
```

A tool that will tell you *"this didn't help"* is more useful than one that always
claims a win.

## Safety

- **Read-only by default.** Profiling and planning never change anything.
- The **applier** writes **only** into the managed config directory
  (`~/.config/ai-host-optimizer`, or the platform equivalent) — never system
  files — runs **no shell**, and escalates **no** privilege.
- Applying is **dry-run first**: `--apply` shows the change; `--yes` performs it.
- Everything applied is **reversible** with `--revert` (and `--revert` is
  idempotent).
- Options are tagged with **risk**, **reversibility** and **privilege** needs.
- Mutually exclusive options (e.g. KV-cache q8_0 vs q4_0; zram vs disk swap) are
  **one-of groups**; stackable options are marked **stackable**.
- **Role-aware**: a `container` cannot tune the host kernel; a `cluster-node` is
  **advisory-only**.
- **Capability vs configuration**: the checklist compares each option's target
  variables against your current environment and marks them `[ ]` todo,
  `[~] partially set` or `[✓] already set`; `--recommend` skips what is already
  configured. Numeric (`size`) options are compared direction-aware, so a value
  already higher than the desired one is never "improved" downwards.

## Requirements

- **Node.js ≥ 20.**
- No native dependencies (2 runtime deps: the MCP SDK and zod).
- Optional: a local runtime on **loopback** (Ollama at `http://127.0.0.1:11434`
  by default) to get tier-A measurements. The tool never pulls a model for you.

## Automated vs advisory

Each option is one or the other, and the CLI/MCP tell you which:

| | Automated (`applyOp`) | Advisory |
|---|---|---|
| Listed as | `[applyable]` | `[advisory]` |
| `--apply` | writes managed env / a systemd drop-in | makes **no** change |
| Undo | `--revert` | n/a |

## Troubleshooting

- **It prompted me for a role.** Only the bare `ai-host-optimizer` (no command)
  prompts. Pass `--role <role>`, or run a command such as `--recommend`.
- **`--json` / `--recommend` / `--doctor` / `--list`.** New in this release — see
  `--help`. `--doctor` checks Node, the managed dir, runtime reachability and the
  saved baseline.
- **My variables don't take effect.** The applier writes files into the managed
  directory; you must `source <managed-dir>/activate.sh` (bash/zsh) or install the
  printed systemd drop-in and restart Ollama.
- **`--benchmark` says no model.** Install one yourself (`ollama pull …`); the
  tool deliberately never pulls implicitly.
- **"Refusing to apply: … advisory only."** You are on `cluster-node`/`ci-runner`.
  Use a non-advisory role, or pass `--force-advisory` deliberately.
- **A remote `OLLAMA_HOST` is refused.** Only loopback is allowed by default; set
  `AIHO_ALLOW_REMOTE_RUNTIME=1` if you truly intend a remote runtime.

## Roadmap

- **M0** — read-only profiler, registry, checklist, CLI + MCP. ✅
- **M1** — reversible applier (user-space), plan/apply/revert, on-host benchmark. ✅
- **M1b** — measured tier-A calibration (median-of-samples benchmark, noise floor, per-option promotion). ✅
- **M1c** — multi-runtime applier: one `<runtime>.env` per target (Ollama,
  llama.cpp, Hugging Face), 8 applyable options, idempotent revert. ✅
- **M1d** — more apply ops: a `systemd-dropin` op (Ollama service env on Linux,
  install commands printed not run) and the `vllm` runtime. 32 options, 11
  applyable. ✅
- **M2** — accessory generation (Ansible/Dockerfile/checklist). ✅ *(generation)*
- **M2b** — distribution: official MCP Registry entry **live**
  (`io.github.williamdoring-prog/ai-host-optimizer`) + CI publish workflow;
  directory listings next. 🚧
- **Hardening (P0)** — enforced path containment, sink-aware value encoding,
  typed apply ops, atomic/union state with backups and restore-on-revert,
  advisory-role refusal (`--force-advisory` to override), registry corrections
  (two options moved to advisory → **9 applyable**), and a CI registry gate. ✅
- **P1** — engine facade + shared render layer, structured MCP outputs
  (`outputSchema`/`structuredContent`), CLI `--recommend`/`--json`/`--doctor`/
  `--list`, robust benchmark statistics (IQR/MAD + bootstrap CI, fixed params,
  workload profiles), tier A/A−/B/C/N, and container/cgroup/WSL/NUMA detection. ✅
- **P2 (tranche 1)** — a `size` apply op with a numeric guard (never set a value
  worse than the runtime default), context-length options for Ollama and
  llama.cpp, and honest advisory entries for GPU visibility / HF offline / model
  store relocation. ✅
- **P2 (tranche 2)** — more numeric levers via `size` (llama.cpp batch/ubatch,
  Ollama queue), `ollama-num-parallel` migrated to the guarded op, and
  `llama-gpu-layers` as advisory. **41 options, 14 applyable.** ✅
- **P2 (step 3)** — multi-runtime benchmarking: **llama.cpp server**
  (`/completion` timings) and **vLLM** (Prometheus `/metrics`), auto-detected on
  loopback, so non-Ollama options can reach tier A. ✅
- **P2 (step 4)** — capability vs configuration: a configuration probe compares
  each option's target variables against the current environment
  (`[ ]` / `[~]` / `[✓]`), direction-aware for numeric options, and
  `--recommend` skips what is already configured. ✅
- **M4** — browser UI and Tauri desktop UI. *(planned)*

## Documentation

- [`docs/architecture.md`](docs/architecture.md) — one core, many front-ends; detection coverage; roadmap.
- [`docs/registry-schema.md`](docs/registry-schema.md) — the option schema and the honesty contract.
- [`docs/publishing.md`](docs/publishing.md) — releasing to npm, the MCP Registry, and the directories.
- [`docs/launch.md`](docs/launch.md) — launch copy (Show HN / r/LocalLLaMA).
- [`SECURITY.md`](SECURITY.md) — security policy and the design commitments.

## Contributing

Contributions are welcome — especially **new optimization options** and
**corrections to unsupported claims**. See [`CONTRIBUTING.md`](CONTRIBUTING.md)
for the dev setup and the registry contribution rules. Participation is governed
by [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).

## Licence

MIT. See `LICENSE`.
