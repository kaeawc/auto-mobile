import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import { ToolRegistry } from "../../src/server/toolRegistry";

/**
 * `ToolRegistry.registerWithServer` registers tools with the SDK for capability
 * and schema advertisement only. Live `tools/call` dispatch is the shared
 * `installToolCallDispatcher` handler (issue #6545), so the SDK's own per-tool
 * dispatch — reached here because nothing replaced it — must refuse to run a
 * tool without that dispatcher's guards.
 */
describe("ToolRegistry.registerWithServer", () => {
  let server: McpServer;
  let client: Client;

  beforeEach(() => {
    ToolRegistry.clearTools();
    server = new McpServer({ name: "register-with-server-test", version: "0.0.1" });
    client = new Client({ name: "register-with-server-client", version: "0.0.1" });
  });

  afterEach(async () => {
    await client.close();
    await server.close();
    ToolRegistry.clearServersForTesting();
    ToolRegistry.clearTools();
  });

  async function connect(): Promise<void> {
    ToolRegistry.registerWithServer(server);
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  }

  test("the SDK per-tool dispatch refuses to run the tool outside the shared dispatcher", async () => {
    let handlerRuns = 0;
    ToolRegistry.register(
      "shadowedTool",
      "A tool whose SDK callback must never dispatch",
      z.object({}),
      async () => {
        handlerRuns += 1;
        return { content: [{ type: "text", text: "ran" }] };
      },
      { supportsProgress: true },
    );
    await connect();

    const result = await client.callTool({ name: "shadowedTool", arguments: {} });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("installToolCallDispatcher");
    expect(handlerRuns).toBe(0);
  });

  test("keeps output schemas internal instead of advertising them through MCP registration", async () => {
    const outputSchema = z.object({ ok: z.boolean() });
    ToolRegistry.register(
      "schemaTool",
      "Tool with a structured result contract",
      z.object({}),
      async () => ({ content: [{ type: "text", text: "ok" }] }),
      { outputSchema: outputSchema },
    );
    await connect();

    const { tools } = await client.listTools();
    const advertised = tools.find((tool) => tool.name === "schemaTool");
    expect(advertised).toBeDefined();
    expect(advertised!.outputSchema).toBeUndefined();
    expect(ToolRegistry.getTool("schemaTool")?.outputSchema).toBe(outputSchema);
  });
});
