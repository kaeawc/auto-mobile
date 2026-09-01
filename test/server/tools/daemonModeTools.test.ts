import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { registerMcpTools } from "../../../src/server/index";
import { ToolRegistry } from "../../../src/server/toolRegistry";
import { serverConfig } from "../../../src/utils/ServerConfig";
import { setDebugModeEnabled } from "../../../src/utils/debug";

describe("Daemon-only MCP tools", () => {
  beforeEach(() => {
    (ToolRegistry as any).tools.clear();
  });

  afterEach(() => {
    setDebugModeEnabled(false);
    serverConfig.setEmbeddedSdkEnabled(false);
    (ToolRegistry as any).tools.clear();
  });

  test("registers plan tools in both modes, criticalSection only in daemon mode", () => {
    registerMcpTools(false);

    const toolNames = ToolRegistry.getToolDefinitions().map((tool) => tool.name);
    expect(toolNames).toContain("executePlan");
    expect(toolNames).not.toContain("criticalSection");
  });

  test("registers criticalSection/barrier plan-only in daemon mode (hidden from discovery, usable in plans)", () => {
    registerMcpTools(true);

    const toolNames = ToolRegistry.getToolDefinitions().map((tool) => tool.name);
    expect(toolNames).toContain("executePlan");
    // Plan-only coordination primitives are registered in daemon mode but hidden
    // from normal discovery — a single direct call would just block.
    expect(toolNames).not.toContain("criticalSection");
    expect(toolNames).not.toContain("barrier");
    expect(ToolRegistry.getTool("criticalSection")).toBeUndefined();
    expect(ToolRegistry.getTool("barrier")).toBeUndefined();
    // ...but resolvable for plan execution.
    expect(ToolRegistry.getToolForPlan("criticalSection")).toBeDefined();
    expect(ToolRegistry.getToolForPlan("barrier")).toBeDefined();
  });

  test("hides debug-only tools unless debug mode is enabled", () => {
    registerMcpTools(false);

    expect(ToolRegistry.getTool("accessibilityFocus")).toBeUndefined();
    expect(ToolRegistry.getTool("setUIState")).toBeUndefined();
    expect(ToolRegistry.getToolForPlan("accessibilityFocus")).toBeUndefined();
    expect(ToolRegistry.getToolForPlan("setUIState")).toBeDefined();
    expect(ToolRegistry.getToolDefinitions().map((tool) => tool.name)).not.toContain(
      "accessibilityFocus",
    );
    expect(ToolRegistry.getToolDefinitions().map((tool) => tool.name)).not.toContain("setUIState");

    (ToolRegistry as any).tools.clear();
    setDebugModeEnabled(true);
    registerMcpTools(false);

    expect(ToolRegistry.getTool("accessibilityFocus")).toBeDefined();
    expect(ToolRegistry.getTool("setUIState")).toBeDefined();
    expect(ToolRegistry.getToolForPlan("accessibilityFocus")).toBeDefined();
    expect(ToolRegistry.getToolForPlan("setUIState")).toBeDefined();
    expect(ToolRegistry.getToolDefinitions().map((tool) => tool.name)).toContain(
      "accessibilityFocus",
    );
    expect(ToolRegistry.getToolDefinitions().map((tool) => tool.name)).toContain("setUIState");
  });

  test("hides embedded-SDK tools unless embedded SDK mode is enabled", () => {
    const embeddedSdkTools = [
      "sqlQuery",
      "setKeyValue",
      "removeKeyValue",
      "clearKeyValueFile",
      "network",
      "mockNetwork",
      "clearMockNetwork",
      "getNetworkGraph",
    ];

    registerMcpTools(false);

    const defaultNames = ToolRegistry.getToolDefinitions().map((tool) => tool.name);
    for (const toolName of embeddedSdkTools) {
      expect(ToolRegistry.getTool(toolName)).toBeUndefined();
      expect(defaultNames).not.toContain(toolName);
    }

    (ToolRegistry as any).tools.clear();
    serverConfig.setEmbeddedSdkEnabled(true);
    registerMcpTools(false);

    const embeddedSdkNames = ToolRegistry.getToolDefinitions().map((tool) => tool.name);
    for (const toolName of embeddedSdkTools) {
      expect(ToolRegistry.getTool(toolName)).toBeDefined();
      expect(embeddedSdkNames).toContain(toolName);
    }
  });
});
