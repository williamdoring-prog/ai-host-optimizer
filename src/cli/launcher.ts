/**
 * CLI launcher.
 *
 * Interfaces (D-030):
 *   ai-host-optimizer                 interactive prompt
 *   ai-host-optimizer --cli           terminal report (read-only)
 *   ai-host-optimizer --mcp           MCP stdio server
 *   ai-host-optimizer --browser/--desktop   (not yet)
 *
 * Commands:
 *   --list                            list options (read-only)
 *   --recommend                       auto-select a safe conflict-free set
 *   --plan --select <ids>             show a plan
 *   --apply [--yes]                   apply the plan (dry-run unless --yes)
 *   --revert                          undo the last apply
 *   --benchmark [--save-baseline]     measure the host (tier A)
 *   --calibrate --select <ids>        record a MEASURED delta for options
 *   --doctor                          diagnose the environment
 *   --generate ansible|dockerfile|checklist
 *
 * Global: --json for machine-readable output; --role <role>; --force-advisory.
 *
 * All orchestration goes through the engine facade (`src/core/engine.ts`), so
 * consent, advisory-role refusal and containment are enforced in one place.
 */

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createEngine, type Engine } from "../core/engine.js";
import { OPTIONS } from "../registry/options.js";
import { runMcpServer, VERSION } from "../mcp/server.js";
import { ROLES, ROLE_DESCRIPTORS } from "../core/roles.js";
import type { SystemRole } from "../core/types.js";
import { managedDir } from "../core/paths.js";
import { compare, loadBaseline, type BenchmarkProfileId } from "../core/benchmark.js";
import { detectRuntime } from "../core/runtimes.js";
import { loadCalibrations } from "../core/calibration.js";
import { detectConfiguration, isOptimalConfiguration } from "../core/checklist.js";
import { renderChecklist, applyabilityLabel, optimalMessage } from "../render/checklist.js";
import { renderPlan } from "../render/plan.js";

export { ROLES };

