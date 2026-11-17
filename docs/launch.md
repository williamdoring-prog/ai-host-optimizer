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

- **A — measured** on your host
- **B — labelled estimate** with a cited method
- **C — qualitative** (direction only, no number)

Nothing is shown as measured unless it was.

**The benchmark is the point.** It measures decode tokens/second via the local
runtime's API, takes several samples, and reports the run-to-run **noise floor**.
`--calibrate` then only promotes an option to tier A when the change *exceeds*
that floor. If it doesn't, it says so and records nothing:

```
$ ai-host-optimizer --calibrate --select flash-attention
  baseline: qwen2.5-coder:14b, 10.29 tok/s, 2638.9 ms, 5549 MiB free
  current : qwen2.5-coder:14b, 10.16 tok/s, 2860.5 ms, 5541 MiB free
  noise floor: ±13.9%

No significant change: decode tokens/s -1.3% is within the ±13.9% noise floor
of this host.
Nothing recorded — a null result is not evidence of an improvement.
```

On my box the run-to-run spread was ±7%, so a single before/after run can show a
"15% win" that is pure noise. A tool that tells you *"this didn't help"* is more
useful than one that always claims a win.

**What it does**

- Profiles the host, **role-aware** — a container can't tune the host kernel; a
  cluster node is advisory-only.
- Checklist → conflict-free plan (one-of groups vs stackable groups).
- Applies — with consent — writing **only** into a managed config directory.
  Dry-run by default, reversible, no shell, no privilege.
- Generates Ansible / Dockerfile / checklist from the same registry.
- Runs as an **MCP server** *and* a CLI.

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
measures tokens/second before and after, and only marks a win if it beats the
host's own **noise floor**.

Real example from my box (RTX 3080, 16 GiB): the run-to-run spread was ±7%, so a
single before/after run proves nothing — which is exactly why most "I enabled X
and got +20%" posts are noise. This tells you when it *can't* tell.

Also works as an MCP server (`--mcp`), so you can ask your client for the
checklist directly.

MIT, npm + MCP Registry. Would love to hear where the option list is wrong.

---

## Pre-post checklist

- [ ] Run `--benchmark --save-baseline --samples 5` on the host you quote.
- [ ] Paste the *real* output; don't round up.
- [ ] npm page and README match the post.
- [ ] MCP Registry entry resolves (so "add it to your client" works).
- [ ] Reply to comments from the same honest stance: tier A or nothing.
