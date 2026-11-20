/**
 * Read-only host profiler.
 *
 * SAFETY: this module must never modify the host. It only reads OS/hardware
 * information and probes for the presence of known tooling. No writes, no
 * privilege escalation, no package installation.
 *
 * DGX Spark / DGX OS aware: detects ARM64, unified memory, the NVIDIA stack,
 * and ConnectX/InfiniBand fabric (for daisy-chained units).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, readdir } from "node:fs/promises";
import os from "node:os";

import type {
  ClusterInfo,
  GpuInfo,
  HostContext,
  HostProfile,
  NvidiaStack,
  Platform,
  SystemRole,
} from "./types.js";

const execFileAsync = promisify(execFile);

/** Detect the platform in our own vocabulary. */
export function detectPlatform(): Platform {
  switch (os.platform()) {
    case "darwin":
      return "macos";
    case "win32":
      return "windows";
    default:
      return "linux";
  }
}

/** Run a command read-only, returning stdout or undefined on any failure. */
async function tryRun(
  file: string,
  args: string[],
  timeoutMs = 3000,
): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(file, args, {
      timeout: timeoutMs,
      windowsHide: true,
    });
    return stdout.trim();
  } catch {
    return undefined;
  }
}

async function readFileSafe(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

/** Parse a simple KEY=VALUE file (e.g. /etc/os-release). */
function parseKeyValue(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m && m[1] && m[2] !== undefined) {
      out[m[1]] = m[2].replace(/^"|"$/g, "");
    }
  }
  return out;
}

interface OsRelease {
  distro?: string;
  isDgxOs?: boolean;
}

async function detectOsRelease(): Promise<OsRelease> {
  if (detectPlatform() !== "linux") return {};
  const result: OsRelease = {};

  const osRelease = await readFileSafe("/etc/os-release");
  if (osRelease) {
    const kv = parseKeyValue(osRelease);
    result.distro = kv["PRETTY_NAME"] ?? kv["NAME"];
    if (/dgx/i.test(`${kv["NAME"] ?? ""} ${kv["ID"] ?? ""} ${kv["ID_LIKE"] ?? ""}`)) {
      result.isDgxOs = true;
    }
  }

  // DGX systems ship a release file.
  const dgxRelease = await readFileSafe("/etc/dgx-release");
  if (dgxRelease) {
    result.isDgxOs = true;
    const kv = parseKeyValue(dgxRelease);
    const version = kv["DGX_SWBUILD_VERSION"];
    if (!result.distro && version) {
      result.distro = `DGX OS ${version}`;
    }
  }

  // DMIDECODE (needs privilege; harmless if it fails). DGX Spark reports
  // system-family "DGX Spark".
  const family = await tryRun("dmidecode", ["--string", "system-family"]);
  if (family && /dgx/i.test(family)) {
    result.isDgxOs = true;
    if (!result.distro) result.distro = family.trim();
  }

  return result;
}

/**
 * Known unified-memory NVIDIA families. Only these share system memory with
 * the CPU; a non-numeric `memory.total` on its own is not evidence of unified
 * memory (MIG instances and vGPUs report `N/A` too).
 */
const UNIFIED_NVIDIA_NAME = /GB10|GB200|GB300|GH200|Grace|Spark/i;

/**
 * Parse `nvidia-smi --query-gpu=name,memory.total,driver_version
 * --format=csv,noheader,nounits` output (one comma-separated row per GPU).
 *
 * A GPU is treated as unified-memory ONLY when its name matches a known
 * unified-memory family. When memory is non-numeric and the name is not such a
 * family, both `vramMiB` and `unifiedMemory` are left undefined (unknown).
 */
export function parseNvidiaSmiGpuList(queryOutput: string): GpuInfo[] {
  const gpus: GpuInfo[] = [];
  for (const line of queryOutput.split("\n")) {
    const [name, mem, driver] = line.split(",").map((s) => s.trim());
    if (!name) continue;
    const numericMem = mem && /^\d+$/.test(mem) ? Number(mem) : undefined;
    const unified = UNIFIED_NVIDIA_NAME.test(name);
    gpus.push({
      vendor: "nvidia",
      name,
      vramMiB: unified ? undefined : numericMem,
      unifiedMemory: unified || undefined,
      driver: driver || undefined,
      source: "nvidia-smi",
    });
  }
  return gpus;
}

