import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { serverConfig } from "../../src/utils/ServerConfig";

describe("ToolRegistry.getToolDefinitions", () => {
  const originalStructuredContentSuppressed = serverConfig.isToolResultsNoStructuredContentEnabled();
  const originalCompactBounds = serverConfig.isObserveResultCompactEnabled();

  beforeEach(() => {
    ToolRegistry.clearTools();
    serverConfig.setToolResultsNoStructuredContentEnabled(false);
    serverConfig.setObserveResultCompactEnabled(false);
  });

  afterEach(() => {
    ToolRegistry.clearTools();
    serverConfig.setToolResultsNoStructuredContentEnabled(originalStructuredContentSuppressed);
    serverConfig.setObserveResultCompactEnabled(originalCompactBounds);
  });

  test("reuses converted input and output schemas across steady-state listings", () => {
    ToolRegistry.register(
      "cachedTool",
      "A tool with schemas worth caching",
      z.object({ value: z.string() }),
      async () => ({ content: [{ type: "text", text: "ok" }] }),
      { outputSchema: z.object({ ok: z.boolean() }) }
    );

    const first = ToolRegistry.getToolDefinitions()[0];
    const second = ToolRegistry.getToolDefinitions()[0];

    expect(second.inputSchema).toBe(first.inputSchema);
    expect(second.outputSchema).toBe(first.outputSchema);
  });

  test("invalidates converted schemas when the tool list changes", () => {
    ToolRegistry.register(
      "invalidateTool",
      "A tool that should be reconverted after invalidation",
      z.object({ value: z.string() }),
      async () => ({ content: [{ type: "text", text: "ok" }] }),
      { outputSchema: z.object({ ok: z.boolean() }) }
    );

    const cached = ToolRegistry.getToolDefinitions()[0];
    expect(ToolRegistry.getToolDefinitions()[0].inputSchema).toBe(cached.inputSchema);

    ToolRegistry.notifyToolListChanged();
    const afterInvalidation = ToolRegistry.getToolDefinitions()[0];

    expect(afterInvalidation.inputSchema).not.toBe(cached.inputSchema);
    expect(afterInvalidation.outputSchema).not.toBe(cached.outputSchema);
  });

  test("reconverts a replaced normal tool registration", () => {
    ToolRegistry.register(
      "replaceTool",
      "Original tool",
      z.object({ before: z.string() }),
      async () => ({ content: [{ type: "text", text: "before" }] })
    );
    const original = ToolRegistry.getToolDefinitions()[0];

    ToolRegistry.register(
      "replaceTool",
      "Replacement tool",
      z.object({ after: z.number() }),
      async () => ({ content: [{ type: "text", text: "after" }] })
    );
    const replacement = ToolRegistry.getToolDefinitions()[0];

    expect(replacement.description).toBe("Replacement tool");
    expect(replacement.inputSchema).not.toBe(original.inputSchema);
    expect(JSON.stringify(replacement.inputSchema)).toContain("after");
  });

  test("reconverts a replaced device-aware tool registration", () => {
    ToolRegistry.registerDeviceAware(
      "replaceDeviceTool",
      "Original device tool",
      z.object({ before: z.string() }),
      async () => ({ content: [{ type: "text", text: "before" }] })
    );
    const original = ToolRegistry.getToolDefinitions()[0];

    ToolRegistry.registerDeviceAware(
      "replaceDeviceTool",
      "Replacement device tool",
      z.object({ after: z.number() }),
      async () => ({ content: [{ type: "text", text: "after" }] })
    );
    const replacement = ToolRegistry.getToolDefinitions()[0];

    expect(replacement.description).toBe("Replacement device tool");
    expect(replacement.inputSchema).not.toBe(original.inputSchema);
    expect(JSON.stringify(replacement.inputSchema)).toContain("after");
  });

  test("caches output schema variants per structured-content and compact-bounds flags", () => {
    const boundsSchema = z.object({
      bounds: z.union([
        z.object({ left: z.number(), top: z.number(), width: z.number(), height: z.number() }),
        z.tuple([z.number(), z.number(), z.number(), z.number()]),
      ]).describe("Element bounds. Default: object; compact: [left, top, right, bottom]."),
    });

    ToolRegistry.register(
      "boundsTool",
      "A tool whose output schema follows runtime flags",
      z.object({}),
      async () => ({ content: [{ type: "text", text: "ok" }] }),
      { outputSchema: boundsSchema }
    );

    const defaultOutput = ToolRegistry.getToolDefinitions()[0].outputSchema;
    expect(JSON.stringify(defaultOutput)).not.toContain("prefixItems");
    expect(ToolRegistry.getToolDefinitions()[0].outputSchema).toBe(defaultOutput);

    serverConfig.setObserveResultCompactEnabled(true);
    ToolRegistry.notifyToolListChanged();
    const compactOutput = ToolRegistry.getToolDefinitions()[0].outputSchema;
    expect(JSON.stringify(compactOutput)).toContain("prefixItems");
    expect(compactOutput).not.toBe(defaultOutput);
    expect(ToolRegistry.getToolDefinitions()[0].outputSchema).toBe(compactOutput);

    serverConfig.setToolResultsNoStructuredContentEnabled(true);
    ToolRegistry.notifyToolListChanged();
    expect(ToolRegistry.getToolDefinitions()[0].outputSchema).toBeUndefined();
  });
});
