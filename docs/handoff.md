# Handoff — `ai-host-optimizer`

Status as of **2026-11-20**. Written so someone can pick this up cold.

## TL;DR

A small, honest local-AI host advisor: it profiles a machine, gives a
confidence-graded checklist of optimizations, plans a conflict-free set, applies
the user's selection into a managed directory (reversible), and **measures**
whether changes helped (with a bootstrap CI, so it refuses to claim noise). Ships
as an **MCP server + CLI**.

- **Released: `1.8.0`** — live on npm (`latest`) and the official MCP Registry (`isLatest`).
- **On `main` (unreleased): benchmark history + regression detection** (`f4fea09`).
- **Tests: 170/170** green (`npm test`); `typecheck`/`build`/`validate:registry` green.
- Registry: **41 options, 14 applyable** (7 `env`, 6 `size`, 1 `systemd-dropin`).
- Runtime deps: **2** (`@modelcontextprotocol/sdk`, `zod`). Node ≥ 20.

## Repo & release state

- **Remote:** `github.com/williamdoring-prog/ai-host-optimizer` (branch `main`).
- **Tags:** `v1.1.0`, `v1.3.0`, `v1.4.0`, `v1.5.0`, `v1.6.0`, `v1.7.0`, `v1.8.0`.
  (`1.2.0` was published manually and has no tag.)
- **Untracked (deliberate):**
  - `research/` — the planning docs (audit, ecosystem research, specialist
    reports, `FINAL_IMPROVEMENT_PROPOSAL.md`, `IMPLEMENTATION_BACKLOG.md`). This
    is the source of the roadmap; consider committing it or archiving it.
  - `ai-host-report.md` — a generated sample report from this machine.

## What shipped, by milestone

| Milestone | Highlights |
|---|---|
| **P0 — safety/honesty** | Path containment (`path.relative`, never `startsWith`); sink-aware value encoding (sh/PS/Dockerfile/YAML) + registry validation; typed apply ops (`env`/`systemd-dropin`/`size`); applier consumes a resolved `Plan`; atomic writes + union state with backups/restore; advisory-role refusal (`--force-advisory`); registry corrections; citations resolve; profiler fixes; CI registry gate. |
| **P1 — architecture/measurement** | `engine` facade + shared `render/`; `paths`/`env`/`roles` single-sourced; CLI `--recommend`/`--json`/`--doctor`/`--list`; MCP structured outputs + annotations + input bounds; benchmark rigor (IQR/MAD + bootstrap CI, recorded params, 4 profiles, TTFT/ITL/prefix-hit/VRAM); tiers A/A−/B/C/N; profiler context (container/cgroup/WSL/VM/GPU visibility/NUMA). |
| **P2 — depth** | `size` apply op with a numeric guard (never worse than the runtime default); option tranches (context length, llama.cpp batch/ubatch, Ollama queue; advisory GPU-layers/visibility/HF-offline/models-path); **multi-runtime benchmarking** (Ollama, llama.cpp `/completion` timings, vLLM Prometheus), auto-detected on loopback; **capability vs configuration** probe (implemented/partial/unset; summary-led reports; "already optimal" message; recommend/calibrate skip implemented). |
| **Hardening** | Managed dir `0700` / files `0600`; `secret: true` redaction; MCP **resources** (`aiho://registry/options`, `aiho://host/profile`, `aiho://host/checklist`, `aiho://docs/*`) and **prompts** (`optimize_local_ai_host`, `explain_option`, `interpret_benchmark`); interactive checkbox selector `--interactive`. |
| **P3 (partial)** | **Benchmark history + regression detection** (`--history`; keyed by host/runtime/model/profile/config digest; flags a slowdown only beyond the interval). |

## On `main`, unreleased

`f4fea09 feat(p3): benchmark history + regression detection (--history, AIHO-028)`
— see `src/core/history.ts`, `--history`, and the `history` engine method. Ready to
cut as **1.9.0** whenever you want.

## Architecture map

