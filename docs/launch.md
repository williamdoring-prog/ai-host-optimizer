# Launch post (draft)

Hooks on the **benchmark**, not on claims. Post to Show HN and r/LocalLLaMA, and
link the repo + npm page. Adjust numbers from your own run before posting.

---

## Show HN: AI Host Optimizer – measures what actually helps your local LLM

Every "speed up your local LLM" guide gives you the same list: Flash Attention,
quantize the KV cache, keep the model resident, tune NUMA. The lists are mostly
right — but they never tell you **which of them actually helps on *your*
machine**, or by how much.

I built a tool that profiles your host, gives you the checklist, and — this is the
part I care about — **measures** the ones you apply so you can see whether they
did anything.

**The honesty rule:** every estimate is tagged.

- **A — measured** on your host
- **B — labelled estimate** with a cited method
- **C — qualitative** (direction only, no number)

Nothing is ever presented as measured unless it was.

**The part I think is actually useful — the benchmark.** It measures decode
tokens/second via the Ollama API, takes several samples, and reports the
run-to-run **noise floor**. Then `--calibrate` compares before/after and only
promotes an option to tier A **when the change exceeds that floor**. If it
doesn't, it says so and records nothing:

```
$ ai-host-optimizer --calibrate --select flash-attention
  baseline: qwen2.5-coder:14b, 10.29 tok/s, 2638.9 ms, 5549 MiB free
  current : qwen2.5-coder:14b, 10.16 tok/s, 2860.5 ms, 5541 MiB free
  noise floor: ±13.9%

No significant change: decode tokens/s -1.3% is within the ±13.9% noise floor
of this host.
Nothing recorded — a null result is not evidence of an improvement.
```

A tool that tells you *"this didn't help"* is more useful than one that always
claims a win.

**What it does**

- Profiles the host (OS/CPU/memory/GPU/cluster), **role-aware** — a container
  can't tune the host kernel; a cluster node is advisory-only.
- Gives a checklist with an estimated improvement + resource footprint per option.
- Resolves a conflict-free plan (one-of groups vs stackable groups).
- Applies — with consent — by writing **only** into a managed config directory.
  Dry-run by default, reversible with `--revert`, no shell, no privilege.
- Generates Ansible / Dockerfile / checklist from the same registry.
- Runs as an **MCP server** *and* a CLI.

**What it deliberately doesn't do**

- No host-kernel changes from inside a container.
- No hidden telemetry; the benchmark talks only to your local runtime.
- No invented numbers: unmeasured options stay tier B/C and say so.

```
npx -y ai-host-optimizer --cli
```

MIT. Feedback — especially "this claim is wrong" — is the most useful thing you
can send.

---

## Reddit variant (r/LocalLLaMA)

**I built a tool that measures whether LLM host tweaks actually help, instead of
just listing them**

Short version: `npx -y ai-host-optimizer --cli` profiles your machine and gives
you the standard checklist (Flash Attention, KV-cache quant, keep-alive, …) with
an honest confidence tier on every number. Then `--benchmark` + `--calibrate`
measures tokens/second before and after and only marks a win if it beats the
host's own noise floor.

Real example from my box (RTX 3080, 16 GiB): the noise floor was ±7–14%, so a
single before/after run proves nothing — which is exactly why most "I enabled X
and got +20%" posts are noise. The tool tells you when it can't tell.

MCP server + CLI, MIT. Would love to hear where the option list is wrong.

---

## Checklist before posting

- [ ] Run `--benchmark --save-baseline --samples 5` on the host you quote.
- [ ] Paste the *real* output; don't round up.
- [ ] Confirm the npm page and README match the post.
- [ ] Have the MCP Registry entry live so the "add it to your client" step works.
