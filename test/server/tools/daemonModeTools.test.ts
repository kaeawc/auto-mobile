import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { createMcpServer } from "../../../src/server/index";
import { ToolRegistry } from "../../../src/server/toolRegistry";
import { serverConfig } from "../../../src/utils/ServerConfig";
import { setDebugModeEnabled } from "../../../src/utils/debug";
import { McpTestFixture } from "../../fixtures/mcpTestFixture";

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

  test("registers criticalSection/barrier plan-only in daemon mode (hidden from discovery, usable in plans)", () => {
    createMcpServer({ daemonMode: true });

    const toolNames = ToolRegistry.getToolDefinitions().map(tool => tool.name);
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
    createMcpServer();

    expect(ToolRegistry.getTool("accessibilityFocus")).toBeUndefined();
    expect(ToolRegistry.getTool("setUIState")).toBeUndefined();
    expect(ToolRegistry.getToolForPlan("accessibilityFocus")).toBeUndefined();
    expect(ToolRegistry.getToolForPlan("setUIState")).toBeDefined();
    expect(ToolRegistry.getToolDefinitions().map(tool => tool.name)).not.toContain("accessibilityFocus");
    expect(ToolRegistry.getToolDefinitions().map(tool => tool.name)).not.toContain("setUIState");

    (ToolRegistry as any).tools.clear();
    setDebugModeEnabled(true);
    createMcpServer({ debug: true });

    expect(ToolRegistry.getTool("accessibilityFocus")).toBeDefined();
    expect(ToolRegistry.getTool("setUIState")).toBeDefined();
    expect(ToolRegistry.getToolForPlan("accessibilityFocus")).toBeDefined();
    expect(ToolRegistry.getToolForPlan("setUIState")).toBeDefined();
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

// Issue #4181, rank 1 (A1): the registry-level assertions above prove
// getToolDefinitions()/getTool() hide these tools, but the regression that
// matters is over the WIRE — a raw MCP client must not be able to call them.
// The CallTool handler resolves names through getTool() (index.ts). Mutating
// that resolve to getToolForPlan() would make criticalSection/barrier/setUIState
// directly callable; these rows red on that mutation because the call would no
// longer be rejected as an unknown tool.
describe("plan-only/debug-only tools are ungated over the wire", () => {
  let fixture: McpTestFixture;

  const permissiveResult = z.object({}).passthrough();

  beforeAll(async () => {
    (ToolRegistry as any).tools.clear();
    // Daemon mode registers criticalSection/barrier plan-only; debug OFF keeps
    // setUIState plan-only (resolvable via getToolForPlan, hidden from getTool).
    fixture = new McpTestFixture({ daemonMode: true });
    await fixture.setup();
  });

  afterAll(async () => {
    if (fixture) {
      await fixture.teardown();
    }
    (ToolRegistry as any).tools.clear();
  });

  test.each(["criticalSection", "barrier", "setUIState"])(
    "%s is rejected as an unknown tool when called directly over the wire",
    async name => {
      const { client } = fixture.getContext();
      await expect(
        client.request({ method: "tools/call", params: { name, arguments: {} } }, permissiveResult)
      ).rejects.toThrow("Unknown tool");
    }
  );

  test("a normally-advertised tool is NOT rejected as unknown (control)", async () => {
    // executePlan is advertised in both modes, so it resolves through getTool
    // and does not produce an "Unknown tool" rejection (it may fail validation,
    // but not with that message).
    const { client } = fixture.getContext();
    let message = "";
    try {
      await client.request(
        { method: "tools/call", params: { name: "executePlan", arguments: {} } },
        permissiveResult
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toContain("Unknown tool");
  });
});
