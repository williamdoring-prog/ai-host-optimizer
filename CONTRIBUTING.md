# Contributing to ai-host-optimizer

Thanks for your interest. This project has one guiding principle that shapes
everything: **never claim what we have not measured.** If you keep that in mind,
you'll fit right in.

## Project philosophy

1. **Honesty over hype.** Every improvement estimate carries a confidence tier:
   **A** (measured on the host), **B** (labelled estimate with a cited method), or
   **C** (qualitative only). Tier B/C must never be presented as a measurement.
2. **Read-only by default.** Profiling and planning change nothing on the user's
   machine. The applier is consent-driven, dry-run-first, contained to the
   managed directory, and reversible.
3. **Evidence before assumptions.** Facts need a source; inferences are labelled.

## Ways to contribute

- **Add or improve an optimization option** (the most valuable contribution — see
  below).
- **Improve hardware detection** in `src/core/profiler.ts`.
- **Fix or improve documentation.**
- **Report bugs / propose features** via GitHub Issues.
- **Report false or unverified claims** — we treat these as bugs, not marketing.

## Development setup

Requires **Node.js ≥ 20**.

```bash
npm install
npm run build       # tsc
npm test            # node --test
npm run typecheck   # tsc --noEmit
npm run dev -- --cli   # run from source (tsx)
```

## Adding an optimization option

The option registry (`src/registry/options.ts`) is **data**, and it is the single
source of truth for every output (CLI, MCP, and — later — generated Ansible/
Dockerfile accessory files). Adding an option means adding an entry to `OPTIONS`.

### The schema

See `docs/registry-schema.md` for the full reference. The essentials:

```ts
{
  id: "kv-cache-quant-q8",              // stable, kebab-case, unique
  name: "Quantize KV cache to q8_0",
  description: "…",
  category: "kv-cache",                 // see the union in core/types.ts
  platforms: ["linux", "macos", "windows"],
  requiresVendor: "nvidia",             // optional: gate on a detected GPU vendor
  requiresPrivilege: false,             // true ⇒ not applicable in a container
  risk: "low",                          // low | medium | high
  reversibility: "fully-reversible",    // fully-reversible | reversible-with-backup | not-reversible
  resourceCost: { gpuMiB: -1 },         // approximate footprint (negative = frees)
  expectedImprovement: {
    metric: "KV cache memory",
    estimate: 0.5,                      // 0.5 = +50%; omit for qualitative
    tier: "B",                          // A | B | C
    method: "Ollama/llama.cpp docs: q8_0 KV cache is ~1/2 of f16.",
  },
  exclusiveGroup: "kv-cache-quant",     // at most one member selectable
  inclusiveGroup: "throughput-stack",   // members stack; may be selected together
  combine: "multiplicative",            // how the estimate stacks
  conflictsWith: [],                    // ids that must not be applied together
  synergizesWith: ["flash-attention"],  // preferred companions
  requires: ["flash-attention"],        // prerequisites
  source: "https://…",                  // citation for the option's existence/behaviour
}
```

### Rules (enforced by `validateRegistry` and the test suite)

- **Tier B requires both** a numeric `estimate` **and** a `method`/citation.
- **`requires` / `conflictsWith` / `synergizesWith` must reference existing ids**,
  and `requires` must not contain a cycle or a self-reference.
- **An `exclusiveGroup` should have ≥ 2 members** (otherwise it is not exclusive).
- **`applyOp`, when present, must be one of the allow-listed ops** (`env`,
  `systemd-dropin`). An option that declares `env` must use `applyOp: "env"`, and
  vice versa.
- **Environment names** must match `^[A-Z_][A-Z0-9_]*$`; **target names** must
  match `^[a-zA-Z0-9._-]+$`; **values** must not contain newlines, NUL bytes, or
  Ansible/Jinja template markers (`{{`, `{%`).
- **`source` must resolve**: an `http(s)` URL, an existing repository path, or a
  prose citation with no path component.
- **Prefer tier C** unless you have a defensible, cited number. Vendor claims are
  welcome but must be labelled as vendor claims in `method`.
- **Do not invent magnitudes.** "Should reduce paging" (tier C) is a valid,
  honest entry; a made-up percentage is not.

### After adding an option

```bash
npm run build && npm test
```

The tests include a registry-consistency check, so they will catch broken
references and tier-B violations.

## Hardware detection contributions

`src/core/profiler.ts` must stay **read-only**: no writes, no privilege
escalation, no package installation. Detection should degrade gracefully — if a
vendor tool is absent, return `undefined` rather than throwing. Prefer
`/proc`, `/sys`, environment variables and standard commands over new native
dependencies.

## Code style

- **TypeScript**, `strict`, ES modules, `NodeNext` resolution.
- Keep the dependency count small — the core should stay auditable.
- No new runtime dependency without discussion in an issue first.
- Match the surrounding style; keep functions small and pure where possible.

## Safety rules for reviewers

Changes that touch the (future) applier, privilege handling, or the local HTTP
server are **safety-critical**. They require an explicit review note covering:
consent, dry-run, reversibility, and injection resistance. See the project's
safety constraints before proposing such a change.

## Pull requests

1. Fork, branch from `main`, and keep the change focused.
2. Ensure `npm run build` and `npm test` pass.
3. Describe **what** changed and **why**, and cite sources for any new claim.
4. Note any new dependency and its licence.

## Reporting a bad claim

If you find an estimate or claim that is unsupported or false, please open an
issue with the option `id` and a source. **Correcting a false claim is a
first-class contribution here.**

## Licence

By contributing you agree your contributions are licensed under the project's
**MIT** licence.

### Dependency licence posture

The runtime surface is deliberately tiny and fully permissive; adding a
copyleft or otherwise encumbered dependency requires an issue and maintainer
sign-off first.

| Package | Version | Licence |
|---|---|---|
| `@modelcontextprotocol/sdk` | ^1.32.2 | MIT |
| `zod` | ^3.23.8 | MIT |
| `typescript` (dev) | ^5.6.0 | Apache-2.0 |
| `tsx` (dev) | ^4.19.0 | MIT |
| `@types/node` (dev) | ^22.7.0 | MIT |

The project itself is MIT. TypeScript is Apache-2.0, which is compatible with
MIT for use as a build tool. No copyleft (GPL/AGPL/LGPL) licence is present in
the runtime or dev dependency tree at the time of writing; re-check with
`npm ls --all` when dependencies change.

## Code of conduct

Participation is governed by `CODE_OF_CONDUCT.md`.
