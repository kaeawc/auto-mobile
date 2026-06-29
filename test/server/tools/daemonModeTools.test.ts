import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createMcpServer } from "../../../src/server/index";
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
    createMcpServer();

    const toolNames = ToolRegistry.getToolDefinitions().map(tool => tool.name);
    expect(toolNames).toContain("executePlan");
    expect(toolNames).not.toContain("criticalSection");
  });

  test("registers criticalSection in daemon mode", () => {
    createMcpServer({ daemonMode: true });

    const toolNames = ToolRegistry.getToolDefinitions().map(tool => tool.name);
    expect(toolNames).toContain("executePlan");
    expect(toolNames).toContain("criticalSection");
  });

  test("hides debug-only tools unless debug mode is enabled", () => {
    createMcpServer();

    expect(ToolRegistry.getTool("accessibilityFocus")).toBeUndefined();
    expect(ToolRegistry.getTool("setUIState")).toBeUndefined();
    expect(ToolRegistry.getToolDefinitions().map(tool => tool.name)).not.toContain("accessibilityFocus");
    expect(ToolRegistry.getToolDefinitions().map(tool => tool.name)).not.toContain("setUIState");

    (ToolRegistry as any).tools.clear();
    setDebugModeEnabled(true);
    createMcpServer({ debug: true });

    expect(ToolRegistry.getTool("accessibilityFocus")).toBeDefined();
    expect(ToolRegistry.getTool("setUIState")).toBeDefined();
    expect(ToolRegistry.getToolDefinitions().map(tool => tool.name)).toContain("accessibilityFocus");
    expect(ToolRegistry.getToolDefinitions().map(tool => tool.name)).toContain("setUIState");
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

    createMcpServer();

    const defaultNames = ToolRegistry.getToolDefinitions().map(tool => tool.name);
    for (const toolName of embeddedSdkTools) {
      expect(ToolRegistry.getTool(toolName)).toBeUndefined();
      expect(defaultNames).not.toContain(toolName);
    }

    (ToolRegistry as any).tools.clear();
    serverConfig.setEmbeddedSdkEnabled(true);
    createMcpServer();

    const embeddedSdkNames = ToolRegistry.getToolDefinitions().map(tool => tool.name);
    for (const toolName of embeddedSdkTools) {
      expect(ToolRegistry.getTool(toolName)).toBeDefined();
      expect(embeddedSdkNames).toContain(toolName);
    }
  });
});