```
core (pure/read-only)                      front-ends
  types.ts  roles.ts  paths.ts  env.ts       cli/launcher.ts   (parse → engine → render)
  safety.ts applyops.ts                      cli/tui.ts        (raw-mode checkbox selector)
  profiler.ts checklist.ts plan.ts           mcp/server.ts     (tools + resources + prompts)
  applier.ts benchmark.ts stats.ts
  calibration.ts history.ts runtimes.ts    render/  (profile/checklist/plan/summary + encoders)
  accessories.ts engine.ts  ◄── the enforcement seam
  registry/options.ts (DATA)  registry/validate.ts (CI)
```

- **`engine.ts`** is the single place consent, advisory-role refusal, containment
  and input bounds are enforced; front-ends are thin. Dependencies are injectable
  (see `EngineDeps`) so the whole surface is unit-tested without a real host.
- **`registry/options.ts`** is the single source of truth for every output.
- **`render/`** holds the shared renderers and the sink encoders.

## Working on it

```bash
npm ci
npm run typecheck
npm run build
npm run validate:registry     # registry integrity (also a CI step)
npm test                      # 170 tests, Node 20+ (scripts/test.mjs)
npm run dev -- --cli          # run from source
```

Definition of done for a change: `typecheck && build && validate:registry && test`
green, new behaviour covered by tests, registry valid, safety invariants preserved
(see `SECURITY.md`).

## Releasing

`.github/workflows/publish-mcp.yml` runs on any `v*` tag and publishes **both**
npm and the MCP Registry — no tokens (npm trusted publishing + registry OIDC).

```bash
npm version <patch|minor>       # or edit package.json + server.json by hand
git add -A && git commit -m "vX.Y.Z: ..." && git push
git tag -a vX.Y.Z -m "vX.Y.Z" && git push origin vX.Y.Z
```

Prerequisites / gotchas:
- **npm Trusted Publisher** must exist for the package with repository
  `williamdoring-prog/ai-host-optimizer`, workflow filename `publish-mcp.yml`
  (exact, `.yml`), and **"Allow `npm publish`"** enabled (new configs default to
  stage-only). See `docs/publishing.md`.
- Keep `package.json` and `server.json` versions in sync (the workflow rewrites
  `server.json` from the tag, but the repo copy should match).
- The workflow **waits (best-effort) for npm to serve the version**, then
  **retries the MCP Registry publish with backoff** — the registry's own npm
  lookup lags the publish. Both are already in place; don't remove them.
- A brand-new trusted publisher must complete its first publish within 2 days.

## Open decisions / remaining work

- **Apply-over-MCP** (opt-in, consented): separate `--mcp-allow-apply` server with
  dry-run preview, out-of-band human confirmation, and a rollback handle. Default
  server stays read-only. Needs a design decision on the consent/elicitation flow.
- **MCP protocol `2026-07-28`** (stateless `server/discover`, per-request `_meta`):
  verify the pinned SDK supports it and clients negotiate it before adopting.
- **Surface decisions:** tool renaming (`get_host_profile`, …) is breaking — keep
  names + aliases? Collapse `sandbox`/`vm-host` roles? Calibration storage shared
  vs per-user?
- **Distribution:** mcp.so is **skipped** (paid); **Glama** is free and still
  pending. Launch copy is ready in `docs/launch.md`.

## Known limitations & caveats

- **Configuration probe is environment-based**: it proves a variable is set in the
  tool's environment, not that a running server picked it up (restart the runtime
  if it started before the variable was set).
- **The interactive selector needs a real TTY**; it is validated via simulated
  keypresses in `src/cli/tui.test.ts`, not visually.
- **Benchmark baseline** is model/profile-specific: comparing a baseline saved on a
  different model produces a meaningless delta (the CLI prints it anyway — a known
  rough edge).
- **llama.cpp/vLLM adapters** are unit-tested at the parser level only; there was
  no live llama.cpp/vLLM server to validate against. Ollama is validated live.
- **`research/`** and `ai-host-report.md` are untracked.

## Where the roadmap came from

`research/FINAL_IMPROVEMENT_PROPOSAL.md` (prioritised P0–P3) and
`research/IMPLEMENTATION_BACKLOG.md` (task IDs `AIHO-NNN`). Everything through P2
plus the hardening items and one P3 item (history) is implemented; the rest is
listed under "Open decisions" above.
