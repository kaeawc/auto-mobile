import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  DEFAULT_MCP_REQUEST_TIMEOUT_MS,
  DEFAULT_OBSERVE_MCP_TIMEOUT_MS,
  DEFAULT_OPEN_LINK_MCP_TIMEOUT_MS,
  LEGACY_OBSERVE_MCP_TIMEOUT_ENV_VAR,
  LEGACY_OPEN_LINK_MCP_TIMEOUT_ENV_VAR,
  MIN_EXECUTE_PLAN_MCP_TIMEOUT_MS,
  MIN_START_DEVICE_MCP_TIMEOUT_MS,
  OBSERVE_MCP_TIMEOUT_ENV_VAR,
  OPEN_LINK_MCP_TIMEOUT_ENV_VAR,
  resolveMcpRequestTimeoutMs
} from "../../src/daemon/mcpRequestTimeout";
import type { DaemonRequest } from "../../src/daemon/types";

describe("resolveMcpRequestTimeoutMs", () => {
  const timeoutEnvVars = [
    OPEN_LINK_MCP_TIMEOUT_ENV_VAR,
    LEGACY_OPEN_LINK_MCP_TIMEOUT_ENV_VAR,
    OBSERVE_MCP_TIMEOUT_ENV_VAR,
    LEGACY_OBSERVE_MCP_TIMEOUT_ENV_VAR,
  ];
  const originalEnv = new Map(timeoutEnvVars.map(name => [name, process.env[name]]));

  beforeEach(() => {
    for (const name of timeoutEnvVars) {
      delete process.env[name];
    }
  });

  afterEach(() => {
    for (const name of timeoutEnvVars) {
      const original = originalEnv.get(name);
      if (original === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = original;
      }
    }
  });

  test("uses default for a tool without a floor", () => {
    const request: DaemonRequest = {
      id: "1",
      type: "mcp_request",
      method: "tools/call",
      params: { name: "tapOn", arguments: {} }
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
      params: { name: "tapOn", arguments: {} },
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
      params: { name: "tapOn", arguments: {} },
      timeoutMs: -1
    };
    expect(resolveMcpRequestTimeoutMs(request)).toBe(DEFAULT_MCP_REQUEST_TIMEOUT_MS);
  });

  test("falls back to default for zero timeoutMs", () => {
    const request: DaemonRequest = {
      id: "1",
      type: "mcp_request",
      method: "tools/call",
      params: { name: "tapOn", arguments: {} },
      timeoutMs: 0
    };
    expect(resolveMcpRequestTimeoutMs(request)).toBe(DEFAULT_MCP_REQUEST_TIMEOUT_MS);
  });

  test("default observe floor is higher than the standard request timeout", () => {
    expect(DEFAULT_OBSERVE_MCP_TIMEOUT_MS).toBe(90_000);
    expect(DEFAULT_OBSERVE_MCP_TIMEOUT_MS).toBeGreaterThan(DEFAULT_MCP_REQUEST_TIMEOUT_MS);
  });

  test("applies default observe floor when client omits timeoutMs", () => {
    const request: DaemonRequest = {
      id: "1",
      type: "mcp_request",
      method: "tools/call",
      params: { name: "observe", arguments: {} }
    };
    expect(resolveMcpRequestTimeoutMs(request)).toBe(DEFAULT_OBSERVE_MCP_TIMEOUT_MS);
  });

  test("raises short observe timeouts to the floor (the CI cold-start case)", () => {
    const request: DaemonRequest = {
      id: "1",
      type: "mcp_request",
      method: "tools/call",
      params: { name: "observe", arguments: {} },
      timeoutMs: 30_000
    };
    expect(resolveMcpRequestTimeoutMs(request)).toBe(DEFAULT_OBSERVE_MCP_TIMEOUT_MS);
  });

  test("preserves observe timeouts above the floor", () => {
    const request: DaemonRequest = {
      id: "1",
      type: "mcp_request",
      method: "tools/call",
      params: { name: "observe", arguments: {} },
      timeoutMs: 150_000
    };
    expect(resolveMcpRequestTimeoutMs(request)).toBe(150_000);
  });

  test("applies configured observe floor from environment", () => {
    process.env[OBSERVE_MCP_TIMEOUT_ENV_VAR] = "150000";
    const request: DaemonRequest = {
      id: "1",
      type: "mcp_request",
      method: "tools/call",
      params: { name: "observe", arguments: {} }
    };
    expect(resolveMcpRequestTimeoutMs(request)).toBe(150_000);
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
