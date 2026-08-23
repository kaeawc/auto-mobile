import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createMcpServer } from "../../../src/server/index";
import { ToolRegistry } from "../../../src/server/toolRegistry";
import { serverConfig } from "../../../src/utils/ServerConfig";

describe("MCP Tools Registry", () => {
  beforeAll(() => {
    createMcpServer();
  });

  test("should expose all required MCP tools through the registry", () => {
    // Test that the server exposes MCP tools correctly
    const toolDefinitions = ToolRegistry.getToolDefinitions();
    expect(Array.isArray(toolDefinitions)).toBe(true);
    expect(toolDefinitions.length).toBeGreaterThan(0);

    // Verify we have the expected tool categories for MCP protocol
    const toolNames = toolDefinitions.map(tool => tool.name);

    // Should include observe tools (core MCP functionality)
    expect(toolNames).toContain("observe");

    // Should include interaction tools (MCP touch/gesture tools)
    expect(toolNames).toContain("tapOn");

    // Should include app management tools (MCP app lifecycle)
    expect(toolNames).toContain("launchApp");
    expect(toolNames).toContain("terminateApp");
    expect(toolNames).toContain("listApps");

  });

  test("should maintain singleton registry across server instances", () => {
    // This tests the MCP initialization pattern
    createMcpServer();

    const tools1 = ToolRegistry.getToolDefinitions();
    const tools2 = ToolRegistry.getToolDefinitions();

    // Both should reference the same registry (MCP pattern)
    expect(tools1.length).toBe(tools2.length);
    expect(tools1.map(t => t.name).sort()).toEqual(tools2.map(t => t.name).sort());

    // Registry should be consistent
    expect(ToolRegistry.getAllTools().length).toBe(tools1.length);
  });

  test("should provide tools that can be executed (handler functions exist)", () => {
    const allTools = ToolRegistry.getAllTools();

    // Each registered tool should have an executable handler
    allTools.forEach(tool => {
      expect(tool).toHaveProperty("handler");
      expect(typeof tool.handler).toBe("function");

      // Should also have a schema for validation
      expect(tool).toHaveProperty("schema");
      expect(typeof tool.schema).toBe("object");
    });
  });

  test("should expose registered output schemas in generated MCP tool definitions", () => {
    const toolDefinitions = ToolRegistry.getToolDefinitions();

    for (const toolName of ["executePlan", "tapOn"]) {
      const tool = toolDefinitions.find(definition => definition.name === toolName);
      expect(tool).toBeDefined();
      expect(tool).toHaveProperty("outputSchema");
      expect(tool!.outputSchema).toHaveProperty("type", "object");
      expect(tool!.outputSchema.properties).toHaveProperty("success");
      expect(tool!.outputSchema.required).toContain("success");
    }
  });

  describe("toolResultsNoStructuredContent gate (issue #2899)", () => {
    afterEach(() => {
      serverConfig.setToolResultsNoStructuredContentEnabled(false);
    });

    test("EC-H: omits outputSchema from tool definitions when the gate is enabled", () => {
      // Baseline: outputSchema advertised when the gate is off.
      serverConfig.setToolResultsNoStructuredContentEnabled(false);
      const withSchema = ToolRegistry.getToolDefinitions().find(t => t.name === "tapOn");
      expect(withSchema).toHaveProperty("outputSchema");

      // With the gate on, the server no longer advertises structuredContent output,
      // keeping tools/list consistent with the stripped tool results.
      serverConfig.setToolResultsNoStructuredContentEnabled(true);
      const defs = ToolRegistry.getToolDefinitions();
      for (const def of defs) {
        expect(def.outputSchema).toBeUndefined();
      }
    });
  });

  // R4 (issue #4181, rank 17): the previous roster referenced FICTIONAL tools
  // (sendText, changeOrientation, openUrl, exitDialog, checkRunningDevices) and
  // guarded with `.filter(...).length > 0` plus a magic `> 15` floor, so it
  // passed even if all but one real name per category vanished. This asserts an
  // EXACT roster of tools that actually register, each by its real name — a
  // renamed or dropped tool reds the specific row.
  test("registers the exact expected tool in each category by real name", () => {
    const toolNames = new Set(ToolRegistry.getToolDefinitions().map(tool => tool.name));

    const expectedByCategory: Record<string, string[]> = {
      observe: ["observe"],
      interaction: ["tapOn", "inputText", "clearText", "pressButton", "swipeOn", "dragAndDrop", "pinchOn"],
      app: ["launchApp", "terminateApp", "installApp", "uninstallApp", "listApps"],
      utility: ["rotate", "setActiveDevice", "openLink", "getDeviceState", "setDeviceState"],
      device: ["listDeviceImages", "listDevices", "getAndroid", "getApple", "killDevice", "deleteDevice"],
    };

    for (const [category, expected] of Object.entries(expectedByCategory)) {
      for (const name of expected) {
        expect(toolNames.has(name), `${category} tool "${name}" should be registered`).toBe(true);
      }
    }
  });

  // D6 backstop (issue #4181, rank 15): serverSetup.test.ts is deleted; this
  // is the surviving "did createMcpServer register the core tool" smoke.
  test("createMcpServer registers the core observe tool", () => {
    expect(ToolRegistry.getToolDefinitions().map(t => t.name)).toContain("observe");
  });
});
