import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  DEFAULT_MCP_REQUEST_TIMEOUT_MS,
  DEFAULT_OBSERVE_MCP_TIMEOUT_MS,
  DEFAULT_OPEN_LINK_MCP_TIMEOUT_MS,
  LEGACY_OBSERVE_MCP_TIMEOUT_ENV_VAR,
  LEGACY_OPEN_LINK_MCP_TIMEOUT_ENV_VAR,
  MIN_EXECUTE_PLAN_MCP_TIMEOUT_MS,
  MIN_LAUNCH_APP_MCP_TIMEOUT_MS,
  MIN_START_DEVICE_MCP_TIMEOUT_MS,
  OBSERVE_MCP_TIMEOUT_ENV_VAR,
  OPEN_LINK_MCP_TIMEOUT_ENV_VAR,
  START_DEVICE_MCP_TIMEOUT_OVERHEAD_MS,
  resolveMcpRequestTimeoutMs
} from "../../src/daemon/mcpRequestTimeout";
import type { DaemonRequest } from "../../src/daemon/types";
import { MAX_DEVICE_READY_TIMEOUT_MS } from "../../src/utils/deviceTimeouts";

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

  // The floor resolution (src/daemon/mcpRequestTimeout.ts:96-107) is:
  //   base  = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT
  //   floor = method === "tools/call" ? toolFloor(params.name) : undefined
  //   result = floor ? Math.max(base, floor) : base
  //
  // Each row below is one point in that spec. `tool` is the tools/call param name
  // (omit to exercise the non-"tools/call" gate via an explicit `method`).
  interface TimeoutCase {
    name: string;
    tool?: string;
    method?: string;
    timeoutMs?: number;
    env?: Record<string, string>;
    expected: number;
  }

  const cases: TimeoutCase[] = [
    // --- Tool floors applied when the client omits timeoutMs (base -> DEFAULT) ---
    { name: "tool without a floor -> default", tool: "tapOn", expected: DEFAULT_MCP_REQUEST_TIMEOUT_MS },
    { name: "executePlan floor when timeoutMs omitted", tool: "executePlan", expected: MIN_EXECUTE_PLAN_MCP_TIMEOUT_MS },
    { name: "startDevice floor when timeoutMs omitted", tool: "startDevice", expected: MIN_START_DEVICE_MCP_TIMEOUT_MS },
    { name: "launchApp floor when timeoutMs omitted", tool: "launchApp", expected: MIN_LAUNCH_APP_MCP_TIMEOUT_MS },
    { name: "observe default floor when timeoutMs omitted", tool: "observe", expected: DEFAULT_OBSERVE_MCP_TIMEOUT_MS },
    { name: "openLink default floor when timeoutMs omitted", tool: "openLink", expected: DEFAULT_OPEN_LINK_MCP_TIMEOUT_MS },

    // --- Short timeouts are raised to the floor (base < floor) ---
    { name: "raises short executePlan to floor", tool: "executePlan", timeoutMs: 180_000, expected: MIN_EXECUTE_PLAN_MCP_TIMEOUT_MS },
    { name: "raises short startDevice to floor", tool: "startDevice", timeoutMs: 60_000, expected: MIN_START_DEVICE_MCP_TIMEOUT_MS },
    { name: "raises short launchApp to floor", tool: "launchApp", timeoutMs: 10_000, expected: MIN_LAUNCH_APP_MCP_TIMEOUT_MS },
    { name: "raises short observe to floor", tool: "observe", timeoutMs: 30_000, expected: DEFAULT_OBSERVE_MCP_TIMEOUT_MS },
    { name: "raises short openLink to floor", tool: "openLink", timeoutMs: 10_000, expected: DEFAULT_OPEN_LINK_MCP_TIMEOUT_MS },

    // --- Timeouts above the floor are preserved (base > floor) ---
    { name: "preserves executePlan above floor", tool: "executePlan", timeoutMs: 900_000, expected: 900_000 },
    { name: "preserves startDevice above floor", tool: "startDevice", timeoutMs: 300_000, expected: 300_000 },
    { name: "preserves launchApp above floor", tool: "launchApp", timeoutMs: 150_000, expected: 150_000 },
    { name: "preserves observe above floor", tool: "observe", timeoutMs: 150_000, expected: 150_000 },

    // --- Boundary: base exactly equal to the floor stays put (Math.max is idempotent) ---
    { name: "executePlan exactly at floor stays", tool: "executePlan", timeoutMs: MIN_EXECUTE_PLAN_MCP_TIMEOUT_MS, expected: MIN_EXECUTE_PLAN_MCP_TIMEOUT_MS },
    { name: "launchApp exactly at floor stays", tool: "launchApp", timeoutMs: MIN_LAUNCH_APP_MCP_TIMEOUT_MS, expected: MIN_LAUNCH_APP_MCP_TIMEOUT_MS },

    // --- Degenerate base values collapse to DEFAULT (not finite / not > 0) ---
    { name: "NaN base -> default (no floor)", tool: "tapOn", timeoutMs: NaN, expected: DEFAULT_MCP_REQUEST_TIMEOUT_MS },
    { name: "Infinity base -> default (no floor)", tool: "tapOn", timeoutMs: Infinity, expected: DEFAULT_MCP_REQUEST_TIMEOUT_MS },
    // Infinity is not finite, so base collapses to DEFAULT and is then floored by the tool.
    { name: "Infinity base -> default then floored", tool: "executePlan", timeoutMs: Infinity, expected: MIN_EXECUTE_PLAN_MCP_TIMEOUT_MS },
    { name: "negative base -> default (no floor)", tool: "tapOn", timeoutMs: -1, expected: DEFAULT_MCP_REQUEST_TIMEOUT_MS },
    { name: "zero base -> default (no floor)", tool: "tapOn", timeoutMs: 0, expected: DEFAULT_MCP_REQUEST_TIMEOUT_MS },

    // --- A tiny positive base is honoured for a non-floored tool, floored otherwise ---
    { name: "1ms honoured for a non-floored tool", tool: "tapOn", timeoutMs: 1, expected: 1 },
    { name: "1ms floored for a floored tool", tool: "executePlan", timeoutMs: 1, expected: MIN_EXECUTE_PLAN_MCP_TIMEOUT_MS },

    // --- The floor is gated on method === "tools/call": a non-"tools/call" method
    //     with a floored tool name in params.name must NOT get the floor. ---
    { name: "non-tools/call + startDevice name -> no floor, default", method: "daemon/availableDevices", tool: "startDevice", expected: DEFAULT_MCP_REQUEST_TIMEOUT_MS },
    { name: "non-tools/call + executePlan name -> raw honoured, no floor", method: "resources/read", tool: "executePlan", timeoutMs: 1, expected: 1 },
    { name: "non-tools/call + startDevice name -> raw above floor untouched", method: "tools/list", tool: "startDevice", timeoutMs: 5_000, expected: 5_000 },

    // --- Environment-configured floors for observe/openLink ---
    { name: "observe env floor when timeoutMs omitted", tool: "observe", env: { [OBSERVE_MCP_TIMEOUT_ENV_VAR]: "150000" }, expected: 150_000 },
    { name: "openLink env floor when timeoutMs omitted", tool: "openLink", env: { [OPEN_LINK_MCP_TIMEOUT_ENV_VAR]: "90000" }, expected: 90_000 },
    { name: "openLink legacy env floor when timeoutMs omitted", tool: "openLink", env: { [LEGACY_OPEN_LINK_MCP_TIMEOUT_ENV_VAR]: "45000" }, expected: 45_000 },
    { name: "raises short openLink to env floor", tool: "openLink", env: { [OPEN_LINK_MCP_TIMEOUT_ENV_VAR]: "90000" }, timeoutMs: 30_000, expected: 90_000 },
    { name: "preserves openLink above env floor", tool: "openLink", env: { [OPEN_LINK_MCP_TIMEOUT_ENV_VAR]: "90000" }, timeoutMs: 120_000, expected: 120_000 },
    { name: "invalid openLink env falls back to default floor", tool: "openLink", env: { [OPEN_LINK_MCP_TIMEOUT_ENV_VAR]: "not-a-number" }, timeoutMs: 10_000, expected: DEFAULT_OPEN_LINK_MCP_TIMEOUT_MS },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      if (testCase.env) {
        for (const [key, value] of Object.entries(testCase.env)) {
          process.env[key] = value;
        }
      }

      const request: DaemonRequest = {
        id: "1",
        type: "mcp_request",
        method: testCase.method ?? "tools/call",
        params: { name: testCase.tool, arguments: {} },
        ...(testCase.timeoutMs === undefined ? {} : { timeoutMs: testCase.timeoutMs }),
      };

      expect(resolveMcpRequestTimeoutMs(request)).toBe(testCase.expected);
    });
  }

  // Constant relationships (not resolve() calls): the observe/openLink default
  // floors must exceed the standard request timeout, or a cold start would abort
  // (issues #2834 / #2723).
  test("default observe and openLink floors exceed the standard request timeout", () => {
    expect(DEFAULT_OBSERVE_MCP_TIMEOUT_MS).toBe(90_000);
    expect(DEFAULT_OPEN_LINK_MCP_TIMEOUT_MS).toBe(90_000);
    expect(DEFAULT_OBSERVE_MCP_TIMEOUT_MS).toBeGreaterThan(DEFAULT_MCP_REQUEST_TIMEOUT_MS);
    expect(DEFAULT_OPEN_LINK_MCP_TIMEOUT_MS).toBeGreaterThan(DEFAULT_MCP_REQUEST_TIMEOUT_MS);
  });

  test("keeps transport alive beyond the startDevice tool budget", () => {
    const request: DaemonRequest = {
      id: "1",
      type: "mcp_request",
      method: "tools/call",
      params: {
        name: "startDevice",
        arguments: { timeoutMs: 300_000 },
      },
    };

    expect(resolveMcpRequestTimeoutMs(request)).toBe(
      300_000 + START_DEVICE_MCP_TIMEOUT_OVERHEAD_MS,
    );
  });

  test("keeps transport alive for the legacy nested startDevice timeout", () => {
    const request: DaemonRequest = {
      id: "1",
      type: "mcp_request",
      method: "tools/call",
      params: {
        name: "startDevice",
        arguments: { device: { platform: "android", timeoutMs: 300_000 } },
      },
    };

    expect(resolveMcpRequestTimeoutMs(request)).toBe(
      300_000 + START_DEVICE_MCP_TIMEOUT_OVERHEAD_MS,
    );
  });

  test("caps oversized startDevice budgets below the Node timer ceiling", () => {
    const request: DaemonRequest = {
      id: "1",
      type: "mcp_request",
      method: "tools/call",
      params: {
        name: "startDevice",
        arguments: { timeoutMs: Number.MAX_SAFE_INTEGER },
      },
    };

    expect(resolveMcpRequestTimeoutMs(request)).toBe(
      MAX_DEVICE_READY_TIMEOUT_MS + START_DEVICE_MCP_TIMEOUT_OVERHEAD_MS,
    );
  });
});
