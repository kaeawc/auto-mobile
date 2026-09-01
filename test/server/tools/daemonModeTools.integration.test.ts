import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { ToolRegistry } from "../../../src/server/toolRegistry";
import { McpTestFixture } from "../../fixtures/mcpTestFixture";

// Registry tests cover the direct API. This suite verifies the MCP wire
// boundary, where getTool() must not expose plan-only tools to clients.
describe("plan-only/debug-only tools are ungated over the wire", () => {
  let fixture: McpTestFixture;
  const permissiveResult = z.object({}).passthrough();

  beforeAll(async () => {
    ToolRegistry.clearTools();
    fixture = new McpTestFixture({ daemonMode: true });
    await fixture.setup();
  });

  afterAll(async () => {
    if (fixture) {
      await fixture.teardown();
    }
    ToolRegistry.clearTools();
  });

  test.each(["criticalSection", "barrier", "setUIState"])(
    "%s is rejected as an unknown tool when called directly over the wire",
    async (name) => {
      const { client } = fixture.getContext();
      await expect(
        client.request({ method: "tools/call", params: { name, arguments: {} } }, permissiveResult),
      ).rejects.toThrow("Unknown tool");
    },
  );

  test("a normally-advertised tool is NOT rejected as unknown (control)", async () => {
    const { client } = fixture.getContext();
    let message = "";
    try {
      await client.request(
        { method: "tools/call", params: { name: "executePlan", arguments: {} } },
        permissiveResult,
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toContain("Unknown tool");
  });
});
