import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { registerToolSelectionTools } from "../../src/server/toolSelectionTools";
import { isDebugModeEnabled, setDebugModeEnabled } from "../../src/utils/debug";
import { serverConfig } from "../../src/utils/ServerConfig";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";

isolateToolRegistry();

describe("ToolRegistry.getToolDefinitions", () => {
  const originalStructuredContentSuppressed =
    serverConfig.isToolResultsNoStructuredContentEnabled();

  beforeEach(() => {
    ToolRegistry.clearTools();
    serverConfig.setToolResultsNoStructuredContentEnabled(false);
  });

  afterEach(() => {
    ToolRegistry.clearTools();
    serverConfig.setToolResultsNoStructuredContentEnabled(originalStructuredContentSuppressed);
  });

  test("selection choices follow availability without leaking hidden or plan-only tools", () => {
    const originalDebug = isDebugModeEnabled();
    try {
      setDebugModeEnabled(false);
      registerToolSelectionTools();
      for (const [name, options] of [
        ["optionalTool", { defaultEnabled: false }],
        ["debugTool", { debugOnly: true }],
        ["hiddenTool", { hidden: true }],
      ] as const) {
        ToolRegistry.register(name, name, z.object({}), {
          handler: async () => ({}),
          ...options,
        });
      }
      ToolRegistry.registerDeviceAware("planTool", "Plan only", z.object({}), async () => ({}), {
        planOnly: true,
      });
      const choices = () => {
        const schema = ToolRegistry.getToolDefinitions().find(
          (tool) => tool.name === "setToolEnabled",
        )!.inputSchema;
        return (schema.properties as Record<string, { enum: string[] }>).toolName.enum;
      };
      const initialChoices = choices();
      expect(initialChoices).toEqual(["optionalTool"]);
      expect(ToolRegistry.getToolDefinitions().map((tool) => tool.name)).toEqual([
        "optionalTool",
        "setToolEnabled",
      ]);
      for (const tool of ToolRegistry.getToolDefinitions()) {
        expect(ToolRegistry.getTool(tool.name)).toBeDefined();
      }
      setDebugModeEnabled(true);
      expect(choices()).toEqual(["debugTool", "optionalTool"]);
      expect(ToolRegistry.getToolDefinitions().map((tool) => tool.name)).toContain("debugTool");
      for (const tool of ToolRegistry.getToolDefinitions()) {
        expect(ToolRegistry.getTool(tool.name)).toBeDefined();
      }
      expect(initialChoices).toEqual(["optionalTool"]);
      setDebugModeEnabled(false);
      expect(choices()).toEqual(["optionalTool"]);
    } finally {
      setDebugModeEnabled(originalDebug);
    }
  });

  test("reuses converted input and output schemas across steady-state listings", () => {
    ToolRegistry.register(
      "cachedTool",
      "A tool with schemas worth caching",
      z.object({ value: z.string() }),
      {
        handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
        outputSchema: z.object({ ok: z.boolean() }),
      },
    );

    const first = ToolRegistry.getToolDefinitions()[0];
    const second = ToolRegistry.getToolDefinitions()[0];

    expect(second.inputSchema).toBe(first.inputSchema);
    expect(second.outputSchema).toBe(first.outputSchema);
  });

  test("constrains appId only in advertised input schemas", () => {
    ToolRegistry.register(
      "appIdSchemaTool",
      "A tool with appId fields in both schemas",
      z.object({ appId: z.string() }),
      {
        handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
        outputSchema: z.object({
          appId: z.string(),
          nested: z.object({ appId: z.string() }),
        }),
      },
    );

    const definition = ToolRegistry.getToolDefinitions()[0];
    const inputAppId = (
      definition.inputSchema.properties as Record<string, Record<string, unknown>>
    ).appId;
    const outputSchema = definition.outputSchema!;
    const outputProperties = outputSchema.properties as Record<string, Record<string, unknown>>;
    const nestedOutputProperties = outputProperties.nested.properties as Record<
      string,
      Record<string, unknown>
    >;

    expect(inputAppId).toMatchObject({
      minLength: 1,
      maxLength: 256,
      pattern: "^[A-Za-z0-9._-]+$",
    });
    expect(outputProperties.appId).not.toHaveProperty("minLength");
    expect(outputProperties.appId).not.toHaveProperty("maxLength");
    expect(outputProperties.appId).not.toHaveProperty("pattern");
    expect(nestedOutputProperties.appId).not.toHaveProperty("minLength");
    expect(nestedOutputProperties.appId).not.toHaveProperty("maxLength");
    expect(nestedOutputProperties.appId).not.toHaveProperty("pattern");
  });

  test("invalidates converted schemas when the tool list changes", () => {
    ToolRegistry.register(
      "invalidateTool",
      "A tool that should be reconverted after invalidation",
      z.object({ value: z.string() }),
      {
        handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
        outputSchema: z.object({ ok: z.boolean() }),
      },
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
      async () => ({ content: [{ type: "text", text: "before" }] }),
    );
    const original = ToolRegistry.getToolDefinitions()[0];

    ToolRegistry.register(
      "replaceTool",
      "Replacement tool",
      z.object({ after: z.number() }),
      async () => ({ content: [{ type: "text", text: "after" }] }),
    );
    const replacement = ToolRegistry.getToolDefinitions()[0];

    expect(replacement.description).toBe("Replacement tool");
    expect(replacement.inputSchema).not.toBe(original.inputSchema);
    expect(JSON.stringify(replacement.inputSchema)).toContain("after");
  });

  test("adding a normal tool registration converts only the added tool; the others stay cached", () => {
    ToolRegistry.register(
      "existingTool",
      "Existing tool",
      z.object({ existing: z.string() }),
      async () => ({ content: [{ type: "text", text: "existing" }] }),
    );
    const originalExisting = ToolRegistry.getToolDefinitions()[0];
    const builtBefore = ToolRegistry.schemaBuildCountForTesting();

    ToolRegistry.register("addedTool", "Added tool", z.object({ added: z.number() }), async () => ({
      content: [{ type: "text", text: "added" }],
    }));
    const definitions = ToolRegistry.getToolDefinitions();
    const existing = definitions.find((tool) => tool.name === "existingTool");
    const added = definitions.find((tool) => tool.name === "addedTool");

    expect(existing).toBeDefined();
    expect(added).toBeDefined();
    expect(existing!.inputSchema).toBe(originalExisting.inputSchema);
    expect(JSON.stringify(added!.inputSchema)).toContain("added");
    expect(ToolRegistry.schemaBuildCountForTesting() - builtBefore).toBe(1);
  });

  test("reconverts a replaced device-aware tool registration", () => {
    ToolRegistry.registerDeviceAware(
      "replaceDeviceTool",
      "Original device tool",
      z.object({ before: z.string() }),
      async () => ({ content: [{ type: "text", text: "before" }] }),
    );
    const original = ToolRegistry.getToolDefinitions()[0];

    ToolRegistry.registerDeviceAware(
      "replaceDeviceTool",
      "Replacement device tool",
      z.object({ after: z.number() }),
      async () => ({ content: [{ type: "text", text: "after" }] }),
    );
    const replacement = ToolRegistry.getToolDefinitions()[0];

    expect(replacement.description).toBe("Replacement device tool");
    expect(replacement.inputSchema).not.toBe(original.inputSchema);
    expect(JSON.stringify(replacement.inputSchema)).toContain("after");
  });

  test("adding a device-aware tool registration converts only the added tool; the others stay cached", () => {
    ToolRegistry.registerDeviceAware(
      "existingDeviceTool",
      "Existing device tool",
      z.object({ existing: z.string() }),
      async () => ({ content: [{ type: "text", text: "existing" }] }),
    );
    const originalExisting = ToolRegistry.getToolDefinitions()[0];
    const builtBefore = ToolRegistry.schemaBuildCountForTesting();

    ToolRegistry.registerDeviceAware(
      "addedDeviceTool",
      "Added device tool",
      z.object({ added: z.number() }),
      async () => ({ content: [{ type: "text", text: "added" }] }),
    );
    const definitions = ToolRegistry.getToolDefinitions();
    const existing = definitions.find((tool) => tool.name === "existingDeviceTool");
    const added = definitions.find((tool) => tool.name === "addedDeviceTool");

    expect(existing).toBeDefined();
    expect(added).toBeDefined();
    expect(existing!.inputSchema).toBe(originalExisting.inputSchema);
    expect(JSON.stringify(added!.inputSchema)).toContain("added");
    expect(ToolRegistry.schemaBuildCountForTesting() - builtBefore).toBe(1);
  });

  test("re-registering a tool with the same schemas reuses its conversion, a changed schema does not", () => {
    const schema = z.object({ same: z.string() });
    const register = (registered: z.ZodType, description: string) =>
      ToolRegistry.register("sameSchemaTool", description, registered, async () => ({
        content: [{ type: "text", text: "ok" }],
      }));
    register(schema, "First");
    const first = ToolRegistry.getToolDefinitions()[0];
    const built = ToolRegistry.schemaBuildCountForTesting();

    register(schema, "Second");
    const second = ToolRegistry.getToolDefinitions()[0];
    expect(second.description).toBe("Second");
    expect(second.inputSchema).toBe(first.inputSchema);
    expect(ToolRegistry.schemaBuildCountForTesting()).toBe(built);

    register(z.object({ other: z.number() }), "Third");
    const third = ToolRegistry.getToolDefinitions()[0];
    expect(third.inputSchema).not.toBe(first.inputSchema);
    expect(JSON.stringify(third.inputSchema)).toContain("other");
    expect(ToolRegistry.schemaBuildCountForTesting()).toBe(built + 1);
  });

  test("a removed tool is converted again when it is registered back", () => {
    const schema = z.object({ back: z.string() });
    const register = () =>
      ToolRegistry.register("comesBackTool", "Comes back", schema, async () => ({
        content: [{ type: "text", text: "ok" }],
      }));
    register();
    expect(ToolRegistry.getToolDefinitions()).toHaveLength(1);
    const built = ToolRegistry.schemaBuildCountForTesting();

    ToolRegistry.unregister("comesBackTool");
    expect(ToolRegistry.getToolDefinitions()).toHaveLength(0);
    register();
    expect(ToolRegistry.getToolDefinitions()).toHaveLength(1);
    expect(ToolRegistry.schemaBuildCountForTesting()).toBe(built + 1);
  });

  test("a session binding or tool selection change keeps every conversion; a tool-list change drops them", () => {
    ToolRegistry.register(
      "selectionTool",
      "A tool whose schemas a selection change cannot affect",
      z.object({ value: z.string() }),
      {
        handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
        outputSchema: z.object({ ok: z.boolean() }),
      },
    );
    const cached = ToolRegistry.getToolDefinitions()[0];
    const built = ToolRegistry.schemaBuildCountForTesting();

    ToolRegistry.notifyToolSelectionChanged();
    const afterSelection = ToolRegistry.getToolDefinitions()[0];
    expect(afterSelection.inputSchema).toBe(cached.inputSchema);
    expect(afterSelection.outputSchema).toBe(cached.outputSchema);
    expect(ToolRegistry.schemaBuildCountForTesting()).toBe(built);

    ToolRegistry.notifyToolListChanged();
    expect(ToolRegistry.getToolDefinitions()[0].inputSchema).not.toBe(cached.inputSchema);
    expect(ToolRegistry.schemaBuildCountForTesting()).toBe(built + 1);
  });

  test("caches output schema variants per structured-content flag (bounds tuple always advertised)", () => {
    const boundsSchema = z.object({
      bounds: z
        .union([
          z.object({ left: z.number(), top: z.number(), width: z.number(), height: z.number() }),
          z.tuple([z.number(), z.number(), z.number(), z.number()]),
        ])
        .describe("Element bounds. Default: positional tuple [left, top, right, bottom]."),
    });

    ToolRegistry.register(
      "boundsTool",
      "A tool whose output schema follows runtime flags",
      z.object({}),
      {
        handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
        outputSchema: boundsSchema,
      },
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
