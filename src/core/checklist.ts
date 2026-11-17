/**
 * Checklist construction and registry validation.
 *
 * Pure functions over the registry — no I/O, no host modification.
 */

import type {
  ChecklistItem,
  HostProfile,
  OptimizationOption,
  SystemRole,
} from "./types.js";

/** Validate the registry's internal consistency. Returns a list of problems. */
export function validateRegistry(options: OptimizationOption[]): string[] {
  const problems: string[] = [];
  const ids = new Set(options.map((o) => o.id));

  for (const o of options) {
    for (const dep of o.requires) {
      if (!ids.has(dep)) problems.push(`${o.id}: requires unknown option "${dep}"`);
    }
    for (const c of o.conflictsWith) {
      if (!ids.has(c)) problems.push(`${o.id}: conflictsWith unknown option "${c}"`);
      if (c === o.id) problems.push(`${o.id}: conflicts with itself`);
    }
    for (const s of o.synergizesWith) {
      if (!ids.has(s)) problems.push(`${o.id}: synergizesWith unknown option "${s}"`);
    }
    if (o.expectedImprovement.tier === "B" && !o.expectedImprovement.method) {
      problems.push(`${o.id}: tier B estimate requires a method/citation`);
    }
    if (o.expectedImprovement.tier === "B" && o.expectedImprovement.estimate === undefined) {
      problems.push(`${o.id}: tier B estimate requires a numeric estimate`);
    }
  }

  // Exclusive-group sanity: a member should not also be inclusive with its rivals.
  const exclusiveGroups = new Map<string, string[]>();
  for (const o of options) {
    if (o.exclusiveGroup) {
      const arr = exclusiveGroups.get(o.exclusiveGroup) ?? [];
      arr.push(o.id);
      exclusiveGroups.set(o.exclusiveGroup, arr);
    }
  }
  for (const [group, members] of exclusiveGroups) {
    if (members.length < 2) {
      problems.push(`exclusive group "${group}" has fewer than two members`);
    }
  }

  return problems;
}

/** Is an option applicable to the profiled host, given its role? */
export function isApplicable(
  option: OptimizationOption,
  profile: HostProfile,
): { applicable: boolean; reason?: string } {
  if (!option.platforms.includes(profile.platform)) {
    return {
      applicable: false,
      reason: `not supported on ${profile.platform}`,
    };
  }
  if (option.requiresVendor) {
    const vendors = (profile.gpu ?? []).map((g) => g.vendor);
    if (!vendors.includes(option.requiresVendor)) {
      return {
        applicable: false,
        reason: `requires ${option.requiresVendor} hardware`,
      };
    }
  }
  // A container cannot change the host kernel, so privileged host-level options
  // do not apply.
  if (profile.role === "container" && option.requiresPrivilege) {
    return {
      applicable: false,
      reason: "container — cannot change the host kernel",
    };
  }
  return { applicable: true };
}

/** Role-specific advisory note, if any. */
function roleNoteFor(role: SystemRole | undefined): string | undefined {
  switch (role) {
    case "sandbox":
      return "sandbox host — experimentation expected; changes are assumed disposable";
    case "vm-host":
      return "VM host — host-level tuning also affects guests";
    case "server":
      return "server — headless, no local console; use dry-run and rollback";
    case "cluster-node":
      return "cluster node — advisory only; changes go through the scheduler/change control";
    case "ci-runner":
      return "CI runner — advisory only; ephemeral environment";
    case "container":
      return "container — host-kernel changes are out of scope";
    default:
      return undefined;
  }
}

/** Roles where the tool should report but not apply (enterprise/CI governance). */
function isAdvisoryRole(role: SystemRole | undefined): boolean {
  return role === "cluster-node" || role === "ci-runner";
}

/**
 * Build the checklist for a host: each option annotated with applicability and
 * the set of options it conflicts with (so a UI can enforce exclusivity).
 * Role-aware (D-036).
 */
export function buildChecklist(
  profile: HostProfile,
  options: OptimizationOption[],
): ChecklistItem[] {
  const advisory = isAdvisoryRole(profile.role);
  const roleNote = roleNoteFor(profile.role);
  return options.map((option) => {
    const { applicable, reason } = isApplicable(option, profile);
    return {
      option,
      applicable,
      reason,
      blockedBy: [...option.conflictsWith],
      advisoryOnly: advisory || undefined,
      roleNote,
    };
  });
}
