# Changelog

All notable changes to this project. Format: `YYYY-MM-DD — summary`.

## Unreleased — P2 depth

Deeper apply coverage without inflating the option list.

**Tranche 1 — the `size` op.**

- **New `size` apply op.** A `size` option sets exactly one numeric environment
  variable and declares the runtime's documented default; validation proves the
  applied value is an *improvement* (above the default, or below with
  `direction: "lower"`), so an option can never set a value worse than the
  runtime default.
- **Context-length options** (`ollama-context-length`, `llama-ctx-size`) — the
  first `size` options, each guarded against a 4096-token default.
- **Honest advisory entries**: `gpu-device-visibility` (the device list is
  host-specific), `hf-offline` (air-gap/reproducibility; breaks downloads until
  unset), and `ollama-models-path` (relocation; existing models are not moved).

**Tranche 2 — more numeric levers.**

- `llama-batch-size` and `llama-ubatch-size` (`size`; guarded against the 2048 /
  512 defaults) for prefill throughput.
- `ollama-max-queue` (`size`; guarded against the 512 default).
- `ollama-num-parallel` migrated from `env` to `size` (guarded against the
  default of 1 slot).
- `llama-gpu-layers` added as **advisory** — the safe layer count is
  model- and VRAM-dependent.

Registry now **41 options, 14 applyable** (7 `env` + 6 `size` + 1
`systemd-dropin`).

- Docs: the launch kit and publishing guide are refreshed for the shipped CLI
  (tiers A/A−/B/C/N, bootstrap-CI verdicts, `--recommend`/`--json`/`--doctor`,
  registry `1.3.0`).

## 1.3.0 — 2026-11-20

Engine seam, machine-readable output, measurement rigor (P1). The safety-critical
logic now lives in a single engine seam, the CLI and MCP surfaces are
machine-readable, and the benchmark reports defensible statistics.

- **Engine facade (`src/core/engine.ts`).** `profile / checklist / plan /
  recommend / apply / revert / benchmark / calibrate / generate` in one typed
  seam; front-ends no longer duplicate orchestration, and consent, advisory-role
  refusal and containment are enforced in one place. Dependencies are injectable,
  so the whole surface is unit-tested without touching a real host.
- **Shared render layer (`src/render/`).** One profile/checklist/plan renderer
  used by both the CLI and the MCP text fallback, plus the sink encoders.
- **MCP structured outputs.** Every data tool now returns `structuredContent`
  with an `outputSchema` and a text fallback, plus `readOnlyHint` annotations and
  titles; `env`/`applyOp` are withheld from agent-facing output. The
  `validate-registry` tool is gone from the agent surface (it is a CI/CLI step
  now) and a `recommend` tool is added. Inputs are bounded (≤ 32 ids, ≤ 64 chars;
  model ≤ 128 chars) and benchmark calls are serialised.
- **CLI DX.** New `--recommend`, `--json`, `--doctor`, `--list`, `--profile`;
  the role prompt now only appears for the bare interactive invocation, so
  scripting is non-interactive. Options are labelled `[applyable]`/`[advisory]`.
- **Benchmark rigor.** Robust dispersion (IQR + MAD) and a **bootstrap
  confidence interval** on the median replace the two-point range; fixed,
  **recorded** parameters (seed, temperature, `num_ctx`, `num_batch`,
  `num_predict`) and the model digest; `compare()` is CI-based (significant iff
  the interval excludes zero) with the old noise floor kept as a fallback.
- **Metrics & profiles.** `decode`, `prefill`, `throughput` and `load` profiles;
  TTFT, inter-token latency, prefix-cache hit rate and VRAM are reported.
- **Tiers A / A− / B / C / N.** Calibration is keyed by (option, model, profile,
  metric) and records the CI and n; a null is persisted as tier **N**, and a
  combined estimate is withheld when a contributor is single-session **A−**.
- **Runtime safety.** The benchmark is loopback-only (refuse a remote
  `OLLAMA_HOST` unless `AIHO_ALLOW_REMOTE_RUNTIME=1`) and never pulls a model
  implicitly.
- **Profiler coverage.** Container/cgroup limits, WSL/VM, GPU visibility and NUMA
  are detected and exposed as a `context` block, and consumed by applicability
  (a container inferred from context disables privileged options; an empty
  `visibleGpus` disables vendor-gated options).
- **Supply chain.** GitHub Actions are pinned by commit SHA, with Dependabot to
  keep the pins current.
- **Tests.** 113 passing (was 70), including the engine, CLI, MCP protocol,
  statistics, calibration and profiler parsers.

### Also in 1.3.0 — correctness, safety and honesty hardening (P0)

A claim-accuracy pass: the applier's safety promises and the registry's honesty
are now **enforced in code and covered by tests**, not just asserted in prose.

