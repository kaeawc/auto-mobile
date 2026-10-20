import { buildElement } from "../../../helpers/elementBuilder";
import { beforeEach, describe, expect, test, spyOn, afterEach, mock } from "bun:test";
import {
  TalkBackSwipeExecutor,
  scrollActionForFingerDirection,
} from "../../../../src/features/action/swipeon/TalkBackSwipeExecutor";
import {
  notificationHierarchy,
  notificationRows,
} from "../../talkback/capturedNotificationTargets";
import { FakeAccessibilityDetector } from "../../../fakes/FakeAccessibilityDetector";
import { FakeGestureExecutor } from "../../../fakes/FakeGestureExecutor";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { FakeCtrlProxy } from "../../../fakes/FakeCtrlProxy";
import { FakeAdbClient } from "../../../fakes/FakeAdbClient";
import { SwipeDirection } from "../../../../src/models";
import type { AdbExecutor } from "../../../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";
import { NoOpPerformanceTracker } from "../../../../src/utils/PerformanceTracker";
import type { BootedDevice, Element } from "../../../../src/models";
import type { FeatureFlagReader } from "../../../../src/features/featureFlags/FeatureFlagService";

afterEach(() => {
  mock.restore();
});

const ANDROID_DEVICE: BootedDevice = {
  name: "test-device",
  platform: "android",
  deviceId: "emulator-5554",
};

const IOS_DEVICE: BootedDevice = {
  name: "test-ios-device",
  platform: "ios",
  deviceId: "test-ios-device",
};

function makeExecutor(
  device: BootedDevice,
  fakeGesture: FakeGestureExecutor,
  fakeProxy: FakeCtrlProxy,
  fakeDetector: FakeAccessibilityDetector,
  fakeTimer: FakeTimer,
  fakeAdb: AdbExecutor = new FakeAdbClient(),
  featureFlags?: FeatureFlagReader,
): TalkBackSwipeExecutor {
  return new TalkBackSwipeExecutor({
    device,
    executeGesture: fakeGesture,
    accessibilityService: fakeProxy,
    accessibilityDetector: fakeDetector,
    adb: fakeAdb,
    timer: fakeTimer,
    featureFlags,
  });
}

