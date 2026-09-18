import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { registerToolSelectionTools } from "../../src/server/toolSelectionTools";
import { McpTestFixture } from "../fixtures/mcpTestFixture";

/**
 * The acceptance harness uses a fresh client for each destructive operation.
 * Exercise the real MCP dispatch gate here: default-disabled tools must be
 * rejected before their handler, then become callable only after the supported
 * public setToolEnabled declaration on that same connection.
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
    // are connected, so dispatch still uses the production selection gate.
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

  test("requires each fresh client to opt into only its destructive tool", async () => {
    await expect(
      provisionClient.client.request(
        { method: "tools/call", params: { name: "provisionDevice", arguments: {} } },
        z.any(),
      ),
    ).rejects.toThrow("Tool provisionDevice is disabled");
    expect(provisionCalls).toBe(0);

    await provisionClient.client.request(
      {
        method: "tools/call",
        params: {
          name: "setToolEnabled",
          arguments: { toolName: "provisionDevice", enabled: true },
        },
      },
      z.any(),
    );
    await provisionClient.client.request(
      { method: "tools/call", params: { name: "provisionDevice", arguments: {} } },
      z.any(),
    );
    expect(provisionCalls).toBe(1);

    await expect(
      deleteClient.client.request(
        { method: "tools/call", params: { name: "deleteDevice", arguments: {} } },
        z.any(),
      ),
    ).rejects.toThrow("Tool deleteDevice is disabled");
    expect(deleteCalls).toBe(0);

    await deleteClient.client.request(
      {
        method: "tools/call",
        params: {
          name: "setToolEnabled",
          arguments: { toolName: "deleteDevice", enabled: true },
        },
      },
      z.any(),
    );
    await deleteClient.client.request(
      { method: "tools/call", params: { name: "deleteDevice", arguments: {} } },
      z.any(),
    );
    expect(deleteCalls).toBe(1);
    expect(provisionCalls).toBe(1);
  });
});
