/**
 * Standalone repro for the AutoMobile `observe` freshness defect (upstream issue:
 * "observe (iOS): the standalone observe glance reports freshness.isFresh: true
 * unconditionally").
 *
 * These tests need NO device and NO patch to *run* — they exercise the real
 * `RealObserveScreen`/`CtrlProxyHierarchy` production classes through fakes this
 * repo already ships (`FakeTimer`, `FakeAdbExecutor`, `RequestManager`, …). They
 * are written to assert the CORRECT behaviour, so on an unpatched checkout they
 * fail red, naming exactly what a consumer would see: a stale tree reported as
 * fresh. Applying the freshness fix turns them green with no other changes.
 *
 * Three failure shapes, one test each:
 *
 *   1. THE CONSTANT — a plain `observe` (no `minTimestamp`, i.e. every call the
 *      public tool schema can make) reports `isFresh: true` no matter how old the
 *      hierarchy's own `updatedAt` is, because `ObserveScreen`'s freshness
 *      diagnostics hardcode `true` on that branch and never look at the age.
 *
 *   2. THE DISCARDED VERDICT — the iOS hierarchy delegate already knows when it
 *      served a host-side cache entry it could NOT re-verify against the device
 *      (`fresh: false`); that verdict never reaches `ObserveScreen`, so a
 *      just-served-from-cache tree is reported fresh regardless of whether it was
 *      ever checked against the screen.
 *
 *   3. THE WRONG CLOCK — the cache-hit decision inside the hierarchy delegate
 *      measures a cached entry's age from `receivedAt` (when the host took
 *      delivery of a push) instead of the tree's own `updatedAt` (when the
 *      content was actually captured). A push that re-delivers unchanged,
 *      already-stale content refreshes `receivedAt` without advancing
 *      `updatedAt`, so the delegate re-serves it from cache — skipping the
 *      re-verification fetch entirely — for as long as the pushes keep coming.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { RealObserveScreen } from "../../../src/features/observe/ObserveScreen";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeObserveCacheStore } from "../../fakes/FakeObserveCacheStore";
import { FakeScreenshotStateStore } from "../../fakes/FakeScreenshotStateStore";
import { resetObserveCacheStore } from "../../../src/features/observe/cache/ObserveCacheRegistry";
import { resetScreenshotStateStore } from "../../../src/features/observe/screenshot/ScreenshotStateRegistry";
import { CtrlProxyHierarchy } from "../../../src/features/observe/ios/CtrlProxyHierarchy";
import { RequestManager } from "../../../src/utils/RequestManager";
import type { ObserveScreenshotRecorder } from "../../../src/features/observe/screenshot/ObserveScreenshotRecorder";
import type { HierarchyCollector } from "../../../src/features/observe/collectors/HierarchyCollector";
import type { DeviceStateCollector } from "../../../src/features/observe/collectors/DeviceStateCollector";
import type { PerformanceAuditor } from "../../../src/features/observe/audits/PerformanceAuditor";
import type { AccessibilityAuditor } from "../../../src/features/observe/audits/AccessibilityAuditor";
import type { AccessibilityStateDetector } from "../../../src/features/observe/audits/AccessibilityStateDetector";
import type { HierarchyPlatformValidator } from "../../../src/features/observe/HierarchyPlatformValidator";
import type { BootedDevice, ObserveResult } from "../../../src/models";
import type { PerformanceTracker } from "../../../src/utils/PerformanceTracker";
import type {
  CtrlProxyCachedHierarchy,
  HierarchyDelegateContext,
  XCTestHierarchy,
} from "../../../src/features/observe/ios/types";

// ---------------------------------------------------------------------------
// Shared no-op fakes so `execute()` completes without touching a real device.
// ---------------------------------------------------------------------------

class FakeScreenshotRecorder implements ObserveScreenshotRecorder {
  start(_perf?: PerformanceTracker, _signal?: AbortSignal): void {}
  async capture(_perf?: PerformanceTracker, _signal?: AbortSignal): Promise<void> {}
}

class NoOpAuditor implements Pick<
  PerformanceAuditor & AccessibilityAuditor & AccessibilityStateDetector,
  "run"
> {
  async run(): Promise<void> {}
}

class FakeDeviceStateCollector implements Pick<
  DeviceStateCollector,
  | "collectBackStack"
  | "collectWakefulness"
  | "collectDeviceLock"
  | "collectActiveWindow"
  | "collectForegroundIdentity"
> {
  async collectBackStack(): Promise<void> {}
  async collectWakefulness(result: ObserveResult): Promise<void> {
    result.wakefulness = "Awake";
  }
  async collectDeviceLock(): Promise<void> {}
  async collectActiveWindow(): Promise<void> {}
  async collectForegroundIdentity(): Promise<string | undefined> {
    return undefined;
  }
}

/** Hands `execute()` a caller-controlled `result.viewHierarchy` directly. */
class ScriptedHierarchyCollector implements Pick<
  HierarchyCollector,
  "collect" | "collectRaw" | "extractScreenSize" | "reconcileScreenDimensions"
