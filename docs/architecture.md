# Architecture

## One core, many front-ends

Every interface is a thin client of a single **engine**. The safety-critical
logic lives in **one** place, so consent, advisory-role refusal and path
containment are enforced once rather than re-implemented per UI.

```
        ┌─────────────────────────── core (pure / read-only) ──────────────────────────┐
        │  registry/options.ts (DATA, single source of truth, validated in CI)         │
        │  core/types.ts   core/roles.ts   core/paths.ts   core/env.ts   core/safety.ts │
        │  core/profiler.ts   core/checklist.ts   core/plan.ts   core/applyops.ts       │
        │  core/applier.ts   core/benchmark.ts   core/stats.ts   core/calibration.ts    │
        │  core/accessories.ts                                                          │
        └───────────────────────────────▲──────────────────────────────────────────────┘
                                        │  engine facade: src/core/engine.ts
                                        │  profile() checklist() plan() recommend()
                                        │  apply(consent) revert() benchmark() calibrate()
                                        │  generate()  — enforces consent, advisory roles,
                                        │  containment and input bounds in ONE place
        ┌───────────────────────────────┴──────────────────────────────────────────────┐
        │  render/: renderProfile / renderChecklist / renderPlan  (shared by front-ends)│
        └───────────────────────────────▲──────────────────────────────────────────────┘
              ┌─────────────────────────┼─────────────────────────┐
        cli/launcher.ts            mcp/server.ts            (future) http/api
        (parse → engine → render)  (tools → engine → structuredContent)
```

**Implemented:** CLI, terminal (interactive), and MCP server.
**Planned:** browser UI and Tauri desktop UI (sharing one web-UI codebase).

## Modules

| Path | Responsibility |
|---|---|
| `src/core/types.ts` | Shared types (option schema, `HostProfile`, `HostContext`, tiers). |
| `src/core/roles.ts` | The canonical `ROLE_NAMES` tuple; `SystemRole` is derived from it. |
| `src/core/paths.ts` | `managedDir()`, the `${MANAGED_DIR}` token. |
| `src/core/env.ts` | One `mergeEnvByTarget`/`flattenEnv` shared by applier and accessories. |
| `src/core/safety.ts` | Containment (`assertContained`) and name validation. |
| `src/core/applyops.ts` | The closed `ApplyOpId` allow-list (`env`, `systemd-dropin`). |
| `src/core/profiler.ts` | **Read-only** host inspection (OS, CPU, memory, GPU, NVIDIA stack, cluster/fabric, container/cgroup/visibility context, tooling). |
| `src/core/checklist.ts` | Checklist construction, applicability rules, `validateRegistry`. |
| `src/core/plan.ts` | Conflict-free planning and honest combined estimates. |
| `src/core/applier.ts` | Reversible, contained, atomic writes into the managed dir. |
| `src/core/benchmark.ts` | Tier-A measurement with robust dispersion + bootstrap CI. |
| `src/core/history.ts` | Benchmark history + regression detection (pure detection). |
| `src/core/stats.ts` | Pure statistics (median, MAD, IQR, bootstrap CIs). |
| `src/core/calibration.ts` | Per-(option, model, profile) measured deltas. |
| `src/core/accessories.ts` | Ansible / Dockerfile / Markdown generation (injection-safe). |
| `src/core/engine.ts` | The engine facade — the single enforcement seam. |
| `src/registry/options.ts` | **The option registry — data.** Single source of truth. |
| `src/registry/validate.ts` | CI entry point for registry validation. |
| `src/render/` | Shared renderers (profile, checklist, plan, summary) + sink encoders. |
| `src/cli/launcher.ts` | Arg parsing, role resolution, terminal output. |
| `src/cli/tui.ts` | Dependency-free interactive checkbox selector (raw mode). |
| `src/mcp/server.ts` | MCP stdio server (read-only tools, structured outputs). |
| `src/index.ts` | Entry point. |

## The safety posture

The profiler and planner perform **no writes**, **no privilege escalation**, and
**no installs**. The applier only ever writes inside the managed directory, and
only through allow-listed ops. Every mutating capability must be:

- **consent-driven** (a real write requires `consent`; dry-run needs none),
- **dry-run by default**, showing the resolved change,
- **reversible**, with a recorded rollback (pre-existing files are backed up and
  restored on `--revert`),
- **allow-listed** (no arbitrary shell),
- **injection-resistant** (values are encoded for the sink they land in),
- **contained** (every written/deleted path is proven, via `path.relative`, to
  lie inside the managed directory),
- **advisory-role aware** (`cluster-node`/`ci-runner` refuse to apply unless
  explicitly overridden).

## The role model

