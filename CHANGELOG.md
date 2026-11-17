# Changelog

All notable changes to this project. Format: `YYYY-MM-DD — summary`.

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

