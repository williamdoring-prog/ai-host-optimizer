# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Instead, use GitHub's
[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
(Security → Report a vulnerability) or contact the maintainer directly.

Please include: affected version, a description, reproduction steps, and impact.

## Scope

This project has an unusually narrow attack surface **by design**:

- **Profiling and planning are read-only.** The profiler performs no writes, no
  privilege escalation, and installs nothing. It only reads OS/hardware
  information and runs read-only commands (`nvidia-smi`, `lspci`, `ibstat`,
  `system_profiler`, …).
- **The applier writes only inside the managed directory**
  (`~/.config/ai-host-optimizer`, or the platform equivalent), never to system
  files, runs **no shell**, and escalates **no** privilege. It is dry-run by
  default, allow-listed, and fully reversible with `--revert`.
- **The benchmark talks only to a local runtime** (Ollama at `127.0.0.1:11434` by
  default) to measure tokens/second. It does not send data anywhere else.
- **No telemetry.** Nothing leaves the host.

### In scope

- Any way the profiler could be made to execute unintended commands or write to
  disk.
- Any way the applier could write **outside** the managed directory, escape the
  allow-list, or run a shell.
- Command-injection via environment variables or command arguments.
- Supply-chain issues in dependencies.

### Out of scope (for now)

- The browser UI and its loopback HTTP server (M4) — these do not exist yet.
  When they land, their threat model (CSRF / DNS-rebinding defence for the
  loopback server) will be documented here.

## Design commitments for anything that can change the system

Any future capability that modifies the host **must**:

1. be **consent-driven** (per change, not one blanket approval);
2. be **dry-run by default**, showing the resolved change;
3. be **reversible**, with a recorded rollback (pre-existing files are backed up
   and restored on `--revert`);
4. be **allow-listed** (no arbitrary shell execution);
5. be **injection-resistant** (the model proposes; the server enforces; values
   are encoded for the sink they are written to);
6. be **contained** — every path written or deleted is proven, via
   `path.relative`, to lie inside the managed directory;
7. **refuse to run in an advisory role** (`cluster-node`, `ci-runner`) unless an
   explicit `--force-advisory` override is given.

## Supported versions

1.x: only the latest release is supported.
