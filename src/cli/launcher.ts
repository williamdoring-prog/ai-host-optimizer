/**
 * CLI launcher.
 *
 * Supports direct single-interface launch (D-030):
 *   ai-host-optimizer                 → interactive prompt
 *   ai-host-optimizer --cli           → terminal interface
 *   ai-host-optimizer --browser       → browser UI   (M4 — not in M0)
 *   ai-host-optimizer --desktop       → Tauri window (M4 — not in M0)
 *   ai-host-optimizer --mcp           → MCP stdio server
 *
 * Before profiling, the user may be asked for the SYSTEM ROLE (D-036):
 *   workstation | laptop | sandbox | vm-host | remote-singleton |
 *   cluster-node | container | ci-runner
 *
 * M0 is READ-ONLY: the CLI profiles the host and prints the checklist.
 * It does not modify the system.
 */

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import { profileHost } from "../core/profiler.js";
import { buildChecklist, validateRegistry } from "../core/checklist.js";
import { OPTIONS } from "../registry/options.js";
import { runMcpServer, VERSION } from "../mcp/server.js";
import { ROLES } from "../core/roles.js";
import type { SystemRole } from "../core/types.js";

export { ROLES };

export interface CliArgs {
  cli?: boolean;
  browser?: boolean;
  desktop?: boolean;
  mcp?: boolean;
  help?: boolean;
  version?: boolean;
  role?: SystemRole;
}

function isRole(value: string): value is SystemRole {
  return (ROLES as string[]).includes(value);
}

/** Parse argv into flags. */
export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--cli":
      case "-c":
        args.cli = true;
        break;
      case "--browser":
      case "-b":
        args.browser = true;
        break;
      case "--desktop":
      case "-d":
        args.desktop = true;
        break;
      case "--mcp":
        args.mcp = true;
        break;
      case "--role": {
        const value = argv[i + 1];
        if (value && isRole(value)) args.role = value;
        i++;
        break;
      }
      case "--help":
      case "-h":
        args.help = true;
        break;
      case "--version":
      case "-v":
        args.version = true;
        break;
    }
  }
  return args;
}

const HELP = `ai-host-optimizer v${VERSION}

Profile a host and recommend AI-model optimizations (read-only in M0).

Usage:
  ai-host-optimizer                 interactive prompt
  ai-host-optimizer --cli           terminal interface
  ai-host-optimizer --browser       browser UI (not yet implemented)
  ai-host-optimizer --desktop       desktop UI (not yet implemented)
  ai-host-optimizer --mcp           run as an MCP stdio server
  ai-host-optimizer --role <role>   set the system role (see below)
  ai-host-optimizer --help          this help

Roles: ${ROLES.join(" | ")}

Nothing is applied in M0. Applying changes (with consent) arrives in M1.
`;

/** Ask the user for the system role. */
export async function promptRole(): Promise<SystemRole | undefined> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    stdout.write("What is this system's role?\n");
    ROLES.forEach((r, i) => stdout.write(`  ${i + 1}) ${r}\n`));
    const answer = (await rl.question("> ")).trim();
    const idx = Number(answer) - 1;
    if (Number.isInteger(idx) && idx >= 0 && idx < ROLES.length) {
      return ROLES[idx];
    }
    const byName = ROLES.find((r) => r === answer);
    return byName;
  } finally {
    rl.close();
  }
}