The system's role is supplied by the user (flag, prompt, or MCP parameter) and
changes applicability:

| Role | Effect |
|---|---|
| `container` | privileged host-kernel options are **not applicable** (also inferred from container/cgroup detection) |
| `cluster-node`, `ci-runner` | **advisory-only** — report, never apply |
| `sandbox` | experimentation expected; changes assumed disposable |
| `vm-host` | host-level tuning also affects guests |
| `server` | headless; no local console, so prefer dry-run + rollback |
| `workstation`, `laptop` | default |

## Detection coverage

| Dimension | Covered |
|---|---|
| Platforms | Linux, Windows, macOS |
| Architectures | x64, ARM64 (Grace, Apple Silicon) |
| Memory models | discrete VRAM, **unified** (Apple / GB10 family), MIG/vGPU reported as *unknown* rather than misread |
| Vendors | NVIDIA, AMD, Apple, Intel, Qualcomm |
| Scale | single host → fabric (ConnectX/InfiniBand, NVLink), MIG |
| Context | schedulers (Slurm, Kubernetes, Run:ai), DGX OS, **container/cgroup limits, WSL/VM, GPU visibility, NUMA** |

## Measurement model

Tier-A evidence comes from a local runtime, loopback-only and with **no implicit
model pulls**. Three servers are supported and auto-detected: **Ollama**
(`/api/generate`), **llama.cpp server** (`/completion` `timings`) and **vLLM**
(Prometheus `/metrics` scraped around a request). Workload profiles (`decode`,
`prefill`, `throughput`, `load`) are measured separately because decode is
memory-bandwidth-bound and prefill is compute-bound. Each result records its
fixed parameters (seed, temperature, `num_ctx`, `num_batch`, `num_predict`) and
the model digest, and reports **median + IQR/MAD + a bootstrap CI** rather than a
two-point range. Calibration tiers are:

| Tier | Meaning |
|---|---|
| **A** | measured, CI excludes zero |
| **A−** | measured, single session — magnitude uncertain |
| **B** | cited estimate |
| **C** | qualitative |
| **N** | measured, no change beyond the interval (a persisted null) |

A combined estimate inherits the weakest contributor and is **withheld** when a
contributor is single-session A−.

**On pairing.** A fully paired A/B/A/B design would need the runtime
configuration to change between cycles, which means restarting the service —
privilege this tool deliberately does not take. The unpaired bootstrap CI is the
honest alternative: it widens automatically when the run-to-run spread is large,
so a difference is claimed only when it is larger than the noise it was measured
against.

## Capabilities vs configuration

A checklist of *what could apply* is not the same as *what is already
implemented*. The profiler's `context` block answers "what is available"; a
**configuration probe** answers "what is already in place" by comparing each
option's target environment variables against the current environment:

- `implemented` — at least one target variable is set and **none** of the set
  variables fall short. Variables for runtimes you are not running stay unset, so
  an option already in effect for the runtime you use is not reported as an
  outstanding change;
- `partial` — a set variable falls short of the desired value (a real remaining
  improvement);
- `unset` — none are set.

For `size` options the comparison is numeric and direction-aware, so a value
already at least as good as the desired one counts as implemented.

The checklist renders this as `[ ]` / `[~]` / `[✓]`; `--recommend` lists only
improvements that are not yet implemented (and does not offer an exclusive-group
alternative when a sibling is already implemented); `--calibrate` refuses to
benchmark an already-implemented option, because there is no before/after change
to measure; `--doctor` summarises the counts; and the MCP `checklist` tool returns
the comparison per option. The tool's own applied state (`state.json`) also marks
options as applied.

Caveat: the probe proves the variable is set *in this environment*, not that the
running server has picked it up — restart the runtime if it started before the
variable was set.

## Roadmap

- **M0** — read-only profiler, registry, checklist, CLI + MCP. ✅
- **M1** — reversible applier for user-space levers + on-host benchmark (tier A). ✅
- **M1b** — measured tier-A calibration with a run-to-run noise floor. ✅
- **M1c** — multi-runtime applier (`<runtime>.env` per target). ✅
- **M1d** — more apply ops (`systemd-dropin`) and the `vllm` runtime. ✅
- **M2** — accessory generation (Ansible/Dockerfile/checklist). ✅
- **P0 hardening** — enforced containment, sink-aware encoding, typed apply ops,
  atomic/union state, advisory-role refusal, registry corrections. ✅
- **P1** — engine facade, shared render layer, structured MCP outputs, CLI
  `--recommend`/`--json`/`--doctor`/`--list`, benchmark rigor, context detection. ✅
- **M2b** — distribution: official MCP Registry entry live; directory listings next.
- **M4** — browser UI and Tauri desktop UI.
