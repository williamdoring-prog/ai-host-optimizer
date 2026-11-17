/**
 * MCP server (stdio transport).
 *
 * Exposes the read-only M0 surface: `profile` and `checklist`.
 * No tool in this file modifies the host.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { z } from "zod";

import { profileHost } from "../core/profiler.js";
import { buildChecklist, validateRegistry } from "../core/checklist.js";
import { OPTIONS } from "../registry/options.js";
import { ROLE_NAMES, ROLE_DESCRIPTORS } from "../core/roles.js";
import type { SystemRole } from "../core/types.js";

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

/** Render the checklist as a human-readable text block. */
function renderChecklist(
  items: ReturnType<typeof buildChecklist>,
  role?: SystemRole,
): string {
  const lines: string[] = [];
  lines.push("AI host optimization checklist (read-only — nothing is applied)");
  if (role) lines.push(`System role: ${role}`);
  const roleNote = items.find((i) => i.roleNote)?.roleNote;
  if (roleNote) lines.push(`Note: ${roleNote}`);
  if (items.some((i) => i.advisoryOnly)) {
    lines.push("Note: this role is ADVISORY ONLY — no changes will be applied.");
  }
  lines.push("");
  for (const item of items) {
    const o = item.option;
    const tier = o.expectedImprovement.tier;
    const est =
      o.expectedImprovement.estimate !== undefined
        ? `${Math.round(o.expectedImprovement.estimate * 100)}%`
        : "qualitative";
    const status = item.applicable ? "[ ]" : "[x] (n/a)";
    lines.push(`${status} ${o.name}  (${o.id})`);
    lines.push(
      `      improves: ${o.expectedImprovement.metric} — ${est} (tier ${tier})`,
    );
    lines.push(
      `      resource: ${JSON.stringify(o.resourceCost)}  risk: ${o.risk}  reversible: ${o.reversibility}`,
    );
    if (o.exclusiveGroup) lines.push(`      exclusive group: ${o.exclusiveGroup}`);
    if (o.inclusiveGroup) lines.push(`      stackable group: ${o.inclusiveGroup}`);
    if (o.conflictsWith.length) lines.push(`      conflicts with: ${o.conflictsWith.join(", ")}`);
    if (o.synergizesWith.length) lines.push(`      synergizes with: ${o.synergizesWith.join(", ")}`);
    if (o.requires.length) lines.push(`      requires: ${o.requires.join(", ")}`);
    if (!item.applicable && item.reason) lines.push(`      not applicable: ${item.reason}`);
    lines.push("");
  }
  return lines.join("\n");
}

/** Create and configure the MCP server. */
export function createServer(): McpServer {
  const server = new McpServer({
    name: "ai-host-optimizer",
    version: VERSION,
  });

  server.tool(
    "profile",
    "Profile this host (read-only): OS, CPU, memory, GPU and detected local-AI tooling.",
    { role: roleField },
    async ({ role }) => {
      const profile = await profileHost(role);
      return {
        content: [{ type: "text", text: JSON.stringify(profile, null, 2) }],
      };
    },
  );

  server.tool(
    "checklist",
    "Return a checklist of AI optimization options for this host, each with an estimated improvement and resource footprint. Read-only.",
    { role: roleField },
    async ({ role }) => {
      const profile = await profileHost(role);
      const items = buildChecklist(profile, OPTIONS);
      return {
        content: [{ type: "text", text: renderChecklist(items, profile.role) }],
      };
    },
  );

  server.tool(
    "validate-registry",
    "Validate the option registry's internal consistency (development aid).",
    {},
    async () => {
      const problems = validateRegistry(OPTIONS);
      const text =
        problems.length === 0
          ? "Registry is consistent."
          : `Registry problems:\n- ${problems.join("\n- ")}`;
      return { content: [{ type: "text", text }] };
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
