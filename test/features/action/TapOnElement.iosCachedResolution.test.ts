import { buildObserveResult } from "../../helpers/observeFixture";
import { iosHierarchyAcquisition } from "../../../src/features/observe/ios/types";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { freshTapHierarchy } from "../../../src/features/action/freshTapHierarchy";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { TapAnyElement as RealTapAnyElement } from "../../../src/features/action/TapAnyElement";
import { CtrlProxyHierarchy } from "../../../src/features/observe/ios/CtrlProxyHierarchy";
import type {
  XCTestHierarchy,
  HierarchyDelegateContext,
} from "../../../src/features/observe/ios/types";
import { recordObservationRead } from "../../../src/features/observe/observationReadScope";
import { displayTransitions } from "../../../src/features/observe/DisplayTransition";
import { resetObserveCacheStore } from "../../../src/features/observe/cache/ObserveCacheRegistry";
import type { ObserveResult } from "../../../src/models";
import { DEFAULT_VISION_CONFIG } from "../../../src/vision";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeAwaitIdle } from "../../fakes/FakeAwaitIdle";
import { FakeIOSCtrlProxy } from "../../fakes/FakeIOSCtrlProxy";
import { FakeIosVoiceOverDetector } from "../../fakes/FakeIosVoiceOverDetector";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeTapStrategy } from "../../fakes/FakeTapStrategy";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeWindow } from "../../fakes/FakeWindow";
import { spyOnIosClientInstance } from "../../helpers/iosCtrlProxyClientSpies";
import { setDebugModeEnabled } from "../../../src/utils/debug";

const device = { name: "cached-ios", deviceId: "cached-ios-9821", platform: "ios" } as const;
const raw = (left: number | null): XCTestHierarchy => ({
  packageName: "com.example.app",
  updatedAt: 1000,
  screenWidth: 390,
  screenHeight: 844,
  hierarchy: {
    className: "XCUIApplication",
    bounds: { left: 0, top: 0, right: 390, bottom: 844 },
    node:
      left === null
        ? []
        : [
            {
              text: "Target",
              resourceId: "target",
              clickable: "true",
              enabled: "true",
              bounds: { left, top: 200, right: left + 80, bottom: 260 },
            },
          ],
  },
});
const converter = new CtrlProxyHierarchy({} as HierarchyDelegateContext);
const observation = (left: number | null): ObserveResult =>
  buildObserveResult({
    updatedAt: 1000,
    settled: true,
    screenSize: { width: 390, height: 844 },
    systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
    activeWindow: { appId: "com.example.app", activityName: "", layoutSeqSum: 0 },
    viewHierarchy: converter.convertToViewHierarchyResult(raw(left)),
  });
afterEach(() => {
  displayTransitions.reset(device.deviceId);
  resetObserveCacheStore();
});

function harness(tool: "tapOn" | "tapAny", freshLeft: number | null = 10) {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  timer.setCurrentTime(1000);
  const client = new FakeIOSCtrlProxy(timer);
  client.setHierarchyData(raw(freshLeft));
  const instance = spyOnIosClientInstance(client);
  const convert = spyOn(client, "convertToViewHierarchyResult").mockImplementation((value) =>
    converter.convertToViewHierarchyResult(value),
  );
  const sync = spyOn(client, "requestHierarchySync");
  const strategy = FakeTapStrategy.ios();
  const detector = new FakeIosVoiceOverDetector();
  const tap =
    tool === "tapOn"
      ? new TapOnElement(device, new FakeAdbClient(), {
          timer,
          tapStrategy: strategy,
          visionConfig: { ...DEFAULT_VISION_CONFIG, enabled: false },
          selectionStateTracker: { prepare: async () => null, finalize: async () => [] },
        })
      : new TapAnyElement(device, new FakeAdbClient(), { timer, iosVoiceOverDetector: detector });
  const observe = new FakeObserveScreen();
  observe.setObserveResult(observation(10));
  tap.observeScreen = observe;
  tap.awaitIdle = new FakeAwaitIdle();
  tap.window = new FakeWindow();
  tap.testHooks.setTerminalScreenshotCapture(async () => {});
  tap.testHooks.setDeferredPredictionRecorder(async () => {});
  if (tap instanceof TapOnElement) {
    tap.deriveTapEffectAfterPostTapObservation = async (_before, current) => ({
      observation: current,
      effect: { screenChanged: false, basis: "viewHierarchy unchanged" },
    });
  }
  const dispatch = spyOn(client, "requestTapCoordinates");
  const run = (searchMs = 100, deadline?: number, signal?: AbortSignal) => {
    const options = {
      text: "Target",
      action: deadline === undefined ? ("longPress" as const) : ("tap" as const),
      duration: 100,
      retryIfNoChange: false,
      selectionStrategy: "first" as const,
      searchUntil: { duration: searchMs },
    };
    return tap instanceof TapOnElement
      ? tap.execute(options, { signal, deadlineMs: deadline })
      : tap.execute(options, { signal, deadlineMs: deadline });
  };
  return {
    tap,
    client,
    sync,
    dispatch,
    observe,
    timer,
    strategy,
    detector,
    run,
    restore: () => {
      instance.mockRestore();
      convert.mockRestore();
      sync.mockRestore();
      dispatch.mockRestore();
    },
  };
}

