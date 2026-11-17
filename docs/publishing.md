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
the npm package and the MCP Registry entry:

1. Create an npm **Automation** token (bypasses 2FA).
2. Add it as the repo secret `NPM_TOKEN` (Settings → Secrets and variables → Actions).
3. Tag and push:

```bash
npm version patch
git push && git push --tags
```

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
github-oidc`) — no registry secret is needed, only `NPM_TOKEN`.

> **Keep `server.json`'s `version` in step with the release.** The workflow
> rewrites it from the tag; for a manual publish, update it by hand (and both the
> top-level `version` and `packages[0].version`).

## 5. Directories (the other layers)

The official registry is live. Now list the server in the community directories.
Each has its own submission flow; the point is to be in **all** of them.

| Layer | Where | Submission |
|---|---|---|
| Official registry | registry.modelcontextprotocol.io | ✅ done (`@1.1.1`) |
| GitHub MCP Registry | GitHub's registry listings | follows the official entry |
| mcp.so | mcp.so | submit a server (GitHub URL) |
| Glama | glama.ai/mcp/servers | add via GitHub |
| PulseMCP | pulsemcp.com | submit a server |

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

Then call the `profile`, `checklist`, `plan` or `benchmark` tools.

## 8. Versioning

Semantic versioning. Breaking changes to the option schema or the CLI are
documented in `CHANGELOG.md`.
