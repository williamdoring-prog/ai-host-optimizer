/**
 * Engine facade (P1).
 *
 * A thin, typed seam over the pure core so every front-end (CLI, MCP, future
 * transports) orchestrates identically and cross-cutting enforcement lives in
 * ONE place: consent, advisory-role refusal, containment, and input bounds.
 *
 * The engine composes existing pure/IO functions; it adds no capability of its
 * own. Dependencies are injectable so the whole surface is unit-testable
 * without profiling a real host or touching the real managed directory.
 */

import { buildChecklist, detectConfiguration, isAdvisoryRole, pendingImprovements } from "./checklist.js";
import { buildPlan, type Plan } from "./plan.js";
import { OPTIONS } from "../registry/options.js";
import { profileHost } from "./profiler.js";
import { managedDir } from "./paths.js";
import {
  loadCalibrations,
  recordCalibration,
  type CalibrationEntry,
} from "./calibration.js";
import {
  compare,
  loadBaseline,
  runBenchmark,
  saveBaseline,
  type BenchmarkComparison,
  type BenchmarkProfileId,
  type BenchmarkResult,
} from "./benchmark.js";
import {
  applyPlan as applyPlanToDisk,
  buildApplyPlan,
  readState as readAppliedState,
  revert as revertDisk,
  type ApplyPlan,
  type ApplyResult,
  type RevertResult,
} from "./applier.js";
import {
  generateAnsible,
  generateChecklistMarkdown,
  generateDockerfile,
} from "./accessories.js";
import type { ChecklistItem, HostProfile, OptimizationOption, Risk, SystemRole } from "./types.js";

export type GenerateKind = "ansible" | "dockerfile" | "checklist";

export interface ApplyOptions {
  /** Explicit consent is required for a real write (not needed for a dry run). */
  consent: boolean;
  /** Default true: preview only. */
  dryRun?: boolean;
  /** Override the advisory-role refusal (documented, deliberate). */
  forceAdvisory?: boolean;
  /** Role used to enforce the advisory gate. */
  role?: SystemRole;
  /** Managed directory override (tests). */
  dir?: string;
}

export interface ApplyOutcome {
  plan: ApplyPlan;
  result: ApplyResult;
}

export interface BenchmarkOptions {
  model?: string;
  samples?: number;
  profile?: BenchmarkProfileId;
  /** Persist the result as the comparison baseline. */
  saveBaseline?: boolean;
}

export interface CalibrateOptions {
  model?: string;
  samples?: number;
  profile?: BenchmarkProfileId;
}

export interface CalibrationReport {
  recorded: CalibrationEntry[];
  current?: BenchmarkResult;
  comparison?: BenchmarkComparison;
  note: string;
}

export interface RecommendOptions {
  /** Highest risk to include (default: all). */
  risk?: Risk;
  /** Include advisory-only options (default false: applyable only). */
  includeAdvisory?: boolean;
  /** Cap the number of selected options. */
  limit?: number;
}

/** The injectable dependencies behind the engine (defaults wire the real core). */
export interface EngineDeps {
  options: OptimizationOption[];
  profileHost: (role?: SystemRole) => Promise<HostProfile>;
  loadCalibrations: () => Promise<Record<string, CalibrationEntry>>;
  runBenchmark: (model?: string, samples?: number, profile?: BenchmarkProfileId) => Promise<BenchmarkResult>;
  loadBaseline: () => Promise<BenchmarkResult | undefined>;
  saveBaseline: (result: BenchmarkResult) => Promise<string>;
  recordCalibration: (entry: CalibrationEntry) => Promise<string>;
  applyPlan: (plan: ApplyPlan, dryRun?: boolean, dir?: string) => Promise<ApplyResult>;
  revert: (dir?: string) => Promise<RevertResult>;
  /** Read the tool's own applied state (option ids it has written). */
  readState: () => Promise<{ optionIds: string[] } | undefined>;
  /** The environment used to compare capabilities against configuration. */
  env: Record<string, string | undefined>;
  managedDir: () => string;
}

export interface Engine {
  profile(role?: SystemRole): Promise<HostProfile>;
  checklist(role?: SystemRole): Promise<ChecklistItem[]>;
  plan(ids: string[], role?: SystemRole): Promise<Plan>;
  recommend(role?: SystemRole, opts?: RecommendOptions): Promise<Plan>;
  apply(plan: Plan, opts: ApplyOptions): Promise<ApplyOutcome>;
  revert(dir?: string): Promise<RevertResult>;
  benchmark(opts?: BenchmarkOptions): Promise<BenchmarkResult>;
  calibrate(ids: string[], opts?: CalibrateOptions): Promise<CalibrationReport>;
  generate(kind: GenerateKind, ids: string[]): string;
}