for (const tool of ["tapOn", "tapAny"] as const) {
  describe(`${tool} iOS cached resolution`, () => {
    test("gone on screen B: not found without dispatch", async () => {
      const h = harness(tool, null);
      try {
        const result = await h.run();
        expect(result.success).toBe(false);
        expect(result.error).toContain(
          tool === "tapOn" ? "Element not found" : "No clickable element found",
        );
        expect(h.dispatch).not.toHaveBeenCalled();
        expect(h.sync.mock.calls[0]?.[3]).toMatchObject({ forceCapture: true });
      } finally {
        h.restore();
      }
    });
    test("moved: dispatch uses the new bounds", async () => {
      const h = harness(tool, 210);
      try {
        const result = await h.run();
        expect(result.success).toBe(true);
        expect(result.element?.bounds).toEqual({ left: 210, top: 200, right: 290, bottom: 260 });
        expect(h.dispatch.mock.calls[0]?.[0]).toMatchObject({ x: 250, y: 230 });
        expect(h.sync).toHaveBeenCalledTimes(1);
        expect(h.sync.mock.calls[0]?.[3]).toMatchObject({ forceCapture: true });
      } finally {
        h.restore();
      }
    });
    test("the request's signal reaches the coordinate tap (#9971)", async () => {
      const h = harness(tool);
      try {
        const controller = new AbortController();
        expect((await h.run(100, undefined, controller.signal)).success).toBe(true);
        expect(h.dispatch.mock.calls[0]?.[0].signal).toBe(controller.signal);
      } finally {
        h.restore();
      }
    });
    test("same screen: exactly one forced hierarchy read", async () => {
      const h = harness(tool);
      try {
        expect((await h.run()).success).toBe(true);
        expect(h.sync).toHaveBeenCalledTimes(1);
        expect(h.sync.mock.calls[0]).toEqual([
          undefined,
          false,
          undefined,
          { timeoutMs: 15000, forceCapture: true },
        ]);
        expect(h.dispatch.mock.calls[0]?.[0]).toMatchObject({ x: 50, y: 230 });
      } finally {
        h.restore();
      }
    });
    test("forced refresh preserves the sync acquisition marker", async () => {
      const h = harness(tool);
      try {
        const syncResult = {
          hierarchy: raw(10),
          [iosHierarchyAcquisition]: "device" as const,
        };
        h.sync.mockResolvedValue(syncResult);
        const markers: unknown[] = [];
        if (h.tap instanceof TapOnElement) {
          const refresh = h.tap.refreshViewHierarchy.bind(h.tap);
          h.tap.refreshViewHierarchy = async (...args) => {
            const hierarchy = await refresh(...args);
            markers.push(hierarchy && Reflect.get(hierarchy, iosHierarchyAcquisition));
            return hierarchy;
          };
        } else {
          h.tap.testHooks.setRefreshViewHierarchy(async (refresh, ...args) => {
            const hierarchy = await refresh(...args);
            markers.push(hierarchy && Reflect.get(hierarchy, iosHierarchyAcquisition));
            return hierarchy;
          });
        }
        expect((await h.run()).success).toBe(true);
        expect(markers).toEqual(["device"]);
        expect(h.sync).toHaveBeenCalledTimes(1);
      } finally {
        h.restore();
      }
    });
    test("already read in this call: no extra read", async () => {
      const h = harness(tool);
      try {
        h.observe.getMostRecentCachedObserveResult = async () =>
          recordObservationRead(observation(10));
        expect((await h.run()).success).toBe(true);
        expect(h.sync).not.toHaveBeenCalled();
        expect(h.dispatch).toHaveBeenCalledTimes(1);
      } finally {
        h.restore();
      }
    });
    test("revalidation miss enters the ordinary polling search", async () => {
      const h = harness(tool, null);
      try {
        h.sync.mockImplementation(async () => ({
          hierarchy: raw(h.sync.mock.calls.length === 1 ? null : 210),
        }));
        const result = await h.run(500);
        expect(result.success).toBe(true);
        expect(result.searchUntil?.requestCount).toBe(1);
        expect(h.sync).toHaveBeenCalledTimes(2);
        expect(h.sync.mock.calls[0]?.[3]).toMatchObject({ forceCapture: true });
        expect(h.sync.mock.calls[1]).toHaveLength(4);
        expect(h.dispatch.mock.calls[0]?.[0]).toMatchObject({ x: 250, y: 230 });
      } finally {
        h.restore();
      }
    });
    test("revalidation budget is bounded by the request deadline", async () => {
      const h = harness(tool);
      try {
        expect((await h.run(100, 4000)).success).toBe(true);
        expect(h.sync.mock.calls[0]?.[3]?.timeoutMs).toBe(3000);
      } finally {
        h.restore();
      }
    });
    test("expired deadline prevents extraction and dispatch", async () => {
      const h = harness(tool);
      try {
        expect((await h.run(100, 1000)).success).toBe(false);
        expect(h.sync).not.toHaveBeenCalled();
        expect(h.dispatch).not.toHaveBeenCalled();
      } finally {
        h.restore();
      }
    });
    test("failed iOS revalidation names the runner", async () => {
      const h = harness(tool);
      try {
        h.sync.mockResolvedValue(null);
        const result = await h.run(100, 2000);
        expect(result.success).toBe(false);
        expect(result.error).toContain(
          "Unable to retrieve a fresh tap hierarchy: iOS runner failed to produce a view hierarchy while revalidating a cached observation. Observe again.",
        );
        expect(h.dispatch).not.toHaveBeenCalled();
      } finally {
        h.restore();
      }
    });
    test("null revalidation retains the remaining request budget", async () => {
      const h = harness(tool);
      try {
        h.sync.mockImplementation(async () =>
          h.sync.mock.calls.length === 1 ? null : { hierarchy: raw(210) },
        );
        expect((await h.run(100, 4000)).success).toBe(true);
        expect(h.sync.mock.calls.map((call) => call[3])).toEqual([
          { timeoutMs: 3000, forceCapture: true },
          { timeoutMs: 2500, forceCapture: true },
        ]);
        expect(h.timer.getSleepHistory()).toContain(500);
        expect(h.dispatch.mock.calls[0]?.[0]).toMatchObject({ x: 250, y: 230 });
      } finally {
        h.restore();
      }
    });
    test.each([true, null])(
      "VoiceOver enabled or unknown excludes coordinate revalidation: %s",
      async (state) => {
        const h = harness(tool);
        try {
          h.strategy.setAccessibilityServiceEnabled(true);
          // The detector fake configures the fail-safe resolved outcome for both states.
          h.detector.setVoiceOverEnabled(true);
          expect((await h.run()).success).toBe(true);
          expect(h.sync).not.toHaveBeenCalled();
          if (tool === "tapAny") {
            expect(h.detector.getCallCount()).toBe(1);
          }
        } finally {
          h.restore();
        }
      },
    );
    test.each(["observe->tap", "tap->tap"])("device reads per tap: %s", async (scenario) => {
      const h = harness(tool);
      try {
        if (scenario === "observe->tap") {
          await h.observe.execute();
        } else {
          expect((await h.run()).success).toBe(true);
        }
        h.sync.mockClear();
        h.dispatch.mockClear();
        expect((await h.run()).success).toBe(true);
        // FakeObserveScreen post-action captures do not issue device requests.
        console.log(
          `${tool} ${scenario}: total=${h.sync.mock.calls.length} resolution device reads`,
        );
        expect(h.sync).toHaveBeenCalledTimes(1);
        expect(h.sync.mock.calls[0]?.[3]).toMatchObject({ forceCapture: true });
      } finally {
        h.restore();
      }
    });
  });
}

