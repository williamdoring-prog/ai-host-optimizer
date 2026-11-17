/**
 * Plan construction: turn a set of selected option ids into an ordered,
 * conflict-free plan with an honest combined estimate.
 *
 * Pure functions — no I/O, no host modification.
 */

import type {
  HostProfile,
  ImprovementTier,
  OptimizationOption,
} from "./types.js";
import { isApplicable } from "./checklist.js";

export interface PlanStep {
  option: OptimizationOption;
  /** True when the step was pulled in automatically as a prerequisite. */
  implicit?: boolean;
}

export interface Rejection {
  id: string;
  reason: string;
}

export interface CombinedEstimate {
  metric: string;
  /** Combined fractional improvement (0.2 = +20%). */
  estimate: number;
  /** Tier of the combined figure — the weakest contributor's tier. */
  tier: ImprovementTier;
  method: string;
  contributors: number;
}

export interface Plan {
  steps: PlanStep[];
  rejections: Rejection[];
  combined?: CombinedEstimate;
  notes: string[];
}

/** Weakest tier wins: A < B < C in strength, so the combined tier is the max. */
function weakestTier(tiers: ImprovementTier[]): ImprovementTier {
  if (tiers.includes("C")) return "C";
  if (tiers.includes("B")) return "B";
  return "A";
}

/**
 * Combine stackable fractional improvements honestly:
 *   combined = 1 − Π (1 − eᵢ)
 * (percentages compound; they do not sum).
 */
export function combineEstimates(values: number[]): number {
  const product = values.reduce((acc, e) => acc * (1 - e), 1);
  return Math.max(0, Math.min(0.99, 1 - product));
}

/**
 * Build a plan from selected option ids.
 *
 * Rules:
 *  - options must exist and be applicable to the host;
 *  - `requires` are pulled in automatically (marked implicit);
 *  - `conflictsWith` pairs are rejected;
 *  - at most one member of an `exclusiveGroup` is kept (first wins);
 *  - stackable options with numeric estimates are combined multiplicatively.
 */
export function buildPlan(
  selectedIds: string[],
  profile: HostProfile,
  options: OptimizationOption[],
): Plan {
  const byId = new Map(options.map((o) => [o.id, o]));
  const rejections: Rejection[] = [];
  const notes: string[] = [];
  const chosen: OptimizationOption[] = [];
  const chosenIds = new Set<string>();
  const implicitIds = new Set<string>();

  const addOption = (option: OptimizationOption, implicit: boolean) => {
    if (chosenIds.has(option.id)) return;
    chosenIds.add(option.id);
    chosen.push(option);
    if (implicit) {
      implicitIds.add(option.id);
      notes.push(`${option.id} included automatically (prerequisite).`);
    }
  };

  const resolve = (id: string, implicit: boolean): void => {
    if (chosenIds.has(id)) return;
    const option = byId.get(id);
    if (!option) {
      rejections.push({ id, reason: "unknown option id" });
      return;
    }
    const { applicable, reason } = isApplicable(option, profile);
    if (!applicable) {
      rejections.push({ id, reason: reason ?? "not applicable" });
      return;
    }
    // Pull in prerequisites first.
    for (const req of option.requires) resolve(req, true);
    // Reject hard conflicts with anything already chosen.
    const clash = option.conflictsWith.find((c) => chosenIds.has(c));
    if (clash) {
      rejections.push({ id, reason: `conflicts with selected option "${clash}"` });
      return;
    }
    // Enforce exclusive groups (first selected wins).
    if (option.exclusiveGroup) {
      const rival = chosen.find((c) => c.exclusiveGroup === option.exclusiveGroup);
      if (rival) {
        rejections.push({
          id,
          reason: `exclusive with "${rival.id}" (group "${option.exclusiveGroup}")`,
        });
        return;
      }
    }
    addOption(option, implicit);
  };

  for (const id of selectedIds) resolve(id, false);

  // Combined estimate over stackable contributors that carry a number.
  const numeric = chosen.filter((o) => o.expectedImprovement.estimate !== undefined);
  let combined: CombinedEstimate | undefined;
  if (numeric.length > 0) {
    const values = numeric.map((o) => o.expectedImprovement.estimate as number);
    const metrics = new Set(numeric.map((o) => o.expectedImprovement.metric));
    const sameMetric = metrics.size === 1;
    combined = {
      metric: sameMetric ? [...metrics][0] as string : "multiple (see individual estimates)",
      estimate: combineEstimates(values),
      tier: weakestTier(numeric.map((o) => o.expectedImprovement.tier)),
      method: sameMetric
        ? "combined multiplicatively (1 − Π(1 − eᵢ)); weakest contributor's tier"
        : "metrics differ — combined figure is indicative only",
      contributors: numeric.length,
    };
    if (!sameMetric) {
      notes.push("Contributors measure different things; the combined figure is indicative only.");
    }
    if (combined.tier !== "A") {
      notes.push("No on-host measurement (tier A) backs this; treat the combined figure as an estimate.");
    }
  }

  return {
    steps: chosen.map((option) => ({
      option,
      implicit: implicitIds.has(option.id) || undefined,
    })),
    rejections,
    combined,
    notes,
  };
}
