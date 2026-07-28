import { afterEach, describe, expect, mock, test } from "bun:test";
import { z } from "zod";
import { McpTestFixture } from "../fixtures/mcpTestFixture";
import { ToolRegistry } from "../../src/server/toolRegistry";
import type { SessionToolProfileService } from "../../src/features/toolCapabilities/SessionToolProfileService";

describe("session tool capability MCP enforcement", () => {
  let fixture: McpTestFixture | undefined;

  afterEach(async () => {
    await fixture?.teardown();
    fixture = undefined;
    ToolRegistry.clearTools();
  });

  test("denies a disabled direct tool before invoking its handler", async () => {
    const isEnabled = mock(async (_sessionUuid: string | undefined, capability: string) =>
      capability === "test-authoring"
    );
    const profileService: Pick<SessionToolProfileService, "isEnabled"> = { isEnabled };
    fixture = new McpTestFixture({
      sessionContext: { sessionId: "mcp-session-1" },
      sessionToolProfileService: profileService,
    });
    await fixture.setup();

    ToolRegistry.clearTools();
    const handler = mock(async () => ({ content: [{ type: "text", text: "ok" }] }));
    ToolRegistry.register(
      "clipboard",
      "clipboard",
      z.object({ sessionUuid: z.string() }),
      handler
    );

    await expect(fixture.client.request(
      {
        method: "tools/call",
        params: {
          name: "clipboard",
          arguments: { sessionUuid: "device-session-1" },
        },
      },
      z.any()
    )).rejects.toThrow("requires the 'clipboard' capability");

    expect(isEnabled).toHaveBeenCalledWith("device-session-1", "clipboard");
    expect(handler).not.toHaveBeenCalled();
  });

  test("denies a disabled device-aware tool when its schema strips sessionUuid", async () => {
    const isEnabled = mock(async (_sessionUuid: string | undefined, capability: string) =>
      capability === "test-authoring"
    );
    const profileService: Pick<SessionToolProfileService, "isEnabled"> = { isEnabled };
    fixture = new McpTestFixture({
      sessionContext: { sessionId: "mcp-session-1" },
      sessionToolProfileService: profileService,
    });
    await fixture.setup();

    ToolRegistry.clearTools();
    const handler = mock(async () => ({ content: [{ type: "text", text: "ok" }] }));
    const nonDeviceHandler = mock(async () => ({ content: [{ type: "text", text: "ok" }] }));
    ToolRegistry.registerDeviceAware(
      "clipboard",
      "clipboard",
      z.object({}),
      handler,
      {
        shouldEnsureDevice: () => false,
        nonDeviceHandler,
      }
    );

    await expect(fixture.client.request(
      {
        method: "tools/call",
        params: {
          name: "clipboard",
          arguments: { sessionUuid: "device-session-1" },
        },
      },
      z.any()
    )).rejects.toThrow("requires the 'clipboard' capability");

    expect(isEnabled).toHaveBeenCalledWith("device-session-1", "clipboard");
    expect(handler).not.toHaveBeenCalled();
    expect(nonDeviceHandler).not.toHaveBeenCalled();
  });

  test("allows an enabled direct tool", async () => {
    const profileService: Pick<SessionToolProfileService, "isEnabled"> = {
      isEnabled: async () => true,
    };
    fixture = new McpTestFixture({
      sessionContext: { sessionId: "mcp-session-1" },
      sessionToolProfileService: profileService,
    });
    await fixture.setup();

    ToolRegistry.clearTools();
    const handler = mock(async () => ({ content: [{ type: "text", text: "ok" }] }));
    ToolRegistry.register(
      "clipboard",
      "clipboard",
      z.object({ sessionUuid: z.string() }),
      handler
    );

    await fixture.client.request(
      {
        method: "tools/call",
        params: {
          name: "clipboard",
          arguments: { sessionUuid: "device-session-1" },
        },
      },
      z.any()
    );

    expect(handler).toHaveBeenCalledTimes(1);
  });
});