test("Android fresh-tap failure text stays byte-identical", async () => {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  await expect(freshTapHierarchy(async () => null, timer)).rejects.toMatchObject({
    message:
      "Unable to retrieve a fresh tap hierarchy: hierarchy unavailable from the accessibility service while TalkBack is on. Observe again and check that the accessibility service is running.",
  });
});

/** Exposes the inherited protected bookkeeping seams to this test harness. */
class TapAnyElement extends RealTapAnyElement {
  override get testHooks() {
    return {
      ...super.testHooks,
      setTerminalScreenshotCapture: (
        capture: (observation: ObserveResult | undefined) => Promise<void>,
      ) => {
        this.captureTerminalObservationScreenshot = capture;
      },
      setDeferredPredictionRecorder: (
        record: (result: unknown, observation: ObserveResult) => Promise<void>,
      ) => {
        this.recordDeferredPredictionOutcome = record;
      },
    };
  }
}

describe("tapOn iOS indeterminate tap with debug mode (#15296)", () => {
  afterEach(() => setDebugModeEnabled(false));
  const timedOut = {
    success: false,
    totalTimeMs: 5000,
    dispatched: true,
    acknowledged: false,
    error: "Tap timed out after 5000ms",
  } as const;

  test("fails without a post-failure hierarchy read behind the still-busy runner", async () => {
    setDebugModeEnabled(true);
    const h = harness("tapOn");
    try {
      h.client.setTapResult(timedOut);
      const result = await h.run();
      expect(result.success).toBe(false);
      expect(result.error).toContain("Tap outcome is indeterminate");
      const dispatchedAt = h.dispatch.mock.invocationCallOrder[0] ?? 0;
      const readsAfterDispatch = h.sync.mock.invocationCallOrder.filter(
        (order) => order > dispatchedAt,
      );
      expect(readsAfterDispatch).toEqual([]);
      expect(result.debug).toBeUndefined();
    } finally {
      h.restore();
    }
  });

  test("an element that is not found still gets the search debug context", async () => {
    setDebugModeEnabled(true);
    const h = harness("tapOn", null);
    try {
      const result = await h.run();
      expect(result.success).toBe(false);
      expect(result.debug?.elementSearch).toBeDefined();
    } finally {
      h.restore();
    }
  });
});
