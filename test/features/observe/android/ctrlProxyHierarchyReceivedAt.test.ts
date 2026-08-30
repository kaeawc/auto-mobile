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
  setPackageRunning: (running: boolean) => void;
  setProbeGate: (gate: Promise<void>) => void;
  waitForProbeStart: () => Promise<void>;
  restore: () => void;
}

function createHarness(): Harness {
  const timer = new FakeTimer();
  let cached: CachedHierarchy | null = null;
  let packageRunning = true;
  let probeGate: Promise<void> = Promise.resolve();
  let resolveProbeStart!: () => void;
  const probeStarted = new Promise<void>((resolve) => {
    resolveProbeStart = resolve;
  });

  const context: HierarchyDelegateContext = {
    getWebSocket: () => null,
    requestManager: new RequestManager(timer),
    timer,
    ensureConnected: async () => true,
    cancelScreenshotBackoff: () => {},
    device: { deviceId: "emulator-5554", platform: "android" } as never,
    adb: {
      executeCommand: async (
        _command: string,
        _timeoutMs?: number,
        _options?: unknown,
        _synchronous?: boolean,
        signal?: AbortSignal,
      ) => {
        resolveProbeStart();
        await probeGate;
        if (signal?.aborted) {
          throw signal.reason;
        }
        return { stdout: packageRunning ? "1234\n" : "" };
      },
    } as never,
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
      ({
        hierarchy: { node: { $: {} } },
        packageName: h.packageName,
        updatedAt: h.updatedAt,
      }) as ViewHierarchyResult,
  );

  return {
    hierarchy,
    timer,
    setCached: (h) => {
      cached = h;
    },
    setPackageRunning: (running) => {
      packageRunning = running;
    },
    setProbeGate: (gate) => {
      probeGate = gate;
    },
    waitForProbeStart: () => probeStarted,
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

  test("invalidates cached hierarchy when its package is no longer running", async () => {
    h = createHarness();
    h.setCached({
      hierarchy: {
        updatedAt: h.timer.now(),
        packageName: "com.stale.app",
      } as AccessibilityHierarchy,
      receivedAt: h.timer.now(),
      fresh: false,
    });
    h.setPackageRunning(false);

    const syncSpy = spyOn(h.hierarchy, "requestHierarchySync").mockResolvedValue({
      hierarchy: {
        updatedAt: h.timer.now(),
        packageName: "com.current.app",
      } as AccessibilityHierarchy,
    });

    const result = await h.hierarchy.getAccessibilityHierarchy(undefined, undefined, true, 0);

    expect(syncSpy).toHaveBeenCalledTimes(1);
    expect(result).not.toBeNull();
    expect(result!.packageName).toBe("com.current.app");
    syncSpy.mockRestore();
  });

  test("preserves a replacement cache entry received during the liveness probe", async () => {
    h = createHarness();
    h.setCached({
      hierarchy: { packageName: "com.stale.app" } as AccessibilityHierarchy,
      receivedAt: h.timer.now(),
      fresh: false,
    });
    h.setPackageRunning(false);

    let releaseProbe!: () => void;
    h.setProbeGate(new Promise<void>((resolve) => (releaseProbe = resolve)));
    const latestPromise = h.hierarchy.getLatestHierarchy(false, 100);
    await h.waitForProbeStart();

    h.setCached({
      hierarchy: { packageName: "com.current.app" } as AccessibilityHierarchy,
      receivedAt: h.timer.now(),
      fresh: true,
    });
    releaseProbe();

    const result = await latestPromise;

    expect(result.hierarchy?.packageName).toBe("com.current.app");
    expect(result.fresh).toBe(true);
  });

  test("uses the remaining request budget for the fresh hierarchy wait", async () => {
    h = createHarness();
    h.timer.advanceTime(1000);
    h.setCached({
      hierarchy: { packageName: "com.test.app" } as AccessibilityHierarchy,
      receivedAt: h.timer.now() - 1,
      fresh: false,
    });

    let releaseProbe!: () => void;
    h.setProbeGate(new Promise<void>((resolve) => (releaseProbe = resolve)));
    let freshWaitTimeout: number | null = null;
    Reflect.set(h.hierarchy, "waitForFreshData", (timeout: number) => {
      freshWaitTimeout = timeout;
      return Promise.resolve(null);
    });
    const latestPromise = h.hierarchy.getLatestHierarchy(true, 1000);
    await h.waitForProbeStart();

    h.timer.advanceTime(900);
    releaseProbe();

    const result = await latestPromise;
    expect(freshWaitTimeout).toBe(100);
    expect(result.fresh).toBe(false);
  });

  test("re-evaluates cache freshness after the liveness probe", async () => {
    h = createHarness();
    h.timer.advanceTime(1000);
    h.setCached({
      hierarchy: { packageName: "com.test.app" } as AccessibilityHierarchy,
      receivedAt: h.timer.now() - 900,
      fresh: true,
    });

    let releaseProbe!: () => void;
    h.setProbeGate(new Promise<void>((resolve) => (releaseProbe = resolve)));
    const latestPromise = h.hierarchy.getLatestHierarchy(false, 1000);
    await h.waitForProbeStart();

    h.timer.advanceTime(200);
    releaseProbe();

    const result = await latestPromise;
    expect(result.fresh).toBe(false);
  });

  test("does not return cached data when the liveness probe is aborted", async () => {
    h = createHarness();
    h.setCached({
      hierarchy: { packageName: "com.test.app" } as AccessibilityHierarchy,
      receivedAt: h.timer.now(),
      fresh: true,
    });

    let releaseProbe!: () => void;
    h.setProbeGate(new Promise<void>((resolve) => (releaseProbe = resolve)));
    const controller = new AbortController();
    const latestPromise = h.hierarchy.getLatestHierarchy(
      false,
      1000,
      undefined,
      false,
      0,
      controller.signal,
    );
    await h.waitForProbeStart();

    controller.abort();
    releaseProbe();

    const result = await latestPromise;
    expect(result.hierarchy).toBeNull();
    expect(result.fresh).toBe(false);
  });
});
