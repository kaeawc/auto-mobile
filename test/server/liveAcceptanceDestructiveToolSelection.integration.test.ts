import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { registerToolSelectionTools } from "../../src/server/toolSelectionTools";
import { McpTestFixture } from "../fixtures/mcpTestFixture";

/**
 * The acceptance harness uses a fresh client for each destructive operation.
 * Exercise the real MCP dispatch path here: default-disabled destructive tools
 * stay absent from a fresh connection's advertised list, but remain callable.
 */
describe("live acceptance destructive tool selection", () => {
  let provisionCalls = 0;
  let deleteCalls = 0;
  const provisionClient = new McpTestFixture();
  const deleteClient = new McpTestFixture();

  beforeAll(async () => {
    await provisionClient.setup();
    await deleteClient.setup();
    // McpTestFixture registers the repository's normal server tools while
    // setting up. Replace only this test's registry after both fresh clients
    // are connected, so dispatch uses the production availability gate.
    ToolRegistry.clearTools();
    ToolRegistry.register(
      "provisionDevice",
      "provision",
      z.object({}),
      async () => {
        provisionCalls++;
        return { content: [{ type: "text" as const, text: "provisioned" }] };
      },
      { defaultEnabled: false },
    );
    ToolRegistry.register(
      "deleteDevice",
      "delete",
      z.object({}),
      async () => {
        deleteCalls++;
        return { content: [{ type: "text" as const, text: "deleted" }] };
      },
      { defaultEnabled: false },
    );
    registerToolSelectionTools();
  });

  afterAll(async () => {
    await provisionClient.teardown();
    await deleteClient.teardown();
    ToolRegistry.clearTools();
  });

  test("keeps each fresh client's destructive tool unadvertised but callable", async () => {
    expect((await provisionClient.client.listTools()).tools.map(({ name }) => name)).not.toContain(
      "provisionDevice",
    );
    await provisionClient.client.request(
      { method: "tools/call", params: { name: "provisionDevice", arguments: {} } },
      z.any(),
    );
    expect(provisionCalls).toBe(1);

    expect((await deleteClient.client.listTools()).tools.map(({ name }) => name)).not.toContain(
      "deleteDevice",
    );
    await deleteClient.client.request(
      { method: "tools/call", params: { name: "deleteDevice", arguments: {} } },
      z.any(),
    );
    expect(deleteCalls).toBe(1);
    expect(provisionCalls).toBe(1);
  });
});