/** The terminal interface: profile + checklist, read-only. */
export async function runCli(role?: SystemRole): Promise<void> {
  const profile = await profileHost(role);
  const items = buildChecklist(profile, OPTIONS);

  stdout.write("Host profile (read-only)\n");
  if (profile.role) stdout.write(`  role     : ${profile.role}\n`);
  stdout.write(
    `  platform : ${profile.platform}${profile.os.distro ? ` (${profile.os.distro})` : ""} — ${profile.os.arch}\n`,
  );
  if (profile.os.isDgxOs) stdout.write(`  dgx      : DGX OS detected\n`);
  stdout.write(`  cpu      : ${profile.cpu.model} (${profile.cpu.cores} cores)\n`);
  stdout.write(
    `  memory   : ${Math.round(profile.memory.totalMiB / 1024)} GiB total, ${Math.round(
      profile.memory.freeMiB / 1024,
    )} GiB free${profile.memory.unified ? " (unified CPU/GPU)" : ""}\n`,
  );
  if (profile.gpu?.length) {
    for (const g of profile.gpu) {
      const mem = g.unifiedMemory
        ? "unified memory"
        : g.vramMiB
          ? `${g.vramMiB} MiB VRAM`
          : "memory unknown";
      stdout.write(`  gpu      : ${g.vendor} ${g.name} (${mem})\n`);
    }
  }
  if (profile.nvidia) {
    const parts: string[] = [];
    if (profile.nvidia.driver) parts.push(`driver ${profile.nvidia.driver}`);
    if (profile.nvidia.cuda) parts.push(`CUDA ${profile.nvidia.cuda}`);
    if (parts.length) stdout.write(`  nvidia   : ${parts.join(", ")}\n`);
  }
  if (profile.cluster) {
    const c = profile.cluster;
    const bits: string[] = [];
    if (c.scheduler && c.scheduler !== "none") bits.push(`scheduler ${c.scheduler}`);
    if (c.gpuCount !== undefined) bits.push(`${c.gpuCount} GPU(s)`);
    if (c.nvlink) bits.push("NVLink");
    if (c.mig) bits.push("MIG");
    if (c.interconnects.length) bits.push(`fabric ${c.interconnects.join(", ")}`);
    if (bits.length) stdout.write(`  cluster  : ${bits.join(", ")}\n`);
  }
  const detected = profile.tooling.filter((t) => t.detected);
  stdout.write(
    `  tooling  : ${detected.length ? detected.map((t) => t.name).join(", ") : "none detected"}\n`,
  );
  stdout.write("\n");

  const advisory = items.some((i) => i.advisoryOnly);
  const roleNote = items.find((i) => i.roleNote)?.roleNote;
  if (roleNote) stdout.write(`NOTE: ${roleNote}\n`);
  if (advisory) stdout.write("NOTE: this role is ADVISORY ONLY — the tool will not apply changes here.\n");
  if (roleNote || advisory) stdout.write("\n");

  stdout.write("Optimization checklist (read-only — nothing is applied)\n\n");
  for (const item of items) {
    const o = item.option;
    const est =
      o.expectedImprovement.estimate !== undefined
        ? `${Math.round(o.expectedImprovement.estimate * 100)}%`
        : "qualitative";
    const mark = item.applicable ? "[ ]" : "[x] n/a";
    stdout.write(`${mark} ${o.name}\n`);
    stdout.write(
      `      improves ${o.expectedImprovement.metric}: ${est} (tier ${o.expectedImprovement.tier})\n`,
    );
    stdout.write(`      risk ${o.risk}; ${o.reversibility}; privilege ${o.requiresPrivilege}\n`);
    if (o.exclusiveGroup) stdout.write(`      one-of group: ${o.exclusiveGroup}\n`);
    if (o.inclusiveGroup) stdout.write(`      stackable: ${o.inclusiveGroup}\n`);
    if (o.conflictsWith.length) stdout.write(`      conflicts: ${o.conflictsWith.join(", ")}\n`);
    if (o.synergizesWith.length) stdout.write(`      synergy: ${o.synergizesWith.join(", ")}\n`);
    if (o.requires.length) stdout.write(`      requires: ${o.requires.join(", ")}\n`);
    if (!item.applicable && item.reason) stdout.write(`      n/a: ${item.reason}\n`);
    stdout.write("\n");
  }

  const problems = validateRegistry(OPTIONS);
  if (problems.length) {
    stdout.write(`WARNING: registry issues:\n- ${problems.join("\n- ")}\n`);
  }
}

/** Interactive launcher prompt. */
export async function runInteractive(role?: SystemRole): Promise<void> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    stdout.write(`ai-host-optimizer v${VERSION}\n\n`);
    stdout.write("Choose an interface:\n");
    stdout.write("  1) Terminal (CLI)\n");
    stdout.write("  2) Browser UI   (not yet implemented)\n");
    stdout.write("  3) Desktop UI   (not yet implemented)\n");
    stdout.write("  4) MCP server\n");
    const answer = (await rl.question("> ")).trim();
    switch (answer) {
      case "1":
        await runCli(role);
        break;
      case "4":
        await runMcpServer();
        break;
      case "2":
      case "3":
        stdout.write("That interface arrives in a later milestone. Use --cli for now.\n");
        break;
      default:
        stdout.write("Unrecognised choice.\n");
    }
  } finally {
    rl.close();
  }
}

/** Dispatch based on parsed args. */
export async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);

  if (args.help) {
    stdout.write(HELP);
    return;
  }
  if (args.version) {
    stdout.write(`${VERSION}\n`);
    return;
  }
  if (args.mcp) {
    await runMcpServer();
    return;
  }

  // Resolve the system role: explicit flag wins; otherwise ask on a TTY.
  let role = args.role;
  if (!role && stdin.isTTY && (args.cli || (!args.browser && !args.desktop))) {
    role = await promptRole();
  }
  if (!role) role = "workstation";

  if (args.cli) {
    await runCli(role);
    return;
  }
  if (args.browser || args.desktop) {
    stdout.write(
      "The browser and desktop interfaces are not yet implemented (planned for a later milestone).\nUse --cli or --mcp.\n",
    );
    return;
  }

  if (!stdin.isTTY) {
    await runCli(role);
    return;
  }
  await runInteractive(role);
}
