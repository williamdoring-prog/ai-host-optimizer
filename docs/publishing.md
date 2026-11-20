# Publishing & Distribution

How to release `ai-host-optimizer` to npm, publish it to the MCP Registry, and
finish the GitHub repo page.

Distribution is **layered on purpose**: no single directory is durable (Smithery
shut down its proxy in 2026), so publish to the registry *and* the directories,
and treat the benchmark — not a claim — as the hook.

## 1. Prerequisites

- An npm account, logged in locally (`npm login`).
- The package name: <https://www.npmjs.com/package/ai-host-optimizer>.
- The repo **About** description and **topics** set (see §6).

## 2. Pre-flight

```bash
npm ci
npm run typecheck
npm run build
npm test
npm pack --dry-run     # inspect exactly what would be published
```

The `files` field publishes: `dist`, `docs`, `README.md`, `CONTRIBUTING.md`,
`SECURITY.md`, `LICENSE` (plus `package.json`).

## 3. Release to npm

### Manual

```bash
npm version patch        # or minor / major — updates package.json + git tag
npm publish --access public
git push && git push --tags
```

### Automated (via CI)

`.github/workflows/publish-mcp.yml` runs on any `v*` tag and publishes **both**
the npm package and the MCP Registry entry — with **no npm token**.

npm [retired legacy/automation tokens](https://docs.npmjs.com/about-access-tokens)
in November 2025. The supported CI path is **trusted publishing** (OIDC):

1. On npmjs.com → your package → **Settings → Trusted publishing**, add a
   **GitHub Actions** publisher:
   - **Organization or user:** `williamdoring-prog`
   - **Repository:** `ai-host-optimizer`
   - **Workflow filename:** `publish-mcp.yml` (filename only, with `.yml`)
   - **Allowed actions:** tick **`npm publish`** (and optionally `npm dist-tag`)
2. Nothing else — no secret. `publish-mcp.yml` already has `id-token: write`,
   uses Node 24, and the package's `repository.url` matches the GitHub repo
   (both required).
3. Tag and push:

```bash
npm version patch
git push && git push --tags
```

> **Time limit:** a new trusted publisher must complete its first successful
> publish within **2 days**, or it expires and must be recreated.

npm automatically attaches **provenance** (public repo + public package), so no
`--provenance` flag is needed.

If you prefer tokens anyway, create a **Granular Access Token** (Read and write
for `ai-host-optimizer`, **Bypass 2FA** enabled) and pass it as
`NODE_AUTH_TOKEN` — but trusted publishing is safer and is what the workflow uses.

## 4. Publish to the MCP Registry

The [official MCP Registry](https://registry.modelcontextprotocol.io) hosts
**metadata only**; the npm package must exist first. Ownership is proven by the
`mcpName` field in the *published* `package.json`, which must equal the `name` in
`server.json`:

- `package.json` → `"mcpName": "io.github.williamdoring-prog/ai-host-optimizer"`
- `server.json` → `"name": "io.github.williamdoring-prog/ai-host-optimizer"`

The `io.github.<username>/` prefix is required for GitHub-based auth, where
`<username>` is the GitHub account that owns the repo.

### One-off (manual)

```bash
# 1. Install the publisher (see the registry docs for your platform), then:
mcp-publisher validate           # validates server.json against the registry
mcp-publisher login github       # device-code flow in the browser
mcp-publisher publish
```

Verify:

```bash
curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=ai-host-optimizer"
```

### Automated

`publish-mcp.yml` already does this via **GitHub OIDC** (`mcp-publisher login
github-oidc`) — no registry secret is needed, and no npm token either (see §3).

> **Keep `server.json`'s `version` in step with the release.** The workflow
> rewrites it from the tag; for a manual publish, update it by hand (and both the
> top-level `version` and `packages[0].version`).

## 5. Directories (the other layers)

The official registry is live (now `1.3.0`). Now list the server in the community
directories. Each has its own submission flow; the point is to be in **all** of
them.

| Layer | Where | Status / submission |
|---|---|---|
| Official registry | registry.modelcontextprotocol.io | ✅ done (`1.3.0`, `isLatest`) |
| GitHub MCP Registry | GitHub's registry listings | follows the official entry |
| mcp.so | <https://mcp.so/submit> | submit the **GitHub repo URL** |
| Glama | <https://glama.ai/mcp/servers> | "Add MCP server" → GitHub repo URL |
| PulseMCP | pulsemcp.com | ⏸️ submissions paused (per the roadmap) |

### How to submit (manual, ~2 min each)

1. **mcp.so** — open <https://mcp.so/submit>, paste
   `https://github.com/williamdoring-prog/ai-host-optimizer`, and use the
   *one-liner* and *categories* below. It indexes the repo's `server.json`.
2. **Glama** — sign in with GitHub at <https://glama.ai/mcp/servers>, choose
   "Add MCP server", and point it at the repo. Glama builds from the repo; make
   sure the README's install block is the `npx -y ai-host-optimizer --mcp` form.
3. Confirm the official entry resolves before announcing, so "add it to your
   client" works:
   ```bash
   curl "https://registry.modelcontextprotocol.io/v0/servers?search=ai-host-optimizer"
   ```

### Ready-to-paste copy

**Short description** (≤ 100 chars, for registries with a hard limit):

> Profile a host and get an evidence-graded checklist of AI-model optimizations.

**One-liner** (directories):

> An MCP server + CLI that profiles your machine, gives an honest, tier-graded
> checklist of AI-model optimizations, and **measures** whether they actually
> helped — with a noise floor, so a null result is reported as a null result.

**Long description**:

> Most "speed up your local LLM" guides list the same tweaks (Flash Attention,
> KV-cache quant, keep-alive, NUMA) but never say which help on *your* machine.
> AI Host Optimizer profiles the host, presents the checklist with an estimated
> improvement and resource footprint per option, resolves a conflict-free plan,
> and — with consent — applies the selected options by writing only into a
> managed config directory (dry-run by default, reversible, no shell, no
> privilege).
>
> Every estimate carries a confidence tier: **A** measured on your host, **B**
> labelled estimate with a cited method, **C** qualitative. Nothing is presented
> as measured unless it was. `--benchmark` measures decode tokens/second and the
> run-to-run noise floor; `--calibrate` only promotes an option to tier A when
> the change exceeds that floor.
>
> Works on Linux/Windows/macOS, x64 and ARM64, consumer GPUs through DGX and
> datacentre, and is role-aware (a container cannot tune the host kernel; a
> cluster node is advisory-only). Also generates Ansible/Dockerfile/checklist
> from the same registry.

**Categories/tags:** `mcp` `model-context-protocol` `ai` `llm` `optimization`
`performance` `ollama` `llama.cpp` `vllm` `gpu` `kv-cache` `cli` `sysadmin`

**Install:**

```
npx -y ai-host-optimizer --cli
```

**Launch hook:** the benchmark — "measure your host, then see which changes
actually move tokens/second." See `docs/launch.md`.

## 6. GitHub repo page

**About** (Settings → the gear beside "About"):

> Profile a host and get an honest, evidence-graded checklist of AI-model optimizations — MCP server + CLI. Read-only by default. Works from laptops to DGX to datacentre.

**Topics:**

```
mcp  model-context-protocol  ai  llm  optimization  performance  ollama
llama-cpp  vllm  gpu  cuda  rocm  apple-silicon  dgx  kv-cache  typescript
cli  developer-tools  sysadmin
```

## 7. Verify the MCP install path

The client config is:

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

Then call the `profile`, `checklist`, `plan`, `recommend` or `benchmark` tools
(all read-only; every data tool returns structured content plus a text fallback).

## 8. Versioning

Semantic versioning. Breaking changes to the option schema or the CLI are
documented in `CHANGELOG.md`.
