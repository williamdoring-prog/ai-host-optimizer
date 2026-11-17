# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Instead, use GitHub's
[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
(Security → Report a vulnerability) or contact the maintainer directly.

Please include: affected version, a description, reproduction steps, and impact.

## Scope

This project has an unusually narrow attack surface **by design**:

- **M0 is read-only.** The profiler performs no writes, no privilege escalation,
  and installs nothing. It only reads OS/hardware information and runs read-only
  commands (`nvidia-smi`, `lspci`, `ibstat`, `system_profiler`, …).
- **No network access** in M0.
- **No telemetry.** Nothing leaves the host.

### In scope

- Any way the profiler could be made to execute unintended commands or write to
  disk.
- Command-injection via environment variables or command arguments.
- Supply-chain issues in dependencies.

### Out of scope (for now)

- The future applier (M1) and local HTTP server (M4) — these do not exist yet.
  When they land, their threat models (consent, dry-run, reversibility, CSRF /
  DNS-rebinding defence for the loopback server) will be documented here.

## Design commitments for anything that can change the system

Any future capability that modifies the host **must**:

1. be **consent-driven** (per change, not one blanket approval);
2. be **dry-run by default**, showing the resolved change;
3. be **reversible**, with a recorded rollback;
4. be **allow-listed** (no arbitrary shell execution);
5. be **injection-resistant** (the model proposes; the server enforces).

## Supported versions

Pre-1.0: only the latest release is supported.
