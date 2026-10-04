import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import {
  applyToolSelection,
  assertUserConfigurableToolNames,
  registerToolSelectionTools,
} from "../../src/server/toolSelectionTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { runWithToolSelectionContext } from "../../src/features/toolSelection/toolSelectionContext";
import { isDebugModeEnabled, setDebugModeEnabled } from "../../src/utils/debug";
import { serverConfig } from "../../src/utils/ServerConfig";

describe("applyToolSelection", () => {
  const readOnlyService = {
    isEnabled: async () => false,
  };
  const originalDebug = isDebugModeEnabled();
  const originalEmbeddedSdk = serverConfig.isEmbeddedSdkEnabled();

  afterEach(() => {
    ToolRegistry.clearTools();
    setDebugModeEnabled(originalDebug);
    serverConfig.setEmbeddedSdkEnabled(originalEmbeddedSdk);
  });

  beforeEach(() => {
    ToolRegistry.clearTools();
    registerToolSelectionTools();
    setDebugModeEnabled(false);
    serverConfig.setEmbeddedSdkEnabled(false);
    ToolRegistry.register("sendKeys", "sendKeys", z.object({}), async () => ({ content: [] }), {
      defaultEnabled: false,
    });
  });

  test.each([
    ["setUIState", { debugOnly: true }, "--debug"],
    ["sdkTool", { embeddedSdkOnly: true }, "embedded SDK"],
  ] as const)("rejects unavailable %s before any batch write", async (name, options, reason) => {
    ToolRegistry.registerDeviceAware(name, name, z.object({}), async () => ({}), options);
    const writes: string[] = [];
    const service = {
      isEnabled: async () => false,
      setEnabled: async (_session: string, toolName: string) => {
        writes.push(toolName);
      },
      setEnabledMany: async (_session: string, toolNames: readonly string[]) => {
        writes.push(...toolNames);
      },
    };
    expect(() => assertUserConfigurableToolNames(["sendKeys", name])).toThrow(reason);
    await expect(applyToolSelection(service, "session", ["sendKeys", name], true)).rejects.toThrow(
      reason,
    );
    expect(writes).toEqual([]);
  });

  test.each([true, false])(
    "setToolEnabled rejects an unavailable tool with enabled=%s",
    async (enabled) => {
      ToolRegistry.register("setUIState", "debug tool", z.object({}), async () => ({}), {
        debugOnly: true,
      });
      const writes: string[] = [];
      const service = {
        isEnabled: async () => false,
        setEnabled: async (_session: string, name: string) => {
          writes.push(name);
        },
      };
      await expect(
        runWithToolSelectionContext(
          {
            toolSelectionProfileUuid: "profile",
            sessionToolSelectionService: service,
          },
          () =>
            ToolRegistry.getTool("setToolEnabled")!.handler({ toolName: "setUIState", enabled }),
        ),
      ).rejects.toThrow("start the daemon with --debug");
      expect(writes).toEqual([]);
    },
  );

  test("still enables callable default-disabled and debug tools when debug is on", async () => {
    ToolRegistry.register("setUIState", "debug tool", z.object({}), async () => ({}), {
      debugOnly: true,
    });
    setDebugModeEnabled(true);
    const writes: string[] = [];
    const service = {
      isEnabled: async () => false,
      setEnabled: async (_session: string, name: string) => {
        writes.push(name);
      },
    };
    expect(await applyToolSelection(service, "session", ["sendKeys", "setUIState"], true)).toEqual({
      requested: ["sendKeys", "setUIState"],
      skipped: [],
    });
    expect(writes).toEqual(["sendKeys", "setUIState"]);
  });

  test("unknown names still reject before writes", async () => {
    await expect(
      applyToolSelection(readOnlyService, "session", ["missingTool"], true),
    ).rejects.toThrow("Tool 'missingTool' is not user-configurable.");
  });

  test("accepts an all-always-on batch with a read-only service", async () => {
    await expect(
      applyToolSelection(readOnlyService, "session", ["setToolEnabled"], true),
    ).resolves.toEqual({
      requested: [],
      skipped: [{ toolName: "setToolEnabled", reason: "always-on" }],
    });
  });

  test("rejects a configurable batch with a read-only service", async () => {
    await expect(
      applyToolSelection(readOnlyService, "session", ["sendKeys"], true),
    ).rejects.toThrow(
      "This MCP server's injected tool-selection service is read-only and cannot update tools.",
    );
  });
});