/** NVIDIA GPUs + driver/CUDA versions. Read-only. */
async function detectNvidia(): Promise<{ gpus: GpuInfo[]; stack: NvidiaStack } | undefined> {
  const stack: NvidiaStack = {};

  const full = await tryRun("nvidia-smi", []);
  if (!full) return undefined;

  // Driver + CUDA from the nvidia-smi header.
  const driverMatch = /Driver Version:\s*([\d.]+)/.exec(full);
  const cudaMatch = /CUDA Version:\s*([\d.]+)/.exec(full);
  if (driverMatch?.[1]) stack.driver = driverMatch[1];
  if (cudaMatch?.[1]) stack.cuda = cudaMatch[1];

  const query = await tryRun("nvidia-smi", [
    "--query-gpu=name,memory.total,driver_version",
    "--format=csv,noheader,nounits",
  ]);

  const gpus = query ? parseNvidiaSmiGpuList(query) : [];
  for (const gpu of gpus) {
    if (!gpu.driver) gpu.driver = stack.driver;
  }

  return { gpus, stack };
}

async function detectOtherGpu(): Promise<GpuInfo[]> {
  const gpus: GpuInfo[] = [];

  // AMD ROCm.
  if (detectPlatform() === "linux") {
    const rocm = await tryRun("rocm-smi", ["--showproductname"]);
    if (rocm) {
      gpus.push({ vendor: "amd", name: rocm.split("\n")[0] ?? "AMD GPU", source: "rocm-smi" });
    }
  }

  return gpus;
}

/** Infer a vendor from a device name string. */
export function vendorFromName(name: string): string {
  const n = name.toLowerCase();
  if (/nvidia|geforce|quadro|rtx|tesla/.test(n)) return "nvidia";
  if (/amd|radeon|instinct|ryzen/.test(n)) return "amd";
  if (/intel|arc|iris|uhd/.test(n)) return "intel";
  if (/apple/.test(n)) return "apple";
  if (/qualcomm|adreno/.test(n)) return "qualcomm";
  return "unknown";
}

/**
 * Parse `lspci` output for display/3D controllers, extracting the device name
 * and inferring the vendor from it. Non-display lines are ignored.
 */
export function parseLspciGpuList(lspciOutput: string): GpuInfo[] {
  const gpus: GpuInfo[] = [];
  for (const line of lspciOutput.split("\n")) {
    if (!/VGA compatible controller|3D controller|Display controller/i.test(line)) {
      continue;
    }
    const name = line.replace(/^[0-9a-f:.]+\s+/, "").replace(/^[^:]+:\s*/, "");
    gpus.push({ vendor: vendorFromName(name), name, source: "lspci" });
  }
  return gpus;
}

/**
 * Parse `system_profiler SPDisplaysDataType` output for `Chipset Model:` lines.
 * Apple GPUs share system memory, so `unifiedMemory` is set.
 */
export function parseAppleChipsetList(systemProfilerOutput: string): GpuInfo[] {
  const gpus: GpuInfo[] = [];
  for (const line of systemProfilerOutput.split("\n")) {
    const m = /Chipset Model:\s*(.+)$/.exec(line.trim());
    if (m?.[1]) {
      gpus.push({
        vendor: vendorFromName(m[1]),
        name: m[1],
        unifiedMemory: true,
        source: "system_profiler",
      });
    }
  }
  return gpus;
}

/**
 * Best-effort enumeration of display/3D controllers across platforms.
 * Read-only. Used to catch Intel Arc, AMD Radeon, and any GPU not covered by
 * nvidia-smi/rocm-smi.
 */
async function detectGpusGeneric(): Promise<GpuInfo[]> {
  const gpus: GpuInfo[] = [];

  if (detectPlatform() === "linux") {
    const lspci = await tryRun("lspci", []);
    if (lspci) gpus.push(...parseLspciGpuList(lspci));
  } else if (detectPlatform() === "windows") {
    const out = await tryRun("powershell", [
      "-NoProfile",
      "-Command",
      "Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name",
    ]);
    if (out) {
      for (const name of out.split("\n").map((s) => s.trim()).filter(Boolean)) {
        gpus.push({ vendor: vendorFromName(name), name, source: "Win32_VideoController" });
      }
    }
  } else if (detectPlatform() === "macos") {
    const sp = await tryRun("system_profiler", ["SPDisplaysDataType"]);
    if (sp) gpus.push(...parseAppleChipsetList(sp));
  }

  return gpus;
}

