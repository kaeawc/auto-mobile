import { describe, expect, test } from "bun:test";
import {
  DEFAULT_MCP_REQUEST_TIMEOUT_MS,
  MIN_EXECUTE_PLAN_MCP_TIMEOUT_MS,
  MIN_START_DEVICE_MCP_TIMEOUT_MS,
  resolveMcpRequestTimeoutMs
} from "../../src/daemon/mcpRequestTimeout";
import type { DaemonRequest } from "../../src/daemon/types";

describe("resolveMcpRequestTimeoutMs", () => {
  test("uses default for non-executePlan tools/call", () => {
    const request: DaemonRequest = {
      id: "1",
      type: "mcp_request",
      method: "tools/call",
      params: { name: "observe", arguments: {} }
    };
    expect(resolveMcpRequestTimeoutMs(request)).toBe(DEFAULT_MCP_REQUEST_TIMEOUT_MS);
  });

  test("applies executePlan floor when client omits timeoutMs", () => {
    const request: DaemonRequest = {
      id: "1",
      type: "mcp_request",
      method: "tools/call",
      params: { name: "executePlan", arguments: {} }
    };
    expect(resolveMcpRequestTimeoutMs(request)).toBe(MIN_EXECUTE_PLAN_MCP_TIMEOUT_MS);
  });

  test("raises short executePlan timeouts to the floor", () => {
    const request: DaemonRequest = {
      id: "1",
      type: "mcp_request",
      method: "tools/call",
      params: { name: "executePlan", arguments: {} },
      timeoutMs: 180_000
    };
    expect(resolveMcpRequestTimeoutMs(request)).toBe(MIN_EXECUTE_PLAN_MCP_TIMEOUT_MS);
  });

  test("preserves executePlan timeouts above the floor", () => {
    const request: DaemonRequest = {
      id: "1",
      type: "mcp_request",
      method: "tools/call",
      params: { name: "executePlan", arguments: {} },
      timeoutMs: 900_000
    };
    expect(resolveMcpRequestTimeoutMs(request)).toBe(900_000);
  });

  test("falls back to default for NaN timeoutMs", () => {
    const request: DaemonRequest = {
      id: "1",
      type: "mcp_request",
      method: "tools/call",
      params: { name: "observe", arguments: {} },
      timeoutMs: NaN
    };
    expect(resolveMcpRequestTimeoutMs(request)).toBe(DEFAULT_MCP_REQUEST_TIMEOUT_MS);
  });

  test("falls back to default for Infinity timeoutMs", () => {
    const request: DaemonRequest = {
      id: "1",
      type: "mcp_request",
      method: "tools/call",
      params: { name: "executePlan", arguments: {} },
      timeoutMs: Infinity
    };
    expect(resolveMcpRequestTimeoutMs(request)).toBe(MIN_EXECUTE_PLAN_MCP_TIMEOUT_MS);
  });

  test("falls back to default for negative timeoutMs", () => {
    const request: DaemonRequest = {
      id: "1",
      type: "mcp_request",
      method: "tools/call",
      params: { name: "observe", arguments: {} },
      timeoutMs: -1
    };
    expect(resolveMcpRequestTimeoutMs(request)).toBe(DEFAULT_MCP_REQUEST_TIMEOUT_MS);
  });

  test("falls back to default for zero timeoutMs", () => {
    const request: DaemonRequest = {
      id: "1",
      type: "mcp_request",
      method: "tools/call",
      params: { name: "observe", arguments: {} },
      timeoutMs: 0
    };
    expect(resolveMcpRequestTimeoutMs(request)).toBe(DEFAULT_MCP_REQUEST_TIMEOUT_MS);
  });

  test("applies startDevice floor when client omits timeoutMs", () => {
    const request: DaemonRequest = {
      id: "1",
      type: "mcp_request",
      method: "tools/call",
      params: { name: "startDevice", arguments: {} }
    };
    expect(resolveMcpRequestTimeoutMs(request)).toBe(MIN_START_DEVICE_MCP_TIMEOUT_MS);
  });

  test("raises short startDevice timeouts to the floor", () => {
    const request: DaemonRequest = {
      id: "1",
      type: "mcp_request",
      method: "tools/call",
      params: { name: "startDevice", arguments: {} },
      timeoutMs: 60_000
    };
    expect(resolveMcpRequestTimeoutMs(request)).toBe(MIN_START_DEVICE_MCP_TIMEOUT_MS);
  });

  test("preserves startDevice timeouts above the floor", () => {
    const request: DaemonRequest = {
      id: "1",
      type: "mcp_request",
      method: "tools/call",
      params: { name: "startDevice", arguments: {} },
      timeoutMs: 300_000
    };
    expect(resolveMcpRequestTimeoutMs(request)).toBe(300_000);
  });
});
