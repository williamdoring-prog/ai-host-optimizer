/**
 * Shared rendering.
 *
 * Front-ends (CLI, MCP) render the same data through these functions so the
 * output cannot drift. Rendering is pure: it takes engine data and returns a
 * string; it never profiles or applies anything.
 */

import type { ChecklistItem, HostProfile, OptimizationOption } from "../core/types.js";

/** `[applyable]` when an option has an automated op, else `[advisory]`. */
export function applyabilityLabel(option: OptimizationOption): string {
  return option.applyOp ? "[applyable]" : "[advisory]";
}

/** A one-line improvement summary, e.g. "decode tokens/s: 50% (tier B)". */
export function improvementSummary(option: OptimizationOption): string {
  const est =
    option.expectedImprovement.estimate !== undefined
      ? `${Math.round(option.expectedImprovement.estimate * 100)}%`
      : "qualitative";
  return `${option.expectedImprovement.metric}: ${est} (tier ${option.expectedImprovement.tier})`;
}

/** Render the host profile block. */
export function renderProfile(profile: HostProfile): string {
  const lines: string[] = ["Host profile (read-only)"];
  if (profile.role) lines.push(`  role     : ${profile.role}`);
  lines.push(
    `  platform : ${profile.platform}${profile.os.distro ? ` (${profile.os.distro})` : ""} — ${profile.os.arch}`,
  );
  if (profile.os.isDgxOs) lines.push("  dgx      : DGX OS detected");
  lines.push(`  cpu      : ${profile.cpu.model} (${profile.cpu.cores} cores)`);
  lines.push(
    `  memory   : ${Math.round(profile.memory.totalMiB / 1024)} GiB total, ` +
      `${Math.round(profile.memory.freeMiB / 1024)} GiB free` +
      `${profile.memory.unified ? " (unified CPU/GPU)" : ""}`,
  );
  for (const g of profile.gpu ?? []) {
    const mem = g.unifiedMemory ? "unified memory" : g.vramMiB ? `${g.vramMiB} MiB VRAM` : "memory unknown";
    lines.push(`  gpu      : ${g.vendor} ${g.name} (${mem})`);
  }
  if (profile.nvidia) {
    const parts: string[] = [];
    if (profile.nvidia.driver) parts.push(`driver ${profile.nvidia.driver}`);
    if (profile.nvidia.cuda) parts.push(`CUDA ${profile.nvidia.cuda}`);
    if (parts.length) lines.push(`  nvidia   : ${parts.join(", ")}`);
  }
  if (profile.cluster) {
    const c = profile.cluster;
    const bits: string[] = [];
    if (c.scheduler && c.scheduler !== "none") bits.push(`scheduler ${c.scheduler}`);
    if (c.gpuCount !== undefined) bits.push(`${c.gpuCount} GPU(s)`);
    if (c.nvlink) bits.push("NVLink");
    if (c.mig) bits.push("MIG");
    if (c.interconnects.length) bits.push(`fabric ${c.interconnects.join(", ")}`);
    if (bits.length) lines.push(`  cluster  : ${bits.join(", ")}`);
  }
  if (profile.context) {
    const x = profile.context;
    const bits: string[] = [];
    if (x.container) bits.push(`container ${x.container}`);
    if (x.wsl) bits.push("WSL");
    if (x.virtualised) bits.push("virtualised");
    if (x.cgroup?.memoryLimitMiB) bits.push(`cgroup mem ≤ ${x.cgroup.memoryLimitMiB} MiB`);
    if (x.cgroup?.cpuQuotaCores) bits.push(`cgroup cpu ≤ ${x.cgroup.cpuQuotaCores} cores`);
    if (x.visibleGpus) bits.push(`visible GPUs: ${x.visibleGpus.length ? x.visibleGpus.join(",") : "none"}`);
    if (x.numaNodes) bits.push(`${x.numaNodes} NUMA node(s)`);
    if (bits.length) lines.push(`  context  : ${bits.join(", ")}`);
  }
  const detected = profile.tooling.filter((t) => t.detected);
  lines.push(
    `  tooling  : ${detected.length ? detected.map((t) => t.name).join(", ") : "none detected"}`,
  );
  return lines.join("\n");
}

/** Render the read-only checklist (profile + options). */
export function renderChecklist(
  profile: HostProfile,
  items: ChecklistItem[],
  opts: { includeProfile?: boolean } = {},
): string {
  const lines: string[] = [];
  if (opts.includeProfile !== false) {
    lines.push(renderProfile(profile), "");
  }
  const roleNote = items.find((i) => i.roleNote)?.roleNote;
  const advisory = items.some((i) => i.advisoryOnly);
  if (roleNote) lines.push(`NOTE: ${roleNote}`);
  if (advisory) lines.push("NOTE: this role is ADVISORY ONLY — the tool will not apply changes here.");
  if (roleNote || advisory) lines.push("");

  lines.push("Optimization checklist (read-only)", "");
  for (const item of items) {
    const o = item.option;
    const mark = item.applicable ? "[ ]" : "[x] n/a";
    lines.push(`${mark} ${applyabilityLabel(o)} ${o.name}  (${o.id})`);
    lines.push(`      improves ${improvementSummary(o)}`);
    lines.push(`      risk ${o.risk}; ${o.reversibility}; privilege ${o.requiresPrivilege}`);
    if (o.exclusiveGroup) lines.push(`      one-of group: ${o.exclusiveGroup}`);
    if (o.inclusiveGroup) lines.push(`      stackable: ${o.inclusiveGroup}`);
    if (o.conflictsWith.length) lines.push(`      conflicts: ${o.conflictsWith.join(", ")}`);
    if (o.synergizesWith.length) lines.push(`      synergy: ${o.synergizesWith.join(", ")}`);
    if (o.requires.length) lines.push(`      requires: ${o.requires.join(", ")}`);
    if (!item.applicable && item.reason) lines.push(`      n/a: ${item.reason}`);
    lines.push("");
  }
  return lines.join("\n");
}
