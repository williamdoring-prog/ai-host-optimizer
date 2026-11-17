/**
 * CLI launcher.
 *
 * Interfaces (D-030):
 *   ai-host-optimizer                 interactive prompt
 *   ai-host-optimizer --cli           terminal report (read-only)
 *   ai-host-optimizer --browser       browser UI   (M4 — not yet)
 *   ai-host-optimizer --desktop       desktop UI   (M4 — not yet)
 *   ai-host-optimizer --mcp           MCP stdio server
 *
 * Commands:
 *   --plan                            show a plan for --select
 *   --apply [--yes]                   apply the plan (dry-run unless --yes)
 *   --revert                          undo the last apply
 *   --benchmark [--save-baseline]     measure the host (tier A)
 *   --generate ansible|dockerfile|checklist
 *
 * Role (D-036): --role <role>, or an interactive prompt on a TTY.
 */

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import { profileHost } from "../core/profiler.js";
import { buildChecklist, validateRegistry } from "../core/checklist.js";
import { OPTIONS } from "../registry/options.js";
import { runMcpServer, VERSION } from "../mcp/server.js";
import { ROLES } from "../core/roles.js";
import type { SystemRole } from "../core/types.js";
import { buildPlan } from "../core/plan.js";
import { applyPlan, buildApplyPlan, managedDir, revert } from "../core/applier.js";
import { compare, loadBaseline, runBenchmark, saveBaseline } from "../core/benchmark.js";
import {
  generateAnsible,
  generateChecklistMarkdown,
  generateDockerfile,
} from "../core/accessories.js";

export { ROLES };