describe("TalkBackSwipeExecutor", () => {
  let fakeAccessibilityDetector: FakeAccessibilityDetector;
  let fakeGestureExecutor: FakeGestureExecutor;
  let fakeTimer: FakeTimer;
  let fakeCtrlProxy: FakeCtrlProxy;
  let executor: TalkBackSwipeExecutor;
  const perf = new NoOpPerformanceTracker();

  beforeEach(() => {
    fakeAccessibilityDetector = new FakeAccessibilityDetector();
    fakeGestureExecutor = new FakeGestureExecutor();
    fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    fakeCtrlProxy = new FakeCtrlProxy();
    spyOn(fakeCtrlProxy, "getAccessibilityHierarchy").mockResolvedValue({
      hierarchy: { node: { $: { "resource-id": "test:id/scrollView" } } },
    });
    executor = makeExecutor(
      ANDROID_DEVICE,
      fakeGestureExecutor,
      fakeCtrlProxy,
      fakeAccessibilityDetector,
      fakeTimer,
    );
  });

  test("duplicate captured list container uses two-finger coordinates without an ID action", async () => {
    spyOn(fakeCtrlProxy, "getAccessibilityHierarchy").mockResolvedValue(notificationHierarchy);
    const target = notificationRows[1];
    const bounds = target.bounds!;
    const x = Math.round((bounds.left + bounds.right) / 2);
    await executor.executeAndroidSwipeWithAccessibility({
      x1: x,
      y1: bounds.bottom - 10,
      x2: x,
      y2: bounds.top + 10,
      direction: "up",
      containerElement: target,
      gestureOptions: { duration: 300 },
      perf,
    });
    expect(fakeCtrlProxy.getActionHistory()).toEqual([]);
    expect<unknown>(fakeCtrlProxy.getTwoFingerSwipeHistory()).toEqual([
      {
        x1: x,
        y1: bounds.bottom - 10,
        x2: x,
        y2: bounds.top + 10,
        duration: 300,
        offset: 100,
        timeoutMs: 5000,
        displayId: undefined,
      },
    ]);
  });

  test("duplicate container with a stable selector sends the scoped scroll", async () => {
    spyOn(fakeCtrlProxy, "getAccessibilityHierarchy").mockResolvedValue(notificationHierarchy);
    const target = { ...notificationRows[1], "test-tag": "selected-container" };
    await executor.executeAndroidSwipeWithAccessibility({
      x1: 540,
      y1: 1500,
      x2: 540,
      y2: 1300,
      direction: "up",
      containerElement: target,
      gestureOptions: {},
      perf,
    });
    expect(fakeCtrlProxy.getActionHistory()).toEqual([]);
    expect(fakeCtrlProxy.getNodeActionHistory()).toMatchObject([
      {
        action: "scroll_forward",
        selector: { resourceId: target["resource-id"], testTag: "selected-container" },
      },
    ]);
    expect(fakeCtrlProxy.getTwoFingerSwipeHistory()).toEqual([]);
  });

  test("unknown TalkBack is re-probed once then warns on the default swipe", async () => {
    fakeAccessibilityDetector.setDefaultResult(null, "unknown");
    const result = await executor.executeSwipeGesture({
      x1: 100,
      y1: 500,
      x2: 100,
      y2: 200,
      direction: "up",
      containerElement: null,
    });
    expect(fakeAccessibilityDetector.getDetectionCallCount()).toBe(2);
    expect(fakeGestureExecutor.getSwipeCalls()).toHaveLength(1);
    expect(result.warnings?.join(" ")).toContain("could not determine");
  });

  test("unsafe return duration rejects before either gesture", async () => {
    for (const returnSpeed of [1e-320, 0.02, Infinity, NaN]) {
      await expect(
        executor.executeBoomerangGesture({
          x1: 100,
          y1: 500,
          x2: 100,
          y2: 200,
          gestureOptions: { duration: 300 },
          boomerang: { apexPauseMs: 100, returnSpeed },
          perf,
        }),
      ).rejects.toThrow(/returnSpeed/);
      expect(fakeGestureExecutor.getSwipeCalls()).toEqual([]);
      expect(fakeTimer.getSleepHistory()).toEqual([]);
    }
  });

  test("abort after the forward boomerang swipe prevents the return command", async () => {
    const controller = new AbortController();
    const originalSwipe = fakeGestureExecutor.swipe.bind(fakeGestureExecutor);
    fakeGestureExecutor.swipe = async (...args) => {
      const result = await originalSwipe(...args);
      controller.abort();
      return result;
    };
    await expect(
      executor.executeBoomerangGesture({
        x1: 10,
        y1: 100,
        x2: 10,
        y2: 20,
        gestureOptions: { duration: 100 },
        boomerang: { apexPauseMs: 50, returnSpeed: 1 },
        perf,
        signal: controller.signal,
      }),
    ).rejects.toThrow("Operation cancelled");
    expect(fakeGestureExecutor.getSwipeCalls()).toHaveLength(1);
    expect(fakeTimer.getSleepHistory()).toEqual([]);
  });

  describe("platform detection", () => {
    test("uses standard swipe for iOS regardless of TalkBack state", async () => {
      fakeAccessibilityDetector.setTalkBackEnabled(true);

      const iosExecutor = makeExecutor(
        IOS_DEVICE,
        fakeGestureExecutor,
        fakeCtrlProxy,
        fakeAccessibilityDetector,
        fakeTimer,
      );

      await iosExecutor.executeSwipeGesture({
        x1: 100,
        y1: 500,
        x2: 100,
        y2: 200,
        direction: "up",
        containerElement: null,
        gestureOptions: { duration: 300 },
        perf,
      });

      expect(fakeGestureExecutor.getSwipeCalls()).toHaveLength(1);
      expect(fakeCtrlProxy.getActionHistory()).toHaveLength(0);
      expect(fakeCtrlProxy.getTwoFingerSwipeHistory()).toHaveLength(0);
    });
  });

  describe("TalkBack detection dependency (#3915 regression)", () => {
    test("passes the injected ADB executor (not null) to detectMethod on android", async () => {
      fakeAccessibilityDetector.setTalkBackEnabled(true);
      const sentinelAdb = new FakeAdbClient();
      const exec = makeExecutor(
        ANDROID_DEVICE,
        fakeGestureExecutor,
        fakeCtrlProxy,
        fakeAccessibilityDetector,
        fakeTimer,
        sentinelAdb,
      );

      await exec.executeSwipeGesture({
        x1: 100,
        y1: 500,
        x2: 100,
        y2: 200,
        direction: "up",
        containerElement: null,
        gestureOptions: { duration: 300 },
        perf,
      });

      // The bug passed `null`, which made detectMethod throw+swallow and report
      // "not talkback" on a cold cache. Detection must receive the real executor.
      expect(fakeAccessibilityDetector.detectMethodAdbArgs.length).toBeGreaterThan(0);
      for (const arg of fakeAccessibilityDetector.detectMethodAdbArgs) {
        expect(arg).not.toBeNull();
      }
      expect(fakeAccessibilityDetector.detectMethodAdbArgs[0]).toBe(sentinelAdb);
    });
  });

  describe("force-accessibility-mode feature flag threading (#3925)", () => {
    test("forwards the injected featureFlags to detectMethod on android", async () => {
      fakeAccessibilityDetector.setTalkBackEnabled(true);
      const sentinelFlags = { __sentinel: true, isEnabled: () => false };
      const exec = makeExecutor(
        ANDROID_DEVICE,
        fakeGestureExecutor,
        fakeCtrlProxy,
        fakeAccessibilityDetector,
        fakeTimer,
        new FakeAdbClient(),
        sentinelFlags,
      );

      await exec.executeSwipeGesture({
        x1: 100,
        y1: 500,
        x2: 100,
        y2: 200,
        direction: "up",
        containerElement: null,
        gestureOptions: { duration: 300 },
        perf,
      });

      expect(fakeAccessibilityDetector.detectMethodFeatureFlagsArgs[0]).toBe(sentinelFlags);
    });
  });

  describe("when TalkBack is disabled (android)", () => {
    beforeEach(() => {
      fakeAccessibilityDetector.setTalkBackEnabled(false);
    });

    test("dispatches to standard swipe method", async () => {
      await executor.executeSwipeGesture({
        x1: 100,
        y1: 500,
        x2: 100,
        y2: 200,
        direction: "up",
        containerElement: null,
        gestureOptions: { duration: 300 },
        perf,
      });

      expect(fakeGestureExecutor.getSwipeCalls()).toHaveLength(1);
      expect(fakeCtrlProxy.getActionHistory()).toHaveLength(0);
      expect(fakeCtrlProxy.getTwoFingerSwipeHistory()).toHaveLength(0);
    });

    test.each(["up", "down", "left", "right"] as SwipeDirection[])(
      "dispatches a standard coordinate swipe for direction %s",
      async (direction) => {
        fakeGestureExecutor.getSwipeCalls().length = 0;

        const fresh = makeExecutor(
          ANDROID_DEVICE,
          fakeGestureExecutor,
          fakeCtrlProxy,
          fakeAccessibilityDetector,
          fakeTimer,
        );

        await fresh.executeSwipeGesture({
          x1: 100,
          y1: 500,
          x2: 100,
          y2: 200,
          direction,
          containerElement: null,
          gestureOptions: { duration: 300 },
          perf,
        });

        // The dispatch the name claims: a single standard gesture swipe with the
        // exact coordinates, and NO accessibility action/two-finger path.
        const swipeCalls = fakeGestureExecutor.getSwipeCalls();
        expect(swipeCalls).toHaveLength(1);
        expect(swipeCalls[0]).toMatchObject({ x1: 100, y1: 500, x2: 100, y2: 200 });
        expect(fakeCtrlProxy.getActionHistory()).toHaveLength(0);
        expect(fakeCtrlProxy.getTwoFingerSwipeHistory()).toHaveLength(0);
      },
    );
  });

  describe("when TalkBack is enabled (android)", () => {
    beforeEach(() => {
      fakeAccessibilityDetector.setTalkBackEnabled(true);
    });

    test("dispatches to accessibility-aware swipe method when container has resource-id", async () => {
      const containerElement: Element = {
        bounds: { left: 0, top: 100, right: 400, bottom: 800 },
        "resource-id": "test:id/scrollView",
        scrollable: true,
      };

      await executor.executeSwipeGesture({
        x1: 100,
        y1: 500,
        x2: 100,
        y2: 200,
        direction: "up",
        containerElement,
        gestureOptions: { duration: 300 },
        perf,
      });

      // Should use accessibility action (not standard gesture swipe)
      expect(fakeGestureExecutor.getSwipeCalls()).toHaveLength(0);
      // Should have called requestAction for scroll
      expect(fakeCtrlProxy.getActionHistory()).toHaveLength(1);
    });

    test("does not use standard gesture swipe when TalkBack is enabled", async () => {
      await executor.executeSwipeGesture({
        x1: 100,
        y1: 500,
        x2: 100,
        y2: 200,
        direction: "up",
        containerElement: null,
        gestureOptions: { duration: 300 },
        perf,
      });

      expect(fakeGestureExecutor.getSwipeCalls()).toHaveLength(0);
    });

    test("uses two-finger swipe when no container provided", async () => {
      await executor.executeSwipeGesture({
        x1: 100,
        y1: 500,
        x2: 100,
        y2: 200,
        direction: "up",
        containerElement: null,
        gestureOptions: { duration: 300 },
        perf,
      });

      expect(fakeCtrlProxy.getActionHistory()).toHaveLength(0);
      expect(fakeCtrlProxy.getTwoFingerSwipeHistory()).toHaveLength(1);
    });

    test("surfaces a failed two-finger swipe as an ActionableError instead of a successful scroll", async () => {
      fakeCtrlProxy.setTwoFingerSwipeResult({
        success: false,
        totalTimeMs: 1,
        error: "scroll rejected",
      });

      await expect(
        executor.executeSwipeGesture({
          x1: 100,
          y1: 500,
          x2: 100,
          y2: 200,
          direction: "up",
          containerElement: null,
          gestureOptions: { duration: 300 },
          perf,
        }),
      ).rejects.toThrow("Two-finger swipe failed: scroll rejected");
    });

    test('uses the "Unknown error" fallback when the two-finger failure carries an empty message', async () => {
      // "" is falsy, so this exercises the `|| "Unknown error"` boundary.
      fakeCtrlProxy.setTwoFingerSwipeResult({ success: false, totalTimeMs: 1, error: "" });

      await expect(
        executor.executeSwipeGesture({
          x1: 100,
          y1: 500,
          x2: 100,
          y2: 200,
          direction: "up",
          containerElement: null,
          gestureOptions: { duration: 300 },
          perf,
        }),
      ).rejects.toThrow("Two-finger swipe failed: Unknown error");
    });

    test.each(["up", "down", "left", "right"] as SwipeDirection[])(
      "dispatches an accessibility two-finger swipe for direction %s (no container)",
      async (direction) => {
        fakeCtrlProxy.clearHistory();
        fakeGestureExecutor.getSwipeCalls().length = 0;
        const fresh = makeExecutor(
          ANDROID_DEVICE,
          fakeGestureExecutor,
          fakeCtrlProxy,
          fakeAccessibilityDetector,
          fakeTimer,
        );

        await fresh.executeSwipeGesture({
          x1: 100,
          y1: 500,
          x2: 100,
          y2: 200,
          direction,
          containerElement: null,
          gestureOptions: { duration: 300 },
          perf,
        });

        // The dispatch the name claims: with TalkBack on and no container, the
        // swipe routes through the accessibility two-finger path, never the
        // standard coordinate gesture.
        expect(fakeCtrlProxy.getTwoFingerSwipeHistory()).toHaveLength(1);
        expect(fakeGestureExecutor.getSwipeCalls()).toHaveLength(0);
      },
    );

    test("boomerang mode announces swipeable element instead of swiping", async () => {
      const containerElement: Element = {
        bounds: { left: 0, top: 100, right: 400, bottom: 800 },
        "resource-id": "test:id/scrollView",
      };

      await executor.executeSwipeGesture({
        x1: 100,
        y1: 500,
        x2: 100,
        y2: 200,
        direction: "up",
        containerElement,
        gestureOptions: { duration: 300 },
        perf,
        boomerang: { apexPauseMs: 100, returnSpeed: 1 },
      });

      expect(fakeCtrlProxy.getActionHistory()).toHaveLength(1);
      expect(fakeCtrlProxy.getActionHistory()[0]).toMatchObject({
        action: "focus",
        resourceId: "test:id/scrollView",
        timeoutMs: 5000,
      });
      expect(fakeGestureExecutor.getSwipeCalls()).toHaveLength(0);
      expect(fakeCtrlProxy.getTwoFingerSwipeHistory()).toHaveLength(0);
    });
  });

  describe("TalkBack state cache invalidation", () => {
    test("re-checks TalkBack state on subsequent swipes", async () => {
      // First swipe with TalkBack disabled
      fakeAccessibilityDetector.setTalkBackEnabled(false);
      await executor.executeSwipeGesture({
        x1: 100,
        y1: 500,
        x2: 100,
        y2: 200,
        direction: "up",
        containerElement: null,
        gestureOptions: { duration: 300 },
        perf,
      });
      expect(fakeGestureExecutor.getSwipeCalls()).toHaveLength(1);

      fakeCtrlProxy.clearHistory();

      // Enable TalkBack and invalidate cache
      fakeAccessibilityDetector.setTalkBackEnabled(true);
      fakeAccessibilityDetector.invalidateCache("emulator-5554");

      // Second swipe should use accessibility method (two-finger swipe since no container)
      await executor.executeSwipeGesture({
        x1: 100,
        y1: 500,
        x2: 100,
        y2: 200,
        direction: "up",
        containerElement: null,
        gestureOptions: { duration: 300 },
        perf,
      });

      expect(fakeCtrlProxy.getTwoFingerSwipeHistory()).toHaveLength(1);
      // Standard gesture swipe still only called once (from the first swipe above)
      expect(fakeGestureExecutor.getSwipeCalls()).toHaveLength(1);
    });
  });

  describe("executeAndroidSwipeWithAccessibility", () => {
    beforeEach(() => {
      fakeAccessibilityDetector.setTalkBackEnabled(true);
    });

    // `direction` is the FINGER direction (what the coordinate path feeds to
    // getSwipeWithinBounds). Finger UP reveals the content BELOW, which is
    // ACTION_SCROLL_FORWARD — the mapping used to be inverted (#6116).
    test("tries ACTION_SCROLL (scroll_forward) when container has resource-id and finger swipes up", async () => {
      const containerElement: Element = {
        bounds: { left: 0, top: 100, right: 400, bottom: 800 },
        "resource-id": "test:id/scrollView",
        scrollable: true,
      };

      await executor.executeAndroidSwipeWithAccessibility({
        x1: 100,
        y1: 500,
        x2: 100,
        y2: 200,
        direction: "up",
        containerElement,
        gestureOptions: { duration: 300 },
        perf,
      });

      expect(fakeCtrlProxy.getActionHistory()).toHaveLength(1);
      expect(fakeCtrlProxy.getActionHistory()[0]).toMatchObject({
        action: "scroll_forward",
        resourceId: "test:id/scrollView",
        timeoutMs: 5000,
      });
      expect(fakeCtrlProxy.getTwoFingerSwipeHistory()).toHaveLength(0);
    });

    test("maps finger-down direction to scroll_backward (reveals content above)", async () => {
      const containerElement: Element = {
        bounds: { left: 0, top: 100, right: 400, bottom: 800 },
        "resource-id": "test:id/scrollView",
      };

      await executor.executeAndroidSwipeWithAccessibility({
        x1: 100,
        y1: 200,
        x2: 100,
        y2: 700,
        direction: "down",
        containerElement,
        gestureOptions: { duration: 300 },
        perf,
      });

      expect(fakeCtrlProxy.getActionHistory()).toHaveLength(1);
      expect(fakeCtrlProxy.getActionHistory()[0]).toMatchObject({
        action: "scroll_backward",
        resourceId: "test:id/scrollView",
      });
    });

    test("maps finger-left direction to scroll_forward (reveals content to the right)", async () => {
      const containerElement: Element = {
        bounds: { left: 0, top: 100, right: 400, bottom: 800 },
        "resource-id": "test:id/scrollView",
      };

      await executor.executeAndroidSwipeWithAccessibility({
        x1: 300,
        y1: 200,
        x2: 100,
        y2: 200,
        direction: "left",
        containerElement,
        gestureOptions: { duration: 300 },
        perf,
      });

      expect(fakeCtrlProxy.getActionHistory()[0]).toMatchObject({
        action: "scroll_forward",
      });
    });

    test("maps finger-right direction to scroll_backward (reveals content to the left)", async () => {
      const containerElement: Element = {
        bounds: { left: 0, top: 100, right: 400, bottom: 800 },
        "resource-id": "test:id/scrollView",
      };

      await executor.executeAndroidSwipeWithAccessibility({
        x1: 100,
        y1: 200,
        x2: 300,
        y2: 200,
        direction: "right",
        containerElement,
        gestureOptions: { duration: 300 },
        perf,
      });

      expect(fakeCtrlProxy.getActionHistory()[0]).toMatchObject({
        action: "scroll_backward",
      });
    });

    test.each([
      ["up", "scroll_forward"],
      ["down", "scroll_backward"],
      ["left", "scroll_forward"],
      ["right", "scroll_backward"],
    ] as Array<[SwipeDirection, string]>)(
      "scrollActionForFingerDirection(%s) is %s, matching the coordinate-swipe content motion (#6116)",
      (fingerDirection, expectedAction) => {
        // The non-TalkBack path moves the finger in `fingerDirection`; the
        // TalkBack ACTION_SCROLL must move the content the same way.
        expect<unknown>(scrollActionForFingerDirection(fingerDirection)).toBe(expectedAction);
      },
    );

    test("an acknowledged scroll never sends a fallback gesture", async () => {
      fakeCtrlProxy.setActionResult({
        success: true,
        action: "scroll_forward",
        totalTimeMs: 1,
        dispatched: true,
        acknowledged: true,
      });
      const result = await executor.executeAndroidSwipeWithAccessibility({
        x1: 100,
        y1: 500,
        x2: 100,
        y2: 200,
        direction: "up",
        containerElement: buildElement({ "resource-id": "test:id/scrollView" }),
        gestureOptions: { duration: 300 },
        perf,
      });
      expect(result.success).toBe(true);
      expect(fakeCtrlProxy.getActionHistory()).toHaveLength(1);
      expect(fakeCtrlProxy.getTwoFingerSwipeHistory()).toHaveLength(0);
    });

    test.each(["Action timeout after 5000ms", "WebSocket connection closed"])(
      "does not repeat a dispatched scroll after %s",
      async (error) => {
        fakeCtrlProxy.setActionResult({
          success: false,
          action: "scroll_forward",
          totalTimeMs: 5000,
          dispatched: true,
          acknowledged: false,
          error,
        });
        const result = await executor.executeAndroidSwipeWithAccessibility({
          x1: 100,
          y1: 500,
          x2: 100,
          y2: 200,
          direction: "up",
          containerElement: buildElement({ "resource-id": "test:id/scrollView" }),
          gestureOptions: { duration: 300 },
          perf,
        });
        expect(result.success).toBe(false);
        expect(result.error).toContain("outcome is indeterminate");
        expect(result.error).toContain("Do not retry automatically");
        expect(fakeCtrlProxy.getActionHistory()).toHaveLength(1);
        expect(fakeCtrlProxy.getTwoFingerSwipeHistory()).toHaveLength(0);
        expect(fakeGestureExecutor.getSwipeCalls()).toHaveLength(0);
      },
    );

    test.each([
      { dispatched: false, acknowledged: false, error: "WebSocket not connected" },
      { dispatched: true, acknowledged: true, error: "Scroll not supported" },
      { dispatched: true, acknowledged: true, error: "node not found" },
    ])("falls back once for a proven scroll refusal: %j", async (failure) => {
      fakeCtrlProxy.setActionResult({
        success: false,
        action: "scroll_forward",
        totalTimeMs: 1,
        ...failure,
      });
      const result = await executor.executeAndroidSwipeWithAccessibility({
        x1: 100,
        y1: 500,
        x2: 100,
        y2: 200,
        direction: "up",
        containerElement: buildElement({ "resource-id": "test:id/scrollView" }),
        gestureOptions: { duration: 300 },
        perf,
      });
      expect(result.success).toBe(true);
      expect(fakeCtrlProxy.getActionHistory()).toHaveLength(1);
      expect(fakeCtrlProxy.getTwoFingerSwipeHistory()).toHaveLength(1);
    });

    test("falls back to two-finger swipe when ACTION_SCROLL fails", async () => {
      fakeCtrlProxy.setActionResult({
        success: false,
        action: "scroll_forward",
        totalTimeMs: 100,
        error: "Scroll not supported",
      });

      const containerElement: Element = {
        bounds: { left: 0, top: 100, right: 400, bottom: 800 },
        "resource-id": "test:id/scrollView",
      };

      await executor.executeAndroidSwipeWithAccessibility({
        x1: 100,
        y1: 500,
        x2: 100,
        y2: 200,
        direction: "up",
        containerElement,
        gestureOptions: { duration: 300 },
        perf,
      });

      expect(fakeCtrlProxy.getTwoFingerSwipeHistory()).toHaveLength(1);
      expect(fakeCtrlProxy.getTwoFingerSwipeHistory()[0]).toMatchObject({
        x1: 100,
        y1: 500,
        x2: 100,
        y2: 200,
        duration: 300,
        offset: 100,
        timeoutMs: 5000,
      });
    });

    test("uses two-finger swipe when container has no resource-id", async () => {
      const containerElement: Element = {
        bounds: { left: 0, top: 100, right: 400, bottom: 800 },
        scrollable: true,
        // No resource-id
      };

      await executor.executeAndroidSwipeWithAccessibility({
        x1: 100,
        y1: 500,
        x2: 100,
        y2: 200,
        direction: "up",
        containerElement,
        gestureOptions: { duration: 300 },
        perf,
      });

      // Should not try ACTION_SCROLL
      expect(fakeCtrlProxy.getActionHistory()).toHaveLength(0);
      // Should use two-finger swipe
      expect(fakeCtrlProxy.getTwoFingerSwipeHistory()).toHaveLength(1);
    });

    test("uses two-finger swipe when no container provided", async () => {
      await executor.executeAndroidSwipeWithAccessibility({
        x1: 100,
        y1: 500,
        x2: 100,
        y2: 200,
        direction: "up",
        containerElement: null,
        gestureOptions: { duration: 300 },
        perf,
      });

      expect(fakeCtrlProxy.getActionHistory()).toHaveLength(0);
      expect(fakeCtrlProxy.getTwoFingerSwipeHistory()).toHaveLength(1);
    });
  });

  describe("executeBoomerangGesture", () => {
    test("calls swipe twice: forward then return", async () => {
      await executor.executeBoomerangGesture({
        x1: 100,
        y1: 500,
        x2: 100,
        y2: 200,
        gestureOptions: { duration: 300 },
        boomerang: { apexPauseMs: 50, returnSpeed: 1 },
        perf,
      });

      const calls = fakeGestureExecutor.getSwipeCalls();
      expect(calls).toHaveLength(2);
      // Forward swipe
      expect(calls[0]).toMatchObject({ x1: 100, y1: 500, x2: 100, y2: 200 });
      // Return swipe (reversed coordinates)
      expect(calls[1]).toMatchObject({ x1: 100, y1: 200, x2: 100, y2: 500 });
    });

    test("sleeps for apexPauseMs between forward and return swipe", async () => {
      await executor.executeBoomerangGesture({
        x1: 100,
        y1: 500,
        x2: 100,
        y2: 200,
        gestureOptions: { duration: 300 },
        boomerang: { apexPauseMs: 150, returnSpeed: 1 },
        perf,
      });

      expect(fakeTimer.wasSleepCalled(150)).toBe(true);
    });

    test("does not sleep when apexPauseMs is 0", async () => {
      await executor.executeBoomerangGesture({
        x1: 100,
        y1: 500,
        x2: 100,
        y2: 200,
        gestureOptions: { duration: 300 },
        boomerang: { apexPauseMs: 0, returnSpeed: 1 },
        perf,
      });

      expect(fakeTimer.getSleepCallCount()).toBe(0);
    });

    test("adjusts return duration based on returnSpeed", async () => {
      await executor.executeBoomerangGesture({
        x1: 100,
        y1: 500,
        x2: 100,
        y2: 200,
        gestureOptions: { duration: 300 },
        boomerang: { apexPauseMs: 0, returnSpeed: 2 },
        perf,
      });

      const calls = fakeGestureExecutor.getSwipeCalls();
      expect(calls).toHaveLength(2);
      // Return swipe duration = 300 / 2 = 150
      expect(calls[1].options?.duration).toBe(150);
    });
  });

  describe("resolveBoomerangConfig", () => {
    test("returns undefined when boomerang is false", () => {
      const result = executor.resolveBoomerangConfig({ boomerang: false });
      expect(result).toBeUndefined();
    });

    test("returns undefined when boomerang is not set", () => {
      const result = executor.resolveBoomerangConfig({});
      expect(result).toBeUndefined();
    });

    test("returns config with default apexPauseMs and returnSpeed when boomerang is true", () => {
      const result = executor.resolveBoomerangConfig({ boomerang: true });
      expect(result).toBeDefined();
      expect(result!.apexPauseMs).toBe(100);
      expect(result!.returnSpeed).toBe(1);
    });

    test("returns config with custom apexPause when provided", () => {
      const result = executor.resolveBoomerangConfig({ boomerang: true, apexPause: 250 });
      expect(result).toBeDefined();
      expect(result!.apexPauseMs).toBe(250);
    });

    test("returns config with custom returnSpeed when provided", () => {
      const result = executor.resolveBoomerangConfig({ boomerang: true, returnSpeed: 3 });
      expect(result).toBeDefined();
      expect(result!.returnSpeed).toBe(3);
    });
  });
});