const RISK_RANK: Record<Risk, number> = { low: 0, medium: 1, high: 2 };

/** Default dependencies wired to the real core. */
export function defaultEngineDeps(): EngineDeps {
  return {
    options: OPTIONS,
    profileHost,
    loadCalibrations,
    runBenchmark,
    loadBaseline,
    saveBaseline,
    recordCalibration,
    applyPlan: applyPlanToDisk,
    revert: revertDisk,
    readState: () => readAppliedState(),
    env: process.env,
    managedDir,
  };
}

class EngineImpl implements Engine {
  constructor(private readonly deps: EngineDeps) {}

  async profile(role?: SystemRole): Promise<HostProfile> {
    return this.deps.profileHost(role);
  }

  async checklist(role?: SystemRole): Promise<ChecklistItem[]> {
    const profile = await this.deps.profileHost(role);
    const items = buildChecklist(profile, this.deps.options, this.deps.env);
    // Mark options the tool itself applied (per state.json). A corrupt state
    // file must not break the read-only checklist.
    try {
      const state = await this.deps.readState();
      if (state) {
        const applied = new Set(state.optionIds);
        for (const item of items) if (applied.has(item.option.id)) item.appliedByTool = true;
      }
    } catch {
      // ignore
    }
    return items;
  }

  async plan(ids: string[], role?: SystemRole): Promise<Plan> {
    const profile = await this.deps.profileHost(role);
    const calibrations = await this.deps.loadCalibrations();
    return buildPlan(ids, profile, this.deps.options, calibrations);
  }

  /**
   * Choose a safe, conflict-free set automatically: applyable first, lower risk
   * first, higher estimated value first, pulling applicable prerequisites and
   * never selecting conflicting or exclusive rivals.
   */
  async recommend(role?: SystemRole, opts: RecommendOptions = {}): Promise<Plan> {
    const profile = await this.deps.profileHost(role);
    const calibrations = await this.deps.loadCalibrations();
    // Capabilities vs configuration: recommend only outstanding improvements
    // (not already implemented, and not an exclusive alternative to one).
    const items = buildChecklist(profile, this.deps.options, this.deps.env);
    const applicable = new Map(pendingImprovements(items).map((i) => [i.option.id, i.option]));
    const maxRisk = opts.risk ? RISK_RANK[opts.risk] : 2;

    const candidates = [...applicable.values()]
      .filter((o) => (opts.includeAdvisory ? true : o.applyOp !== undefined))
      .filter((o) => RISK_RANK[o.risk] <= maxRisk)
      .sort((a, b) => {
        const applyable = (a.applyOp ? 0 : 1) - (b.applyOp ? 0 : 1);
        if (applyable !== 0) return applyable;
        const risk = RISK_RANK[a.risk] - RISK_RANK[b.risk];
        if (risk !== 0) return risk;
        const est = (b.expectedImprovement.estimate ?? 0) - (a.expectedImprovement.estimate ?? 0);
        if (est !== 0) return est;
        return a.id.localeCompare(b.id);
      });

    const chosen = new Set<string>();
    const chosenList: OptimizationOption[] = [];
    const add = (o: OptimizationOption) => {
      if (chosen.has(o.id)) return;
      chosen.add(o.id);
      chosenList.push(o);
    };
    const conflicts = (o: OptimizationOption) =>
      o.conflictsWith.some((c) => chosen.has(c)) ||
      chosenList.some((c) => c.conflictsWith.includes(o.id));
    const exclusiveRival = (o: OptimizationOption) =>
      o.exclusiveGroup !== undefined &&
      chosenList.some((c) => c.exclusiveGroup === o.exclusiveGroup);

    for (const option of candidates) {
      if (chosen.has(option.id)) continue;
      if (conflicts(option) || exclusiveRival(option)) continue;
      const prereqs = option.requires
        .map((id) => applicable.get(id))
        .filter((o): o is OptimizationOption => o !== undefined);
      if (prereqs.some((p) => conflicts(p) || exclusiveRival(p))) continue;
      for (const p of prereqs) add(p);
      add(option);
      if (opts.limit !== undefined && chosenList.length >= opts.limit) break;
    }

    return buildPlan(
      chosenList.map((o) => o.id),
      profile,
      this.deps.options,
      calibrations,
    );
  }

