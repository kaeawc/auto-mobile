import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  DEFAULT_MCP_REQUEST_TIMEOUT_MS,
  DEFAULT_OBSERVE_MCP_TIMEOUT_MS,
  DEFAULT_OPEN_LINK_MCP_TIMEOUT_MS,
  LEGACY_OBSERVE_MCP_TIMEOUT_ENV_VAR,
  LEGACY_OPEN_LINK_MCP_TIMEOUT_ENV_VAR,
  MIN_CRASH_APP_MCP_TIMEOUT_MS,
  MIN_EXECUTE_PLAN_MCP_TIMEOUT_MS,
  MIN_LAUNCH_APP_MCP_TIMEOUT_MS,
  MIN_PREFERENCE_MCP_TIMEOUT_MS,
  MIN_PROVISION_DEVICE_MCP_TIMEOUT_MS,
  MIN_START_DEVICE_MCP_TIMEOUT_MS,
  MIN_TEARDOWN_DEVICE_MCP_TIMEOUT_MS,
  MIN_UNINSTALL_APP_MCP_TIMEOUT_MS,
  MIN_VIDEO_RECORDING_MCP_TIMEOUT_MS,
  OBSERVE_MCP_TIMEOUT_ENV_VAR,
  OPEN_LINK_MCP_TIMEOUT_ENV_VAR,
  START_DEVICE_MCP_TIMEOUT_OVERHEAD_MS,
  TAP_ANY_LONG_PRESS_MCP_TIMEOUT_HEADROOM_MS,
  resolveMcpRequestTimeoutMs,
  ProgressExtendableDeadline,
  MAX_PROGRESS_EXTENDED_MCP_REQUEST_TIMEOUT_MS,
} from "../../src/daemon/mcpRequestTimeout";
import { TAP_ANY_SEARCH_UNTIL_DEFAULT_MS } from "../../src/features/action/TapAnyElement";
import type { DaemonRequest } from "../../src/daemon/types";
import {
  DEFAULT_DEVICE_TEARDOWN_TIMEOUT_MS,
  DEFAULT_PROVISION_DEVICE_TIMEOUT_MS,
  DAEMON_RPC_SOCKET_IDLE_TIMEOUT_MS,
  MAX_DEVICE_READY_TIMEOUT_MS,
} from "../../src/utils/deviceTimeouts";

