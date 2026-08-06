import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { serverConfig } from "../../src/utils/ServerConfig";

describe("ToolRegistry.getToolDefinitions", () => {
  const originalStructuredContentSuppressed = serverConfig.isToolResultsNoStructuredContentEnabled();

  beforeEach(() => {
    ToolRegistry.clearTools();
    serverConfig.setToolResultsNoStructuredContentEnabled(false);
  });

  afterEach(() => {
    ToolRegistry.clearTools();
    serverConfig.setToolResultsNoStructuredContentEnabled(originalStructuredContentSuppressed);
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

  test("invalidates converted schemas when adding a normal tool registration", () => {
    ToolRegistry.register(
      "existingTool",
      "Existing tool",
      z.object({ existing: z.string() }),
      async () => ({ content: [{ type: "text", text: "existing" }] })
    );
    const originalExisting = ToolRegistry.getToolDefinitions()[0];

    ToolRegistry.register(
      "addedTool",
      "Added tool",
      z.object({ added: z.number() }),
      async () => ({ content: [{ type: "text", text: "added" }] })
    );
    const definitions = ToolRegistry.getToolDefinitions();
    const existing = definitions.find(tool => tool.name === "existingTool");
    const added = definitions.find(tool => tool.name === "addedTool");

    expect(existing).toBeDefined();
    expect(added).toBeDefined();
    expect(existing!.inputSchema).not.toBe(originalExisting.inputSchema);
    expect(JSON.stringify(added!.inputSchema)).toContain("added");
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

  test("invalidates converted schemas when adding a device-aware tool registration", () => {
    ToolRegistry.registerDeviceAware(
      "existingDeviceTool",
      "Existing device tool",
      z.object({ existing: z.string() }),
      async () => ({ content: [{ type: "text", text: "existing" }] })
    );
    const originalExisting = ToolRegistry.getToolDefinitions()[0];

    ToolRegistry.registerDeviceAware(
      "addedDeviceTool",
      "Added device tool",
      z.object({ added: z.number() }),
      async () => ({ content: [{ type: "text", text: "added" }] })
    );
    const definitions = ToolRegistry.getToolDefinitions();
    const existing = definitions.find(tool => tool.name === "existingDeviceTool");
    const added = definitions.find(tool => tool.name === "addedDeviceTool");

    expect(existing).toBeDefined();
    expect(added).toBeDefined();
    expect(existing!.inputSchema).not.toBe(originalExisting.inputSchema);
    expect(JSON.stringify(added!.inputSchema)).toContain("added");
  });

  test("caches output schema variants per structured-content flag (bounds tuple always advertised)", () => {
    const boundsSchema = z.object({
      bounds: z.union([
        z.object({ left: z.number(), top: z.number(), width: z.number(), height: z.number() }),
        z.tuple([z.number(), z.number(), z.number(), z.number()]),
      ]).describe("Element bounds. Default: positional tuple [left, top, right, bottom]."),
    });

    ToolRegistry.register(
      "boundsTool",
      "A tool whose output schema follows runtime flags",
      z.object({}),
      async () => ({ content: [{ type: "text", text: "ok" }] }),
      { outputSchema: boundsSchema }
    );

    // Bounds compaction is now an unconditional default, so the positional tuple
    // arm (a JSON-Schema `prefixItems`) is always advertised.
    const defaultOutput = ToolRegistry.getToolDefinitions()[0].outputSchema;
    expect(JSON.stringify(defaultOutput)).toContain("prefixItems");
    expect(ToolRegistry.getToolDefinitions()[0].outputSchema).toBe(defaultOutput);

    serverConfig.setToolResultsNoStructuredContentEnabled(true);
    ToolRegistry.notifyToolListChanged();
    expect(ToolRegistry.getToolDefinitions()[0].outputSchema).toBeUndefined();
  });
});