export interface CliArgs {
  cli?: boolean;
  browser?: boolean;
  desktop?: boolean;
  mcp?: boolean;
  help?: boolean;
  version?: boolean;
  role?: SystemRole;
  list?: boolean;
  recommend?: boolean;
  doctor?: boolean;
  json?: boolean;
  plan?: boolean;
  apply?: boolean;
  revert?: boolean;
  benchmark?: boolean;
  calibrate?: boolean;
  saveBaseline?: boolean;
  samples?: number;
  profile?: string;
  generate?: string;
  select?: string[];
  yes?: boolean;
  forceAdvisory?: boolean;
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
      case "--list":
        args.list = true;
        break;
      case "--recommend":
        args.recommend = true;
        break;
      case "--doctor":
        args.doctor = true;
        break;
      case "--json":
        args.json = true;
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
      case "--calibrate":
        args.calibrate = true;
        break;
      case "--save-baseline":
        args.saveBaseline = true;
        break;
      case "--samples": {
        const value = Number(argv[i + 1]);
        if (Number.isInteger(value) && value > 0 && value <= 50) args.samples = value;
        i++;
        break;
      }
      case "--profile": {
        const value = argv[i + 1];
        if (value) args.profile = value;
        i++;
        break;
      }
      case "--yes":
      case "-y":
        args.yes = true;
        break;
      case "--force-advisory":
        args.forceAdvisory = true;
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
  ai-host-optimizer --mcp           run as an MCP stdio server
  ai-host-optimizer --browser       browser UI (not yet implemented)
  ai-host-optimizer --desktop       desktop UI (not yet implemented)

Commands:
  --list                            list every option (read-only)
  --recommend                       auto-select a safe, conflict-free set
  --plan                            show a plan for --select <ids>
  --apply [--yes]                   apply the plan (DRY-RUN unless --yes)
  --revert                          undo the last apply
  --benchmark [--save-baseline]     measure the host (tier A)
  --calibrate --select <ids>        record a MEASURED (tier A/A-/N) delta
  --doctor                          diagnose Node, managed dir, runtime, baseline
  --generate <kind>                 ansible | dockerfile | checklist
  --samples <n>                     samples per measurement (default 3, max 50)
  --profile <id>                    decode | prefill | throughput | load

Options:
  --select <id,id,...>              option ids (see --list)
  --role <role>                     set the system role (see below)
  --json                            emit machine-readable JSON where applicable
  --force-advisory                  override the refusal to apply in an advisory role
  --help / --version

Roles:
${ROLES.map((r) => `  ${r.padEnd(13)} - ${ROLE_DESCRIPTORS[r]}`).join("\n")}

Safety: applying writes ONLY into the managed directory
  ${managedDir()}
and is fully reversible with --revert.
`;

function printJson(value: unknown): void {
  stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** Ask the user for the system role. */
export async function promptRole(): Promise<SystemRole | undefined> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    stdout.write("What is this system's role?\n");
    ROLES.forEach((r, i) =>
      stdout.write(`  ${i + 1}) ${r.padEnd(13)} - ${ROLE_DESCRIPTORS[r]}\n`),
    );
    const answer = (await rl.question("> ")).trim();
    const idx = Number(answer) - 1;
    if (Number.isInteger(idx) && idx >= 0 && idx < ROLES.length) return ROLES[idx];
    return ROLES.find((r) => r === answer);
  } finally {
    rl.close();
  }
}

/** --list (read-only; no profiling). */
export function runList(json = false): void {
  if (json) {
    printJson(
      OPTIONS.map((o) => ({
        id: o.id,
        name: o.name,
        applyability: o.applyOp ? "applyable" : "advisory",
        category: o.category,
        risk: o.risk,
        tier: o.expectedImprovement.tier,
        platforms: o.platforms,
        configuration: detectConfiguration(o)?.state ?? "n/a",
      })),
    );
    return;
  }
  stdout.write(`Option registry (${OPTIONS.length} options)\n\n`);
  for (const o of OPTIONS) {
    const state = detectConfiguration(o)?.state;
    const tag = state === "implemented" ? " [implemented]" : state === "partial" ? " [partial]" : "";
    stdout.write(`  ${applyabilityLabel(o)} ${o.id}${tag}\n`);
    stdout.write(`      ${o.name} — ${o.category}, risk ${o.risk}\n`);
  }
}

/** The terminal report: profile + checklist, read-only. */
export async function runCli(engine: Engine, role?: SystemRole, json = false): Promise<void> {
  const profile = await engine.profile(role);
  const items = await engine.checklist(role);
  if (json) {
    printJson({ profile, checklist: items });
    return;
  }
  stdout.write(`${renderChecklist(profile, items, { version: VERSION })}\n`);
}

/** --recommend */
export async function runRecommend(engine: Engine, role: SystemRole, json = false): Promise<void> {
  const plan = await engine.recommend(role);
  if (json) {
    printJson(plan);
    return;
  }
  stdout.write(`${renderPlan(plan, `Recommended plan for the "${role}" role`)}\n\n`);
  if (plan.steps.length) {
    stdout.write(`Apply with: --apply --select ${plan.steps.map((s) => s.option.id).join(",")} [--yes]\n`);
    return;
  }
  // Nothing to recommend: distinguish "ideal configuration in place" from
  // "nothing applyable on this host" so we don't suggest benchmarking a no-op.
  const items = await engine.checklist(role);
  if (isOptimalConfiguration(items)) {
    stdout.write(`${optimalMessage(VERSION)}\n`);
    return;
  }
  stdout.write("No safe, applyable options were found for this host.\n");
}

/** --plan */
export async function runPlan(
  engine: Engine,
  role: SystemRole,
  select: string[],
  json = false,
): Promise<void> {
  const plan = await engine.plan(select, role);
  if (json) {
    printJson(plan);
    return;
  }
  stdout.write(`${renderPlan(plan, `Plan for ${select.length} requested option(s)`)}\n`);
  stdout.write("\nApply with: --apply --select <ids> [--yes]\n");
}

/** --apply */
export async function runApply(
  engine: Engine,
  role: SystemRole,
  select: string[],
  yes: boolean,
  forceAdvisory = false,
): Promise<void> {
  if (select.length === 0) {
    stdout.write("Nothing selected. Use --recommend, or --plan --select <ids>.\n");
    return;
  }
  const plan = await engine.plan(select, role);
  if (plan.steps.length === 0) {
    stdout.write("Nothing to apply (no applicable options).\n");
    for (const r of plan.rejections) stdout.write(`  - ${r.id}: ${r.reason}\n`);
    return;
  }

  let outcome;
  try {
    outcome = await engine.apply(plan, {
      consent: yes,
      dryRun: !yes,
      forceAdvisory,
      role,
    });
  } catch (err) {
    stdout.write(`${(err as Error).message}\n`);
    return;
  }

  const { plan: applyPlan, result } = outcome;
  if (applyPlan.files.length === 0) {
    stdout.write(
      "The selected options have no automated apply operation in this version.\n" +
        "They remain advisory (see --plan). No changes made.\n",
    );
    return;
  }

  stdout.write(`Apply plan (${applyPlan.optionIds.length} option(s)):\n`);
  for (const id of applyPlan.optionIds) stdout.write(`  + ${id}\n`);
  if (Object.keys(applyPlan.envByTarget).length > 0) {
    stdout.write("\nEnvironment to be written (by target runtime):\n");
    for (const target of Object.keys(applyPlan.envByTarget).sort()) {
      stdout.write(`  [${target}]\n`);
      for (const [k, v] of Object.entries(applyPlan.envByTarget[target]!).sort()) {
        stdout.write(`    ${k}=${v}\n`);
      }
    }
  }
  stdout.write(`\nManaged directory: ${managedDir()}\nFiles:\n`);
  for (const f of applyPlan.files) stdout.write(`  ${f.path}\n`);

  stdout.write(
    `\n${result.dryRun ? "DRY-RUN — nothing written." : "Applied."} ` +
      `(${result.written.length} file(s)${result.dryRun ? " would be written" : " written"})\n`,
  );
  if (applyPlan.notes.length > 0) {
    stdout.write("\nManual steps (this tool never escalates privilege):\n");
    for (const n of applyPlan.notes) stdout.write(`${n}\n`);
  }
  if (result.dryRun) {
    stdout.write("\nRe-run with --yes to apply. Undo any time with --revert.\n");
  } else {
    stdout.write(
      `\nActivate (bash/zsh):  source ${managedDir()}/activate.sh\nRevert:  --revert\n`,
    );
  }
}

/** --revert */
export async function runRevert(engine: Engine): Promise<void> {
  const result = await engine.revert();
  if (result.removed.length === 0) {
    stdout.write("Nothing to revert (no recorded apply).\n");
    return;
  }
  stdout.write("Reverted. Removed:\n");
  for (const f of result.removed) stdout.write(`  ${f}\n`);
}

function fmt(n: number | undefined, digits = 2): string {
  return n === undefined ? "n/a" : n.toFixed(digits);
}

/** --benchmark */
export async function runBenchmarkCmd(engine: Engine, args: CliArgs): Promise<void> {
  const profile = (args.profile as BenchmarkProfileId | undefined) ?? undefined;
  stdout.write("Running benchmark (tier A where measurable)…\n");
  const result = await engine.benchmark({
    samples: args.samples,
    profile,
    saveBaseline: args.saveBaseline ?? false,
  });
  if (args.json) {
    printJson(result);
    return;
  }
  stdout.write(`  time     : ${result.timestamp}\n`);
  stdout.write(`  profile  : ${result.profile}\n`);
  if (result.runtime) stdout.write(`  runtime  : ${result.runtime}\n`);
  if (result.model) stdout.write(`  model    : ${result.model}${result.modelDigest ? ` (${result.modelDigest.slice(0, 12)})` : ""}\n`);
  if (result.tokensPerSec !== undefined) stdout.write(`  decode   : ${result.tokensPerSec} tokens/s (median)\n`);
  if (result.promptEvalRate !== undefined) stdout.write(`  prefill  : ${result.promptEvalRate} tokens/s\n`);
  if (result.ttftMs !== undefined) stdout.write(`  ttft     : ${fmt(result.ttftMs, 1)} ms\n`);
  if (result.interTokenMs !== undefined) stdout.write(`  itl      : ${fmt(result.interTokenMs, 2)} ms/token\n`);
  if (result.prefixHitRate !== undefined) stdout.write(`  prefix   : ${(result.prefixHitRate * 100).toFixed(1)}% cache hit\n`);
  if (result.vramMiB !== undefined) stdout.write(`  vram     : ${result.vramMiB} MiB used\n`);
  if (result.loadMs !== undefined) stdout.write(`  load     : ${result.loadMs} ms\n`);
  if (result.totalMs !== undefined) stdout.write(`  latency  : ${result.totalMs} ms\n`);
  if (result.sampleCount !== undefined) stdout.write(`  samples  : ${result.sampleCount}\n`);
  if (result.dispersion) {
    stdout.write(
      `  spread   : IQR ${(result.dispersion.iqr ?? 0).toFixed(3)}, MAD ${(result.dispersion.mad ?? 0).toFixed(3)}\n`,
    );
  }
  if (result.ci) {
    stdout.write(`  ci (95%) : [${fmt(result.ci.low)}, ${fmt(result.ci.high)}] tokens/s\n`);
  }
  stdout.write(`  params   : ${JSON.stringify(result.params)}\n`);
  stdout.write(`  free mem : ${result.memFreeMiB} MiB\n`);
  stdout.write(`  note     : ${result.note}\n`);

  if (args.saveBaseline) {
    stdout.write(`\nBaseline saved (${result.profile} profile).\n`);
    return;
  }
  const baseline = await loadBaseline();
  if (baseline) {
    const cmp = compare(baseline, result);
    stdout.write("\nComparison vs baseline:\n");
    if (cmp.tokensPerSecDelta !== undefined) {
      stdout.write(`  decode  : ${(cmp.tokensPerSecDelta * 100).toFixed(1)}% (positive = faster)\n`);
    }
    if (cmp.latencyDelta !== undefined) {
      stdout.write(`  latency : ${(cmp.latencyDelta * 100).toFixed(1)}% (negative = faster)\n`);
    }
    if (cmp.ci) {
      stdout.write(`  ci (95%) : [${fmt(cmp.ci.low)}, ${fmt(cmp.ci.high)}]\n`);
    } else {
      stdout.write(`  noise   : ±${(cmp.noiseFloor * 100).toFixed(1)}%\n`);
    }
    stdout.write(`  verdict : ${cmp.significant ? "significant (CI excludes zero)" : "not significant"}\n`);
    stdout.write(`  free mem: ${cmp.memFreeDeltaMiB >= 0 ? "+" : ""}${cmp.memFreeDeltaMiB} MiB\n`);
  } else {
    stdout.write("\n(No baseline saved. Run with --save-baseline before applying changes.)\n");
  }
}

/** --calibrate --select <ids> */
export async function runCalibrate(engine: Engine, args: CliArgs): Promise<void> {
  const select = args.select ?? [];
  if (select.length === 0) {
    stdout.write("Usage: --calibrate --select <ids>\n");
    stdout.write("Run `--benchmark --save-baseline` first, then apply + restart, then calibrate.\n");
    return;
  }

  // Do not benchmark options that are already implemented: there is no
  // before/after change to measure against.
  const alreadyImplemented = select.filter((id) => {
    const option = OPTIONS.find((o) => o.id === id);
    return option ? detectConfiguration(option)?.state === "implemented" : false;
  });
  const pending = select.filter((id) => !alreadyImplemented.includes(id));
  if (alreadyImplemented.length) {
    stdout.write(`Skipping already-implemented option(s): ${alreadyImplemented.join(", ")}\n`);
  }
  if (pending.length === 0) {
    stdout.write(
      "Nothing to calibrate: everything selected is already implemented, so there is no " +
        "change to measure.\n",
    );
    return;
  }

  stdout.write("Measuring the current state (tier A)…\n");
  const report = await engine.calibrate(pending, {
    samples: args.samples,
    profile: args.profile as BenchmarkProfileId | undefined,
  });
  if (args.json) {
    printJson(report);
    return;
  }
  if (report.current) {
    stdout.write(`  current : ${report.current.model ?? "?"} ${fmt(report.current.tokensPerSec)} tok/s\n`);
  }
  if (report.comparison) {
    const cmp = report.comparison;
    if (cmp.tokensPerSecDelta !== undefined) {
      stdout.write(`  decode  : ${(cmp.tokensPerSecDelta * 100).toFixed(1)}%\n`);
    }
    if (cmp.ci) stdout.write(`  ci (95%) : [${fmt(cmp.ci.low)}, ${fmt(cmp.ci.high)}]\n`);
    stdout.write(`  verdict : ${cmp.significant ? "significant" : "not significant"}\n`);
  }
  stdout.write(`${report.note}\n`);
  if (report.recorded.length) {
    stdout.write(`Tier: ${report.recorded[0]!.tier}. Future --plan runs will reflect it.\n`);
  }
}

/** --doctor */
export async function runDoctor(engine: Engine, role: SystemRole, json = false): Promise<void> {
  const dir = managedDir();
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

  checks.push({ name: "node", ok: Number(process.versions.node.split(".")[0]) >= 20, detail: `v${process.versions.node}` });
  checks.push({ name: "platform", ok: true, detail: `${process.platform}/${process.arch}` });

  // Managed-dir writability.
  try {
    await mkdir(dir, { recursive: true });
    const probe = join(dir, ".doctor-probe");
    await writeFile(probe, "ok", "utf8");
    await rm(probe, { force: true });
    checks.push({ name: "managed-dir", ok: true, detail: `writable: ${dir}` });
  } catch (err) {
    checks.push({ name: "managed-dir", ok: false, detail: `${dir}: ${(err as Error).message}` });
  }

  // Runtime detection across the supported servers (loopback only).
  const runtime = await detectRuntime();
  checks.push({
    name: "runtime",
    ok: runtime !== undefined,
    detail: runtime
      ? `${runtime.id} at ${runtime.base}`
      : "none detected on loopback (Ollama :11434, llama.cpp :8080, vLLM :8000)",
  });

  const baseline = await loadBaseline();
  checks.push({
    name: "baseline",
    ok: baseline !== undefined,
    detail: baseline ? `saved ${baseline.timestamp} (${baseline.profile ?? "decode"})` : "none — run --benchmark --save-baseline",
  });
  const calibrations = await loadCalibrations();
  checks.push({
    name: "calibrations",
    ok: true,
    detail: `${Object.keys(calibrations).length} entr(y/ies)`,
  });

  // Capabilities vs configuration: how many options are already implemented.
  const items = await engine.checklist(role);
  const implemented = items.filter((i) => i.configuration?.state === "implemented").length;
  const partial = items.filter((i) => i.configuration?.state === "partial").length;
  checks.push({
    name: "configuration",
    ok: true,
    detail: isOptimalConfiguration(items)
      ? "optimal — every applicable optimization is already implemented"
      : `${implemented} option(s) already implemented, ${partial} partially set`,
  });

  if (json) {
    printJson({ role, managedDir: dir, checks });
    return;
  }
  stdout.write("Environment diagnostics\n\n");
  for (const c of checks) stdout.write(`  ${c.ok ? "[ok]  " : "[!!]  "}${c.name.padEnd(14)} ${c.detail}\n`);
  stdout.write(
    "\nTo make managed env take effect for Ollama on Linux, install the systemd drop-in\n" +
      "(printed by --apply) and restart: sudo systemctl restart ollama\n",
  );
}

/** --generate */
export function runGenerate(engine: Engine, kind: string, select: string[]): void {
  if (kind !== "ansible" && kind !== "dockerfile" && kind !== "checklist") {
    stdout.write(`Unknown generate kind "${kind}". Use: ansible | dockerfile | checklist\n`);
    return;
  }
  stdout.write(engine.generate(kind, select));
}

/** Interactive launcher prompt. */
export async function runInteractive(engine: Engine, role?: SystemRole): Promise<void> {
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
        await runCli(engine, role);
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
export async function main(argv: string[], engine: Engine = createEngine()): Promise<void> {
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

  const hasCommand =
    args.list || args.recommend || args.doctor || args.plan || args.apply || args.revert ||
    args.benchmark || args.calibrate || args.generate || args.cli;

  // Only prompt for a role when no command was given (keeps scripting non-interactive).
  let role = args.role;
  if (!role && !hasCommand && stdin.isTTY) role = await promptRole();
  if (!role) role = "workstation";

  if (args.list) {
    runList(args.json);
    return;
  }
  if (args.recommend) {
    await runRecommend(engine, role, args.json);
    return;
  }
  if (args.doctor) {
    await runDoctor(engine, role, args.json);
    return;
  }
  if (args.plan) {
    await runPlan(engine, role, args.select ?? [], args.json);
    return;
  }
  if (args.apply) {
    await runApply(engine, role, args.select ?? [], args.yes ?? false, args.forceAdvisory ?? false);
    return;
  }
  if (args.revert) {
    await runRevert(engine);
    return;
  }
  if (args.benchmark) {
    await runBenchmarkCmd(engine, args);
    return;
  }
  if (args.calibrate) {
    await runCalibrate(engine, args);
    return;
  }
  if (args.generate) {
    runGenerate(engine, args.generate, args.select ?? []);
    return;
  }
  if (args.cli) {
    await runCli(engine, role, args.json);
    return;
  }
  if (args.browser || args.desktop) {
    stdout.write(
      "The browser and desktop interfaces are not yet implemented (planned for a later milestone).\nUse --cli, --mcp, or a command (--recommend/--plan/--apply/--benchmark).\n",
    );
    return;
  }

  if (!stdin.isTTY) {
    await runCli(engine, role);
    return;
  }
  await runInteractive(engine, role);
}
