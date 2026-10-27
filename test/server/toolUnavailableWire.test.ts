import { ProtocolError } from "@modelcontextprotocol/client";
import { installHermeticServerFixture } from "../helpers/hermeticServerFixture";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { McpTestFixture } from "../fixtures/mcpTestFixture";
import { DAEMON_TOOL_UNAVAILABLE_CODE, DAEMON_UNKNOWN_TOOL_CODE } from "../../src/daemon/types";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { isToolUnavailableWireError } from "../../src/daemon/toolUnavailableError";
import { serverConfig } from "../../src/utils/ServerConfig";
import { isDebugModeEnabled, setDebugModeEnabled } from "../../src/utils/debug";

/**
 * Issue #10177: a tool the server registers but gates off (debug-only,
 * embedded-SDK-only, plan-only) must reach the daemon proxy with a structured
 * marker, while a name the registry has never heard of carries `daemon_unknown_tool` (#11821), never the unavailable marker. Both
 * keep the historical `Unknown tool: ...` text and -32603 wire code.
 */
describe("gated tools carry a structured marker over the MCP wire (issue #10177)", () => {
  const originalDebug = isDebugModeEnabled();
  const originalEmbeddedSdk = serverConfig.isEmbeddedSdkEnabled();
  let fixture: McpTestFixture;
  let restoreHermeticServer: () => void;

  const GATED = [
    { name: "__gate_debug__", reason: "--debug is disabled; start the daemon with --debug" },
    {
      name: "__gate_embedded__",
      reason: "embedded SDK mode is disabled; start the daemon with --embedded-sdk",
    },
    { name: "__gate_plan__", reason: "plan-only tool" },
  ] as const;

  beforeAll(async () => {
    restoreHermeticServer = installHermeticServerFixture();
    setDebugModeEnabled(false);
    serverConfig.setEmbeddedSdkEnabled(false);
    const noop = async () => ({ content: [] });
    ToolRegistry.register("__gate_debug__", "debug", z.object({}), noop, { debugOnly: true });
    ToolRegistry.registerDeviceAware("__gate_embedded__", "sdk", z.object({}), noop, {
      embeddedSdkOnly: true,
    });
    ToolRegistry.registerDeviceAware("__gate_plan__", "plan", z.object({}), noop, {
      planOnly: true,
      planExecutable: true,
    });
    fixture = new McpTestFixture();
    await fixture.setup();
  });

  afterAll(async () => {
    await fixture?.teardown();
    setDebugModeEnabled(originalDebug);
    serverConfig.setEmbeddedSdkEnabled(originalEmbeddedSdk);
    restoreHermeticServer();
  });

  async function callError(name: string): Promise<ProtocolError> {
    const { client } = fixture.getContext();
    try {
      await client.callTool({ name, arguments: {} });
    } catch (error) {
      expect(error).toBeInstanceOf(ProtocolError);
      return error as ProtocolError;
    }
    throw new Error(`${name} unexpectedly succeeded`);
  }

  test.each([...GATED])("$name: gate reason text unchanged, marker on the wire", async (gated) => {
    const error = await callError(gated.name);
    expect(error.code).toBe(-32603);
    expect(error.message).toBe(`Unknown tool: ${gated.name}. ${gated.reason}`);
    expect(error.data).toEqual({ code: DAEMON_TOOL_UNAVAILABLE_CODE, toolName: gated.name });
    expect(isToolUnavailableWireError(error)).toBe(true);
  });

  test("a name the registry never registered carries the unknown-tool code, not the unavailable marker", async () => {
    const error = await callError("__never_registered__");
    expect(error.code).toBe(-32603);
    expect(error.message).toBe("Unknown tool: __never_registered__");
    expect(error.data).toEqual({
      code: DAEMON_UNKNOWN_TOOL_CODE,
      toolName: "__never_registered__",
    });
    expect(isToolUnavailableWireError(error)).toBe(false);
  });

  test("the marker predicate rejects look-alikes", () => {
    expect(isToolUnavailableWireError(new Error("Unknown tool: x. --debug is disabled"))).toBe(
      false,
    );
    expect(isToolUnavailableWireError({ data: null })).toBe(false);
    expect(isToolUnavailableWireError({ data: { code: "other" } })).toBe(false);
    expect(isToolUnavailableWireError(undefined)).toBe(false);
  });
});
