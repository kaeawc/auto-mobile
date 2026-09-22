import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { serverConfig } from "../../src/utils/ServerConfig";
import { isDebugModeEnabled, setDebugModeEnabled } from "../../src/utils/debug";
import { McpTestFixture } from "../fixtures/mcpTestFixture";

describe("tool availability and per-connection selection", () => {
  let fixture: McpTestFixture | undefined;
  const originalDebugMode = isDebugModeEnabled();
  const originalEmbeddedSdkMode = serverConfig.isEmbeddedSdkEnabled();

  afterEach(async () => {
    await fixture?.teardown();
    fixture = undefined;
    ToolRegistry.clearTools();
    setDebugModeEnabled(originalDebugMode);
    serverConfig.setEmbeddedSdkEnabled(originalEmbeddedSdkMode);
  });

  test("keeps an unadvertised default-off tool callable while availability-gated tools stay unavailable", async () => {
    setDebugModeEnabled(false);
    serverConfig.setEmbeddedSdkEnabled(false);
    fixture = new McpTestFixture();
    await fixture.setup();

    ToolRegistry.clearTools();
    ToolRegistry.register(
      "defaultOffTool",
      "Default-off tool",
      z.object({}),
      async () => ({ content: [{ type: "text" as const, text: "default-off handler ran" }] }),
      { defaultEnabled: false },
    );
    ToolRegistry.register(
      "debugOnlyTool",
      "Debug-only tool",
      z.object({}),
      async () => ({ content: [] }),
      { debugOnly: true },
    );
    ToolRegistry.registerDeviceAware(
      "embeddedSdkOnlyTool",
      "Embedded-SDK-only tool",
      z.object({}),
      async () => ({ content: [] }),
      { embeddedSdkOnly: true },
    );
    ToolRegistry.registerDeviceAware(
      "barrier",
      "Plan-only barrier",
      z.object({}),
      async () => ({ content: [] }),
      { planOnly: true, planExecutable: true },
    );

    const listedNames = (await fixture.client.listTools()).tools.map(({ name }) => name);
    expect(listedNames).not.toContain("defaultOffTool");
    expect(listedNames).not.toContain("debugOnlyTool");
    expect(listedNames).not.toContain("embeddedSdkOnlyTool");
    expect(listedNames).not.toContain("barrier");

    const defaultOffResult = await fixture.client.request(
      { method: "tools/call", params: { name: "defaultOffTool", arguments: {} } },
      z.any(),
    );
    expect(defaultOffResult.content[0]?.text).toBe("default-off handler ran");

    for (const unavailableTool of ["debugOnlyTool", "embeddedSdkOnlyTool", "barrier"]) {
      await expect(
        fixture.client.request(
          { method: "tools/call", params: { name: unavailableTool, arguments: {} } },
          z.any(),
        ),
      ).rejects.toThrow(`Unknown tool: ${unavailableTool}`);
    }
  });
});