// --- execution context (container / cgroup / virtualisation / visibility) ----

/** DMI product-name strings that indicate a virtual machine. */
const VIRTUAL_PRODUCT_RE = /QEMU|KVM|VMware|VirtualBox|Microsoft|Hyper-V|Bochs/i;

/** Values at or above this are treated as "no cgroup limit" (2^60 bytes). */
const CGROUP_NO_LIMIT_BYTES = 2 ** 60;

/**
 * Parse a cgroup memory-limit file (v2 `memory.max`, or v1
 * `memory.limit_in_bytes`) and return the limit in MiB. Returns undefined for
 * `max`, absent/invalid values, and "effectively unlimited" values (>= 2^60).
 */
export function parseCgroupMemory(text: string): number | undefined {
  const trimmed = text.trim();
  if (!trimmed || trimmed === "max") return undefined;
  const bytes = Number(trimmed);
  if (!Number.isFinite(bytes) || bytes < 0 || bytes >= CGROUP_NO_LIMIT_BYTES) {
    return undefined;
  }
  return Math.round(bytes / 1024 / 1024);
}

/**
 * Parse a cgroup v2 `cpu.max` file (`"<quota> <period>"`, either possibly
 * `max`) into a core count (`quota / period`). Returns undefined when the quota
 * is `max`, the period is missing/invalid, or the quota is non-positive (cgroup
 * v1 uses `-1` for "unlimited").
 */
export function parseCgroupCpu(text: string): number | undefined {
  const [quotaRaw, periodRaw] = text.trim().split(/\s+/);
  if (!quotaRaw || quotaRaw === "max") return undefined;
  const quota = Number(quotaRaw);
  const period = periodRaw !== undefined ? Number(periodRaw) : Number.NaN;
  if (!Number.isFinite(quota) || quota <= 0) return undefined;
  if (!Number.isFinite(period) || period <= 0) return undefined;
  return quota / period;
}

/**
 * Union of `CUDA_VISIBLE_DEVICES` and `NVIDIA_VISIBLE_DEVICES`, split on commas
 * and trimmed. Returns undefined when neither variable is set; an explicitly
 * empty value yields `[]` ("no GPUs visible to the runtime").
 */
export function parseVisibleGpus(
  cudaVisible: string | undefined,
  nvidiaVisible: string | undefined,
): string[] | undefined {
  if (cudaVisible === undefined && nvidiaVisible === undefined) return undefined;
  const ids = new Set<string>();
  for (const raw of [cudaVisible, nvidiaVisible]) {
    if (raw === undefined) continue;
    for (const part of raw.split(",")) {
      const id = part.trim();
      if (id) ids.add(id);
    }
  }
  return [...ids];
}

/**
 * Count NUMA nodes in a `/sys/devices/system/node/` directory listing
 * (whitespace/newline separated entries matching `node<digits>`). Returns
 * undefined when there are none.
 */
export function countNumaNodes(listing: string): number | undefined {
  const count = listing.split(/\s+/).filter((entry) => /^node\d+$/.test(entry)).length;
  return count > 0 ? count : undefined;
}

async function readDirSafe(path: string): Promise<string[] | undefined> {
  try {
    return await readdir(path);
  } catch {
    return undefined;
  }
}

/**
 * Detect the execution context: container runtime, WSL, virtualisation, cgroup
 * limits, GPU visibility and NUMA topology. Read-only. Linux-focused; on other
 * platforms only the cheap environment-variable signals are reported.
 */