> {
  constructor(
    private viewHierarchy: {
      hierarchy: unknown;
      updatedAt?: number;
      receivedAt?: number;
      fresh?: boolean;
    },
  ) {}
  async collect(result: ObserveResult): Promise<void> {
    result.viewHierarchy = {
      screenWidth: 1080,
      screenHeight: 1920,
      wakefulness: "Awake",
      ...this.viewHierarchy,
    } as any;
  }
  async collectRaw(): Promise<void> {}
  extractScreenSize(): { width: number; height: number } | null {
    return { width: 1080, height: 1920 };
  }
  reconcileScreenDimensions(viewHierarchy: unknown): unknown {
    return viewHierarchy;
  }
}

const device: BootedDevice = { deviceId: "test-device", name: "Test Device", platform: "ios" };

function createObserveScreen(
  fakeTimer: FakeTimer,
  viewHierarchy: { hierarchy: unknown; updatedAt?: number; receivedAt?: number; fresh?: boolean },
  platformValidator?: HierarchyPlatformValidator,
) {
  const observeScreen = new RealObserveScreen(
    device,
    new FakeAdbClientFactory(new FakeAdbExecutor()),
    {
      cacheStore: new FakeObserveCacheStore(fakeTimer),
      screenshotStateStore: new FakeScreenshotStateStore(),
      screenshotRecorder: new FakeScreenshotRecorder(),
      hierarchyCollector: new ScriptedHierarchyCollector(
        viewHierarchy,
      ) as unknown as HierarchyCollector,
      deviceStateCollector: new FakeDeviceStateCollector() as unknown as DeviceStateCollector,
      performanceAuditor: new NoOpAuditor() as unknown as PerformanceAuditor,
      accessibilityAuditor: new NoOpAuditor() as unknown as AccessibilityAuditor,
      accessibilityStateDetector: new NoOpAuditor() as unknown as AccessibilityStateDetector,
      platformValidator,
    },
    fakeTimer,
  );
  return { observeScreen };
}

describe("freshness regression repro (glance path, ObserveScreen.execute)", () => {
  afterEach(() => {
    resetObserveCacheStore();
    resetScreenshotStateStore();
  });

  test("THE CONSTANT: a plain observe of a 216s-stale hierarchy is not reported fresh", async () => {
    // A several-minutes-stale tree stands in for the reported symptom: the
    // hierarchy stayed frozen (e.g. an unchanging native structure around a
    // WebView) while the on-screen content visibly changed underneath it.
    const STALE_MS = 216_000;
    const fakeTimer = new FakeTimer();
    const { observeScreen } = createObserveScreen(fakeTimer, {
      hierarchy: { text: "frozen-tree" },
      updatedAt: fakeTimer.now() - STALE_MS,
    });

    // The glance path: no minTimestamp, exactly what every public `observe`
    // tool call makes (minTimestamp is not in the tool's input schema).
    const result = await observeScreen.execute();

    expect(result.freshness?.isFresh).toBe(false);
  });

  test("THE DISCARDED VERDICT: a cache entry served unverified is never fresh, even 1ms old", async () => {
    // `viewHierarchy.fresh === false` is the iOS delegate's own honest verdict:
    // it handed back a host-side cache entry because the runner did not answer a
    // synchronous re-verification request. The tree's age alone (1ms) would look
    // perfectly fine; the point of this test is that "was it ever checked
    // against the device on this call" must win regardless of age.
    const fakeTimer = new FakeTimer();
    const { observeScreen } = createObserveScreen(fakeTimer, {
      hierarchy: { text: "unverified-tree" },
      updatedAt: fakeTimer.now() - 1,
      fresh: false,
    });

    const result = await observeScreen.execute();

    expect(result.freshness?.isFresh).toBe(false);
  });

  test("CLOCK SKEW (#5377): a device-skewed but host-fresh tree reports host-domain age with no false warning", async () => {
    // Reproduces the reported emulator symptom: the device clock is ~25s behind
    // the host, so the device-authored `updatedAt` is 25s in the past relative to
    // host `now`, but the tree was verified and received on the host ~200ms ago.
    // ageMs must reflect the ~200ms host-domain receipt age, not the 25s skew,
    // and the "…the rest of the observation was slow" warning must NOT fire.
    const SKEW_MS = 25_000;
    const fakeTimer = new FakeTimer();
    const { observeScreen } = createObserveScreen(fakeTimer, {
      hierarchy: { text: "Wifi" },
      updatedAt: fakeTimer.now() - SKEW_MS, // device domain, skewed behind host
      receivedAt: fakeTimer.now() - 200, // host domain, freshly received
      fresh: true, // delegate verified against the device on this call
    });

    const result = await observeScreen.execute();

    expect(result.freshness?.isFresh).toBe(true);
    expect(result.freshness?.ageMs).toBe(200);
    expect(result.freshness?.warning).toBeUndefined();
    // The raw device timestamp is still reported for correlation.
    expect(result.freshness?.actualTimestamp).toBe(fakeTimer.now() - SKEW_MS);
  });

  test("A RETRIEVAL FAILURE: an error hierarchy is never reported fresh", async () => {
    const fakeTimer = new FakeTimer();
    const { observeScreen } = createObserveScreen(fakeTimer, {
      hierarchy: { error: "CtrlProxy did not return a hierarchy" },
      updatedAt: fakeTimer.now(),
    });

    const result = await observeScreen.execute();

    expect(result.freshness?.isFresh).toBe(false);
    expect(result.freshness?.warning).toContain("could not be retrieved");
  });

  test("A PLATFORM-REJECTED HIERARCHY: a scrubbed observation is never reported fresh", async () => {
    const fakeTimer = new FakeTimer();
    const { observeScreen } = createObserveScreen(fakeTimer, {
      hierarchy: { node: { $: { class: "android.widget.TextView" } } },
      updatedAt: fakeTimer.now(),
    });

    const result = await observeScreen.execute();

    expect(result.viewHierarchy).toBeUndefined();
    expect(result.error).toContain("Platform mismatch");
    expect(result.freshness?.isFresh).toBe(false);
    expect(result.freshness?.warning).toContain("could not be retrieved");
  });
});

