# Publishing

How to release `ai-host-optimizer` to npm and finish the GitHub repo page.

## 1. Prerequisites

- An npm account, logged in locally (`npm login`).
- Confirm the package name is available: <https://www.npmjs.com/package/ai-host-optimizer>
  (if taken, rename `name` in `package.json`).
- Set the repo **About** description and **topics** (see §4).

## 2. Pre-flight

```bash
npm ci
npm run typecheck
npm run build
npm test
npm pack --dry-run     # inspect exactly what would be published
```

The `files` field publishes: `dist`, `docs`, `README.md`, `CONTRIBUTING.md`,
`LICENSE` (plus `package.json`). `src/`, `node_modules/` and `dist/` build output
are excluded/included as configured.

## 3. Release

### Manual

```bash
npm version patch        # or minor / major — updates package.json + git tag
npm publish --access public
git push && git push --tags
```

### Automated (via CI)

`.github/workflows/ci.yml` publishes on any `v*` tag:

1. Create an npm **automation** token.
2. Add it as the repo secret `NPM_TOKEN` (Settings → Secrets and variables → Actions).
3. Tag and push:

```bash
npm version patch
git push && git push --tags
```

The workflow runs typecheck → build → test, then `npm publish --provenance`.

## 4. GitHub repo page

**About** (Settings → the gear beside "About"):

> Profile a host and get an honest, evidence-graded checklist of AI-model optimizations — MCP server + CLI. Read-only by default. Works from laptops to DGX to datacentre.

**Topics:**

```
mcp  model-context-protocol  ai  llm  optimization  performance  ollama
llama-cpp  vllm  gpu  cuda  rocm  apple-silicon  dgx  kv-cache  typescript
cli  developer-tools  sysadmin
```

## 5. After publishing — verify the MCP install path

Once on npm, the client config is:

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

Then list it in the MCP registries/directories (official MCP Registry, the GitHub
MCP Registry, and third-party directories). Publish to **all** layers — a single
directory can disappear (Smithery shut down its proxy in 2026).

## 6. Versioning

Semantic versioning. While `0.x`, minor versions may include breaking changes;
document them in `CHANGELOG.md`.