export async function detectContext(): Promise<HostContext | undefined> {
  const env = process.env;
  const ctx: HostContext = {};

  const visibleGpus = parseVisibleGpus(
    env["CUDA_VISIBLE_DEVICES"],
    env["NVIDIA_VISIBLE_DEVICES"],
  );
  if (visibleGpus !== undefined) ctx.visibleGpus = visibleGpus;

  if (detectPlatform() !== "linux") {
    return Object.keys(ctx).length > 0 ? ctx : undefined;
  }

  // Container runtime. Most specific marker first.
  if ((await readFileSafe("/run/.containerenv")) !== undefined) {
    ctx.container = "podman";
  } else if ((await readFileSafe("/.dockerenv")) !== undefined) {
    ctx.container = "docker";
  } else if (env["KUBERNETES_SERVICE_HOST"]) {
    ctx.container = "kubernetes";
  } else {
    const cgroup = await readFileSafe("/proc/1/cgroup");
    if (cgroup && /docker|kubepods|containerd/i.test(cgroup)) {
      ctx.container = "unknown";
    }
  }

  // WSL.
  const procVersion = await readFileSafe("/proc/version");
  if (procVersion && /microsoft/i.test(procVersion)) ctx.wsl = true;

  // Virtualisation: prefer systemd-detect-virt; fall back to the DMI product
  // name when the command is unavailable. An explicit "none" is authoritative.
  const virt = await tryRun("systemd-detect-virt", []);
  if (virt) {
    if (virt !== "none") ctx.virtualised = true;
  } else {
    const product = await readFileSafe("/sys/class/dmi/id/product_name");
    if (product && VIRTUAL_PRODUCT_RE.test(product)) ctx.virtualised = true;
  }

  // cgroup v2 first, then v1.
  const memoryV2 = await readFileSafe("/sys/fs/cgroup/memory.max");
  const memoryText =
    memoryV2 ?? (await readFileSafe("/sys/fs/cgroup/memory/memory.limit_in_bytes"));
  const memoryLimitMiB = memoryText !== undefined ? parseCgroupMemory(memoryText) : undefined;

  let cpuQuotaCores: number | undefined;
  const cpuV2 = await readFileSafe("/sys/fs/cgroup/cpu.max");
  if (cpuV2 !== undefined) {
    cpuQuotaCores = parseCgroupCpu(cpuV2);
  } else {
    const quota = await readFileSafe("/sys/fs/cgroup/cpu/cpu.cfs_quota_us");
    const period = await readFileSafe("/sys/fs/cgroup/cpu/cpu.cfs_period_us");
    if (quota !== undefined && period !== undefined) {
      cpuQuotaCores = parseCgroupCpu(`${quota.trim()} ${period.trim()}`);
    }
  }
  if (memoryLimitMiB !== undefined || cpuQuotaCores !== undefined) {
    ctx.cgroup = { memoryLimitMiB, cpuQuotaCores };
  }

  // NUMA topology.
  const nodes = await readDirSafe("/sys/devices/system/node/");
  if (nodes) {
    const count = countNumaNodes(nodes.join("\n"));
    if (count !== undefined) ctx.numaNodes = count;
  }

  return Object.keys(ctx).length > 0 ? ctx : undefined;
}

/** Detect high-speed fabric (ConnectX / InfiniBand) and cluster context. */
async function detectCluster(): Promise<ClusterInfo | undefined> {
  const interconnects: string[] = [];
  const notes: string[] = [];

  if (detectPlatform() === "linux") {
    // RDMA devices (ConnectX appears here).
    const ibDevices = await tryRun("ls", ["/sys/class/infiniband"]);
    if (ibDevices) {
      for (const dev of ibDevices.split(/\s+/).filter(Boolean)) {
        interconnects.push(`rdma:${dev}`);
      }
    }

    // Link types (InfiniBand vs Ethernet) when ibstat is available.
    const ibstat = await tryRun("ibstat", ["-l"]);
    if (ibstat) {
      for (const dev of ibstat.split("\n").map((s) => s.trim()).filter(Boolean)) {
        if (!interconnects.includes(`rdma:${dev}`)) interconnects.push(`ib:${dev}`);
      }
    }

    // High-speed fabric controllers (ConnectX/Mellanox/InfiniBand) visible on
    // the PCI bus. Link names alone never carry the vendor, so probe lspci.
    const lspci = await tryRun("lspci", []);
    if (lspci) {
      for (const line of lspci.split("\n")) {
        if (
          /Ethernet controller|Network controller/i.test(line) &&
          /mellanox|connectx|infiniband/i.test(line)
        ) {
          const name = line.replace(/^[0-9a-f:.]+\s+/, "").replace(/^[^:]+:\s*/, "");
          interconnects.push(`pci:${name}`);
        }
      }
    }
  }

  // Scheduler / orchestration context (works on any platform).
  const env = process.env;
  let scheduler: ClusterInfo["scheduler"] = "none";
  if (env["SLURM_JOB_ID"] || env["SLURM_JOBID"]) scheduler = "slurm";
  else if (env["KUBERNETES_SERVICE_HOST"]) scheduler = "kubernetes";
  else if (env["RUNAI_"] || env["RUNAI_JOB_NAME"]) scheduler = "runai";

  // GPU count, NVLink topology, and MIG (NVIDIA only; read-only).
  let gpuCount: number | undefined;
  let nvlink: boolean | undefined;
  let mig: boolean | undefined;

  const list = await tryRun("nvidia-smi", ["-L"]);
  if (list) {
    const lines = list.split("\n").filter((l) => l.trim().length > 0);
    gpuCount = lines.filter((l) => /^GPU \d+/.test(l)).length;
    mig = /MIG/i.test(list);
  }

  const topo = await tryRun("nvidia-smi", ["topo", "-m"]);
  if (topo) {
    nvlink = /\bNV\d+\b/.test(topo);
  }

  if (interconnects.length === 0 && scheduler === "none" && gpuCount === undefined) {
    return undefined;
  }

  if (interconnects.length > 0) {
    notes.push(
      "Fabric detected — daisy-chained/multi-node configurations are possible; node count is not inferred automatically.",
    );
  }
  if (scheduler !== "none") {
    notes.push(
      `Scheduler context detected (${scheduler}); enterprise change-control usually requires advisory output rather than automatic application.`,
    );
  }
  if (mig) notes.push("MIG instances detected — resource budgets are per-instance, not per-GPU.");
  if (nvlink) notes.push("NVLink topology detected.");

  return { interconnects, scheduler, gpuCount, nvlink, mig, notes };
}