  async apply(plan: Plan, opts: ApplyOptions): Promise<ApplyOutcome> {
    if (opts.role && isAdvisoryRole(opts.role) && !opts.forceAdvisory) {
      throw new Error(
        `refusing to apply: the "${opts.role}" role is advisory only (pass forceAdvisory to override)`,
      );
    }
    const dryRun = opts.dryRun ?? true;
    if (!dryRun && !opts.consent) {
      throw new Error("refusing to apply without explicit consent (consent: true)");
    }
    const dir = opts.dir ?? this.deps.managedDir();
    const applyPlan = buildApplyPlan(plan, dir);
    const result = await this.deps.applyPlan(applyPlan, dryRun, dir);
    return { plan: applyPlan, result };
  }

  async revert(dir?: string): Promise<RevertResult> {
    return this.deps.revert(dir);
  }

  async benchmark(opts: BenchmarkOptions = {}): Promise<BenchmarkResult> {
    const result = await this.deps.runBenchmark(opts.model, opts.samples, opts.profile);
    if (opts.saveBaseline) await this.deps.saveBaseline(result);
    return result;
  }

  async calibrate(ids: string[], opts: CalibrateOptions = {}): Promise<CalibrationReport> {
    // Only measure options that are not already implemented: an option already
    // in effect has no before/after change to measure, so benchmarking it would
    // be measuring against a configuration that already contains it.
    const byId = new Map(this.deps.options.map((o) => [o.id, o]));
    const pending = ids.filter((id) => {
      const option = byId.get(id);
      return option ? detectConfiguration(option, this.deps.env)?.state !== "implemented" : true;
    });
    const skipped = ids.filter((id) => !pending.includes(id));
    if (pending.length === 0) {
      return {
        recorded: [],
        note:
          `Nothing to calibrate: ${ids.join(", ")} ` +
          `${ids.length === 1 ? "is" : "are"} already implemented, so there is no ` +
          "before/after change to measure.",
      };
    }

    const baseline = await this.deps.loadBaseline();
    if (!baseline) {
      return {
        recorded: [],
        note: "No baseline. Run a benchmark with saveBaseline before applying, then calibrate.",
      };
    }
    const current = await this.deps.runBenchmark(opts.model, opts.samples, opts.profile);
    const comparison = compare(baseline, current);
    const metric = comparison.tokensPerSecDelta !== undefined ? "decode tokens/s" : "total latency";
    const delta =
      comparison.tokensPerSecDelta ??
      (comparison.latencyDelta !== undefined ? -comparison.latencyDelta : undefined);
    if (delta === undefined) {
      return { recorded: [], current, comparison, note: "No comparable metric; nothing recorded." };
    }

    // Tier the result honestly: A only when the CI excludes zero AND it was
    // reproduced; A- for a significant single-session result; N for a null.
    const tier: CalibrationEntry["tier"] = !comparison.significant
      ? "N"
      : comparison.ci
        ? "A"
        : "A-";
    const recorded: CalibrationEntry[] = [];
    for (const id of pending) {
      const entry: CalibrationEntry = {
        optionId: id,
        metric,
        delta,
        noiseFloor: comparison.noiseFloor,
        significant: comparison.significant,
        tier,
        model: current.model,
        profile: current.profile,
        params: current.params,
        ci: comparison.ci,
        reproduced: tier === "A" ? true : undefined,
        measuredAt: new Date().toISOString(),
        samples: current.sampleCount ?? 1,
        method:
          tier === "N"
            ? "measured null on this host (no change beyond the interval)"
            : `measured on this host (${metric}${comparison.ci ? ", CI excludes zero" : ", single session"})`,
      };
      await this.deps.recordCalibration(entry);
      recorded.push(entry);
    }
    const suffix = skipped.length ? ` (skipped already-implemented: ${skipped.join(", ")})` : "";
    return {
      recorded,
      current,
      comparison,
      note:
        (tier === "N"
          ? "No change beyond the interval; recorded as a persisted null (tier N)."
          : `Recorded tier-${tier} calibration for ${recorded.length} option(s).`) + suffix,
    };
  }

  generate(kind: GenerateKind, ids: string[]): string {
    const byId = new Map(this.deps.options.map((o) => [o.id, o]));
    const selected = (ids.length ? ids : this.deps.options.map((o) => o.id))
      .map((id) => byId.get(id))
      .filter((o): o is OptimizationOption => o !== undefined);
    switch (kind) {
      case "ansible":
        return generateAnsible(selected);
      case "dockerfile":
        return generateDockerfile(selected);
      case "checklist":
        return generateChecklistMarkdown(selected);
    }
  }
}

/** Create an engine, overriding any subset of the default dependencies. */
export function createEngine(overrides: Partial<EngineDeps> = {}): Engine {
  return new EngineImpl({ ...defaultEngineDeps(), ...overrides });
}
