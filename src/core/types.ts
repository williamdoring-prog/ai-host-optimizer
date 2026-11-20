/**
 * Core types for the AI host optimizer.
 *
 * Describes what the tool can *report* and (behind explicit consent) *apply*.
 * The schema is the contract shared by the profiler, planner, applier and the
 * registry, which is the single source of truth for every output.
 */

import type { ApplyOpId } from "./applyops.js";
import type { SystemRole } from "./roles.js";

export type { SystemRole };

/** Platform a capability applies to. */
export type Platform = "linux" | "macos" | "windows";

/** Risk level of an option. */
export type Risk = "low" | "medium" | "high";

/** How an option is undone. */
export type Reversibility =
  | "fully-reversible" // a documented inverse exists
  | "reversible-with-backup" // needs a backup/snapshot first
  | "not-reversible"; // e.g. cache prune — destructive

/**
 * Confidence tier for an improvement estimate (honesty contract).
 *   A  = measured on this host, CI-significant and reproduced;
 *   A- = measured on this host, single session / direction consistent;
 *   B  = labelled estimate with a cited method;
 *   C  = qualitative only;
 *   N  = measured, but no change beyond the interval (a persisted null).
 * B/C must never masquerade as A, and a single-session A- must not be combined.
 */
export type ImprovementTier = "A" | "A-" | "B" | "C" | "N";

/** How a stackable option's estimate combines with others. */
export type CombineModel = "additive" | "multiplicative" | "diminishing";

/** Expected resource footprint of an option. */
export interface ResourceCost {
  /** Relative CPU cost, 0–1 (fraction of one core under load), or undefined if unknown. */
  cpu?: number;
  /** Additional RAM in MiB (negative = frees memory). */
  ramMiB?: number;
  /** Additional disk in MiB. */
  diskMiB?: number;
  /** Additional GPU VRAM in MiB (negative = frees VRAM). */
  gpuMiB?: number;
}

/** An improvement estimate, carrying its own confidence tier. */
export interface ExpectedImprovement {
  /** What is being improved, e.g. "decode tokens/s", "time-to-first-token", "VRAM". */
  metric: string;
  /** Estimated fractional improvement (0.2 = +20%), only when a number is justified. */
  estimate?: number;
  /** Confidence tier for `estimate`. */
  tier: ImprovementTier;
  /** Method or citation backing the estimate (required for tier B). */
  method?: string;
}

/** A single optimization option. */
export interface OptimizationOption {
  id: string;
  name: string;
  description: string;
  category:
    | "runtime"
    | "quantization"
    | "kv-cache"
    | "cache"
    | "memory"
    | "gpu"
    | "cpu"
    | "storage"
    | "provider-cache"
    | "package";

  /** Platforms this option supports. */
  platforms: Platform[];

  /**
   * If set, the option applies only when a GPU from this vendor is present
   * (e.g. "nvidia", "amd", "apple", "intel", "qualcomm").
   */
  requiresVendor?: string;

  /** Does applying this require elevated privileges? */
  requiresPrivilege: boolean;

  risk: Risk;
  reversibility: Reversibility;

  resourceCost: ResourceCost;
  expectedImprovement: ExpectedImprovement;

  /**
   * At most one member of an exclusive group may be selected
   * (genuinely conflicting options).
   */
  exclusiveGroup?: string;

  /**
   * Members of an inclusive group may be selected together because their
   * improvements stack (D-026).
   */
  inclusiveGroup?: string;

  /** How this option's estimate combines when stacked. */
  combine?: CombineModel;

  /** Option ids that must not be applied together with this one. */
  conflictsWith: string[];

  /** Option ids that reinforce this one (preferred combinations). */
  synergizesWith: string[];

  /** Prerequisite option ids. */
  requires: string[];

  /** Allow-listed operation id that would implement this. Absent = advisory only. */
  applyOp?: ApplyOpId;

