/**
 * MCP server (stdio transport).
 *
 * Exposes a READ-ONLY surface: `profile`, `checklist`, `plan`, `benchmark`.
 * No tool in this file modifies the host. Data tools return both
 * `structuredContent` (machine-readable, with an `outputSchema`) and a short
 * text fallback, so agents can compose reliably.
 *
 * Implementation detail (`env`, `applyOp`) is deliberately omitted from the
 * agent-facing option view; agents are told whether an option is `applyable`
 * but are not handed the machinery.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { z } from "zod";

import { createEngine, type Engine } from "../core/engine.js";
import { ROLE_NAMES, ROLE_DESCRIPTORS } from "../core/roles.js";
import { renderChecklist } from "../render/checklist.js";
import { renderPlan } from "../render/plan.js";
import type { ChecklistItem, OptimizationOption } from "../core/types.js";

/** Read the version from package.json (kept in sync automatically). */
function readVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, "..", "..", "package.json"), "utf8")) as {
      version?: string;
    };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const VERSION = readVersion();

const roleField = z
  .enum(ROLE_NAMES)
  .optional()
  .describe(
    "System role; changes which advice applies. One of: " +
      ROLE_NAMES.map((r) => `${r} (${ROLE_DESCRIPTORS[r]})`).join("; ") +
      ".",
  );

/** Input bounds (security): cap counts and lengths so a caller cannot exhaust us. */
const MAX_SELECT = 32;
const MAX_ID_LEN = 64;
const MAX_MODEL_LEN = 128;
const selectField = z
  .array(z.string().min(1).max(MAX_ID_LEN))
  .min(1)
  .max(MAX_SELECT)
  .describe(`Option ids to include (1–${MAX_SELECT}, see the checklist tool).`);
const modelField = z
  .string()
  .max(MAX_MODEL_LEN)
  .optional()
  .describe("Model to measure; defaults to the first local model. Never pulled implicitly.");

/** Agent-facing option view: no `env` / `applyOp` implementation detail. */
function publicOption(o: OptimizationOption): Record<string, unknown> {
  return {
    id: o.id,
    name: o.name,
    description: o.description,
    category: o.category,
    platforms: o.platforms,
    risk: o.risk,
    reversibility: o.reversibility,
    requiresPrivilege: o.requiresPrivilege,
    requiresVendor: o.requiresVendor,
    resourceCost: o.resourceCost,
    expectedImprovement: o.expectedImprovement,
    exclusiveGroup: o.exclusiveGroup,
    inclusiveGroup: o.inclusiveGroup,
    conflictsWith: o.conflictsWith,
    synergizesWith: o.synergizesWith,
    requires: o.requires,
    source: o.source,
    applyable: o.applyOp !== undefined,
  };
}

function publicChecklistItem(item: ChecklistItem): Record<string, unknown> {
  return {
    option: publicOption(item.option),
    applicable: item.applicable,
    reason: item.reason,
    blockedBy: item.blockedBy,
    advisoryOnly: item.advisoryOnly,
    roleNote: item.roleNote,
  };
}

/** Guard against overlapping expensive benchmark calls. */
let benchmarkRunning = false;

/** Create and configure the MCP server. */
export function createServer(engine: Engine = createEngine()): McpServer {
  const server = new McpServer({ name: "ai-host-optimizer", version: VERSION });

  server.registerTool(
    "profile",
    {
      title: "Profile host",
      description: "Profile this host (read-only): OS, CPU, memory, GPU and detected local-AI tooling.",
      inputSchema: { role: roleField },
      outputSchema: { profile: z.record(z.string(), z.unknown()) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ role }) => {
      const profile = await engine.profile(role);
      return {
        content: [{ type: "text", text: JSON.stringify(profile, null, 2) }],
        structuredContent: { profile: profile as unknown as Record<string, unknown> },
      };
    },
  );

  server.registerTool(
    "checklist",
    {
      title: "Optimization checklist",
      description:
        "Return a checklist of AI optimization options for this host, each with an estimated " +
        "improvement, resource footprint and applicability. Read-only.",
      inputSchema: { role: roleField },
      outputSchema: {
        role: z.string().optional(),
        items: z.array(z.record(z.string(), z.unknown())),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ role }) => {
      const profile = await engine.profile(role);
      const items = await engine.checklist(role);
      return {
        content: [{ type: "text", text: renderChecklist(profile, items) }],
        structuredContent: {
          role: profile.role,
          items: items.map(publicChecklistItem),
        },
      };
    },
  );

  server.registerTool(
    "plan",
    {
      title: "Plan options",
      description:
        "Resolve a conflict-free plan for the given option ids, with a combined improvement " +
        "estimate. Where a MEASURED (tier A) calibration exists on this host, it replaces the " +
        "estimate. Read-only — nothing is applied.",
      inputSchema: { select: selectField, role: roleField },
      outputSchema: { plan: z.record(z.string(), z.unknown()) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ select, role }) => {
      const plan = await engine.plan(select, role);
      return {
        content: [{ type: "text", text: renderPlan(plan, "Plan") }],
        structuredContent: { plan: plan as unknown as Record<string, unknown> },
      };
    },
  );

  server.registerTool(
    "recommend",
    {
      title: "Recommend a plan",
      description:
        "Auto-select a safe, conflict-free set of applyable options for this host and return the " +
        "resulting plan. Read-only.",
      inputSchema: { role: roleField },
      outputSchema: { plan: z.record(z.string(), z.unknown()) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ role }) => {
      const plan = await engine.recommend(role);
      return {
        content: [{ type: "text", text: renderPlan(plan, "Recommended plan") }],
        structuredContent: { plan: plan as unknown as Record<string, unknown> },
      };
    },
  );

  server.registerTool(
    "benchmark",
    {
      title: "Benchmark host",
      description:
        "Measure this host's local inference rate (tier A evidence): decode tokens/second, prefill, " +
        "TTFT, inter-token latency and the run-to-run interval. Loads a model, so it can take a " +
        "minute or more. Read-only (no host changes, no implicit model pulls).",
      inputSchema: {
        model: modelField,
        samples: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("Samples per measurement (default 3). More samples = tighter interval."),
        profile: z
          .enum(["decode", "prefill", "throughput", "load"])
          .optional()
          .describe("Workload profile (default decode)."),
      },
      outputSchema: { benchmark: z.record(z.string(), z.unknown()) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ model, samples, profile }) => {
      if (benchmarkRunning) {
        return {
          content: [{ type: "text", text: "A benchmark is already running; try again shortly." }],
          isError: true,
        };
      }
      benchmarkRunning = true;
      try {
        const result = await engine.benchmark({ model, samples, profile });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: { benchmark: result as unknown as Record<string, unknown> },
        };
      } finally {
        benchmarkRunning = false;
      }
    },
  );

  return server;
}

/** Run the MCP server over stdio. */
export async function runMcpServer(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
