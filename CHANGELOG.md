# Changelog

All notable changes to this project. Format: `YYYY-MM-DD — summary`.

## 0.0.1 — 2026-11-17 — M0 (read-only)

- Initial scaffold.
- **Read-only** host profiler (OS, CPU, memory, GPU, detected local-AI tooling).
- Option registry with the full schema: `resourceCost`, `exclusiveGroup`,
  `inclusiveGroup`/`stackable`, `combine`, `conflictsWith`, `synergizesWith`,
  `requires`, `expectedImprovement` (tier A/B/C).
- Checklist builder + registry validation.
- CLI launcher with direct single-interface flags (`--cli`, `--mcp`, plus
  `--browser`/`--desktop` placeholders) and an interactive prompt.
- MCP stdio server exposing `profile`, `checklist`, `validate-registry`.
- **No applier**: nothing modifies the host. Applying changes (with consent,
  dry-run, rollback) arrives in M1.