- **Path containment, proven.** Every path written or deleted must resolve
  strictly inside the managed directory, checked with `path.relative` (never
  `startsWith`, which sibling prefixes and Windows case differences defeat).
  Registry target names must match `^[a-zA-Z0-9._-]+$`.
- **Sink-aware encoding.** Registry values are encoded for the sink they land in
  (POSIX shell, PowerShell, Dockerfile, Ansible literal block). Values that
  cannot be represented safely (newlines, NUL, Jinja/Ansible template markers)
  are rejected by validation.
- **Advisory roles enforced.** `--apply` now refuses for `cluster-node` and
  `ci-runner` unless `--force-advisory` is passed — the tool no longer prints
  "advisory only" and then writes anyway.
- **Typed apply ops.** `applyOp` is a closed union (`env` | `systemd-dropin`);
  an unknown op fails validation and CI instead of silently turning an option
  into an advisory no-op.
- **The applier consumes a resolved `Plan`.** A non-applicable or conflicting
  option can no longer be materialised at the write boundary.
- **Atomic, crash-safe, union state.** Writes go temp → fsync → rename;
  `state.json` accumulates the union of every applied file; pre-existing files
  are backed up and restored on `--revert`; a corrupt state file is a hard error;
  the systemd drop-in prints an uninstall command.
- **Registry corrections.** `hf-transfer` now uses `HF_XET_HIGH_PERFORMANCE`
  (`HF_HUB_ENABLE_HF_TRANSFER` is deprecated); `ollama-max-loaded-models` and
  `vllm-attention-backend` are advisory (their applied values contradicted the
  documented defaults / auto-selection); `dgx-tensor-parallel`'s estimate is
  fixed to +100% (`1`), not +200%; `tensorrt-llm` and `nvfp4-blackwell` now
  require an NVIDIA GPU; `ollama-num-parallel`'s memory cost reflects
  `NUM_PARALLEL × CONTEXT_LENGTH`.
- **Citations resolve.** The 25 dangling `research/mcp/*.md` `source` fields are
  replaced with real documentation URLs; validation rejects path-like citations
  that do not exist.
- **Profiler correctness.** Unified memory is derived per vendor (MIG/vGPU `N/A`
  is no longer misread as unified); the phantom Apple GPU on Intel Macs is gone;
  the dead ConnectX `ip` branch is replaced with an `lspci` probe; probes run
  concurrently.
- **CI.** `npm run validate:registry` runs as its own CI step; the registry
  validator now checks duplicate ids, unknown ops, invalid `combine`, `requires`
  cycles, malformed env names/targets/values, and citation resolvability.
- **Docs.** `SECURITY.md`, `CONTRIBUTING.md`, `docs/registry-schema.md` and the
  in-code headers now match what the code enforces; dependency licences recorded.

## 1.2.0 — 2026-11-17

**M1d — more apply ops.** The applier gains a second operation type and two more
runtimes.

- New op **`systemd-dropin`**: the `ollama-systemd-dropin` option (Linux) writes a
  systemd drop-in into the managed directory so the Ollama service actually reads
  the managed `ollama.env`. Installing it needs root, so the `sudo cp` /
  `systemctl restart` commands are **printed**, never run — the applier still
  escalates no privilege.
- New target runtime **`vllm`**, with `vllm-attention-backend` and
  `vllm-long-context`.
- The apply plan now carries multiple ops (`ops[]`), writes nested files (the
  drop-in lives under `systemd/ollama.service.d/`), and reports **manual steps**
  in its output.
- Registry now **32 options**, **11 applyable**, **2 op types**, **4 runtimes**
  (`ollama`, `llama.cpp`, `huggingface`, `vllm`).

## 1.1.1 — 2026-11-17

- Add `mcpName` to `package.json`. The MCP Registry verifies this ownership
  marker **inside the published package**, and 1.1.0 shipped without it, so
  1.1.1 is the first release eligible for the official MCP Registry.
- **Published to the official MCP Registry** as
  `io.github.williamdoring-prog/ai-host-optimizer@1.1.1` (verified via the
  registry API).

## 1.1.0 — 2026-11-17

**M1c — multi-runtime applier.** The applier is no longer Ollama-only.

- The option `env` field is now grouped by **target runtime**
  (`ollama`, `llama.cpp`, `huggingface`), and the applier writes one
  `<runtime>.env` file per target plus a single `activate.sh` / `activate.ps1`.
- `flash-attention` and `kv-cache-quant-q8`/`q4` now configure **both** Ollama and
  the llama.cpp server (`LLAMA_ARG_*`) from one logical option.
- New applyable options (registry now **29 options**, **8 applyable**):
  `ollama-num-parallel`, `ollama-max-loaded-models`, `hf-cache-location`,
  `hf-transfer`.
