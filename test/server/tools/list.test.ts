import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ToolRegistry } from "../../../src/server/toolRegistry";
import { McpTestFixture } from "../../fixtures/mcpTestFixture";
import { z } from "zod/v4";
import { compileJsonSchema } from "../../helpers/jsonSchemaCompile";

const listToolsResponseSchema = z.object({
  tools: z.array(
    z
      .object({
        name: z.string(),
        description: z.string(),
        inputSchema: z.object({}).passthrough(),
        outputSchema: z.object({}).passthrough().optional(),
      })
      .passthrough(),
  ),
});

describe("MCP Tools List", () => {
  let fixture: McpTestFixture;

  describe("with default registry", () => {
    beforeAll(async () => {
      fixture = new McpTestFixture();
      await fixture.setup();
    });

    afterAll(async () => {
      if (fixture) {
        await fixture.teardown();
      }
    });

    test("tools/list serves only the core tool profile by default", async function () {
      const { client } = fixture.getContext();

      const result = await client.request(
        { method: "tools/list", params: {} },
        listToolsResponseSchema,
      );

      const wireNames = result.tools.map((tool) => tool.name).sort();
      const advertisedNames = ToolRegistry.getToolDefinitions()
        .filter((tool) => ToolRegistry.getRegisteredTool(tool.name)?.defaultEnabled)
        .map((tool) => tool.name)
        .sort();
      const allToolNames = ToolRegistry.getAllTools()
        .map((tool) => tool.name)
        .sort();

      expect(wireNames).toEqual(advertisedNames);
      // The core profile must stay smaller than the full registered surface.
      expect(wireNames.length).toBeLessThanOrEqual(allToolNames.length);
    });

    test("given a tool is registered, endpoint should return a list with that tool", async function () {
      const { client } = fixture.getContext();

      // Send list_tools request
      const result = await client.request(
        {
          method: "tools/list",
          params: {},
        },
        listToolsResponseSchema,
      );

      // Verify tools list contains registered tools
      expect(typeof result).toBe("object");
      expect(result).toHaveProperty("tools");
      expect(Array.isArray(result.tools)).toBe(true);
      expect(result.tools.length).toBeGreaterThan(0);

      // Verify each tool has required properties
      result.tools.forEach((tool) => {
        expect(tool).toHaveProperty("name");
        expect(tool).toHaveProperty("description");
        expect(tool).toHaveProperty("inputSchema");
        expect(typeof tool.name).toBe("string");
        expect(typeof tool.description).toBe("string");
        expect(typeof tool.inputSchema).toBe("object");
      });

      // Verify we have some expected tools (like observe, etc.)
      const toolNames = result.tools.map((tool) => tool.name);
      expect(toolNames).toContain("observe");
      expect(toolNames).toContain("tapOn");
      expect(toolNames).toContain("inputText");
      expect(toolNames).not.toContain("clipboard");
      expect(toolNames).not.toContain("openLink");
      expect(toolNames).not.toContain("provisionDevice");
      expect(toolNames).not.toContain("deleteDevice");
      expect(toolNames).not.toContain("settleObserve");
      expect(toolNames).not.toContain("waitForCondition");
    });

    test("lists deleteDevice after it is explicitly enabled", async function () {
      const { client } = fixture.getContext();

      await client.request(
        {
          method: "tools/call",
          params: {
            name: "setToolEnabled",
            arguments: { toolName: "deleteDevice", enabled: true },
          },
        },
        z.any(),
      );

      const result = await client.request(
        { method: "tools/list", params: {} },
        listToolsResponseSchema,
      );

      expect(result.tools.map((tool) => tool.name)).toContain("deleteDevice");
    });

    test("strict clients can compile observe outputSchema", async function () {
      const { client } = fixture.getContext();

      const result = await client.request(
        {
          method: "tools/list",
          params: {},
        },
        listToolsResponseSchema,
      );

      const observe = result.tools.find((tool) => tool.name === "observe");

      expect(observe?.outputSchema).toBeDefined();
      expect(() => compileJsonSchema(observe!.outputSchema)).not.toThrow();
    });
  });
});
