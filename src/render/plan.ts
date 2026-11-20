/**
 * Render a resolved `Plan` as text. Shared by the CLI and the MCP text fallback.
 */

import type { Plan } from "../core/plan.js";
import { applyabilityLabel, improvementSummary } from "./checklist.js";

export function renderPlan(plan: Plan, header = "Plan"): string {
  const lines: string[] = [`${header}`, ""];
  if (plan.steps.length === 0) lines.push("  (no applicable options)");
  for (const step of plan.steps) {
    const o = step.option;
    const flags: string[] = [applyabilityLabel(o)];
    if (step.implicit) flags.push("[prerequisite]");
    if (o.expectedImprovement.tier === "A" || o.expectedImprovement.tier === "A-") {
      flags.push("[measured]");
    }
    const est =
      o.expectedImprovement.estimate !== undefined
        ? ` ${Math.round(o.expectedImprovement.estimate * 100)}%`
        : "";
    lines.push(`  + ${o.name} (${o.id}) ${flags.join(" ")}${est}`);
    lines.push(`      ${improvementSummary(o)}`);
  }
  if (plan.rejections.length) {
    lines.push("", "Rejected:");
    for (const r of plan.rejections) lines.push(`  - ${r.id}: ${r.reason}`);
  }
  if (plan.combined) {
    lines.push(
      "",
      `Combined estimate: ${Math.round(plan.combined.estimate * 100)}% on "${plan.combined.metric}" ` +
        `(tier ${plan.combined.tier})`,
      `  method: ${plan.combined.method}`,
    );
  }
  for (const note of plan.notes) lines.push(`  note: ${note}`);
  return lines.join("\n");
}
