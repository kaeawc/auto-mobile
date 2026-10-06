import { DEFAULT_DEVICE_SNAPSHOT_CONFIG } from "../../src/features/snapshot/DeviceSnapshotConfig";
import {
  DEFAULT_VM_SNAPSHOT_TIMEOUT_MS,
  MAX_VM_SNAPSHOT_TIMEOUT_MS,
} from "../../src/features/snapshot/deviceSnapshotTimeout";
import { MAX_VM_SNAPSHOT_TIMEOUT_MS as schemaSnapshotMaxMs } from "../../src/server/snapshotTools";
import { BARRIER_TIMEOUT_MS as coordinatorDefaultMs } from "../../src/server/CriticalSectionCoordinator";
import { BARRIER_TIMEOUT_MS } from "../../src/features/action/coordinationTimeout";
import { DEFAULT_EXPLORE_TIMEOUT_MS as explorationDefaultMs } from "../../src/features/navigation/Explore";
import { DEFAULT_EXPLORE_TIMEOUT_MS } from "../../src/features/navigation/exploreTimeout";
import { SHARED_STORAGE_PUSH_TIMEOUT_MS as storagePushMs } from "../../src/server/sharedStorageService";
import { APP_FILE_PUSH_TIMEOUT_MS as appPushMs } from "../../src/server/appFileService";
import {
  SHARED_STORAGE_PUSH_TIMEOUT_MS,
  APP_FILE_PUSH_TIMEOUT_MS,
} from "../../src/features/storage/fileTransferTimeout";
import {
  MCP_ARGUMENT_BUDGET_CASES,
  MALFORMED_MCP_BUDGETS,
} from "../helpers/mcpArgumentBudgetCases";
import {
  DEFAULT_OVERLAY_EVENT_TIMEOUT_MS,
  MAX_OVERLAY_EVENT_TIMEOUT_MS,
} from "../../src/features/overlay/overlayEventTimeout";
import {
  DEFAULT_OVERLAY_ASSET_TIMEOUT_MS,
  MAX_OVERLAY_ASSET_COUNT,
} from "../../src/features/overlay/overlayAssets";
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
  MIN_TEARDOWN_DEVICE_MCP_TIMEOUT_MS,
  MIN_UNINSTALL_APP_MCP_TIMEOUT_MS,
  MIN_INSTALL_APP_MCP_TIMEOUT_MS,
  INSTALL_APP_MCP_TIMEOUT_HEADROOM_MS,
  MIN_VIDEO_RECORDING_MCP_TIMEOUT_MS,
  OBSERVE_MCP_TIMEOUT_ENV_VAR,
  OPEN_LINK_MCP_TIMEOUT_ENV_VAR,
  START_DEVICE_MCP_TIMEOUT_OVERHEAD_MS,
  TAP_ANY_LONG_PRESS_MCP_TIMEOUT_HEADROOM_MS,
  TAP_ANY_LONG_PRESS_NON_PRESS_OVERHEAD_MS,
  MAX_SETTIMEOUT_DELAY_MS,
  MAX_CALLER_MCP_REQUEST_TIMEOUT_MS,
  clampCallerMcpRequestTimeoutMs,
  resolveMcpRequestTimeoutMs,
  ProgressExtendableDeadline,
  MAX_PROGRESS_EXTENDED_MCP_REQUEST_TIMEOUT_MS,
  EXECUTE_PLAN_BUDGET_HEADROOM_MS,
  MAX_EXECUTE_PLAN_BUDGET_CONTENT_CHARS,
  MAX_EXECUTE_PLAN_BUDGET_STEPS,
  WAIT_BUDGET_MCP_TIMEOUT_HEADROOM_MS,
} from "../../src/daemon/mcpRequestTimeout";
import {
  TAP_ANY_SEARCH_UNTIL_DEFAULT_MS,
  TAP_ANY_SEARCH_UNTIL_MAX_MS,
  TAP_ANY_LONG_PRESS_MAX_DURATION_MS,
  TAP_ANY_ORDINARY_TAP_GESTURE_WORST_CASE_MS,
  TAP_ANY_ORDINARY_TAP_CTRL_PROXY_TIMEOUT_MS,
  TAP_ANY_ORDINARY_TAP_CTRL_PROXY_MIN_TIMEOUT_MS,
  TAP_ANY_ORDINARY_TAP_DURATION_MS,
  TAP_ANY_DOUBLE_TAP_GAP_MS,
  TAP_ANY_TERMINAL_SCREENSHOT_WORST_CASE_MS,
} from "../../src/features/action/TapAnyElement";
import {
  FINAL_OBSERVATION_MAX_RETRY_ATTEMPTS,
  FINAL_OBSERVATION_RETRY_BACKOFF_MS,
} from "../../src/features/action/BaseVisualChange";
import { IOS_HIERARCHY_REQUEST_TIMEOUT_MS } from "../../src/features/observe/ios/CtrlProxyHierarchy";
import { IOS_VOICEOVER_STATE_REQUEST_TIMEOUT_MS } from "../../src/features/observe/ios/CtrlProxyVoiceOver";
import type { DaemonRequest } from "../../src/daemon/types";
import {
  DEFAULT_DEVICE_TEARDOWN_TIMEOUT_MS,
  DEFAULT_PROVISION_DEVICE_TIMEOUT_MS,
  DAEMON_RPC_SOCKET_IDLE_TIMEOUT_MS,
  MAX_PROVISION_DEVICE_TIMEOUT_MS,
  MAX_DEVICE_READY_TIMEOUT_MS,
} from "../../src/utils/deviceTimeouts";

import { ANDROID_PACKAGE_TRANSFER_TIMEOUT_MS } from "../../src/features/action/InstallApp";

