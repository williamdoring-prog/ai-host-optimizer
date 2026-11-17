# ai-host-optimizer

**Profile a host, plan AI-model optimizations, and apply them — reversibly, with consent.**

An MCP server *and* a CLI that inspects your machine, presents a **checklist** of
AI-optimization options (each with an **estimated improvement** and its **resource
footprint**), resolves a **conflict-free plan**, and — with explicit consent —
applies the selected options by writing files into a **managed config directory**.
Everything is **dry-run by default** and **reversible**.

> **Status: 1.0.** The profiler and the planner are read-only. The applier writes
> only inside `~/.config/ai-host-optimizer` (platform-appropriate), never touches
> system files, never runs a shell, and never escalates privilege.

## Why

Running local models well depends on host configuration (KV-cache size, Flash
Attention, prefix caching, memory/NUMA/swap behaviour, provider prompt caching).
The knowledge is scattered across guides. This tool profiles *your* host and tells
you what is worth doing — **honestly**, labelling each estimate by confidence.

## Install

```bash
# one-off
npx ai-host-optimizer --cli

# or globally
npm install -g ai-host-optimizer
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

**What is automated:** options with an `applyOp` (currently the Ollama runtime
environment, the llama.cpp server environment, and the Hugging Face cache). The
applier writes one `<runtime>.env` file per target — `ollama.env`,
`llama.cpp.env`, `huggingface.env` — plus a single `activate.sh` / `activate.ps1`.
Everything else is **advisory**: `--apply` says so plainly rather than doing
nothing silently.

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

Tools exposed:

| Tool | Purpose |
|---|---|
| `profile` | Read-only host profile (OS, CPU, memory, GPU, detected tooling) |
| `checklist` | Optimization options with estimated improvement + resource footprint |
| `plan` | Conflict-free plan for selected ids, with a combined estimate (uses tier-A calibrations when present) |
| `benchmark` | Measure local inference rate (decode tokens/s) + the noise floor — tier-A evidence |
| `validate-registry` | Registry consistency check (development aid) |

Published to the **official MCP Registry** as
`io.github.williamdoring-prog/ai-host-optimizer` (see `server.json`).

## Honesty contract

Every estimate carries a confidence tier:

- **A — measured** on your host (via `--benchmark` / `--calibrate`).
- **B — labelled estimate** with a cited method.
- **C — qualitative** (direction only, no number).

Tier B/C estimates are **never** presented as measurements. A combined estimate is
only shown once its inputs are trustworthy (see the project plan).

**Calibration is honest about noise.** `--benchmark` takes several samples and
reports their spread; `--calibrate` compares before/after and only promotes an
option to tier A when the change **exceeds the host's own noise floor** (the
combined run-to-run range). A null result is reported as a null result and records
nothing — a small difference inside the noise is not claimed as a win. Use
`--samples <n>` to lower the noise floor when you need to detect a small effect.

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

## Roadmap

- **M0** — read-only profiler, registry, checklist, CLI + MCP. ✅
- **M1** — reversible applier (user-space), plan/apply/revert, on-host benchmark. ✅
- **M1b** — measured tier-A calibration (median-of-samples benchmark, noise floor, per-option promotion). ✅
- **M1c** — multi-runtime applier: one `<runtime>.env` per target (Ollama, llama.cpp, Hugging Face), 8 applyable options, idempotent revert. ✅
- **M2** — accessory generation (Ansible/Dockerfile/checklist). ✅ *(generation)*
- **M2b** — distribution: official MCP Registry manifest + CI publish workflow; directory listings. 🚧 *(prepared)*
- **M4** — browser UI and Tauri desktop UI. *(planned)*

## Documentation

- [`docs/architecture.md`](docs/architecture.md) — one core, many front-ends; detection coverage; roadmap.
- [`docs/registry-schema.md`](docs/registry-schema.md) — the option schema and the honesty contract.
- [`docs/publishing.md`](docs/publishing.md) — releasing to npm and finishing the repo page.
- [`SECURITY.md`](SECURITY.md) — security policy and the read-only design commitments.

## Contributing

Contributions are welcome — especially **new optimization options** and
**corrections to unsupported claims**. See [`CONTRIBUTING.md`](CONTRIBUTING.md)
for the dev setup and the registry contribution rules. Participation is governed
by [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).

## Licence

MIT. See `LICENSE`.