export interface CliArgs {
  cli?: boolean;
  browser?: boolean;
  desktop?: boolean;
  mcp?: boolean;
  help?: boolean;
  version?: boolean;
  role?: SystemRole;
  plan?: boolean;
  apply?: boolean;
  revert?: boolean;
  benchmark?: boolean;
  saveBaseline?: boolean;
  generate?: string;
  select?: string[];
  yes?: boolean;
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
      case "--plan":
        args.plan = true;
        break;
      case "--apply":
        args.apply = true;
        break;
      case "--revert":
        args.revert = true;
        break;
      case "--benchmark":
        args.benchmark = true;
        break;
      case "--save-baseline":
        args.saveBaseline = true;
        break;
      case "--yes":
      case "-y":
        args.yes = true;
        break;
      case "--role": {
        const value = argv[i + 1];
        if (value && isRole(value)) args.role = value;
        i++;
        break;
      }
      case "--generate": {
        const value = argv[i + 1];
        if (value) args.generate = value;
        i++;
        break;
      }
      case "--select": {
        const value = argv[i + 1];
        if (value) args.select = value.split(",").map((s) => s.trim()).filter(Boolean);
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

Profile a host, plan AI-model optimizations, and (with consent) apply them.

Interfaces:
  ai-host-optimizer                 interactive prompt
  ai-host-optimizer --cli           terminal report (read-only)
  ai-host-optimizer --browser       browser UI (not yet implemented)
  ai-host-optimizer --desktop       desktop UI (not yet implemented)
  ai-host-optimizer --mcp           run as an MCP stdio server

Commands:
  --plan                            show a plan for --select <ids>
  --apply [--yes]                   apply the plan (DRY-RUN unless --yes)
  --revert                          undo the last apply
  --benchmark [--save-baseline]     measure the host (tier A)
  --generate <kind>                 ansible | dockerfile | checklist

Options:
  --select <id,id,...>              option ids (see --cli output)
  --role <role>                     ${ROLES.join(" | ")}
  --help / --version

Safety: applying writes ONLY into the managed directory
  ${managedDir()}
and is fully reversible with --revert.
`;

/** Ask the user for the system role. */
export async function promptRole(): Promise<SystemRole | undefined> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    stdout.write("What is this system's role?\n");
    ROLES.forEach((r, i) => stdout.write(`  ${i + 1}) ${r}\n`));
    const answer = (await rl.question("> ")).trim();
    const idx = Number(answer) - 1;
    if (Number.isInteger(idx) && idx >= 0 && idx < ROLES.length) return ROLES[idx];
    return ROLES.find((r) => r === answer);
  } finally {
    rl.close();
  }
}

/** The terminal report: profile + checklist, read-only. */
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

  const roleNote = items.find((i) => i.roleNote)?.roleNote;
  const advisory = items.some((i) => i.advisoryOnly);
  if (roleNote) stdout.write(`NOTE: ${roleNote}\n`);
  if (advisory) stdout.write("NOTE: this role is ADVISORY ONLY — the tool will not apply changes here.\n");
  if (roleNote || advisory) stdout.write("\n");

  stdout.write("Optimization checklist (read-only)\n\n");
  for (const item of items) {
    const o = item.option;
    const est =
      o.expectedImprovement.estimate !== undefined
        ? `${Math.round(o.expectedImprovement.estimate * 100)}%`
        : "qualitative";
    const mark = item.applicable ? "[ ]" : "[x] n/a";
    stdout.write(`${mark} ${o.name}  (${o.id})\n`);
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
  stdout.write("Next: --plan --select <ids>   then   --apply --select <ids> [--yes]\n");
}

/** --plan */
export async function runPlan(role: SystemRole, select: string[]): Promise<void> {
  const profile = await profileHost(role);
  const plan = buildPlan(select, profile, OPTIONS);

  stdout.write(`Plan for ${select.length} requested option(s)\n\n`);
  if (plan.steps.length === 0) stdout.write("  (no applicable options)\n");
  for (const step of plan.steps) {
    stdout.write(`  + ${step.option.name} (${step.option.id})${step.implicit ? " [prerequisite]" : ""}\n`);
  }
  if (plan.rejections.length) {
    stdout.write("\nRejected:\n");
    for (const r of plan.rejections) stdout.write(`  - ${r.id}: ${r.reason}\n`);
  }
  if (plan.combined) {
    stdout.write(
      `\nCombined estimate: ${Math.round(plan.combined.estimate * 100)}% on "${plan.combined.metric}" (tier ${plan.combined.tier})\n`,
    );
    stdout.write(`  method: ${plan.combined.method}\n`);
  }
  for (const n of plan.notes) stdout.write(`  note: ${n}\n`);
  stdout.write("\nApply with: --apply --select <ids> [--yes]\n");
}

/** --apply */
export async function runApply(role: SystemRole, select: string[], yes: boolean): Promise<void> {
  const profile = await profileHost(role);
  const plan = buildPlan(select, profile, OPTIONS);

  if (plan.steps.length === 0) {
    stdout.write("Nothing to apply (no applicable options).\n");
    if (plan.rejections.length) {
      for (const r of plan.rejections) stdout.write(`  - ${r.id}: ${r.reason}\n`);
    }
    return;
  }

  const ids = plan.steps.map((s) => s.option.id);
  const applyPlanResult = buildApplyPlan(ids, OPTIONS);

  if (Object.keys(applyPlanResult.envVars).length === 0) {
    stdout.write(
      "The selected options have no automated apply operation in this version.\n" +
        "They remain advisory (see --plan). No changes made.\n",
    );
    return;
  }

  stdout.write(`Apply plan (${applyPlanResult.optionIds.length} option(s)):\n`);
  for (const id of applyPlanResult.optionIds) stdout.write(`  + ${id}\n`);
  stdout.write(`\nEnvironment to be written:\n`);
  for (const [k, v] of Object.entries(applyPlanResult.envVars).sort()) {
    stdout.write(`  ${k}=${v}\n`);
  }
  stdout.write(`\nManaged directory: ${managedDir()}\n`);
  stdout.write(`Files:\n`);
  for (const f of applyPlanResult.files) stdout.write(`  ${f.path}\n`);

  const dryRun = !yes;
  const result = await applyPlan(applyPlanResult, dryRun);

  stdout.write(
    `\n${result.dryRun ? "DRY-RUN — nothing written." : "Applied."} ` +
      `(${result.written.length} file(s)${result.dryRun ? " would be written" : " written"})\n`,
  );
  if (result.dryRun) {
    stdout.write("Re-run with --yes to apply. Undo any time with --revert.\n");
  } else {
    stdout.write(
      "Activate (bash/zsh):  source " +
        `${managedDir()}/activate.sh\n` +
        "Revert:  --revert\n",
    );
  }
}

/** --revert */
export async function runRevert(): Promise<void> {
  const result = await revert();
  if (result.removed.length === 0) {
    stdout.write("Nothing to revert (no recorded apply).\n");
    return;
  }
  stdout.write(`Reverted. Removed:\n`);
  for (const f of result.removed) stdout.write(`  ${f}\n`);
}

/** --benchmark */
export async function runBenchmarkCmd(saveAsBaseline: boolean): Promise<void> {
  stdout.write("Running benchmark (tier A where measurable)…\n");
  const result = await runBenchmark();
  stdout.write(`  time     : ${result.timestamp}\n`);
  if (result.model) stdout.write(`  model    : ${result.model}\n`);
  if (result.totalMs !== undefined) stdout.write(`  latency  : ${result.totalMs} ms\n`);
  stdout.write(`  free mem : ${result.memFreeMiB} MiB\n`);
  stdout.write(`  note     : ${result.note}\n`);

  if (saveAsBaseline) {
    const path = await saveBaseline(result);
    stdout.write(`\nBaseline saved: ${path}\n`);
    return;
  }

  const baseline = await loadBaseline();
  if (baseline) {
    const cmp = compare(baseline, result);
    stdout.write("\nComparison vs baseline:\n");
    if (cmp.latencyDelta !== undefined) {
      stdout.write(`  latency : ${(cmp.latencyDelta * 100).toFixed(1)}% (negative = faster)\n`);
    }
    stdout.write(`  free mem: ${cmp.memFreeDeltaMiB >= 0 ? "+" : ""}${cmp.memFreeDeltaMiB} MiB\n`);
  } else {
    stdout.write("\n(No baseline saved. Run with --save-baseline before applying changes.)\n");
  }
}

/** --generate */
export async function runGenerate(kind: string, select: string[]): Promise<void> {
  const byId = new Map(OPTIONS.map((o) => [o.id, o]));
  const selected = (select.length ? select : OPTIONS.map((o) => o.id))
    .map((id) => byId.get(id))
    .filter((o): o is (typeof OPTIONS)[number] => o !== undefined);

  switch (kind) {
    case "ansible":
      stdout.write(generateAnsible(selected));
      break;
    case "dockerfile":
      stdout.write(generateDockerfile(selected));
      break;
    case "checklist":
      stdout.write(generateChecklistMarkdown(selected));
      break;
    default:
      stdout.write(`Unknown generate kind "${kind}". Use: ansible | dockerfile | checklist\n`);
  }
}

/** Interactive launcher prompt. */
export async function runInteractive(role?: SystemRole): Promise<void> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    stdout.write(`ai-host-optimizer v${VERSION}\n\n`);
    stdout.write("Choose an interface:\n");
    stdout.write("  1) Terminal report (CLI)\n");
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
  if (!role && stdin.isTTY && !args.benchmark && !args.generate) {
    role = await promptRole();
  }
  if (!role) role = "workstation";

  if (args.plan) {
    await runPlan(role, args.select ?? []);
    return;
  }
  if (args.apply) {
    await runApply(role, args.select ?? [], args.yes ?? false);
    return;
  }
  if (args.revert) {
    await runRevert();
    return;
  }
  if (args.benchmark) {
    await runBenchmarkCmd(args.saveBaseline ?? false);
    return;
  }
  if (args.generate) {
    await runGenerate(args.generate, args.select ?? []);
    return;
  }
  if (args.cli) {
    await runCli(role);
    return;
  }
  if (args.browser || args.desktop) {
    stdout.write(
      "The browser and desktop interfaces are not yet implemented (planned for a later milestone).\nUse --cli, --mcp, or a command (--plan/--apply/--benchmark).\n",
    );
    return;
  }

  if (!stdin.isTTY) {
    await runCli(role);
    return;
  }
  await runInteractive(role);
}
