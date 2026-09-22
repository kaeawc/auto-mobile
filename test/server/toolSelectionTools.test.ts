import { beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import {
  applyToolSelection,
  registerToolSelectionTools,
} from "../../src/server/toolSelectionTools";
import { ToolRegistry } from "../../src/server/toolRegistry";

describe("applyToolSelection", () => {
  const readOnlyService = {
    isEnabled: async () => false,
  };

  beforeEach(() => {
    ToolRegistry.clearTools();
    registerToolSelectionTools();
    ToolRegistry.register("sendKeys", "sendKeys", z.object({}), async () => ({ content: [] }), {
      defaultEnabled: false,
    });
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