describe("resolveMcpRequestTimeoutMs", () => {
  const timeoutEnvVars = [
    OPEN_LINK_MCP_TIMEOUT_ENV_VAR,
    LEGACY_OPEN_LINK_MCP_TIMEOUT_ENV_VAR,
    OBSERVE_MCP_TIMEOUT_ENV_VAR,
    LEGACY_OBSERVE_MCP_TIMEOUT_ENV_VAR,
  ];
  const originalEnv = new Map(timeoutEnvVars.map((name) => [name, process.env[name]]));

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
    {
      name: "tool without a floor -> default",
      tool: "tapOn",
      expected: DEFAULT_MCP_REQUEST_TIMEOUT_MS,
    },
    {
      name: "executePlan floor when timeoutMs omitted",
      tool: "executePlan",
      expected: MIN_EXECUTE_PLAN_MCP_TIMEOUT_MS,
    },
    {
      name: "startDevice floor when timeoutMs omitted",
      tool: "startDevice",
      expected: MIN_START_DEVICE_MCP_TIMEOUT_MS,
    },
    {
      name: "provisionDevice floor when timeoutMs omitted",
      tool: "provisionDevice",
      expected: MIN_PROVISION_DEVICE_MCP_TIMEOUT_MS,
    },
    {
      name: "deleteDevice floor when timeoutMs omitted",
      tool: "deleteDevice",
      expected: MIN_TEARDOWN_DEVICE_MCP_TIMEOUT_MS,
    },
    {
      name: "launchApp floor when timeoutMs omitted",
      tool: "launchApp",
      expected: MIN_LAUNCH_APP_MCP_TIMEOUT_MS,
    },
    {
      name: "crashApp floor when timeoutMs omitted",
      tool: "crashApp",
      expected: MIN_CRASH_APP_MCP_TIMEOUT_MS,
    },
    {
      name: "videoRecording floor when timeoutMs omitted",
      tool: "videoRecording",
      expected: MIN_VIDEO_RECORDING_MCP_TIMEOUT_MS,
    },
    {
      name: "uninstallApp floor when timeoutMs omitted",
      tool: "uninstallApp",
      expected: MIN_UNINSTALL_APP_MCP_TIMEOUT_MS,
    },
    {
      name: "getPreference floor when timeoutMs omitted",
      tool: "getPreference",
      expected: MIN_PREFERENCE_MCP_TIMEOUT_MS,
    },
    {
      name: "setPreference floor when timeoutMs omitted",
      tool: "setPreference",
      expected: MIN_PREFERENCE_MCP_TIMEOUT_MS,
    },
    {
      name: "observe default floor when timeoutMs omitted",
      tool: "observe",
      expected: DEFAULT_OBSERVE_MCP_TIMEOUT_MS,
    },
    {
      name: "openLink default floor when timeoutMs omitted",
      tool: "openLink",
      expected: DEFAULT_OPEN_LINK_MCP_TIMEOUT_MS,
    },

    // --- Short timeouts are raised to the floor (base < floor) ---
    {
      name: "raises short executePlan to floor",
      tool: "executePlan",
      timeoutMs: 180_000,
      expected: MIN_EXECUTE_PLAN_MCP_TIMEOUT_MS,
    },
    {
      name: "raises short startDevice to floor",
      tool: "startDevice",
      timeoutMs: 60_000,
      expected: MIN_START_DEVICE_MCP_TIMEOUT_MS,
    },
    {
      name: "raises short provisionDevice to floor",
      tool: "provisionDevice",
      timeoutMs: 60_000,
      expected: MIN_PROVISION_DEVICE_MCP_TIMEOUT_MS,
    },
    {
      name: "raises short deleteDevice to floor",
      tool: "deleteDevice",
      timeoutMs: 30_000,
      expected: MIN_TEARDOWN_DEVICE_MCP_TIMEOUT_MS,
    },
    {
      name: "raises short launchApp to floor",
      tool: "launchApp",
      timeoutMs: 10_000,
      expected: MIN_LAUNCH_APP_MCP_TIMEOUT_MS,
    },
    {
      name: "raises short crashApp to floor",
      tool: "crashApp",
      timeoutMs: 30_000,
      expected: MIN_CRASH_APP_MCP_TIMEOUT_MS,
    },
    {
      name: "raises short videoRecording to floor",
      tool: "videoRecording",
      timeoutMs: 30_000,
      expected: MIN_VIDEO_RECORDING_MCP_TIMEOUT_MS,
    },
    {
      name: "raises short uninstallApp to floor",
      tool: "uninstallApp",
      timeoutMs: 30_000,
      expected: MIN_UNINSTALL_APP_MCP_TIMEOUT_MS,
    },
    {
      name: "raises short getPreference to floor",
      tool: "getPreference",
      timeoutMs: 30_000,
      expected: MIN_PREFERENCE_MCP_TIMEOUT_MS,
    },
    {
      name: "raises short setPreference to floor",
      tool: "setPreference",
      timeoutMs: 30_000,
      expected: MIN_PREFERENCE_MCP_TIMEOUT_MS,
    },
    {
      name: "raises short observe to floor",
      tool: "observe",
      timeoutMs: 30_000,
      expected: DEFAULT_OBSERVE_MCP_TIMEOUT_MS,
    },
    {
      name: "raises short openLink to floor",
      tool: "openLink",
      timeoutMs: 10_000,
      expected: DEFAULT_OPEN_LINK_MCP_TIMEOUT_MS,
    },

    // --- Timeouts above the floor are preserved (base > floor) ---
    {
      name: "preserves executePlan above floor",
      tool: "executePlan",
      timeoutMs: 900_000,
      expected: 900_000,
    },
    {
      name: "preserves startDevice above floor",
      tool: "startDevice",
      timeoutMs: 300_000,
      expected: 300_000,
    },
    {
      name: "preserves provisionDevice outer request timeout above the floor",
      tool: "provisionDevice",
      timeoutMs: 600_000,
      expected: 600_000,
    },
    {
      name: "preserves deleteDevice above floor",
      tool: "deleteDevice",
      timeoutMs: 120_000,
      expected: 120_000,
    },
    {
      name: "preserves launchApp above floor",
      tool: "launchApp",
      timeoutMs: 150_000,
      expected: 150_000,
    },
    {
      name: "preserves uninstallApp above floor",
      tool: "uninstallApp",
      timeoutMs: 90_000,
      expected: 90_000,
    },
    {
      name: "preserves observe above floor",
      tool: "observe",
      timeoutMs: 150_000,
      expected: 150_000,
    },

    // --- Boundary: base exactly equal to the floor stays put (Math.max is idempotent) ---
    {
      name: "executePlan exactly at floor stays",
      tool: "executePlan",
      timeoutMs: MIN_EXECUTE_PLAN_MCP_TIMEOUT_MS,
      expected: MIN_EXECUTE_PLAN_MCP_TIMEOUT_MS,
    },
    {
      name: "launchApp exactly at floor stays",
      tool: "launchApp",
      timeoutMs: MIN_LAUNCH_APP_MCP_TIMEOUT_MS,
      expected: MIN_LAUNCH_APP_MCP_TIMEOUT_MS,
    },

    // --- Degenerate base values collapse to DEFAULT (not finite / not > 0) ---
    {
      name: "NaN base -> default (no floor)",
      tool: "tapOn",
      timeoutMs: NaN,
      expected: DEFAULT_MCP_REQUEST_TIMEOUT_MS,
    },
    {
      name: "Infinity base -> default (no floor)",
      tool: "tapOn",
      timeoutMs: Infinity,
      expected: DEFAULT_MCP_REQUEST_TIMEOUT_MS,
    },
    // Infinity is not finite, so base collapses to DEFAULT and is then floored by the tool.
    {
      name: "Infinity base -> default then floored",
      tool: "executePlan",
      timeoutMs: Infinity,
      expected: MIN_EXECUTE_PLAN_MCP_TIMEOUT_MS,
    },
    {
      name: "negative base -> default (no floor)",
      tool: "tapOn",
      timeoutMs: -1,
      expected: DEFAULT_MCP_REQUEST_TIMEOUT_MS,
    },
    {
      name: "zero base -> default (no floor)",
      tool: "tapOn",
      timeoutMs: 0,
      expected: DEFAULT_MCP_REQUEST_TIMEOUT_MS,
    },

    // --- A tiny positive base is honoured for a non-floored tool, floored otherwise ---
    { name: "1ms honoured for a non-floored tool", tool: "tapOn", timeoutMs: 1, expected: 1 },
    {
      name: "1ms floored for a floored tool",
      tool: "executePlan",
      timeoutMs: 1,
      expected: MIN_EXECUTE_PLAN_MCP_TIMEOUT_MS,
    },

    // --- The floor is gated on method === "tools/call": a non-"tools/call" method
    //     with a floored tool name in params.name must NOT get the floor. ---
    {
      name: "non-tools/call + startDevice name -> no floor, default",
      method: "daemon/availableDevices",
      tool: "startDevice",
      expected: DEFAULT_MCP_REQUEST_TIMEOUT_MS,
    },
    {
      name: "non-tools/call + executePlan name -> raw honoured, no floor",
      method: "resources/read",
      tool: "executePlan",
      timeoutMs: 1,
      expected: 1,
    },
    {
      name: "non-tools/call + startDevice name -> raw above floor untouched",
      method: "tools/list",
      tool: "startDevice",
      timeoutMs: 5_000,
      expected: 5_000,
    },

    // --- Environment-configured floors for observe/openLink ---
    {
      name: "observe env floor when timeoutMs omitted",
      tool: "observe",
      env: { [OBSERVE_MCP_TIMEOUT_ENV_VAR]: "150000" },
      expected: 150_000,
    },
    {
      name: "openLink env floor when timeoutMs omitted",
      tool: "openLink",
      env: { [OPEN_LINK_MCP_TIMEOUT_ENV_VAR]: "90000" },
      expected: 90_000,
    },
    {
      name: "openLink legacy env floor when timeoutMs omitted",
      tool: "openLink",
      env: { [LEGACY_OPEN_LINK_MCP_TIMEOUT_ENV_VAR]: "45000" },
      expected: 45_000,
    },
    {
      name: "raises short openLink to env floor",
      tool: "openLink",
      env: { [OPEN_LINK_MCP_TIMEOUT_ENV_VAR]: "90000" },
      timeoutMs: 30_000,
      expected: 90_000,
    },
    {
      name: "preserves openLink above env floor",
      tool: "openLink",
      env: { [OPEN_LINK_MCP_TIMEOUT_ENV_VAR]: "90000" },
      timeoutMs: 120_000,
      expected: 120_000,
    },
    {
      name: "invalid openLink env falls back to default floor",
      tool: "openLink",
      env: { [OPEN_LINK_MCP_TIMEOUT_ENV_VAR]: "not-a-number" },
      timeoutMs: 10_000,
      expected: DEFAULT_OPEN_LINK_MCP_TIMEOUT_MS,
    },
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
  test("default observe, openLink, and crashApp floors exceed the standard timeout", () => {
    expect(DEFAULT_OBSERVE_MCP_TIMEOUT_MS).toBe(90_000);
    expect(DEFAULT_OPEN_LINK_MCP_TIMEOUT_MS).toBe(90_000);
    expect(MIN_CRASH_APP_MCP_TIMEOUT_MS).toBe(90_000);
    expect(DEFAULT_OBSERVE_MCP_TIMEOUT_MS).toBeGreaterThan(DEFAULT_MCP_REQUEST_TIMEOUT_MS);
    expect(DEFAULT_OPEN_LINK_MCP_TIMEOUT_MS).toBeGreaterThan(DEFAULT_MCP_REQUEST_TIMEOUT_MS);
    expect(MIN_CRASH_APP_MCP_TIMEOUT_MS).toBeGreaterThan(DEFAULT_MCP_REQUEST_TIMEOUT_MS);
  });

  test("videoRecording preserves the compatibility floor", () => {
    expect(MIN_VIDEO_RECORDING_MCP_TIMEOUT_MS).toBe(90_000);
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

  test("tapAny longPress with a large duration raises the outer deadline beyond duration + headroom", () => {
    const duration = 60_000;
    const request: DaemonRequest = {
      id: "1",
      type: "mcp_request",
      method: "tools/call",
      params: {
        name: "tapAny",
        arguments: { action: "longPress", duration },
      },
    };

    const resolved = resolveMcpRequestTimeoutMs(request);
    // No `searchUntil` is given, so the floor must still budget the implicit
    // default search window `TapAnyElement.getSearchUntilDuration` applies
    // (#6248 review, P2) -- not just duration + headroom.
    expect(resolved).toBe(
      duration + TAP_ANY_SEARCH_UNTIL_DEFAULT_MS + TAP_ANY_LONG_PRESS_MCP_TIMEOUT_HEADROOM_MS,
    );
    // Must not fire before the CtrlProxy-level request timeout TapAnyElement
    // sizes for the same call (duration + the same headroom, #6248 review).
    expect(resolved).toBeGreaterThanOrEqual(duration + TAP_ANY_LONG_PRESS_MCP_TIMEOUT_HEADROOM_MS);
  });

  test("tapAny longPress with no searchUntil budgets the implicit default search window (#6248 review)", () => {
    const duration = 60_000;
    const request: DaemonRequest = {
      id: "1",
      type: "mcp_request",
      method: "tools/call",
      params: {
        name: "tapAny",
        arguments: { action: "longPress", duration },
      },
    };

    expect(resolveMcpRequestTimeoutMs(request)).toBe(
      duration + TAP_ANY_SEARCH_UNTIL_DEFAULT_MS + TAP_ANY_LONG_PRESS_MCP_TIMEOUT_HEADROOM_MS,
    );
  });

  test("tapAny longPress budgets pre-gesture searchUntil.duration ahead of the press (#6248 review)", () => {
    const duration = 60_000;
    const searchUntilDuration = 12_000;
    const request: DaemonRequest = {
      id: "1",
      type: "mcp_request",
      method: "tools/call",
      params: {
        name: "tapAny",
        arguments: {
          action: "longPress",
          duration,
          searchUntil: { duration: searchUntilDuration },
        },
      },
    };

    const resolved = resolveMcpRequestTimeoutMs(request);
    expect(resolved).toBe(
      duration + searchUntilDuration + TAP_ANY_LONG_PRESS_MCP_TIMEOUT_HEADROOM_MS,
    );
    expect(resolved).toBeGreaterThanOrEqual(
      duration + searchUntilDuration + TAP_ANY_LONG_PRESS_MCP_TIMEOUT_HEADROOM_MS,
    );
  });

  test("tapAny longPress honours an outer timeoutMs already above the derived floor", () => {
    const request: DaemonRequest = {
      id: "1",
      type: "mcp_request",
      method: "tools/call",
      params: {
        name: "tapAny",
        arguments: { action: "longPress", duration: 60_000 },
      },
      timeoutMs: 120_000,
    };

    expect(resolveMcpRequestTimeoutMs(request)).toBe(120_000);
  });

  test("a normal tapAny tap keeps the standard default timeout", () => {
    const request: DaemonRequest = {
      id: "1",
      type: "mcp_request",
      method: "tools/call",
      params: {
        name: "tapAny",
        arguments: { action: "tap" },
      },
    };

    expect(resolveMcpRequestTimeoutMs(request)).toBe(DEFAULT_MCP_REQUEST_TIMEOUT_MS);
  });

  test("a tapAny longPress with no duration keeps the standard default timeout", () => {
    const request: DaemonRequest = {
      id: "1",
      type: "mcp_request",
      method: "tools/call",
      params: {
        name: "tapAny",
        arguments: { action: "longPress" },
      },
    };

    expect(resolveMcpRequestTimeoutMs(request)).toBe(DEFAULT_MCP_REQUEST_TIMEOUT_MS);
  });

  test("keeps transport alive for getAndroid's named preparation budgets", () => {
    const request: DaemonRequest = {
      id: "1",
      type: "mcp_request",
      method: "tools/call",
      params: {
        name: "getAndroid",
        arguments: { bootTimeoutMs: 300_000, automationReadyTimeoutMs: 45_000 },
      },
    };

    expect(resolveMcpRequestTimeoutMs(request)).toBe(
      345_000 + START_DEVICE_MCP_TIMEOUT_OVERHEAD_MS,
    );
  });

  test("keeps transport alive beyond the provisionDevice tool budget", () => {
    const request: DaemonRequest = {
      id: "1",
      type: "mcp_request",
      method: "tools/call",
      params: {
        name: "provisionDevice",
        arguments: { timeoutMs: 600_000 },
      },
    };

    expect(resolveMcpRequestTimeoutMs(request)).toBe(
      600_000 + START_DEVICE_MCP_TIMEOUT_OVERHEAD_MS,
    );
  });

  test("keeps transport headroom when provisionDevice uses its default lifecycle budget", () => {
    const request: DaemonRequest = {
      id: "1",
      type: "mcp_request",
      method: "tools/call",
      params: {
        name: "provisionDevice",
        arguments: {},
      },
    };

    expect(MIN_PROVISION_DEVICE_MCP_TIMEOUT_MS).toBe(
      DEFAULT_PROVISION_DEVICE_TIMEOUT_MS + START_DEVICE_MCP_TIMEOUT_OVERHEAD_MS,
    );
    expect(resolveMcpRequestTimeoutMs(request)).toBe(
      DEFAULT_PROVISION_DEVICE_TIMEOUT_MS + START_DEVICE_MCP_TIMEOUT_OVERHEAD_MS,
    );
  });

  test("keeps transport alive beyond the deleteDevice tool budget", () => {
    const request: DaemonRequest = {
      id: "1",
      type: "mcp_request",
      method: "tools/call",
      params: {
        name: "deleteDevice",
        arguments: { timeoutMs: 600_000 },
      },
    };

    expect(resolveMcpRequestTimeoutMs(request)).toBe(
      600_000 + START_DEVICE_MCP_TIMEOUT_OVERHEAD_MS,
    );
  });

  test("keeps transport headroom when deleteDevice uses its default lifecycle budget", () => {
    const request: DaemonRequest = {
      id: "1",
      type: "mcp_request",
      method: "tools/call",
      params: {
        name: "deleteDevice",
        arguments: {},
      },
    };

    expect(MIN_TEARDOWN_DEVICE_MCP_TIMEOUT_MS).toBe(
      DEFAULT_DEVICE_TEARDOWN_TIMEOUT_MS + START_DEVICE_MCP_TIMEOUT_OVERHEAD_MS,
    );
    expect(resolveMcpRequestTimeoutMs(request)).toBe(
      DEFAULT_DEVICE_TEARDOWN_TIMEOUT_MS + START_DEVICE_MCP_TIMEOUT_OVERHEAD_MS,
    );
  });

  test("caps getApple's combined preparation budgets below the daemon socket idle timeout", () => {
    const request: DaemonRequest = {
      id: "1",
      type: "mcp_request",
      method: "tools/call",
      params: {
        name: "getApple",
        arguments: {
          bootTimeoutMs: Number.MAX_SAFE_INTEGER,
          automationReadyTimeoutMs: Number.MAX_SAFE_INTEGER,
        },
      },
    };

    const resolved = resolveMcpRequestTimeoutMs(request);
    expect(resolved).toBe(MAX_DEVICE_READY_TIMEOUT_MS + START_DEVICE_MCP_TIMEOUT_OVERHEAD_MS);
    expect(resolved).toBeLessThan(DAEMON_RPC_SOCKET_IDLE_TIMEOUT_MS);
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

  test("caps oversized startDevice budgets below the daemon socket idle timeout", () => {
    const request: DaemonRequest = {
      id: "1",
      type: "mcp_request",
      method: "tools/call",
      params: {
        name: "startDevice",
        arguments: { timeoutMs: Number.MAX_SAFE_INTEGER },
      },
    };

    const resolved = resolveMcpRequestTimeoutMs(request);
    expect(resolved).toBe(MAX_DEVICE_READY_TIMEOUT_MS + START_DEVICE_MCP_TIMEOUT_OVERHEAD_MS);
    expect(resolved).toBeLessThan(DAEMON_RPC_SOCKET_IDLE_TIMEOUT_MS);
  });
});

/**
 * Pure deadline math backing both extension points the daemon wires up for a
 * progress-emitting request (issue #6222 review, P1): `handleIdeRequest`'s
 * `resetTimeoutOnProgress`/`maxTotalTimeout` for the inner MCP SDK call, and
 * `UnixSocketServer`'s own `requestDeadlineMs`-equivalent pre-flight budget
 * check (`requireRemainingMcpForwardBudget`). Both read `deadline.value` (or
 * `deadline.ceiling`) live and call `extendOnProgress` only when a progress
 * notification for that specific request actually arrives -- a tool that
 * never emits progress never touches this class at all, so its deadline is
 * exactly what it always was.
 */
describe("ProgressExtendableDeadline", () => {
  test("starts at receivedAt + initialTimeout, unaffected until a progress tick arrives", () => {
    const deadline = new ProgressExtendableDeadline(1_000, 30_000);
    expect(deadline.value).toBe(31_000);
  });

  test("a progress tick resets the deadline forward from now, by the extension amount", () => {
    const deadline = new ProgressExtendableDeadline(0, 30_000);
    // 25s in, well before the original 30s deadline, a tick arrives.
    deadline.extendOnProgress(25_000, 30_000);
    expect(deadline.value).toBe(55_000);
  });

  test("a request that keeps progressing survives past its original deadline, up to the bounded ceiling", () => {
    const receivedAt = 0;
    const initialTimeoutMs = 30_000;
    const deadline = new ProgressExtendableDeadline(receivedAt, initialTimeoutMs);

    // Tick every 20s -- each tick arrives well before the deadline it most
    // recently set, so the request never actually expires.
    let nowMs = 0;
    for (let i = 0; i < 5; i++) {
      nowMs += 20_000;
      deadline.extendOnProgress(nowMs, initialTimeoutMs);
      expect(deadline.value).toBeGreaterThan(nowMs);
    }
    // 100s of wall-clock elapsed -- more than 3x the original 30s deadline --
    // and the request is still not expired.
    expect(nowMs).toBe(100_000);
    expect(deadline.value).toBeGreaterThan(nowMs);
  });

  test("progress can never push the deadline past the bounded ceiling", () => {
    const receivedAt = 0;
    const initialTimeoutMs = 30_000;
    const deadline = new ProgressExtendableDeadline(receivedAt, initialTimeoutMs);
    const ceiling = receivedAt + MAX_PROGRESS_EXTENDED_MCP_REQUEST_TIMEOUT_MS;
    expect(deadline.ceiling).toBe(ceiling);

    // Keep progressing indefinitely, well past the ceiling.
    let nowMs = 0;
    for (let i = 0; i < 40; i++) {
      nowMs += 20_000;
      deadline.extendOnProgress(nowMs, initialTimeoutMs);
      expect(deadline.value).toBeLessThanOrEqual(ceiling);
    }
    expect(nowMs).toBeGreaterThan(ceiling);
    // Once past the ceiling, the deadline is pinned there -- the request
    // is effectively already expired relative to `nowMs`, exactly the
    // "still killed" behavior a genuinely hung-but-progressing tool needs.
    expect(deadline.value).toBe(ceiling);
    expect(deadline.value).toBeLessThan(nowMs);
  });

  test("a proposal at or behind the current deadline never shortens it", () => {
    const deadline = new ProgressExtendableDeadline(0, 30_000);
    deadline.extendOnProgress(25_000, 30_000); // pushes to 55_000
    const beforeMs = deadline.value;
    // A late-arriving/out-of-order tick proposing an earlier value is a no-op.
    deadline.extendOnProgress(10_000, 1_000); // would propose 11_000, far behind
    expect(deadline.value).toBe(beforeMs);
  });

  test("a request with a floor already above the progress ceiling keeps its own larger ceiling", () => {
    // e.g. executePlan's 10-minute floor is larger than the default 5-minute
    // progress ceiling -- progress must not SHRINK that tool's effective ceiling.
    const tenMinutes = 600_000;
    const deadline = new ProgressExtendableDeadline(0, tenMinutes);
    expect(deadline.ceiling).toBe(tenMinutes);
  });

  test("never extended when no progress arrives -- a non-progressing request's deadline is exactly its original value", () => {
    const deadline = new ProgressExtendableDeadline(1_000, DEFAULT_MCP_REQUEST_TIMEOUT_MS);
    // No extendOnProgress call at all.
    expect(deadline.value).toBe(1_000 + DEFAULT_MCP_REQUEST_TIMEOUT_MS);
  });
});
