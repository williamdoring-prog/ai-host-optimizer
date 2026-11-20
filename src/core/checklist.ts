/**
 * Checklist construction and registry validation.
 *
 * Pure functions over the registry — no I/O, no host modification. The one
 * filesystem touch is `validateRegistry`'s citation check, which only *reads*
 * to confirm that a path-like `source` actually exists.
 */

import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  ChecklistItem,
  HostProfile,
  OptimizationOption,
  SystemRole,
} from "./types.js";
import { COMBINE_MODELS, isApplyOpId } from "./applyops.js";
import { ENV_NAME_RE, TARGET_NAME_RE } from "./safety.js";
import { findUnencodable } from "../render/encoding.js";

/** Repository root, used to resolve path-like `source` citations. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * A citation is acceptable when it is an http(s) URL, an existing file (absolute
 * or relative to the repo root), or a prose reference with no path component.
 * A dangling path-like citation (e.g. `research/mcp/missing.md`) is rejected.
 */
function isResolvableCitation(source: string): boolean {
  if (/^https?:\/\//i.test(source)) return true;
  const pathLike = /[\\/]/.test(source) || /\.(md|txt|json|html?)$/i.test(source);
  if (!pathLike) return true; // prose citation, e.g. "Ollama documentation"
  const candidate = isAbsolute(source) ? source : resolve(REPO_ROOT, source);
  return existsSync(candidate);
}

/** Detect a cycle in the `requires` graph. Returns a human-readable cycle. */
function findRequiresCycle(options: OptimizationOption[]): string | undefined {
  const byId = new Map(options.map((o) => [o.id, o]));
  const state = new Map<string, "visiting" | "done">();

  const visit = (id: string, trail: string[]): string | undefined => {
    const mark = state.get(id);
    if (mark === "done") return undefined;
    if (mark === "visiting") return [...trail, id].join(" -> ");
    state.set(id, "visiting");
    const option = byId.get(id);
    for (const req of option?.requires ?? []) {
      if (!byId.has(req)) continue; // unknown ids are reported separately
      const cycle = visit(req, [...trail, id]);
      if (cycle) return cycle;
    }
    state.set(id, "done");
    return undefined;
  };

  for (const o of options) {
    const cycle = visit(o.id, []);
    if (cycle) return cycle;
  }
  return undefined;
}

/** Validate the registry's internal consistency. Returns a list of problems. */
export function validateRegistry(options: OptimizationOption[]): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();

  for (const o of options) {
    if (ids.has(o.id)) problems.push(`${o.id}: duplicate option id`);
    ids.add(o.id);
  }

  for (const o of options) {
    for (const dep of o.requires) {
      if (!ids.has(dep)) problems.push(`${o.id}: requires unknown option "${dep}"`);
      if (dep === o.id) problems.push(`${o.id}: requires itself`);
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
    if (o.combine !== undefined && !(COMBINE_MODELS as readonly string[]).includes(o.combine)) {
      problems.push(`${o.id}: invalid combine model "${o.combine}"`);
    }

    // The apply-op allow-list is typed, but the registry is data — verify it.
    if (o.applyOp !== undefined && !isApplyOpId(o.applyOp)) {
      problems.push(`${o.id}: unknown applyOp "${o.applyOp}"`);
    }
    const envTargets = Object.keys(o.env ?? {});
    const envLikeOp = o.applyOp === "env" || o.applyOp === "size";
    if (envLikeOp && envTargets.length === 0) {
      problems.push(`${o.id}: applyOp "${o.applyOp}" but no env variables declared`);
    }
    if (envTargets.length > 0 && !envLikeOp) {
      problems.push(`${o.id}: declares env variables but applyOp is not "env" or "size"`);
    }
    if (o.applyOp === "size") {
      problems.push(...validateSizeGuard(o));
    } else if (o.size) {
      problems.push(`${o.id}: declares a size guard but applyOp is not "size"`);
    }
    for (const [target, vars] of Object.entries(o.env ?? {})) {
      if (!TARGET_NAME_RE.test(target)) {
        problems.push(`${o.id}: invalid env target name "${target}"`);
      }
      for (const [name, value] of Object.entries(vars)) {
        if (!ENV_NAME_RE.test(name)) {
          problems.push(`${o.id}: invalid env variable name "${name}"`);
        }
        const bad = findUnencodable(value);
        if (bad) problems.push(`${o.id}: env ${name} ${bad}`);
      }
    }

    if (o.source && !isResolvableCitation(o.source)) {
      problems.push(`${o.id}: source "${o.source}" is neither a URL nor an existing file`);
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

  const cycle = findRequiresCycle(options);
  if (cycle) problems.push(`requires cycle: ${cycle}`);

  return problems;
}

/** Validate a `size` option's numeric guard (never a value worse than default). */
function validateSizeGuard(o: OptimizationOption): string[] {
  const problems: string[] = [];
  const guard = o.size;
  if (!guard) {
    problems.push(`${o.id}: applyOp "size" requires a size guard`);
    return problems;
  }
  if (!Number.isFinite(guard.defaultValue) || guard.defaultValue < 0) {
    problems.push(`${o.id}: size.defaultValue must be a non-negative number`);
  }
  const vars = Object.entries(o.env ?? {}).flatMap(([target, vars]) =>
    Object.entries(vars).map(([name, value]) => ({ target, name, value })),
  );
  if (vars.length !== 1) {
    problems.push(`${o.id}: applyOp "size" must declare exactly one env variable (found ${vars.length})`);
    return problems;
  }
  const { name, value } = vars[0]!;
  if (!/^\d+$/.test(value)) {
    problems.push(`${o.id}: size value for ${name} must be an integer (got "${value}")`);
    return problems;
  }
  const n = Number(value);
  const direction = guard.direction ?? "higher";
  if (direction === "higher" && !(n > guard.defaultValue)) {
    problems.push(`${o.id}: size ${name}=${n} must exceed the default ${guard.defaultValue}`);
  }
  if (direction === "lower" && !(n < guard.defaultValue)) {
    problems.push(`${o.id}: size ${name}=${n} must be below the default ${guard.defaultValue}`);
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
  // An explicitly empty visibility list means the runtime cannot see any GPU,
  // so no vendor-specific option applies.
  const visibleGpus = profile.context?.visibleGpus;
  if (option.requiresVendor && visibleGpus !== undefined && visibleGpus.length === 0) {
    return {
      applicable: false,
      reason: "no GPU visible to the runtime",
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
  // do not apply. An explicit role wins; otherwise a detected container context
  // is enough to treat the host as a container.
  const inContainer =
    profile.role === "container" ||
    (profile.role === undefined && profile.context?.container !== undefined);
  if (inContainer && option.requiresPrivilege) {
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

/** Roles where the tool must report but not apply (enterprise/CI governance). */
export function isAdvisoryRole(role: SystemRole | undefined): boolean {
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