  /**
   * Environment variables this option contributes to a managed runtime
   * configuration, grouped by **target runtime** (e.g. `ollama`, `llama.cpp`,
   * `huggingface`, `vllm`). The applier writes one file per target inside the
   * managed directory. Values may use `${MANAGED_DIR}`, which the applier
   * resolves to the managed config directory.
   */
  env?: Record<string, Record<string, string>>;

  /** Optional citation for the option's existence/behaviour. */
  source?: string;
}

/** A detected GPU / accelerator. */
export interface GpuInfo {
  vendor: string;
  name: string;
  /** Discrete VRAM in MiB. Absent when memory is unified (e.g. GB10, Apple silicon). */
  vramMiB?: number;
  /** True when the accelerator shares system memory with the CPU. */
  unifiedMemory?: boolean;
  driver?: string;
  source: string;
}

/** Multi-node / fabric / cluster information. */
export interface ClusterInfo {
  /** High-speed interconnect interfaces detected (e.g. ConnectX, InfiniBand). */
  interconnects: string[];
  /** Best-effort node count if a fabric is detected. */
  nodes?: number;
  /** Detected scheduler/orchestration context. */
  scheduler?: "slurm" | "kubernetes" | "runai" | "none";
  /** Number of GPUs detected on this host. */
  gpuCount?: number;
  /** True if NVLink/NVSwitch links were detected. */
  nvlink?: boolean;
  /** True if MIG (Multi-Instance GPU) instances were detected. */
  mig?: boolean;
  notes?: string[];
}

/** NVIDIA software stack versions, when present. */
export interface NvidiaStack {
  driver?: string;
  cuda?: string;
  /** True if this looks like a DGX system (DGX OS or DGX release file). */
  isDgx?: boolean;
}

/**
 * Execution context that changes what is *available* (as opposed to what
 * exists): container/cgroup limits, virtualisation, and GPU visibility.
 */
export interface HostContext {
  /** Container runtime, when running inside one. */
  container?: "docker" | "podman" | "kubernetes" | "unknown";
  /** True under WSL. */
  wsl?: boolean;
  /** Virtualisation detected (hypervisor/VM), when known. */
  virtualised?: boolean;
  /** cgroup v1/v2 resource limits, when present. */
  cgroup?: {
    memoryLimitMiB?: number;
    cpuQuotaCores?: number;
  };
  /** GPU identifiers the runtime is allowed to see (CUDA/NVIDIA_VISIBLE_DEVICES). */
  visibleGpus?: string[];
  /** Number of NUMA nodes detected (Linux). */
  numaNodes?: number;
}

/** The result of profiling a host. Read-only. */
export interface HostProfile {
  timestamp: string;
  platform: Platform;
  /** System role supplied by the user (D-036). */
  role?: SystemRole;
  os: {
    platform: string;
    release: string;
    /** Node/JS architecture, e.g. "x64" or "arm64". */
    arch: string;
    /** Linux distro pretty name from /etc/os-release, when available. */
    distro?: string;
    /** True when DGX OS (or a DGX release file) is detected. */
    isDgxOs?: boolean;
  };
  cpu: {
    model: string;
    cores: number;
  };
  memory: {
    totalMiB: number;
    freeMiB: number;
    /** True when CPU and accelerator share one memory pool. */
    unified?: boolean;
  };
  gpu?: GpuInfo[];
  nvidia?: NvidiaStack;
  cluster?: ClusterInfo;
  /** Container/cgroup/virtualisation/visibility context. */
  context?: HostContext;
  disk?: {
    mount: string;
    freeMiB?: number;
  }[];
  /** Detected local-AI tooling, if any. */
  tooling: {
    name: string;
    version?: string;
    detected: boolean;
  }[];
}

/** A checklist item: an option plus its computed applicability. */
export interface ChecklistItem {
  option: OptimizationOption;
  /** Is this option applicable to the profiled host? */
  applicable: boolean;
  /** Reason when not applicable. */
  reason?: string;
  /** Option ids that conflict with the current (empty) selection. */
  blockedBy: string[];
  /** True when the role requires advisory-only output (e.g. a cluster node). */
  advisoryOnly?: boolean;
  /** A role-specific note to display. */
  roleNote?: string;
}
