/**
 * Deadline budgeting for the Android hierarchy delegate (issue #4261).
 *
 * `getAccessibilityHierarchy(..., timeoutMs)` documents `timeoutMs` as the
 * OVERALL budget for the read — it exists so a caller polling against its own
 * deadline (keyboard-state confirmation) cannot be blocked past it. The sync
 * fallback already subtracts elapsed time; the WebSocket fresh-data wait did
 * not, so a slow availability check or reconnect could be followed by another
 * full `DEFAULT_FRESH_WAIT_MS` wait on top of time already spent.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { CtrlProxyHierarchy } from "../../../../src/features/observe/android/CtrlProxyHierarchy";
import type {
  CachedHierarchy,
  HierarchyDelegateContext,
} from "../../../../src/features/observe/android/types";
import { AndroidCtrlProxyManager } from "../../../../src/utils/CtrlProxyManager";
import { RequestManager } from "../../../../src/utils/RequestManager";
import { FakeTimer } from "../../../fakes/FakeTimer";

const DEFAULT_FRESH_WAIT_MS = 1000;

interface Harness {
  hierarchy: CtrlProxyHierarchy;
  timer: FakeTimer;
  /** `freshWaitMs` handed to `getLatestHierarchy`, or null if it was never called. */
  observedFreshWait: () => number | null;
  restore: () => void;
}

/**
 * @param availabilityCostMs fake milliseconds the availability check burns
 *   before the fresh wait starts.
 */
function createHarness(availabilityCostMs: number): Harness {
  const timer = new FakeTimer();
  let cached: CachedHierarchy | null = null;
  let observedFreshWait: number | null = null;

  const context: HierarchyDelegateContext = {
    getWebSocket: () => null,
    requestManager: new RequestManager(timer),
    timer,
    ensureConnected: async () => true,
    cancelScreenshotBackoff: () => {},
    device: { deviceId: "emulator-5554", platform: "android" } as never,
    adb: {} as never,
    getCachedHierarchy: () => cached,
    setCachedHierarchy: (h) => {
      cached = h;
    },
    getLastWebSocketTimeout: () => 0,
    setLastWebSocketTimeout: () => {},
  };

  const managerSpy = spyOn(AndroidCtrlProxyManager, "getInstance").mockReturnValue({
    isAvailable: async () => {
      timer.advanceTime(availabilityCostMs);
      return true;
    },
  } as never);

  const hierarchy = new CtrlProxyHierarchy(context);
  const latestSpy = spyOn(hierarchy, "getLatestHierarchy").mockImplementation(
    async (_waitForFresh?: boolean, freshWaitMs?: number) => {
      observedFreshWait = freshWaitMs ?? null;
      return { hierarchy: null, fresh: false };
    },
  );
  // The sync fallback is not under test here; keep it from reaching a device.
  const syncSpy = spyOn(hierarchy, "requestHierarchySync").mockResolvedValue(null);

  return {
    hierarchy,
    timer,
    observedFreshWait: () => observedFreshWait,
    restore: () => {
      managerSpy.mockRestore();
      latestSpy.mockRestore();
      syncSpy.mockRestore();
    },
  };
}

describe("Android CtrlProxyHierarchy fresh-wait budgeting", () => {
  let h: Harness | null = null;

  afterEach(() => {
    h?.restore();
    h = null;
  });

  test("the fresh wait is charged against time already spent on the availability check", async () => {
    h = createHarness(800);

    await h.hierarchy.getAccessibilityHierarchy(
      undefined,
      undefined,
      false,
      0,
      false,
      undefined,
      1000,
    );

    // 1000ms budget, 800ms already burned: at most 200ms is left for the wait.
    expect(h.observedFreshWait()).toBe(200);
  });

  test("an availability check that overruns the whole budget leaves no fresh wait", async () => {
    h = createHarness(1500);

    await h.hierarchy.getAccessibilityHierarchy(
      undefined,
      undefined,
      false,
      0,
      false,
      undefined,
      1000,
    );

    expect(h.observedFreshWait()).toBe(0);
  });

  test("a fast availability check still gets the full requested wait", async () => {
    h = createHarness(0);

    await h.hierarchy.getAccessibilityHierarchy(
      undefined,
      undefined,
      false,
      0,
      false,
      undefined,
      500,
    );

    expect(h.observedFreshWait()).toBe(500);
  });

  test("without a caller budget the default fresh wait is unchanged", async () => {
    h = createHarness(800);

    await h.hierarchy.getAccessibilityHierarchy(
      undefined,
      undefined,
      false,
      0,
      false,
      undefined,
      undefined,
    );

    expect(h.observedFreshWait()).toBe(DEFAULT_FRESH_WAIT_MS);
  });
});