describe("freshness regression repro (receivedAt-vs-updatedAt clock, CtrlProxyHierarchy)", () => {
  test("THE WRONG CLOCK: a push that re-delivers stale content without a new capture forces re-verification", async () => {
    const timer = new FakeTimer();
    const requestManager = new RequestManager(timer);
    let cached: CtrlProxyCachedHierarchy | null = null;
    let fetches = 0;

    const makeHierarchy = (updatedAt: number, marker: string): XCTestHierarchy =>
      ({
        updatedAt,
        packageName: "com.test.app",
        hierarchy: { text: marker },
      }) as XCTestHierarchy;

    const context: HierarchyDelegateContext = {
      getWebSocket: () =>
        ({
          readyState: 1,
          send: (data: string) => {
            const message = JSON.parse(data) as { requestId: string };
            fetches += 1;
            requestManager.resolve(message.requestId, {
              hierarchy: makeHierarchy(timer.now(), `fetch-${fetches}`),
            });
          },
        }) as never,
      requestManager,
      timer,
      ensureConnected: async () => true,
      cancelScreenshotBackoff: () => {},
      cacheFreshTtlMs: 500,
      getCachedHierarchy: () => cached,
      setCachedHierarchy: (h) => {
        cached = h;
      },
    };

    const hierarchy = new CtrlProxyHierarchy(context);

    // Prime the cache with a real fetch at t=1000 (nonzero: the delegate treats
    // a zero/absent capture timestamp as "no timestamp" and falls back to the
    // delivery clock, which would mask exactly the divergence this test forges).
    // Capture (updatedAt) and delivery (receivedAt) coincide here, exactly as on
    // a healthy channel — this step is not the defect, it just seeds a baseline
    // entry to corrupt below.
    timer.advanceTime(1000);
    await hierarchy.getLatestHierarchy(true, 1000);
    expect(fetches).toBe(1);
    const primed = cached!;
    expect(primed.hierarchy.updatedAt).toBe(1000);

    // 10s pass with NO new extraction — but the host receives a push that
    // re-delivers the SAME already-captured tree (SdkHierarchyRefreshPublisher
    // re-broadcasting HierarchyDebouncer.getLastHierarchy() on the real runner).
    // That only refreshes the DELIVERY clock; the CONTENT's capture clock
    // (`hierarchy.updatedAt`) does not move. Simulate exactly that by re-stamping
    // `receivedAt` on the existing cache entry while keeping the same hierarchy.
    timer.advanceTime(10_000);
    context.setCachedHierarchy({ ...primed, receivedAt: timer.now() });

    // `observe`'s default glance path: skipWaitForFresh=true, no invalidation.
    await hierarchy.getLatestHierarchy(false, 15000, undefined, true, 0);

    // A cache-age computed from the DELIVERY clock (receivedAt, just refreshed)
    // looks brand new and would skip the fetch — fetches would stay at 1 while
    // silently re-serving a 10s-stale tree forever, for as long as the pushes
    // keep coming. A cache-age computed from the CAPTURE clock (updatedAt, still
    // t=0) is correctly 10s old, past the freshness budget, and must force a
    // synchronous re-verification.
    expect(fetches).toBe(2);
  });
});
