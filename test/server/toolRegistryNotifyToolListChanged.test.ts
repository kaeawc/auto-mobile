import { describe, expect, test } from "bun:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ToolRegistry } from "../../src/server/toolRegistry";

// Minimal MCP-server stand-in: registerWithServer only calls registerTool (no-op
// here) and stores the server; notifyToolListChanged calls sendToolListChanged.
class FakeMcpServer {
  calls = 0;
  shouldThrow = false;
  registerTool(): void {
    // no-op — we only care about the notify path
  }
  sendToolListChanged(): void {
    this.calls += 1;
    if (this.shouldThrow) {
      throw new Error("send boom");
    }
  }
}

describe("ToolRegistry.notifyToolListChanged", () => {
  test("delegates to server.sendToolListChanged() after registerWithServer", () => {
    const server = new FakeMcpServer();
    ToolRegistry.registerWithServer(server as unknown as McpServer);

    ToolRegistry.notifyToolListChanged();

    expect(server.calls).toBe(1);
  });

  test("swallows sendToolListChanged errors (best-effort, never throws)", () => {
    const server = new FakeMcpServer();
    server.shouldThrow = true;
    ToolRegistry.registerWithServer(server as unknown as McpServer);

    expect(() => ToolRegistry.notifyToolListChanged()).not.toThrow();
    expect(server.calls).toBe(1);
  });
});
