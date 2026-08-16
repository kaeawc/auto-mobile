import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { McpTestFixture } from "../fixtures/mcpTestFixture";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { executionTracker } from "../../src/server/executionTracker";

const captureSchema = z.object({
  value: z.string().optional(),
}).strict();

async function callCaptureTool(
  fixture: McpTestFixture,
  args: Record<string, unknown>,
  whileHandling?: (handlerArgs: Record<string, unknown>) => void,
): Promise<Record<string, unknown>> {
  let capturedArgs: Record<string, unknown> | undefined;
  ToolRegistry.clearTools();
  ToolRegistry.register("captureMcpSession", "captureMcpSession", captureSchema, async handlerArgs => {
    capturedArgs = handlerArgs;
    whileHandling?.(handlerArgs);
    return { content: [{ type: "text", text: "ok" }] };
  });

  const { client } = fixture.getContext();
  await client.request({
    method: "tools/call",
    params: {
      name: "captureMcpSession",
      arguments: args,
    },
  }, z.any());

  expect(capturedArgs).toBeDefined();
  return capturedArgs!;
}

describe("MCP session autolock routing", () => {
  let fixture: McpTestFixture | undefined;

  afterEach(async () => {
    if (fixture) {
      await fixture.teardown();
      fixture = undefined;
    }
    ToolRegistry.clearTools();
  });

  test("strips proxy-injected session keys before schema validation and passes them to handlers", async () => {
    fixture = new McpTestFixture({ daemonMode: true, sessionContext: { sessionId: "shared-loopback-session" } });
    await fixture.setup();

    const capturedArgs = await callCaptureTool(fixture, {
      value: "ok",
      __mcpSessionId: "unix-socket-session",
    });

    expect(capturedArgs.value).toBe("ok");
    expect(capturedArgs.__mcpSessionId).toBe("unix-socket-session");
  });

  test("tracks proxy-injected MCP sessions under their autolock key", async () => {
    fixture = new McpTestFixture({ daemonMode: true, sessionContext: { sessionId: "shared-loopback-session" } });
    await fixture.setup();

    await callCaptureTool(
      fixture,
      { value: "ok", __mcpSessionId: "unix-socket-session" },
      () => {
        expect(executionTracker.hasActiveSessionExecutions("unix-socket-session")).toBe(true);
        // The forwarded key drives autolock expiry, while the transport key is
        // retained solely so its close/error handlers can cancel this execution.
        expect(executionTracker.hasActiveSessionExecutions("shared-loopback-session")).toBe(true);
      },
    );
  });

  test("does not use the shared daemon loopback MCP session as an implicit autolock key", async () => {
    fixture = new McpTestFixture({ daemonMode: true, sessionContext: { sessionId: "shared-loopback-session" } });
    await fixture.setup();

    const capturedArgs = await callCaptureTool(fixture, { value: "ok" });

    expect(capturedArgs.value).toBe("ok");
    expect(capturedArgs).not.toHaveProperty("__mcpSessionId");
  });

  test("keeps direct MCP sessions available as implicit autolock keys", async () => {
    fixture = new McpTestFixture({ sessionContext: { sessionId: "direct-mcp-session" } });
    await fixture.setup();

    const capturedArgs = await callCaptureTool(fixture, { value: "ok" });

    expect(capturedArgs.value).toBe("ok");
    expect(capturedArgs.__mcpSessionId).toBe("direct-mcp-session");
  });
});
