/**
 * Host-domain receipt time on the Android hierarchy delegate (issue #5377).
 *
 * Observation age must be measured in a single clock domain. The Android device
 * clock (an emulator, commonly) can be seconds off the host, so subtracting the
 * device-authored `updatedAt` from host `now` misreports that skew as age. The
 * delegate already tracks a host-clock `receivedAt` for its cache; these tests
 * pin that it is carried onto the converted `ViewHierarchyResult` so
 * `ObserveScreen` can base age on it:
 *
 *   - a fresh sync stamps `receivedAt` to the current HOST clock, and
 *   - a cache hit carries the cache entry's ORIGINAL host receipt time.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { CtrlProxyHierarchy } from "../../../../src/features/observe/android/CtrlProxyHierarchy";
import type {
  AccessibilityHierarchy,
  CachedHierarchy,
  HierarchyDelegateContext,
} from "../../../../src/features/observe/android/types";
import type { ViewHierarchyResult } from "../../../../src/models/ViewHierarchyResult";
import { AndroidCtrlProxyManager } from "../../../../src/utils/CtrlProxyManager";
import { RequestManager } from "../../../../src/utils/RequestManager";
import { FakeTimer } from "../../../fakes/FakeTimer";

interface Harness {
  hierarchy: CtrlProxyHierarchy;
  timer: FakeTimer;
  setCached: (h: CachedHierarchy | null) => void;
  restore: () => void;
}

function createHarness(): Harness {
  const timer = new FakeTimer();
  let cached: CachedHierarchy | null = null;

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
    isAvailable: async () => true,
  } as never);

  const hierarchy = new CtrlProxyHierarchy(context);
  // The tree content and its conversion are not under test — return a minimal
  // converted result so we can assert only the receipt-time metadata on it.
  const convertSpy = spyOn(hierarchy, "convertToViewHierarchyResult").mockImplementation(
    (h: AccessibilityHierarchy) =>
      ({ hierarchy: { node: { $: {} } }, updatedAt: h.updatedAt }) as ViewHierarchyResult,
  );

  return {
    hierarchy,
    timer,
    setCached: (h) => {
      cached = h;
    },
    restore: () => {
      managerSpy.mockRestore();
      convertSpy.mockRestore();
    },
  };
}

const DEVICE_SKEW_MS = 25_000;

describe("Android CtrlProxyHierarchy host-domain receivedAt (#5377)", () => {
  let h: Harness | null = null;

  afterEach(() => {
    h?.restore();
    h = null;
  });

  test("a fresh sync stamps receivedAt to the current host clock, not the device timestamp", async () => {
    h = createHarness();
    h.timer.advanceTime(100_000); // host clock now well past 0

    // No cache, so the delegate falls through to a synchronous fetch. The device
    // authored `updatedAt` is skewed 25s behind the host clock.
    const deviceUpdatedAt = h.timer.now() - DEVICE_SKEW_MS;
    const syncSpy = spyOn(h.hierarchy, "requestHierarchySync").mockResolvedValue({
      hierarchy: {
        updatedAt: deviceUpdatedAt,
        packageName: "com.test.app",
      } as AccessibilityHierarchy,
    });

    const result = await h.hierarchy.getAccessibilityHierarchy(undefined, undefined, true, 0);

    expect(result).not.toBeNull();
    expect(result!.updatedAt).toBe(deviceUpdatedAt); // device timestamp preserved
    expect(result!.receivedAt).toBe(h.timer.now()); // host domain, ~now
    syncSpy.mockRestore();
  });

  test("a cache hit carries the cache entry's original host receipt time", async () => {
    h = createHarness();
    h.timer.advanceTime(100_000);

    const receivedAt = h.timer.now() - 300; // host domain: cached 300ms ago
    const deviceUpdatedAt = h.timer.now() - DEVICE_SKEW_MS; // device domain, skewed
    h.setCached({
      hierarchy: {
        updatedAt: deviceUpdatedAt,
        packageName: "com.test.app",
      } as AccessibilityHierarchy,
      receivedAt,
      fresh: true,
    });

    // Glance path (skipWaitForFresh) so the fresh cache entry is served directly.
    const result = await h.hierarchy.getAccessibilityHierarchy(undefined, undefined, true, 0);

    expect(result).not.toBeNull();
    expect(result!.receivedAt).toBe(receivedAt);
  });
});
