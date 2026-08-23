import { describe, expect, test } from "bun:test";
import { McpTimeoutError } from "../../src/daemon/McpTimeoutError";

describe("McpTimeoutError", () => {
  test("formats message with tool name, timeout, and origin", () => {
    const err = new McpTimeoutError({
      toolName: "startDevice",
      timeoutMs: 180_000,
      origin: "DaemonClient.sendRequest",
    });
    expect(err.message).toBe(
      "MCP timeout: startDevice exceeded 180000ms at DaemonClient.sendRequest",
    );
    expect(err.name).toBe("McpTimeoutError");
    expect(err.toolName).toBe("startDevice");
    expect(err.timeoutMs).toBe(180_000);
    expect(err.origin).toBe("DaemonClient.sendRequest");
  });

  test("includes detail when provided", () => {
    const err = new McpTimeoutError({
      toolName: "executePlan",
      timeoutMs: 600_000,
      origin: "UnixSocketServer.handleRequest",
      detail: "spent 601000ms waiting in queue",
    });
    expect(err.message).toBe(
      "MCP timeout: executePlan exceeded 600000ms at UnixSocketServer.handleRequest (spent 601000ms waiting in queue)",
    );
  });
});
