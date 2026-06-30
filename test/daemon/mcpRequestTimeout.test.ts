import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  DEFAULT_MCP_REQUEST_TIMEOUT_MS,
  DEFAULT_OPEN_LINK_MCP_TIMEOUT_MS,
  LEGACY_OPEN_LINK_MCP_TIMEOUT_ENV_VAR,
  MIN_EXECUTE_PLAN_MCP_TIMEOUT_MS,
  MIN_START_DEVICE_MCP_TIMEOUT_MS,
  OPEN_LINK_MCP_TIMEOUT_ENV_VAR,
  resolveMcpRequestTimeoutMs
} from "../../src/daemon/mcpRequestTimeout";
import type { DaemonRequest } from "../../src/daemon/types";

describe("resolveMcpRequestTimeoutMs", () => {
  const originalOpenLinkTimeout = process.env[OPEN_LINK_MCP_TIMEOUT_ENV_VAR];
  const originalLegacyOpenLinkTimeout = process.env[LEGACY_OPEN_LINK_MCP_TIMEOUT_ENV_VAR];

  beforeEach(() => {
    delete process.env[OPEN_LINK_MCP_TIMEOUT_ENV_VAR];
    delete process.env[LEGACY_OPEN_LINK_MCP_TIMEOUT_ENV_VAR];
  });

  afterEach(() => {
    if (originalOpenLinkTimeout === undefined) {
      delete process.env[OPEN_LINK_MCP_TIMEOUT_ENV_VAR];
    } else {
      process.env[OPEN_LINK_MCP_TIMEOUT_ENV_VAR] = originalOpenLinkTimeout;
    }
    if (originalLegacyOpenLinkTimeout === undefined) {
      delete process.env[LEGACY_OPEN_LINK_MCP_TIMEOUT_ENV_VAR];
    } else {
      process.env[LEGACY_OPEN_LINK_MCP_TIMEOUT_ENV_VAR] = originalLegacyOpenLinkTimeout;
    }
  });

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

  test("default openLink floor is higher than the standard request timeout", () => {
    // A deeplink that launches the app and performs a login/network round-trip can
    // take ~45s end to end, exceeding the 30s standard timeout (issue #2723). The
    // default floor must give those calls room to finish rather than aborting a
    // link-open that actually succeeds on screen.
    expect(DEFAULT_OPEN_LINK_MCP_TIMEOUT_MS).toBe(90_000);
    expect(DEFAULT_OPEN_LINK_MCP_TIMEOUT_MS).toBeGreaterThan(DEFAULT_MCP_REQUEST_TIMEOUT_MS);
  });

  test("applies default openLink floor when client omits timeoutMs", () => {
    const request: DaemonRequest = {
      id: "1",
      type: "mcp_request",
      method: "tools/call",
      params: { name: "openLink", arguments: {} }
    };
    expect(resolveMcpRequestTimeoutMs(request)).toBe(DEFAULT_OPEN_LINK_MCP_TIMEOUT_MS);
  });

  test("raises short openLink timeouts to the default floor", () => {
    const request: DaemonRequest = {
      id: "1",
      type: "mcp_request",
      method: "tools/call",
      params: { name: "openLink", arguments: {} },
      timeoutMs: 10_000
    };
    expect(resolveMcpRequestTimeoutMs(request)).toBe(DEFAULT_OPEN_LINK_MCP_TIMEOUT_MS);
  });

  test("applies configured openLink floor from environment", () => {
    process.env[OPEN_LINK_MCP_TIMEOUT_ENV_VAR] = "90000";

    const request: DaemonRequest = {
      id: "1",
      type: "mcp_request",
      method: "tools/call",
      params: { name: "openLink", arguments: {} }
    };
    expect(resolveMcpRequestTimeoutMs(request)).toBe(90_000);
  });

  test("applies legacy configured openLink floor from environment", () => {
    process.env[LEGACY_OPEN_LINK_MCP_TIMEOUT_ENV_VAR] = "45000";

    const request: DaemonRequest = {
      id: "1",
      type: "mcp_request",
      method: "tools/call",
      params: { name: "openLink", arguments: {} }
    };
    expect(resolveMcpRequestTimeoutMs(request)).toBe(45_000);
  });

  test("raises short openLink timeouts to configured environment floor", () => {
    process.env[OPEN_LINK_MCP_TIMEOUT_ENV_VAR] = "90000";

    const request: DaemonRequest = {
      id: "1",
      type: "mcp_request",
      method: "tools/call",
      params: { name: "openLink", arguments: {} },
      timeoutMs: 30_000
    };
    expect(resolveMcpRequestTimeoutMs(request)).toBe(90_000);
  });

  test("preserves openLink timeouts above configured environment floor", () => {
    process.env[OPEN_LINK_MCP_TIMEOUT_ENV_VAR] = "90000";

    const request: DaemonRequest = {
      id: "1",
      type: "mcp_request",
      method: "tools/call",
      params: { name: "openLink", arguments: {} },
      timeoutMs: 120_000
    };
    expect(resolveMcpRequestTimeoutMs(request)).toBe(120_000);
  });

  test("falls back to default openLink floor for invalid environment values", () => {
    process.env[OPEN_LINK_MCP_TIMEOUT_ENV_VAR] = "not-a-number";

    const request: DaemonRequest = {
      id: "1",
      type: "mcp_request",
      method: "tools/call",
      params: { name: "openLink", arguments: {} },
      timeoutMs: 10_000
    };
    expect(resolveMcpRequestTimeoutMs(request)).toBe(DEFAULT_OPEN_LINK_MCP_TIMEOUT_MS);
  });
});
