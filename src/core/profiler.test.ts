import { test } from "node:test";
import assert from "node:assert/strict";

import {
  countNumaNodes,
  parseAppleChipsetList,
  parseCgroupCpu,
  parseCgroupMemory,
  parseLspciGpuList,
  parseNvidiaSmiGpuList,
  parseVisibleGpus,
} from "./profiler.js";

test("parseNvidiaSmiGpuList: discrete GPU has numeric VRAM and no unified flag", () => {
  const gpus = parseNvidiaSmiGpuList("NVIDIA GeForce RTX 4090, 24564, 535.104.05");
  assert.equal(gpus.length, 1);
  const gpu = gpus[0]!;
  assert.equal(gpu.vendor, "nvidia");
  assert.equal(gpu.name, "NVIDIA GeForce RTX 4090");
  assert.equal(gpu.vramMiB, 24564);
  assert.equal(gpu.unifiedMemory, undefined);
  assert.equal(gpu.driver, "535.104.05");
  assert.equal(gpu.source, "nvidia-smi");
});

test("parseNvidiaSmiGpuList: unified-memory family is flagged and has no VRAM", () => {
  const gpus = parseNvidiaSmiGpuList("NVIDIA GB10, [N/A], 570.00");
  assert.equal(gpus.length, 1);
  const gpu = gpus[0]!;
  assert.equal(gpu.name, "NVIDIA GB10");
  assert.equal(gpu.unifiedMemory, true);
  assert.equal(gpu.vramMiB, undefined);
});

test("parseNvidiaSmiGpuList: Grace-family name is unified even with numeric memory", () => {
  const gpus = parseNvidiaSmiGpuList("NVIDIA Grace Hopper, 97871, 570.00");
  const gpu = gpus[0]!;
  assert.equal(gpu.unifiedMemory, true);
  assert.equal(gpu.vramMiB, undefined);
});

test("parseNvidiaSmiGpuList: N/A memory on an ordinary GPU is unknown, not unified", () => {
  // Regression: MIG instances and vGPUs report N/A but are NOT unified memory.
  const gpus = parseNvidiaSmiGpuList(
    "NVIDIA A100-SXM4-40GB MIG 1g.5gb, N/A, 535.104.05",
  );
  assert.equal(gpus.length, 1);
  const gpu = gpus[0]!;
  assert.equal(gpu.vramMiB, undefined);
  assert.equal(gpu.unifiedMemory, undefined);
});

test("parseNvidiaSmiGpuList: parses multiple rows", () => {
  const gpus = parseNvidiaSmiGpuList(
    "NVIDIA GeForce RTX 3090, 24576, 535.104.05\nNVIDIA GeForce RTX 3090, 24576, 535.104.05",
  );
  assert.equal(gpus.length, 2);
  assert.equal(gpus[0]!.vramMiB, 24576);
  assert.equal(gpus[1]!.vramMiB, 24576);
});

test("parseLspciGpuList: extracts display controllers and infers vendors", () => {
  const lspci = [
    "00:02.0 VGA compatible controller: Intel Corporation Raptor Lake-P [Iris Xe Graphics]",
    "01:00.0 3D controller: NVIDIA Corporation GA100 [A100 PCIe 40GB]",
    "02:00.0 Ethernet controller: Intel Corporation Ethernet Controller I225-V",
    "03:00.0 Audio device: Intel Corporation Raptor Lake HD Audio",
  ].join("\n");

  const gpus = parseLspciGpuList(lspci);
  assert.equal(gpus.length, 2);
  assert.equal(gpus[0]!.vendor, "intel");
  assert.equal(gpus[0]!.name, "Intel Corporation Raptor Lake-P [Iris Xe Graphics]");
  assert.equal(gpus[0]!.source, "lspci");
  assert.equal(gpus[1]!.vendor, "nvidia");
  assert.equal(gpus[1]!.name, "NVIDIA Corporation GA100 [A100 PCIe 40GB]");
});

test("parseAppleChipsetList: Apple GPU is unified memory", () => {
  const sp = [
    "Graphics/Displays:",
    "    Apple M3 Pro:",
    "      Chipset Model: Apple M3 Pro",
    "      Type: GPU",
    "      Bus: Built-In",
  ].join("\n");

  const gpus = parseAppleChipsetList(sp);
  assert.equal(gpus.length, 1);
  const gpu = gpus[0]!;
  assert.equal(gpu.vendor, "apple");
  assert.equal(gpu.name, "Apple M3 Pro");
  assert.equal(gpu.unifiedMemory, true);
  assert.equal(gpu.source, "system_profiler");
});

test("parseAppleChipsetList: ignores output with no chipset model", () => {
  assert.deepEqual(parseAppleChipsetList("Graphics/Displays:\n  Type: GPU"), []);
});

// --- execution-context parsers ----------------------------------------------

test("parseCgroupMemory: numeric limit converts bytes to MiB", () => {
  assert.equal(parseCgroupMemory("1073741824\n"), 1024);
  assert.equal(parseCgroupMemory("536870912"), 512);
});

test("parseCgroupMemory: max and effectively-unlimited values are no limit", () => {
  assert.equal(parseCgroupMemory("max\n"), undefined);
  assert.equal(parseCgroupMemory("9223372036854771712"), undefined); // 2^63-ish (v1)
  assert.equal(parseCgroupMemory(""), undefined);
});

test("parseCgroupCpu: v2 cpu.max quota/period yields cores", () => {
  assert.equal(parseCgroupCpu("50000 100000"), 0.5);
  assert.equal(parseCgroupCpu("200000 100000"), 2);
});

test("parseCgroupCpu: max quota is unlimited (undefined)", () => {
  assert.equal(parseCgroupCpu("max 100000"), undefined);
  assert.equal(parseCgroupCpu("-1 100000"), undefined); // v1 "unlimited"
});

test("parseVisibleGpus: splits and trims both variables", () => {
  assert.deepEqual(parseVisibleGpus("0,1", undefined), ["0", "1"]);
  assert.deepEqual(parseVisibleGpus(undefined, "0"), ["0"]);
  assert.deepEqual(parseVisibleGpus("0", "1"), ["0", "1"]);
});

test("parseVisibleGpus: explicit empty value means no GPUs visible", () => {
  assert.deepEqual(parseVisibleGpus("", undefined), []);
});

test("parseVisibleGpus: both unset is unknown (undefined)", () => {
  assert.equal(parseVisibleGpus(undefined, undefined), undefined);
});

test("countNumaNodes: counts node entries and ignores other entries", () => {
  assert.equal(countNumaNodes("node0 node1 cpu0 online"), 2);
  assert.equal(countNumaNodes("node0\nnode1\nnode2\n"), 3);
});

test("countNumaNodes: no node entries is undefined", () => {
  assert.equal(countNumaNodes("cpu0 online"), undefined);
  assert.equal(countNumaNodes(""), undefined);
});
