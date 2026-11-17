# Option Registry Schema

The registry (`src/registry/options.ts`) is the project's **single source of
truth**. Every output — the CLI checklist, the MCP result, and (later) the
generated Ansible playbook and Dockerfile — is derived from it, so they cannot
drift apart.

## An option

```ts
interface OptimizationOption {
  id: string;                 // stable, kebab-case, unique
  name: string;
  description: string;
  category: Category;         // runtime | quantization | kv-cache | cache | memory |
                              // gpu | cpu | storage | provider-cache | package
  platforms: Platform[];      // linux | macos | windows
  requiresVendor?: string;    // gate on a detected GPU vendor (nvidia/amd/apple/intel/qualcomm)
  requiresPrivilege: boolean; // true ⇒ not applicable in a container
  risk: "low" | "medium" | "high";
  reversibility: "fully-reversible" | "reversible-with-backup" | "not-reversible";
  resourceCost: { cpu?: number; ramMiB?: number; diskMiB?: number; gpuMiB?: number };
  expectedImprovement: {
    metric: string;           // e.g. "decode tokens/s", "KV cache memory"
    estimate?: number;        // 0.5 = +50%; omit for qualitative
    tier: "A" | "B" | "C";
    method?: string;          // required for tier B — the cited method
  };
  exclusiveGroup?: string;    // at most one member selectable
  inclusiveGroup?: string;    // members stack; may be selected together
  combine?: "additive" | "multiplicative" | "diminishing";
  conflictsWith: string[];    // ids that must not be applied together
  synergizesWith: string[];   // preferred companions
  requires: string[];         // prerequisites
  applyOp?: string;           // allow-listed operation id; absent = advisory only
  env?: Record<string, Record<string, string>>;
                              // target runtime -> { NAME: value }, e.g.
                              // { ollama: { OLLAMA_FLASH_ATTENTION: "1" },
                              //   "llama.cpp": { LLAMA_ARG_FLASH_ATTN: "1" } }
  source?: string;            // citation for the option's existence/behaviour
}
```

## Apply ops (the applier allow-list)

Only options with an `applyOp` are automated; everything else is **advisory**
(the CLI says so plainly rather than doing nothing silently).

| `applyOp` | Effect | Reversible |
|---|---|---|
| `env` | Write `<target>.env` per target runtime into the managed directory, plus `activate.sh` / `activate.ps1` | ✅ `--revert` |

Target runtimes currently used: `ollama`, `llama.cpp`, `huggingface`. The applier
substitutes `${MANAGED_DIR}` in a value with the managed config directory, so an
option can point a cache at a known-safe location. A target with no contributing
options is not written at all.

## Confidence tiers (the honesty contract)

| Tier | Meaning | Requirements |
|---|---|---|
| **A** | Measured on **this** host | Requires the M1 benchmark; not used in M0 |
| **B** | Labelled estimate with a **cited method** | Numeric `estimate` **and** `method` |
| **C** | Qualitative (direction only) | No number; `method` optional |

**Tier B/C must never masquerade as tier A.** A combined estimate is only shown
once every contributor is trustworthy.

## Groups: exclusive vs inclusive

- **`exclusiveGroup`** — genuinely conflicting options; **at most one** may be
  selected. Example: `kv-cache-quant` (q8_0 *or* q4_0); `memory-overflow`
  (zram *or* disk swap).
- **`inclusiveGroup`** — options whose improvements **stack**; they may be
  selected **together**. Example: `throughput-stack` (Flash Attention + prefix
  caching + KV quantization).

## Conflicts and synergies

- **`conflictsWith`** — hard incompatibilities (e.g. `mlock` vs `zram`/`disk-swap`).
- **`synergizesWith`** — options that reinforce one another (preferred combos).
- **`requires`** — prerequisites (e.g. KV quantization *requires* Flash Attention
  in llama.cpp).

## Combining stacked estimates

Stacked improvements are **not summed**. Percentages compound and interact with
the bottleneck (decode is memory-bandwidth-bound). The intended model is:

```
combined = 1 − Π (1 − eᵢ)
```

with saturation/clamping, and a downgrade to **tier C** wherever the interaction
is unknown. Where only measurement can be trusted, the tool must say so.

## Validation

`validateRegistry()` (and the test suite) enforces:

- every `requires` / `conflictsWith` / `synergizesWith` id exists;
- tier B has both an `estimate` and a `method`;
- no option conflicts with itself;
- an `exclusiveGroup` has ≥ 2 members.

Run `npm run build && npm test` after editing the registry.

## Selection (planned, M1)

Given the user's selections and the host's resource budget, the planner should
maximise a **synergy-first, stackable, non-conflicting** set (a
multiple-choice-knapsack with precedence and a pairwise synergy bonus),
surfacing **exclusive choices** for the user to pick one — and reporting the
**combined, honest** estimate rather than a naive sum.