- `${MANAGED_DIR}` in an env value is resolved to the managed config directory
  (used by `hf-cache-location` to relocate the Hugging Face cache safely).
- `--apply` prints the resolved environment **grouped by target runtime**.
- `--revert` is now **idempotent** and clears its state file.
- Ansible generation emits one task per target and resolves `${MANAGED_DIR}` to
  the playbook's `managed_dir`; the Dockerfile resolves it to
  `/opt/ai-host-optimizer`.
- `SECURITY.md` updated to describe the (now existing) applier and the local-only
  benchmark.

**M2b — distribution.** Preparing for the MCP Registry and the directories.

- `server.json` (official MCP Registry manifest) added, validated with
  `mcp-publisher validate` against `registry.modelcontextprotocol.io`.
- `package.json` gains `mcpName` (`io.github.williamdoring-prog/ai-host-optimizer`)
  — the ownership marker the registry verifies in the published package.
- `.github/workflows/publish-mcp.yml`: on a `v*` tag, build → test → publish to
  npm → publish to the MCP Registry via **GitHub OIDC**.
- `.github/workflows/ci.yml`: build + tests across Linux/Windows/macOS and
  Node 20/22.
- `docs/publishing.md` rewritten for the registry + directory layers;
  `docs/launch.md` added (the benchmark-led launch copy).

## 1.0.3 — 2026-11-17

**M1b — measured tier-A calibration.** The benchmark is now a real, honest
measurement rather than a single wall-clock guess:

- `--benchmark` measures **decode tokens/second** (and prefill rate) via the
  Ollama HTTP API, takes several samples, discards a warm-up load, and reports
  the **median** plus the run-to-run **spread** (the noise floor).
- New `--calibrate --select <ids>`: compares a before/after measurement and
  records a **tier-A** delta for the selected options — **only when the change
  exceeds the host's combined noise floor**. A null result is reported as a null
  result and records nothing; a difference inside the noise is never claimed.
- `--plan` replaces an option's estimate with the measured value and marks it
  `[measured]` when a significant calibration exists; otherwise the original
  tier-B/C estimate stands, annotated with the null result.
- New `--samples <n>` (default 3, max 50) to lower the noise floor when a small
  effect must be detected.
- Calibrations are stored in the managed directory (`calibration.json`).
- MCP: new **`plan`** and **`benchmark`** tools.

## 1.0.2 — 2026-11-17

- Roles curated for clarity and professionalism. The non-standard
  `remote-singleton` role is replaced by **`server`** (a headless host with no
  local console). Final set: `workstation`, `laptop`, `server`, `vm-host`,
  `container`, `sandbox`, `cluster-node`, `ci-runner`.
- Each role now carries a **descriptor explaining what makes it unique**, shown
  in the interactive prompt, in `--help`, and in the MCP tool schema.

## 1.0.1 — 2026-11-17

- Fix: `--version` (and the MCP server version) now read from `package.json`
  instead of a hardcoded string.
- Fix: corrupted `README.md` (a stray UTF-16 tail containing NUL bytes) that
  blocked publishing.

## 1.0.0 — 2026-11-17

First release.

**Profile (read-only)**
- Host profiler: OS/distro, CPU, memory (**unified or discrete**), GPU, NVIDIA
  driver/CUDA, **DGX OS**, **cluster/fabric** (ConnectX/InfiniBand, NVLink, MIG),
  schedulers (Slurm/Kubernetes/Run:ai), and detected local-AI tooling.
- **Role-aware** (workstation, laptop, sandbox, vm-host, remote-singleton,
  cluster-node, container, ci-runner).
- **Vendor-gated** advice (NVIDIA / AMD / Apple / Intel / Qualcomm).
- **25 optimization options** with the full group model (exclusive / inclusive /
  conflicts / synergies / requires) and **tier A/B/C** honesty-labelled estimates.

**Plan & apply**
- `--plan --select <ids>` — resolve a conflict-free plan, pulling in prerequisites
  and reporting a **combined estimate** (`1 − Π(1 − eᵢ)`, weakest tier).
- `--apply [--yes]` — apply the plan. **Dry-run by default**; writes only into the
  managed config directory; fully reversible.
- `--revert` — undo the last apply.
- `--benchmark [--save-baseline]` — a real (tier A) on-host measurement and a
  before/after comparison.

**Generate**
- `--generate ansible|dockerfile|checklist` — declarative accessory files
  generated from the same registry (check-mode friendly; the Dockerfile documents
  that a container cannot tune the host kernel).

**Interfaces**
- CLI, terminal, and **MCP server** (`profile`, `checklist`, `validate-registry`).

**Safety**
- Read-only by default; the applier never touches system files, never runs a
  shell, and never escalates privilege.

## 0.0.1 — 2026-11-17 — M0 (read-only)

- Initial scaffold: read-only profiler, option registry, checklist, CLI + MCP.