async function detectTooling(): Promise<HostProfile["tooling"]> {
  const checks: Array<{ name: string; cmd: string; args: string[] }> = [
    { name: "ollama", cmd: "ollama", args: ["--version"] },
    { name: "llama.cpp", cmd: "llama-cli", args: ["--version"] },
    { name: "vllm", cmd: "vllm", args: ["--version"] },
    { name: "python3", cmd: "python3", args: ["--version"] },
    { name: "docker", cmd: "docker", args: ["--version"] },
    { name: "nvidia-container-toolkit", cmd: "nvidia-ctk", args: ["--version"] },
    { name: "nvcc", cmd: "nvcc", args: ["--version"] },
  ];

  return Promise.all(
    checks.map(async (c) => {
      const out = await tryRun(c.cmd, c.args);
      return {
        name: c.name,
        detected: out !== undefined,
        version: out?.split("\n")[0],
      };
    }),
  );
}

/**
 * Profile the host. Read-only.
 * `role` (D-036) is the user-supplied system role; it affects checklist
 * applicability, not what is profiled.
 */
export async function profileHost(role?: SystemRole): Promise<HostProfile> {
  const platform = detectPlatform();
  const cpus = os.cpus();
  // All probes are read-only and independent; run them concurrently.
  const [osRelease, nvidia, otherGpuAll, genericGpu, cluster, tooling, context] =
    await Promise.all([
      detectOsRelease(),
      detectNvidia(),
      detectOtherGpu(),
      detectGpusGeneric(),
      detectCluster(),
      detectTooling(),
      detectContext(),
    ]);
  const otherGpu = nvidia ? [] : otherGpuAll;

  // Merge GPU lists, de-duplicating by (vendor, name).
  const seen = new Set<string>();
  const gpu: GpuInfo[] = [];
  for (const g of [...(nvidia?.gpus ?? []), ...otherGpu, ...genericGpu]) {
    const key = `${g.vendor}:${g.name}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    gpu.push(g);
  }
  const unified = gpu.some((g) => g.unifiedMemory);

  const nvidiaStack: NvidiaStack | undefined = nvidia
    ? { ...nvidia.stack, isDgx: osRelease.isDgxOs }
    : undefined;

  return {
    timestamp: new Date().toISOString(),
    platform,
    role,
    os: {
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      distro: osRelease.distro,
      isDgxOs: osRelease.isDgxOs,
    },
    cpu: {
      model: cpus[0]?.model ?? "unknown",
      cores: cpus.length,
    },
    memory: {
      totalMiB: Math.round(os.totalmem() / 1024 / 1024),
      freeMiB: Math.round(os.freemem() / 1024 / 1024),
      unified: unified || undefined,
    },
    gpu: gpu.length ? gpu : undefined,
    nvidia: nvidiaStack,
    cluster,
    context,
    disk: undefined,
    tooling,
  };
}