describe("resolveMcpRequestTimeoutMs", () => {
  test("installApp floor covers the downgrade transfer chain plus headroom", () => {
    expect(MIN_INSTALL_APP_MCP_TIMEOUT_MS).toBeGreaterThanOrEqual(
      ANDROID_PACKAGE_TRANSFER_TIMEOUT_MS,
    );
    expect(MIN_INSTALL_APP_MCP_TIMEOUT_MS).toBe(
      3 * ANDROID_PACKAGE_TRANSFER_TIMEOUT_MS + INSTALL_APP_MCP_TIMEOUT_HEADROOM_MS,
    );
  });
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
    {
      name: "installApp preserves timeout above floor",
      tool: "installApp",
      timeoutMs: MIN_INSTALL_APP_MCP_TIMEOUT_MS + INSTALL_APP_MCP_TIMEOUT_HEADROOM_MS,
      expected: MIN_INSTALL_APP_MCP_TIMEOUT_MS + INSTALL_APP_MCP_TIMEOUT_HEADROOM_MS,
    },

    {
      name: "installApp raises short timeout to floor",
      tool: "installApp",
      timeoutMs: DEFAULT_MCP_REQUEST_TIMEOUT_MS,
      expected: MIN_INSTALL_APP_MCP_TIMEOUT_MS,
    },

    {
      name: "installApp floor when timeoutMs omitted",
      tool: "installApp",
      expected: MIN_INSTALL_APP_MCP_TIMEOUT_MS,
    },

    {
      name: "setDeviceResources floor when timeoutMs omitted",
      tool: "setDeviceResources",
      expected: 305_000,
    },
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
      name: "startDevice default includes cold boot and runner setup",
      tool: "startDevice",
      expected: 365_000,
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
      name: "raises short startDevice transport to default lifecycle budget",
      tool: "startDevice",
      timeoutMs: 60_000,
      expected: 365_000,
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
      name: "preserves startDevice above default lifecycle budget",
      tool: "startDevice",
      timeoutMs: 400_000,
      expected: 400_000,
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

  // Issue #6385: clients now send their own deadline; the daemon honours it
  // with a sane upper clamp so a runaway value cannot pin a request forever.
  test("honours a caller timeoutMs above the default", () => {
    const request: DaemonRequest = {
      id: "1",
      type: "mcp_request",
      method: "tools/call",
      params: { name: "tapOn", arguments: {} },
      timeoutMs: 120_000,
    };
    expect(resolveMcpRequestTimeoutMs(request)).toBe(120_000);
  });

  test("clamps an oversized caller timeoutMs to MAX_CALLER_MCP_REQUEST_TIMEOUT_MS", () => {
    const request: DaemonRequest = {
      id: "1",
      type: "mcp_request",
      method: "tools/call",
      params: { name: "tapOn", arguments: {} },
      timeoutMs: Number.MAX_SAFE_INTEGER,
    };
    expect(resolveMcpRequestTimeoutMs(request)).toBe(MAX_CALLER_MCP_REQUEST_TIMEOUT_MS);
    expect(MAX_CALLER_MCP_REQUEST_TIMEOUT_MS).toBeLessThan(MAX_SETTIMEOUT_DELAY_MS);
  });

  test("clampCallerMcpRequestTimeoutMs rejects missing, non-finite and non-positive values", () => {
    expect(clampCallerMcpRequestTimeoutMs(undefined)).toBeUndefined();
    expect(clampCallerMcpRequestTimeoutMs("5000")).toBeUndefined();
    expect(clampCallerMcpRequestTimeoutMs(Number.NaN)).toBeUndefined();
    expect(clampCallerMcpRequestTimeoutMs(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(clampCallerMcpRequestTimeoutMs(0)).toBeUndefined();
    expect(clampCallerMcpRequestTimeoutMs(-1)).toBeUndefined();
    expect(clampCallerMcpRequestTimeoutMs(250)).toBe(250);
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
    // default search window `TapAnyElement.getSearchUntilDuration` applies,
    // plus the consolidated non-press overhead covering the VoiceOver probe,
    // final observation, and headroom (#6248 review, P2) -- not just
    // duration + headroom.
    expect(resolved).toBe(
      duration + TAP_ANY_SEARCH_UNTIL_DEFAULT_MS + TAP_ANY_LONG_PRESS_NON_PRESS_OVERHEAD_MS,
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
      duration + TAP_ANY_SEARCH_UNTIL_DEFAULT_MS + TAP_ANY_LONG_PRESS_NON_PRESS_OVERHEAD_MS,
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
      duration + searchUntilDuration + TAP_ANY_LONG_PRESS_NON_PRESS_OVERHEAD_MS,
    );
    expect(resolved).toBeGreaterThanOrEqual(
      duration + searchUntilDuration + TAP_ANY_LONG_PRESS_MCP_TIMEOUT_HEADROOM_MS,
    );
  });

  test("tapAny longPress budgets the non-press overhead to cover the VoiceOver probe and final observe (#6248 review)", () => {
    // The consolidated overhead must be generous enough to cover BOTH the
    // VoiceOver-detection probe (up to a 5s timeout) and
    // BaseVisualChange.takeObservation's final hierarchy request (up to
    // ~15s) on top of the existing fixed headroom -- not just the press
    // itself. Regression guard for the #6248 review P2 finding that neither
    // phase was budgeted at all.
    expect(TAP_ANY_LONG_PRESS_NON_PRESS_OVERHEAD_MS).toBeGreaterThanOrEqual(
      5000 + 15000 + TAP_ANY_LONG_PRESS_MCP_TIMEOUT_HEADROOM_MS,
    );
  });

  test("tapAny budget includes a queued terminal screenshot after an asynchronous observe", () => {
    // `ObserveScreen.execute` can leave a 10s screenshot in flight. Terminal
    // evidence then queues a second 10s fresh capture behind it.
    expect(TAP_ANY_TERMINAL_SCREENSHOT_WORST_CASE_MS).toBe(20_000);
    expect(TAP_ANY_LONG_PRESS_NON_PRESS_OVERHEAD_MS).toBeGreaterThanOrEqual(
      TAP_ANY_TERMINAL_SCREENSHOT_WORST_CASE_MS,
    );
  });

  test("tapAny longPress non-press overhead covers the REALISTIC worst case of the final-observation retry loop (#6248 review)", () => {
    // `BaseVisualChange.takeObservation` retries the final observation up to
    // `FINAL_OBSERVATION_MAX_RETRY_ATTEMPTS` times after the initial attempt
    // (5 attempts total), each an independent `CtrlProxyHierarchy` request
    // bounded by `IOS_HIERARCHY_REQUEST_TIMEOUT_MS`, separated by
    // `FINAL_OBSERVATION_RETRY_BACKOFF_MS` backoff delays. An earlier round
    // of this constant reserved only one attempt's worth of timeout (~15s),
    // which undersized the overhead against the real 5-attempt retry loop
    // (issue #6248 review, P2) -- this asserts against the actual derived
    // worst case rather than a guessed constant.
    const observeAttempts = 1 + FINAL_OBSERVATION_MAX_RETRY_ATTEMPTS;
    const observeWorstCaseMs =
      observeAttempts * IOS_HIERARCHY_REQUEST_TIMEOUT_MS +
      FINAL_OBSERVATION_RETRY_BACKOFF_MS.reduce((sum, delayMs) => sum + delayMs, 0);

    expect(TAP_ANY_LONG_PRESS_NON_PRESS_OVERHEAD_MS).toBeGreaterThanOrEqual(
      5000 /* VoiceOver probe */ + observeWorstCaseMs + TAP_ANY_LONG_PRESS_MCP_TIMEOUT_HEADROOM_MS,
    );
  });

  test("tapAny longPress non-press overhead covers the FULL final-observation pipeline: hierarchy AND a11y detection per attempt (#6248 review)", () => {
    // `ObserveScreen.execute` spends up to `IOS_HIERARCHY_REQUEST_TIMEOUT_MS`
    // (~15s) collecting the iOS hierarchy AND another
    // `IOS_VOICEOVER_STATE_REQUEST_TIMEOUT_MS` (~5s) in the unconditional
    // accessibility-state-detection step (`AccessibilityStateDetector.run`),
    // both serially, on EVERY final-observation attempt -- not just the
    // hierarchy request. An earlier round of this constant budgeted only the
    // hierarchy request per attempt, undersizing the overhead against the
    // real per-attempt pipeline cost (issue #6248 review, P2, fuZRo).
    const observeAttempts = 1 + FINAL_OBSERVATION_MAX_RETRY_ATTEMPTS;
    const perAttemptPipelineMs =
      IOS_HIERARCHY_REQUEST_TIMEOUT_MS + IOS_VOICEOVER_STATE_REQUEST_TIMEOUT_MS;
    const observeWorstCaseMs =
      observeAttempts * perAttemptPipelineMs +
      FINAL_OBSERVATION_RETRY_BACKOFF_MS.reduce((sum, delayMs) => sum + delayMs, 0);

    expect(TAP_ANY_LONG_PRESS_NON_PRESS_OVERHEAD_MS).toBeGreaterThanOrEqual(
      IOS_VOICEOVER_STATE_REQUEST_TIMEOUT_MS /* pre-gesture VoiceOver probe */ +
        observeWorstCaseMs +
        TAP_ANY_LONG_PRESS_MCP_TIMEOUT_HEADROOM_MS,
    );
  });

  test("tapAny longPress duration is bounded so the derived request deadline can never overflow MAX_SETTIMEOUT_DELAY_MS (#6248 review, terminal)", () => {
    // `TapAnyElement.getLongPressDuration` now REJECTS a longPress duration
    // above `TAP_ANY_LONG_PRESS_MAX_DURATION_MS` outright (fuZRt), so the
    // maximum duration this resolver will ever actually see, combined with
    // the largest possible `searchUntil.duration` and the full non-press
    // overhead, must never require clamping.
    const duration = TAP_ANY_LONG_PRESS_MAX_DURATION_MS;
    const request: DaemonRequest = {
      id: "1",
      type: "mcp_request",
      method: "tools/call",
      params: {
        name: "tapAny",
        arguments: {
          action: "longPress",
          duration,
          searchUntil: { duration: TAP_ANY_SEARCH_UNTIL_MAX_MS },
        },
      },
    };

    const resolved = resolveMcpRequestTimeoutMs(request);
    expect(resolved).toBe(
      duration + TAP_ANY_SEARCH_UNTIL_MAX_MS + TAP_ANY_LONG_PRESS_NON_PRESS_OVERHEAD_MS,
    );
    expect(resolved).toBeLessThanOrEqual(MAX_SETTIMEOUT_DELAY_MS);
  });

  test("tapAny longPress with a duration near the setTimeout ceiling is clamped to MAX_SETTIMEOUT_DELAY_MS", () => {
    // Internal requests are budgeted before schema validation. Without a clamp, a
    // duration near/above 2^31-1 pushes the derived deadline past
    // setTimeout's 32-bit range, which Bun/Node silently normalize to 1ms --
    // timing the daemon request out almost immediately instead of honoring
    // the requested long press (#6248 review, P2).
    const duration = MAX_SETTIMEOUT_DELAY_MS;
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
    expect(resolved).toBe(MAX_SETTIMEOUT_DELAY_MS);
    expect(resolved).toBeLessThanOrEqual(MAX_SETTIMEOUT_DELAY_MS);
  });

  test("tapAny longPress with an unbounded duration far past the setTimeout ceiling is still clamped", () => {
    const duration = Number.MAX_SAFE_INTEGER;
    const request: DaemonRequest = {
      id: "1",
      type: "mcp_request",
      method: "tools/call",
      params: {
        name: "tapAny",
        arguments: { action: "longPress", duration },
      },
    };

    expect(resolveMcpRequestTimeoutMs(request)).toBe(MAX_SETTIMEOUT_DELAY_MS);
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
      // Must exceed the derived floor (duration + searchUntil default +
      // the consolidated non-press overhead) for this test to actually
      // exercise "an outer timeoutMs already above the floor" rather than
      // being silently overridden by a larger floor.
      timeoutMs: 300_000,
    };

    expect(resolveMcpRequestTimeoutMs(request)).toBe(300_000);
  });

  // Issue #6276 (follow-up to #6248 review thread funaf): ordinary tap/doubleTap
  // previously had NO tapAny-specific outer floor at all -- this fell straight
  // through to `DEFAULT_MCP_REQUEST_TIMEOUT_MS` regardless of the call's real
  // worst-case pipeline cost. It must now budget the same non-press overhead
  // the longPress floor does (every tapAny action shares the same pre/post
  // observation pipeline), plus the ordinary gesture's own worst case and the
  // effective search window.
  test("a normal tapAny tap gets a tapAny-specific outer floor, not just the standard default (#6276)", () => {
    const request: DaemonRequest = {
      id: "1",
      type: "mcp_request",
      method: "tools/call",
      params: {
        name: "tapAny",
        arguments: { action: "tap" },
      },
    };

    const resolved = resolveMcpRequestTimeoutMs(request);
    expect(resolved).toBe(
      TAP_ANY_ORDINARY_TAP_GESTURE_WORST_CASE_MS +
        TAP_ANY_SEARCH_UNTIL_DEFAULT_MS +
        TAP_ANY_LONG_PRESS_NON_PRESS_OVERHEAD_MS,
    );
    expect(resolved).toBeGreaterThan(DEFAULT_MCP_REQUEST_TIMEOUT_MS);
  });

  test("an omitted tapAny action (schema defaults to tap) gets the same ordinary-tap floor (#6276)", () => {
    const request: DaemonRequest = {
      id: "1",
      type: "mcp_request",
      method: "tools/call",
      params: {
        name: "tapAny",
        arguments: {},
      },
    };

    expect(resolveMcpRequestTimeoutMs(request)).toBe(
      TAP_ANY_ORDINARY_TAP_GESTURE_WORST_CASE_MS +
        TAP_ANY_SEARCH_UNTIL_DEFAULT_MS +
        TAP_ANY_LONG_PRESS_NON_PRESS_OVERHEAD_MS,
    );
  });

  test("tapAny doubleTap budgets the same ordinary-tap floor as a plain tap (#6276)", () => {
    const request: DaemonRequest = {
      id: "1",
      type: "mcp_request",
      method: "tools/call",
      params: {
        name: "tapAny",
        arguments: { action: "doubleTap" },
      },
    };

    expect(resolveMcpRequestTimeoutMs(request)).toBe(
      TAP_ANY_ORDINARY_TAP_GESTURE_WORST_CASE_MS +
        TAP_ANY_SEARCH_UNTIL_DEFAULT_MS +
        TAP_ANY_LONG_PRESS_NON_PRESS_OVERHEAD_MS,
    );
  });

  // Issue #6306 review, P2: an earlier round of this arithmetic charged only
  // the doubleTap's on-device press time (2 * 50ms + 200ms gap = 300ms) even
  // though each of its two sequential CtrlProxy requests can independently
  // consume its own full per-request deadline before replying -- with
  // near-deadline observations that undersizing let the outer floor expire
  // even though the CtrlProxy requests were still within their own
  // established timeout. The gesture term must derive from the REAL
  // per-request deadline (floored at the established 5s default, issue #6306
  // review P1), not just the press duration.
  test("tapAny ordinary-tap gesture worst case derives from the actual per-request CtrlProxy deadline, not just on-device press time (#6306 review, P2)", () => {
    expect(TAP_ANY_ORDINARY_TAP_CTRL_PROXY_TIMEOUT_MS).toBe(
      TAP_ANY_ORDINARY_TAP_CTRL_PROXY_MIN_TIMEOUT_MS,
    );
    expect(TAP_ANY_ORDINARY_TAP_CTRL_PROXY_TIMEOUT_MS).toBeGreaterThan(
      TAP_ANY_ORDINARY_TAP_DURATION_MS,
    );
    expect(TAP_ANY_ORDINARY_TAP_GESTURE_WORST_CASE_MS).toBe(
      2 * TAP_ANY_ORDINARY_TAP_CTRL_PROXY_TIMEOUT_MS + TAP_ANY_DOUBLE_TAP_GAP_MS,
    );
    // Would have been 300ms (2 * 50ms press + 200ms gap) before the fix --
    // now at least 2 * the established 5s CtrlProxy floor.
    expect(TAP_ANY_ORDINARY_TAP_GESTURE_WORST_CASE_MS).toBeGreaterThanOrEqual(
      2 * TAP_ANY_ORDINARY_TAP_CTRL_PROXY_MIN_TIMEOUT_MS,
    );
  });

  test("tapAny ordinary tap budgets pre-gesture searchUntil.duration ahead of the fixed gesture cost (#6276)", () => {
    const searchUntilDuration = 12_000;
    const request: DaemonRequest = {
      id: "1",
      type: "mcp_request",
      method: "tools/call",
      params: {
        name: "tapAny",
        arguments: { action: "tap", searchUntil: { duration: searchUntilDuration } },
      },
    };

    expect(resolveMcpRequestTimeoutMs(request)).toBe(
      TAP_ANY_ORDINARY_TAP_GESTURE_WORST_CASE_MS +
        searchUntilDuration +
        TAP_ANY_LONG_PRESS_NON_PRESS_OVERHEAD_MS,
    );
  });

  test("tapAny ordinary tap honours an outer timeoutMs already above the derived floor (#6276)", () => {
    const request: DaemonRequest = {
      id: "1",
      type: "mcp_request",
      method: "tools/call",
      params: {
        name: "tapAny",
        arguments: { action: "tap" },
      },
      // Must exceed the derived floor for this test to actually exercise "an
      // outer timeoutMs already above the floor" rather than being silently
      // overridden by a larger floor.
      timeoutMs:
        TAP_ANY_ORDINARY_TAP_GESTURE_WORST_CASE_MS +
        TAP_ANY_SEARCH_UNTIL_DEFAULT_MS +
        TAP_ANY_LONG_PRESS_NON_PRESS_OVERHEAD_MS +
        60_000,
    };

    expect(resolveMcpRequestTimeoutMs(request)).toBe(
      TAP_ANY_ORDINARY_TAP_GESTURE_WORST_CASE_MS +
        TAP_ANY_SEARCH_UNTIL_DEFAULT_MS +
        TAP_ANY_LONG_PRESS_NON_PRESS_OVERHEAD_MS +
        60_000,
    );
  });

  // Item 2 of issue #6276: the outer budget must also cover the SEPARATE
  // pre-action `ObserveScreen.execute` call `BaseVisualChange.observedInteraction`
  // performs BEFORE the gesture, not just the post-gesture final-observation
  // retry loop -- an earlier round of this budget was blind to that call.
  test("tapAny non-press overhead includes the pre-action observation on top of the post-action retry loop (#6276)", () => {
    const observeAttempts = 1 + FINAL_OBSERVATION_MAX_RETRY_ATTEMPTS;
    const perAttemptPipelineMs =
      IOS_HIERARCHY_REQUEST_TIMEOUT_MS + IOS_VOICEOVER_STATE_REQUEST_TIMEOUT_MS;
    const postActionWorstCaseMs =
      observeAttempts * perAttemptPipelineMs +
      FINAL_OBSERVATION_RETRY_BACKOFF_MS.reduce((sum, delayMs) => sum + delayMs, 0);
    // The SEPARATE pre-action observation runs the same per-attempt pipeline
    // (hierarchy + a11y detection) exactly once, in addition to the
    // post-action retry loop above.
    const preActionObserveMs = perAttemptPipelineMs;

    expect(TAP_ANY_LONG_PRESS_NON_PRESS_OVERHEAD_MS).toBeGreaterThanOrEqual(
      IOS_VOICEOVER_STATE_REQUEST_TIMEOUT_MS /* pre-gesture VoiceOver probe */ +
        preActionObserveMs +
        postActionWorstCaseMs +
        TAP_ANY_LONG_PRESS_MCP_TIMEOUT_HEADROOM_MS,
    );
  });

  test("a tapAny longPress with omitted duration still budgets the effective default press (#6248 review)", () => {
    // TapAnyElement.getLongPressDuration substitutes a real default press
    // (1500ms on iOS, the larger of the iOS/Android defaults) when `duration`
    // is omitted -- the outer floor must budget that effective press instead
    // of assuming an omitted duration costs zero press time.
    const request: DaemonRequest = {
      id: "1",
      type: "mcp_request",
      method: "tools/call",
      params: {
        name: "tapAny",
        arguments: { action: "longPress" },
      },
    };

    const resolved = resolveMcpRequestTimeoutMs(request);
    expect(resolved).toBeGreaterThan(DEFAULT_MCP_REQUEST_TIMEOUT_MS);
    expect(resolved).toBeGreaterThanOrEqual(
      1500 + TAP_ANY_SEARCH_UNTIL_DEFAULT_MS + TAP_ANY_LONG_PRESS_NON_PRESS_OVERHEAD_MS,
    );
  });

  test("a tapAny longPress with a zero duration still budgets the effective default press (#6248 review)", () => {
    const request: DaemonRequest = {
      id: "1",
      type: "mcp_request",
      method: "tools/call",
      params: {
        name: "tapAny",
        arguments: { action: "longPress", duration: 0 },
      },
    };

    const resolved = resolveMcpRequestTimeoutMs(request);
    expect(resolved).toBeGreaterThan(DEFAULT_MCP_REQUEST_TIMEOUT_MS);
    expect(resolved).toBeGreaterThanOrEqual(
      1500 + TAP_ANY_SEARCH_UNTIL_DEFAULT_MS + TAP_ANY_LONG_PRESS_NON_PRESS_OVERHEAD_MS,
    );
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

  test("keeps transport alive through an explicit resource-configuration budget", () => {
    const request: DaemonRequest = {
      id: "resources",
      type: "mcp_request",
      method: "tools/call",
      params: { name: "setDeviceResources", arguments: { timeoutMs: 300_000 } },
    };
    expect(resolveMcpRequestTimeoutMs(request)).toBe(
      300_000 + START_DEVICE_MCP_TIMEOUT_OVERHEAD_MS,
    );
  });

  test("keeps transport alive through provisionDevice rollback", () => {
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
      600_000 + DEFAULT_DEVICE_TEARDOWN_TIMEOUT_MS + START_DEVICE_MCP_TIMEOUT_OVERHEAD_MS,
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
      DEFAULT_PROVISION_DEVICE_TIMEOUT_MS +
        DEFAULT_DEVICE_TEARDOWN_TIMEOUT_MS +
        START_DEVICE_MCP_TIMEOUT_OVERHEAD_MS,
    );
    expect(resolveMcpRequestTimeoutMs(request)).toBe(
      DEFAULT_PROVISION_DEVICE_TIMEOUT_MS +
        DEFAULT_DEVICE_TEARDOWN_TIMEOUT_MS +
        START_DEVICE_MCP_TIMEOUT_OVERHEAD_MS,
    );
  });

  test("caps provisionDevice lifecycle and rollback budgets below socket idle timeout", () => {
    const request: DaemonRequest = {
      id: "1",
      type: "mcp_request",
      method: "tools/call",
      params: {
        name: "provisionDevice",
        arguments: { timeoutMs: Number.MAX_SAFE_INTEGER },
      },
    };

    const resolved = resolveMcpRequestTimeoutMs(request);
    expect(resolved).toBe(
      MAX_PROVISION_DEVICE_TIMEOUT_MS +
        DEFAULT_DEVICE_TEARDOWN_TIMEOUT_MS +
        START_DEVICE_MCP_TIMEOUT_OVERHEAD_MS,
    );
    expect(resolved).toBeLessThan(DAEMON_RPC_SOCKET_IDLE_TIMEOUT_MS);
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

  test("onExtended listeners fire only when the deadline actually moves forward, and stop after unsubscribe (issue #6283)", () => {
    const deadline = new ProgressExtendableDeadline(0, 30_000);
    const seen: number[] = [];
    const unsubscribe = deadline.onExtended(() => seen.push(deadline.value));

    deadline.extendOnProgress(1_000, 10_000); // proposes 11s < 30s: no-op
    expect(seen).toEqual([]);

    deadline.extendOnProgress(29_000, 30_000);
    expect(seen).toEqual([59_000]);

    unsubscribe();
    unsubscribe(); // idempotent
    deadline.extendOnProgress(40_000, 30_000);
    expect(deadline.value).toBe(70_000);
    expect(seen).toEqual([59_000]);
  });
});

describe("tapOn long press outer budget", () => {
  test.each([
    ["longPress", 17000, undefined, undefined, 48500],
    ["longPress", 17000, 4000, undefined, 51000],
    ["longPress", 17000.6, 4000.6, undefined, 51002],
    ["longPress", 17000, 0, undefined, 48500],
    ["longPress", 17000, undefined, 120000, 120000],
    ["longPress", MAX_SETTIMEOUT_DELAY_MS, undefined, undefined, MAX_SETTIMEOUT_DELAY_MS],
    ["longPress", undefined, undefined, undefined, 30000],
    ["longPress", 0, undefined, undefined, 30000],
    ["longPress", Infinity, undefined, undefined, 30000],
    ["tap", 17000, undefined, undefined, 30000],
  ])(
    "action %s duration %s search %s caller %s resolves %s",
    (action, duration, searchDuration, timeoutMs, expected) => {
      const request: DaemonRequest = {
        id: "tap-on-budget",
        type: "mcp_request",
        method: "tools/call",
        timeoutMs,
        params: {
          name: "tapOn",
          arguments: { action, duration, searchUntil: { duration: searchDuration } },
        },
      };
      expect(resolveMcpRequestTimeoutMs(request)).toBe(expected!);
    },
  );
});

describe("text request floors", () => {
  for (const length of [300, 1000, 5000]) {
    test(`sendKeys covers ${length} characters`, () => {
      expect(
        resolveMcpRequestTimeoutMs({
          id: "text",
          type: "mcp_request",
          method: "tools/call",
          params: {
            name: "sendKeys",
            arguments: { commands: [{ action: "type", text: "a".repeat(length) }] },
          },
        }),
      ).toBeGreaterThan(Math.min(120_000, length * 100 + 2000));
    });
    test(`setUIState covers ${length} characters`, () => {
      expect(
        resolveMcpRequestTimeoutMs({
          id: "text",
          type: "mcp_request",
          method: "tools/call",
          params: {
            name: "setUIState",
            arguments: {
              fields: [{ selector: { elementId: "field" }, value: "a".repeat(length) }],
            },
          },
        }),
      ).toBeGreaterThan(Math.min(120_000, length * 100 + 2000));
    });
  }
  test.each(["sendKeys", "setUIState"])("short %s keeps its existing timeout", (name) => {
    expect(
      resolveMcpRequestTimeoutMs({
        id: "text",
        type: "mcp_request",
        method: "tools/call",
        params: {
          name,
          arguments: {
            commands: [{ action: "type", text: "hello" }],
            fields: [{ value: "hello" }],
          },
        },
      }),
    ).toBe(name === "sendKeys" ? 30_000 : 60_000);
  });
});

test("short sendKeys keeps a caller timeout that already fits", () => {
  expect(
    resolveMcpRequestTimeoutMs({
      id: "short",
      type: "mcp_request",
      method: "tools/call",
      timeoutMs: 10_000,
      params: { name: "sendKeys", arguments: { commands: [{ action: "type", text: "hello" }] } },
    }),
  ).toBe(10_000);
});

test("text request floor budgets sequential commands independently", () => {
  expect(
    resolveMcpRequestTimeoutMs({
      id: "batch",
      type: "mcp_request",
      method: "tools/call",
      params: {
        name: "sendKeys",
        arguments: {
          commands: [
            { action: "type", text: "a".repeat(1000) },
            { action: "clear" },
            { action: "type", text: "hello" },
          ],
        },
      },
    }),
  ).toBe(147_000);
});

describe("bounded excess text request floors", () => {
  const resolve = (name: string, texts: string[], timeoutMs?: number): number =>
    resolveMcpRequestTimeoutMs({
      id: "text-excess",
      type: "mcp_request",
      method: "tools/call",
      timeoutMs,
      params: {
        name,
        arguments:
          name === "sendKeys"
            ? { commands: texts.map((text) => ({ action: "type", text })) }
            : { fields: texts.map((value) => ({ value })) },
      },
    });

  test.each([
    [300, 77_000],
    [1000, 147_000],
    [5000, 165_000],
  ])("single sendKeys length %s has floor %s", (length, expected) => {
    expect(resolve("sendKeys", ["a".repeat(length)])).toBe(expected);
  });

  test("twenty short fields preserve the existing floor and caller precedence", () => {
    const texts = Array.from({ length: 20 }, () => "a".repeat(30));
    expect(resolve("setUIState", texts)).toBe(60_000);
    expect(resolve("setUIState", texts, 90_000)).toBe(90_000);
    expect(resolve("sendKeys", texts, 10_000)).toBe(10_000);
  });

  test("crossing the short-text boundary adds one margin and only the excess", () => {
    const texts = Array.from({ length: 20 }, () => "a".repeat(30));
    texts[0] += "a";
    expect(resolve("setUIState", texts)).toBe(80_100);
    texts[0] += "a";
    expect(resolve("setUIState", texts)).toBe(80_200);
  });

  test("two long entries share one margin", () => {
    expect(resolve("setUIState", ["a".repeat(300), "a".repeat(1000)])).toBe(204_000);
  });

  test("a larger caller timeout retains precedence over the text floor", () => {
    expect(resolve("sendKeys", ["a".repeat(1000)], 200_000)).toBe(200_000);
  });

  test("twenty 500-character fields budget excesses", () => {
    expect(
      resolve(
        "setUIState",
        Array.from({ length: 20 }, () => "a".repeat(500)),
      ),
    ).toBe(1_020_000);
  });

  test.each(["sendKeys", "setUIState"])("%s text floor cannot exceed the caller cap", (name) => {
    expect(
      resolve(
        name,
        Array.from({ length: 100 }, () => "a".repeat(1000)),
      ),
    ).toBe(MAX_CALLER_MCP_REQUEST_TIMEOUT_MS);
  });
});

describe("argument budget deadline gaps", () => {
  for (const budget of MCP_ARGUMENT_BUDGET_CASES) {
    const resolve = (args: unknown, timeoutMs?: number): number =>
      resolveMcpRequestTimeoutMs({
        id: "argument-budget",
        type: "mcp_request",
        method: "tools/call",
        timeoutMs,
        params: { name: budget.tool, arguments: args },
      });
    test(`${budget.tool} omitted arguments use the default floor`, () => {
      expect(resolve(undefined)).toBe(budget.defaultFloor);
      expect(resolve({})).toBe(budget.defaultFloor);
      expect(resolve(budget.argumentsFor(undefined))).toBe(budget.defaultFloor);
    });
    test(`${budget.tool} supplied work budget gets headroom`, () => {
      expect(resolve(budget.argumentsFor(budget.supplied))).toBe(budget.suppliedFloor);
    });
    test(`${budget.tool} larger request timeout wins`, () => {
      expect(resolve({}, 1_000_000)).toBe(1_000_000);
      expect(resolve(budget.argumentsFor(budget.supplied), 1_000_000)).toBe(1_000_000);
    });
    test(`${budget.tool} malformed arguments are safe and bounded`, () => {
      for (const value of MALFORMED_MCP_BUDGETS) {
        const result = resolve(budget.argumentsFor(value));
        expect(result).toBeGreaterThanOrEqual(budget.defaultFloor);
        expect(result).toBeLessThanOrEqual(MAX_CALLER_MCP_REQUEST_TIMEOUT_MS);
        if (
          value !== Number.MAX_SAFE_INTEGER ||
          budget.tool.includes("Storage") ||
          budget.tool === "putAppFile"
        ) {
          expect(result).toBe(budget.defaultFloor);
        }
      }
      for (const args of [null, "wrong", [], { waitFor: [] }]) {
        expect(resolve(args)).toBe(budget.defaultFloor);
      }
      expect(resolve(budget.argumentsFor(budget.oversized))).toBe(
        MAX_CALLER_MCP_REQUEST_TIMEOUT_MS,
      );
    });
  }
  test("observe uses nested timeout aliases for legacy and DSL waits", () => {
    const resolve = (args: Record<string, unknown>) =>
      resolveMcpRequestTimeoutMs({
        id: "observe-alias",
        type: "mcp_request",
        method: "tools/call",
        params: { name: "observe", arguments: args },
      });
    for (const selector of [
      { elementId: "missing" },
      { for: "appear" },
      { for: "stable" },
      { textAny: ["missing"] },
    ]) {
      expect(resolve({ waitFor: { ...selector, timeoutMs: 600_000 } })).toBe(630_000);
      expect(resolve({ waitFor: { ...selector, timeout: 600_000, timeoutMs: 700_000 } })).toBe(
        630_000,
      );
    }
    expect(resolve({ timeoutMs: 600_000 })).toBe(DEFAULT_OBSERVE_MCP_TIMEOUT_MS);
    expect(resolve({ waitFor: { for: "stable" } })).toBe(DEFAULT_OBSERVE_MCP_TIMEOUT_MS);
    const previousFloor = process.env[OBSERVE_MCP_TIMEOUT_ENV_VAR];
    process.env[OBSERVE_MCP_TIMEOUT_ENV_VAR] = "700000";
    try {
      expect(resolve({ waitFor: { timeout: 600_000 } })).toBe(700_000);
    } finally {
      if (previousFloor === undefined) {
        delete process.env[OBSERVE_MCP_TIMEOUT_ENV_VAR];
      } else {
        process.env[OBSERVE_MCP_TIMEOUT_ENV_VAR] = previousFloor;
      }
    }
  });
  describe("overlay awaitEvent", () => {
    const resolve = (args: unknown, timeoutMs?: number): number =>
      resolveMcpRequestTimeoutMs({
        id: "overlay-await",
        type: "mcp_request",
        method: "tools/call",
        timeoutMs,
        params: { name: "overlay", arguments: args },
      });
    const headroom = WAIT_BUDGET_MCP_TIMEOUT_HEADROOM_MS;
    test("the default wait outlives the tool's own default timeout", () => {
      expect(resolve({ action: "awaitEvent", id: "panel" })).toBe(
        DEFAULT_OVERLAY_EVENT_TIMEOUT_MS + headroom,
      );
      expect(resolve({ action: "awaitEvent", id: "panel" })).toBeGreaterThan(
        DEFAULT_OVERLAY_EVENT_TIMEOUT_MS,
      );
    });
    test("a supplied timeoutMs gets headroom, including the 60 s maximum", () => {
      expect(resolve({ action: "awaitEvent", timeoutMs: 45_000 })).toBe(45_000 + headroom);
      expect(resolve({ action: "awaitEvent", timeoutMs: MAX_OVERLAY_EVENT_TIMEOUT_MS })).toBe(
        MAX_OVERLAY_EVENT_TIMEOUT_MS + headroom,
      );
      expect(resolve({ action: "awaitEvent", timeoutMs: 10 })).toBe(10 + headroom);
    });
    test("an over-maximum value is bounded by the tool's maximum", () => {
      expect(resolve({ action: "awaitEvent", timeoutMs: 600_000 })).toBe(
        MAX_OVERLAY_EVENT_TIMEOUT_MS + headroom,
      );
      expect(resolve({ action: "awaitEvent", timeoutMs: Number.MAX_SAFE_INTEGER })).toBe(
        MAX_OVERLAY_EVENT_TIMEOUT_MS + headroom,
      );
    });
    test("malformed values and arguments use the default wait", () => {
      for (const value of MALFORMED_MCP_BUDGETS) {
        const result = resolve({ action: "awaitEvent", timeoutMs: value });
        expect(result).toBeLessThanOrEqual(MAX_OVERLAY_EVENT_TIMEOUT_MS + headroom);
        if (value !== Number.MAX_SAFE_INTEGER) {
          expect(result).toBe(DEFAULT_OVERLAY_EVENT_TIMEOUT_MS + headroom);
        }
      }
      for (const args of [null, "wrong", [], undefined, {}]) {
        expect(resolve(args)).toBe(DEFAULT_MCP_REQUEST_TIMEOUT_MS);
      }
    });
    test("other overlay actions and a larger request timeout are unchanged", () => {
      for (const action of ["show", "update", "dismiss", "status", "toString", 1, undefined]) {
        expect(resolve({ action, timeoutMs: 60_000 })).toBe(DEFAULT_MCP_REQUEST_TIMEOUT_MS);
      }
      expect(resolve({ action: "awaitEvent", timeoutMs: 60_000 }, 1_000_000)).toBe(1_000_000);
    });
    test("show and update with assets budget one upload timeout per asset plus the request", () => {
      const assets = (count: number) =>
        Array.from({ length: count }, (_, i) => ({ id: `a${i}`, path: `/x/${i}.png` }));
      const perAsset = DEFAULT_OVERLAY_ASSET_TIMEOUT_MS;
      for (const action of ["show", "update"]) {
        expect(resolve({ action, assets: assets(1) })).toBe(perAsset + 5_000 + headroom);
        expect(resolve({ action, assets: assets(4) })).toBe(4 * perAsset + 5_000 + headroom);
        expect(resolve({ action, assets: assets(4), timeoutMs: 20_000 })).toBe(
          4 * perAsset + 20_000 + headroom,
        );
      }
      // The tool rejects more than the contract maximum, so the budget stops growing there.
      expect(resolve({ action: "show", assets: assets(500) })).toBe(
        MAX_OVERLAY_ASSET_COUNT * perAsset + 5_000 + headroom,
      );
    });
    test("show without usable assets keeps the default deadline", () => {
      for (const assets of [undefined, [], "x", null, {}]) {
        expect(resolve({ action: "show", assets })).toBe(DEFAULT_MCP_REQUEST_TIMEOUT_MS);
      }
    });
    test("hostile tool names never reach a resolver", () => {
      for (const name of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
        expect(
          resolveMcpRequestTimeoutMs({
            id: "hostile",
            type: "mcp_request",
            method: "tools/call",
            params: { name, arguments: { action: "awaitEvent" } },
          }),
        ).toBe(DEFAULT_MCP_REQUEST_TIMEOUT_MS);
      }
    });
  });
  test("putAppFile legacy single-file shape uses one push floor", () => {
    expect(
      resolveMcpRequestTimeoutMs({
        id: "legacy-file",
        type: "mcp_request",
        method: "tools/call",
        params: {
          name: "putAppFile",
          arguments: {
            appId: "example",
            container: "data",
            destinationPath: "fixture",
            contentText: "x",
          },
        },
      }),
    ).toBe(150_000);
  });
  test.each(["tapOn", "listDevices", "observe"])(
    "%s unrelated arguments keep the existing deadline",
    (name) => {
      expect(
        resolveMcpRequestTimeoutMs({
          id: "unrelated",
          type: "mcp_request",
          method: "tools/call",
          params: {
            name,
            arguments: { timeout: 600_000, timeoutMs: 600_000, files: new Array(100) },
          },
        }),
      ).toBe(name === "observe" ? DEFAULT_OBSERVE_MCP_TIMEOUT_MS : DEFAULT_MCP_REQUEST_TIMEOUT_MS);
    },
  );
});

test("request budget constants are the tool implementation constants", () => {
  expect(DEFAULT_DEVICE_SNAPSHOT_CONFIG.vmSnapshotTimeoutMs).toBe(DEFAULT_VM_SNAPSHOT_TIMEOUT_MS);
  expect(schemaSnapshotMaxMs).toBe(MAX_VM_SNAPSHOT_TIMEOUT_MS);
  expect(coordinatorDefaultMs).toBe(BARRIER_TIMEOUT_MS);
  expect(explorationDefaultMs).toBe(DEFAULT_EXPLORE_TIMEOUT_MS);
  expect(storagePushMs).toBe(SHARED_STORAGE_PUSH_TIMEOUT_MS);
  expect(appPushMs).toBe(APP_FILE_PUSH_TIMEOUT_MS);
});

describe("client-supplied tool names that match inherited object members", () => {
  const INHERITED_NAMES = ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"];
  const ARGUMENT_SETS: Array<Record<string, unknown> | undefined> = [
    undefined,
    {},
    { timeout: 600_000, timeoutMs: 600_000, files: [{}, {}], commands: [], fields: [] },
  ];

  test.each(INHERITED_NAMES)("%s resolves to the default deadline without throwing", (name) => {
    for (const args of ARGUMENT_SETS) {
      expect(
        resolveMcpRequestTimeoutMs({
          id: "inherited",
          type: "mcp_request",
          method: "tools/call",
          params: { name, arguments: args },
        }),
      ).toBe(DEFAULT_MCP_REQUEST_TIMEOUT_MS);
    }
  });

  test.each([undefined, null, 7, true, {}])(
    "non-string tool name %p resolves to the default deadline without throwing",
    (name) => {
      for (const args of ARGUMENT_SETS) {
        const request = {
          id: "non-string",
          type: "mcp_request",
          method: "tools/call",
          params: { name, arguments: args },
        } as unknown as Parameters<typeof resolveMcpRequestTimeoutMs>[0];
        expect(resolveMcpRequestTimeoutMs(request)).toBe(DEFAULT_MCP_REQUEST_TIMEOUT_MS);
      }
    },
  );
});

describe("executePlan deadline derived from the plan's steps (#9882)", () => {
  const HEADROOM_MS = EXECUTE_PLAN_BUDGET_HEADROOM_MS;
  // observe waitFor budgets its timeout plus the wait headroom.
  const observeWait = (timeoutMs: number, extra: Record<string, unknown> = {}) => ({
    tool: "observe",
    params: { waitFor: { elementId: "x", timeout: timeoutMs }, ...extra },
  });
  const observeWaitMs = (timeoutMs: number): number =>
    timeoutMs + WAIT_BUDGET_MCP_TIMEOUT_HEADROOM_MS;
  // JSON is valid YAML, and the daemon sees planContent as a YAML string.
  const planContent = (plan: Record<string, unknown>): string => JSON.stringify(plan);
  const resolvePlan = (content: unknown, timeoutMs?: number): number =>
    resolveMcpRequestTimeoutMs({
      id: "plan",
      type: "mcp_request",
      method: "tools/call",
      timeoutMs,
      params: { name: "executePlan", arguments: { planContent: content, platform: "android" } },
    });

  test("sequential waits sum past the 600 s floor, plus headroom", () => {
    const content = planContent({
      name: "p",
      steps: [observeWait(300_000), observeWait(300_000), observeWait(300_000)],
    });
    expect(resolvePlan(content)).toBe(3 * observeWaitMs(300_000) + HEADROOM_MS);
    expect(resolvePlan(content)).toBeGreaterThan(MIN_EXECUTE_PLAN_MCP_TIMEOUT_MS);
  });

  test("parallel device tracks take the longest track's sum, not the total", () => {
    const content = planContent({
      name: "p",
      devices: ["A", "B"],
      steps: [
        observeWait(300_000, { device: "A" }),
        observeWait(300_000, { device: "B" }),
        observeWait(300_000, { device: "A" }),
        observeWait(300_000, { device: "B" }),
        observeWait(300_000, { device: "A" }),
      ],
    });
    // Track A has three waits, track B two.
    expect(resolvePlan(content)).toBe(3 * observeWaitMs(300_000) + HEADROOM_MS);
  });

  test("criticalSection counts its barrier wait and its nested sub-steps on the owner track", () => {
    const content = planContent({
      name: "p",
      devices: ["A", "B"],
      steps: [
        {
          tool: "criticalSection",
          params: {
            device: "A",
            lock: "l",
            deviceCount: 2,
            steps: [
              { tool: "observe", params: { device: "A", waitFor: { timeout: 400_000 } } },
              { tool: "observe", params: { device: "A", waitFor: { timeout: 400_000 } } },
            ],
          },
        },
        observeWait(100_000, { device: "B" }),
      ],
    });
    const barrierMs = BARRIER_TIMEOUT_MS + WAIT_BUDGET_MCP_TIMEOUT_HEADROOM_MS;
    expect(resolvePlan(content)).toBe(barrierMs + 2 * observeWaitMs(400_000) + HEADROOM_MS);
  });

  test("legacy `command` and inline-param steps are budgeted like params steps", () => {
    const content = [
      "name: p",
      "steps:",
      "  - command: observe",
      "    waitFor: { timeout: 500000 }",
      "  - tool: observe",
      "    params:",
      "      waitFor: { timeout: 500000 }",
    ].join("\n");
    expect(resolvePlan(content)).toBe(2 * observeWaitMs(500_000) + HEADROOM_MS);
  });

  test("fixed-floor tools such as installApp contribute their own floor", () => {
    const content = planContent({
      name: "p",
      steps: [
        { tool: "installApp", params: { apk: "a" } },
        { tool: "installApp", params: { apk: "b" } },
      ],
    });
    expect(resolvePlan(content)).toBe(2 * MIN_INSTALL_APP_MCP_TIMEOUT_MS + HEADROOM_MS);
  });

  test("a short plan keeps the 600 s floor", () => {
    const content = planContent({
      name: "p",
      steps: [
        { tool: "tapOn", params: { text: "ok" } },
        { tool: "observe", params: {} },
        observeWait(5_000),
      ],
    });
    expect(resolvePlan(content)).toBe(MIN_EXECUTE_PLAN_MCP_TIMEOUT_MS);
  });

  test("a larger caller timeout wins", () => {
    const content = planContent({
      name: "p",
      steps: [observeWait(300_000), observeWait(300_000), observeWait(300_000)],
    });
    expect(resolvePlan(content, 1_500_000)).toBe(1_500_000);
  });

  test("a sum beyond the global cap saturates at the cap", () => {
    const content = planContent({
      name: "p",
      steps: Array.from({ length: 10 }, () => observeWait(300_000)),
    });
    expect(resolvePlan(content)).toBe(MAX_CALLER_MCP_REQUEST_TIMEOUT_MS);
  });

  test("malformed plans fall back to the floor without throwing", () => {
    const malformed: unknown[] = [
      undefined,
      null,
      42,
      ["steps"],
      "",
      ": : [",
      "just a string",
      "- a\n- b",
      planContent({ name: "p" }),
      planContent({ name: "p", steps: "nope" }),
      planContent({ name: "p", steps: { tool: "observe" } }),
      planContent({ name: "p", steps: [null, 1, "x", [], {}, { tool: 5 }, { tool: "observe" }] }),
      planContent({ name: "p", steps: [{ tool: "observe", params: "bad" }] }),
      planContent({ name: "p", steps: [{ tool: "criticalSection", params: { steps: "bad" } }] }),
      planContent({ name: "p", devices: "A", steps: [{ tool: "observe", params: { device: 1 } }] }),
    ];
    for (const content of malformed) {
      expect(resolvePlan(content)).toBe(MIN_EXECUTE_PLAN_MCP_TIMEOUT_MS);
    }
  });

  test("absurd numbers stay within the cap", () => {
    const content = planContent({
      name: "p",
      steps: [
        observeWait(Number.MAX_SAFE_INTEGER),
        observeWait(Number.NaN),
        observeWait(-1),
        { tool: "barrier", params: { timeout: 1e308 } },
      ],
    });
    expect(resolvePlan(content)).toBe(MAX_CALLER_MCP_REQUEST_TIMEOUT_MS);
  });

  test("oversized plans saturate instead of being walked", () => {
    const manySteps = planContent({
      name: "p",
      steps: Array.from({ length: MAX_EXECUTE_PLAN_BUDGET_STEPS + 1 }, () => ({ tool: "tapOn" })),
    });
    expect(resolvePlan(manySteps)).toBe(MAX_CALLER_MCP_REQUEST_TIMEOUT_MS);
    expect(resolvePlan("#".repeat(MAX_EXECUTE_PLAN_BUDGET_CONTENT_CHARS + 1))).toBe(
      MAX_CALLER_MCP_REQUEST_TIMEOUT_MS,
    );
    let nested: Record<string, unknown> = { tool: "tapOn" };
    for (let depth = 0; depth < 20; depth += 1) {
      nested = { tool: "criticalSection", params: { steps: [nested] } };
    }
    expect(resolvePlan(planContent({ name: "p", steps: [nested] }))).toBe(
      MAX_CALLER_MCP_REQUEST_TIMEOUT_MS,
    );
  });

  test("a plan exactly at the step bound is still budgeted, not saturated", () => {
    const content = planContent({
      name: "p",
      steps: Array.from({ length: MAX_EXECUTE_PLAN_BUDGET_STEPS }, () => ({ tool: "tapOn" })),
    });
    expect(resolvePlan(content)).toBe(MIN_EXECUTE_PLAN_MCP_TIMEOUT_MS);
  });

  test("only executePlan is affected, and only on tools/call", () => {
    const content = planContent({ name: "p", steps: [observeWait(900_000)] });
    expect(
      resolveMcpRequestTimeoutMs({
        id: "other",
        type: "mcp_request",
        method: "tools/call",
        params: { name: "tapOn", arguments: { planContent: content } },
      }),
    ).toBe(DEFAULT_MCP_REQUEST_TIMEOUT_MS);
    expect(
      resolveMcpRequestTimeoutMs({
        id: "other",
        type: "mcp_request",
        method: "resources/read",
        params: { name: "executePlan", arguments: { planContent: content } },
      }),
    ).toBe(DEFAULT_MCP_REQUEST_TIMEOUT_MS);
  });
});
