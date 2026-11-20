import { test } from "node:test";
import assert from "node:assert/strict";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createServer } from "./server.js";
import { createEngine } from "../core/engine.js";
import { OPTIONS } from "../registry/options.js";
import type { HostProfile } from "../core/types.js";

const profile: HostProfile = {
  timestamp: new Date().toISOString(),
  platform: "linux",
  role: "workstation",
  os: { platform: "linux", release: "6.0", arch: "x64" },
  cpu: { model: "test", cores: 8 },
  memory: { totalMiB: 32768, freeMiB: 16384 },
  gpu: [{ vendor: "nvidia", name: "Test GPU", vramMiB: 24576, source: "test" }],
  tooling: [],
};

function fakeEngine() {
  return createEngine({
    options: OPTIONS,
    profileHost: async (role) => ({ ...profile, role }),
    loadCalibrations: async () => ({}),
    managedDir: () => "/tmp/aiho-mcp-test",
    readState: async () => undefined,
    loadHistory: async () => [],
    appendHistory: async () => "path",
    env: {},
  });
}

async function connectedClient(): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = createServer(fakeEngine());
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

test("the MCP surface is read-only and structured", async () => {
  const { client, close } = await connectedClient();
  try {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["benchmark", "checklist", "plan", "profile", "recommend"]);
    // No mutating tool exists on the default server.
    assert.ok(!names.some((n) => /apply|revert|write/.test(n)));
    // Every data tool declares an output schema and a read-only annotation.
    for (const tool of tools) {
      assert.ok(tool.outputSchema, `${tool.name} should declare an outputSchema`);
      assert.equal(tool.annotations?.readOnlyHint, true, `${tool.name} should be read-only`);
    }
  } finally {
    await close();
  }
});

test("checklist returns structured content and a text fallback", async () => {
  const { client, close } = await connectedClient();
  try {
    const res = await client.callTool({ name: "checklist", arguments: {} });
    const structured = res.structuredContent as { items?: unknown[] } | undefined;
    assert.ok(Array.isArray(structured?.items));
    assert.ok((structured?.items?.length ?? 0) > 0);
    // Implementation detail is not exposed to agents.
    const first = (structured?.items?.[0] as { option?: Record<string, unknown> }).option ?? {};
    assert.equal("env" in first, false);
    assert.equal("applyOp" in first, false);
    assert.ok(typeof first["applyable"] === "boolean");
    assert.ok(Array.isArray(res.content));
  } finally {
    await close();
  }
});

test("profile returns structured content", async () => {
  const { client, close } = await connectedClient();
  try {
    const res = await client.callTool({ name: "profile", arguments: {} });
    const structured = res.structuredContent as { profile?: { platform?: string } } | undefined;
    assert.equal(structured?.profile?.platform, "linux");
    assert.ok(res.isError !== true);
  } finally {
    await close();
  }
});

test("plan returns structured content for valid ids", async () => {
  const { client, close } = await connectedClient();
  try {
    const res = await client.callTool({
      name: "plan",
      arguments: { select: ["flash-attention"] },
    });
    const structured = res.structuredContent as { plan?: { steps?: unknown[] } } | undefined;
    assert.ok(Array.isArray(structured?.plan?.steps));
  } finally {
    await close();
  }
});

test("plan rejects an over-long selection (input bounds)", async () => {
  const { client, close } = await connectedClient();
  try {
    const select = Array.from({ length: 40 }, () => "flash-attention");
    let failed = false;
    try {
      const res = await client.callTool({ name: "plan", arguments: { select } });
      failed = res.isError === true;
    } catch {
      failed = true;
    }
    assert.ok(failed, "a selection over the cap should be rejected");
  } finally {
    await close();
  }
});

test("the server exposes the registry, docs and host artifacts as resources", async () => {
  const { client, close } = await connectedClient();
  try {
    const { resources } = await client.listResources();
    const uris = resources.map((r) => r.uri);
    assert.ok(uris.includes("aiho://registry/options"));
    assert.ok(uris.includes("aiho://host/profile"));
    assert.ok(uris.includes("aiho://host/checklist"));
    assert.ok(uris.some((u) => u.startsWith("aiho://docs/")));

    const reg = await client.readResource({ uri: "aiho://registry/options" });
    const text = (reg.contents[0] as { text: string }).text;
    const parsed = JSON.parse(text) as unknown[];
    assert.ok(Array.isArray(parsed) && parsed.length > 0);
  } finally {
    await close();
  }
});

test("the server exposes prompts for the common workflows", async () => {
  const { client, close } = await connectedClient();
  try {
    const { prompts } = await client.listPrompts();
    const names = prompts.map((p) => p.name);
    assert.ok(names.includes("optimize_local_ai_host"));
    assert.ok(names.includes("explain_option"));
    assert.ok(names.includes("interpret_benchmark"));

    const explained = await client.getPrompt({
      name: "explain_option",
      arguments: { id: "kv-cache-quant-q8" },
    });
    assert.equal(explained.messages[0]?.role, "user");
  } finally {
    await close();
  }
});
