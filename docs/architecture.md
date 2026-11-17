# Architecture

## One core, many front-ends

Every interface is a thin client of a single engine. The safety-critical logic
lives in **one** place, so the safety rules are enforced once rather than
re-implemented per UI.

```
        ┌──────────────────── core engine (one implementation) ─────────────────┐
        │  profiler · option registry · checklist builder · (planner/applier)   │
        └──────────▲──────────────▲──────────────▲──────────────▲──────────────┘
                   │ local engine API (in-process today; loopback JSON later)
   ┌───────────────┼──────────────┼──────────────┼──────────────┼──────────────┐
 CLI launcher   Browser UI     Desktop UI      Terminal        MCP server
 (--cli)        (--browser)    (--desktop)     (interactive)   (--mcp)
```

**Implemented in M0:** CLI, terminal, and MCP server.
**Planned:** browser UI and Tauri desktop UI (which will share one web-UI codebase).

## Modules

| Path | Responsibility |
|---|---|
| `src/core/types.ts` | All shared types, including the option schema and `SystemRole`. |
| `src/core/profiler.ts` | **Read-only** host inspection (OS, CPU, memory, GPU, NVIDIA stack, cluster/fabric, tooling). |
| `src/core/checklist.ts` | Builds the checklist; validates the registry; applies applicability rules. |
| `src/core/roles.ts` | The system-role list shared by the CLI and MCP server. |
| `src/registry/options.ts` | **The option registry — data.** Single source of truth. |
| `src/cli/launcher.ts` | Arg parsing, role resolution, terminal output. |
| `src/mcp/server.ts` | MCP stdio server (`profile`, `checklist`, `validate-registry`). |
| `src/index.ts` | Entry point. |

## The read-only posture

M0 performs **no writes**, **no privilege escalation**, and **no installs**. The
profiler only reads:
- `os.*` (Node standard library),
- `/etc/os-release`, `/etc/dgx-release` (Linux),
- `nvidia-smi`, `rocm-smi`, `lspci`, `ibstat`, `dmidecode`, `system_profiler`
  (read-only invocations; failures are swallowed).

Any future applier (M1) must be:
- **consent-driven** (per change, not one blanket approval),
- **dry-run by default**, showing the resolved change,
- **reversible**, with a recorded rollback,
- **allow-listed** (no arbitrary shell),
- **injection-resistant** (the model proposes; the server enforces).

## The role model

The system's role is supplied by the user (flag, prompt, or MCP parameter) and
changes applicability:

| Role | Effect |
|---|---|
| `container` | privileged host-kernel options are **not applicable** |
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
| Memory models | discrete VRAM, **unified** (Apple / Strix Halo / GB10) |
| Vendors | NVIDIA, AMD, Apple, Intel, Qualcomm |
| Scale | single host → fabric (ConnectX/InfiniBand, NVLink), MIG |
| Context | schedulers (Slurm, Kubernetes, Run:ai), DGX OS |

## Roadmap

- **M0** — read-only profiler, registry, checklist, CLI + MCP. *(current)*
- **M1** — reversible applier for user-space levers + on-host benchmark (tier A).
- **M1b** — calibrated tier-B coefficient table.
- **M2** — ASM package; distribution to MCP registries.
- **M2b** — generated Ansible/Dockerfile accessory files.
- **M4** — browser UI and Tauri desktop UI.
