# Changelog

All notable changes to this project. Format: `YYYY-MM-DD — summary`.

## 1.0.2 — 2026-11-17

- Roles curated for clarity and professionalism. The non-standard
  `remote-singleton` role is replaced by **`server`** (a headless host with no
  local console). Final set: `workstation`, `laptop`, `server`, `vm-host`,
  `container`, `sandbox`, `cluster-node`, `ci-runner`.

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

