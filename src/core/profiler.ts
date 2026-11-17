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
import { readFile } from "node:fs/promises";
import os from "node:os";

import type {
  ClusterInfo,
  GpuInfo,
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

/** NVIDIA GPUs + driver/CUDA versions. Read-only. */
async function detectNvidia(): Promise<{ gpus: GpuInfo[]; stack: NvidiaStack } | undefined> {
  const gpus: GpuInfo[] = [];
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

  if (query) {
    for (const line of query.split("\n")) {
      const [name, mem, driver] = line.split(",").map((s) => s.trim());
      if (!name) continue;
      // On unified-memory systems (GB10), nvidia-smi reports memory as
      // "Not Supported"/"[N/A]" — so a non-numeric value means unified memory,
      // and we must NOT invent a VRAM figure.
      const numericMem = mem && /^\d+$/.test(mem) ? Number(mem) : undefined;
      const unified = /GB10|GB200|Grace|Spark/i.test(name) || numericMem === undefined;
      gpus.push({
        vendor: "nvidia",
        name,
        vramMiB: unified ? undefined : numericMem,
        unifiedMemory: unified || undefined,
        driver: driver ?? stack.driver,
        source: "nvidia-smi",
      });
    }
  }

  return { gpus, stack };
}

async function detectOtherGpu(): Promise<GpuInfo[]> {
  const gpus: GpuInfo[] = [];

  // Apple Silicon (unified memory).
  if (detectPlatform() === "macos") {
    const brand = await tryRun("sysctl", ["-n", "machdep.cpu.brand_string"]);
    if (brand) {
      gpus.push({ vendor: "apple", name: brand, unifiedMemory: true, source: "sysctl" });
    }
  }

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
function vendorFromName(name: string): string {
  const n = name.toLowerCase();
  if (/nvidia|geforce|quadro|rtx|tesla/.test(n)) return "nvidia";
  if (/amd|radeon|instinct|ryzen/.test(n)) return "amd";
  if (/intel|arc|iris|uhd/.test(n)) return "intel";
  if (/apple/.test(n)) return "apple";
  if (/qualcomm|adreno/.test(n)) return "qualcomm";
  return "unknown";
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
    if (lspci) {
      for (const line of lspci.split("\n")) {
        if (/VGA compatible controller|3D controller|Display controller/i.test(line)) {
          const name = line.replace(/^[0-9a-f:.]+\s+/, "").replace(/^[^:]+:\s*/, "");
          gpus.push({ vendor: vendorFromName(name), name, source: "lspci" });
        }
      }
    }
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
    if (sp) {
      for (const line of sp.split("\n")) {
        const m = /Chipset Model:\s*(.+)$/.exec(line.trim());
        if (m?.[1]) {
          gpus.push({ vendor: vendorFromName(m[1]), name: m[1], source: "system_profiler" });
        }
      }
    }
  }

  return gpus;
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

    // High-speed Ethernet (ConnectX often presents as 100G+ links).
    const links = await tryRun("ip", ["-o", "link", "show"]);
    if (links) {
      for (const line of links.split("\n")) {
        const m = /^\d+:\s+([^:@]+)[@:]/.exec(line.trim());
        const ifname = m?.[1];
        if (ifname && /^(enp|ens|ib|rocep|eth)/.test(ifname) && /connectx|mellanox/i.test(line)) {
          interconnects.push(`eth:${ifname}`);
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
  const osRelease = await detectOsRelease();
  const nvidia = await detectNvidia();
  const otherGpu = nvidia ? [] : await detectOtherGpu();
  const genericGpu = await detectGpusGeneric();
  const cluster = await detectCluster();
  const tooling = await detectTooling();

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
    disk: undefined,
    tooling,
  };
}
