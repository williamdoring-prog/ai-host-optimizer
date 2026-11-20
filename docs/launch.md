# Launch kit

Hooks on the **benchmark**, not on claims. The one rule: quote **real** output from
your own host — never a rounded-up number.

Links to use:
- npm: https://www.npmjs.com/package/ai-host-optimizer
- repo: https://github.com/williamdoring-prog/ai-host-optimizer
- MCP Registry: `io.github.williamdoring-prog/ai-host-optimizer`

Best time: a weekday morning, US Eastern. Post the *same* content to Show HN and
r/LocalLLaMA (they don't overlap much).

---

## Show HN

**Title:**

> Show HN: AI Host Optimizer – measures whether LLM host tweaks actually help

**Body:**

Every "speed up your local LLM" guide lists the same tweaks — Flash Attention,
quantize the KV cache, keep the model resident, tune NUMA. The lists are mostly
right. They just never tell you **which of them helps on *your* machine**, or by
how much.

This tool profiles the host, gives you the checklist with a resource footprint per
option, and then — the part I care about — **measures** the options you apply so
you can see whether they did anything.

Every estimate is tagged by confidence:

- **A — measured** on your host, confidence interval excludes zero
- **A− — measured**, single session (direction consistent, magnitude uncertain)
- **B — labelled estimate** with a cited method
- **C — qualitative** (direction only, no number)
- **N — measured null** (no change beyond the interval)

Nothing is shown as measured unless it was.

**The benchmark is the point.** It measures decode tokens/second (plus prefill,
TTFT, inter-token latency and VRAM) via the local runtime's API, fixes and
records the parameters, and reports the **median with IQR/MAD and a bootstrap
confidence interval**. `--calibrate` only promotes an option to tier A when that
interval **excludes zero**; otherwise it records a **null** (tier N). If it can't
tell, it says so:

```
$ ai-host-optimizer --calibrate --select flash-attention
  current : qwen2.5-coder:14b 10.16 tok/s
  decode  : -1.3%
  ci (95%) : [-4.1, 1.2]
  verdict : not significant
  No change beyond the interval; recorded as a persisted null (tier N).
```

On my box the run-to-run spread was ±7%, so a single before/after run can show a
"15% win" that is pure noise. A tool that tells you *"this didn't help"* is more
useful than one that always claims a win.

**What it does**

- Profiles the host, **role-aware** — a container can't tune the host kernel; a
  cluster node is advisory-only.
- `--recommend` auto-selects a safe, conflict-free set; `--plan` resolves any
  selection (one-of groups vs stackable groups).
- Applies — with consent — writing **only** into a managed config directory.
  Dry-run by default, reversible (pre-existing files are backed up and restored),
  no shell, no privilege.
- `--json` on every command, `--doctor` for diagnostics, `--list` for the registry.
- Generates Ansible / Dockerfile / checklist from the same registry.
- Runs as an **MCP server** (structured outputs) *and* a CLI.

**What it deliberately doesn't do**

- No host-kernel changes from inside a container.
- No telemetry — the benchmark talks only to your local runtime.
- No invented numbers: unmeasured options stay tier B/C and say so.

```
npx -y ai-host-optimizer --cli
```

MIT. "This claim is wrong" is the most useful feedback you can send.

---

## r/LocalLLaMA

**Title:**

> I built a tool that measures whether LLM host tweaks actually help, instead of
> just listing them

**Body:**

Short version: `npx -y ai-host-optimizer --cli` profiles your machine and prints
the standard checklist (Flash Attention, KV-cache quant, keep-alive, …) with an
honest confidence tier on every number. Then `--benchmark` + `--calibrate`
measures tokens/second before and after, and only marks a win if the bootstrap
confidence interval **excludes zero** — otherwise it records a null (tier N).

Real example from my box (RTX 3080, 16 GiB): the run-to-run spread was ±7%, so a
single before/after run proves nothing — which is exactly why most "I enabled X
and got +20%" posts are noise. This tells you when it *can't* tell.

`--recommend` picks a safe conflict-free set for you, and `--json` makes it
scriptable. Also works as an MCP server (`--mcp`) with structured outputs.

MIT, npm + MCP Registry. Would love to hear where the option list is wrong.

---

## Pre-post checklist

- [ ] Run `--benchmark --save-baseline --samples 5` on the host you quote.
- [ ] Paste the *real* output; don't round up.
- [ ] npm page and README match the post.
- [ ] MCP Registry entry resolves (so "add it to your client" works).
- [ ] Reply to comments from the same honest stance: tier A or nothing.
