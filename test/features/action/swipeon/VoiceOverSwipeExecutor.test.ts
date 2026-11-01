import { beforeEach, describe, expect, test } from "bun:test";
import {
  VoiceOverSwipeExecutor,
  createDefaultVoiceOverSwipeRunner,
} from "../../../../src/features/action/swipeon/VoiceOverSwipeExecutor";
import { FakeIosVoiceOverDetector } from "../../../fakes/FakeIosVoiceOverDetector";
import { FakeIOSCtrlProxy } from "../../../fakes/FakeIOSCtrlProxy";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { NoOpPerformanceTracker } from "../../../../src/utils/PerformanceTracker";
import type { GestureExecutor } from "../../../../src/features/action/swipeon/types";
import type { SwipeResult } from "../../../../src/models/SwipeResult";
import type { BootedDevice, Element } from "../../../../src/models";
import { VOICEOVER_STATE_UNKNOWN_WARNING } from "../../../../src/features/accessibility/interfaces/IosVoiceOverDetector";

const ANDROID_DEVICE: BootedDevice = {
  name: "emulator",
  platform: "android",
  deviceId: "emulator-5554",
};
const IOS_DEVICE: BootedDevice = { name: "iPhone", platform: "ios", deviceId: "00001234-ABCD" };

function makeSwipeResult(overrides: Partial<SwipeResult> = {}): SwipeResult {
  return {
    success: true,
    x1: 100,
    y1: 500,
    x2: 100,
    y2: 200,
    duration: 300,
    ...overrides,
  };
}

function makeFakeGestureExecutor(): {
  executor: GestureExecutor;
  calls: Array<{ x1: number; y1: number; x2: number; y2: number; options?: { duration?: number } }>;
} {
  const calls: Array<{
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    options?: { duration?: number };
  }> = [];
  const executor: GestureExecutor = {
    swipe: async ({ x1, y1, x2, y2 }, options) => {
      calls.push({ x1, y1, x2, y2, options });
      return makeSwipeResult({ x1, y1, x2, y2, duration: options?.duration ?? 300 });
    },
  };
  return { executor, calls };
}

function makeContainerElement(overrides: Partial<Element> = {}): Element {
  return {
    bounds: { left: 0, top: 0, right: 375, bottom: 812 },
    ...overrides,
  } as Element;
}

describe("VoiceOverSwipeExecutor", () => {
  let fakeVoiceOverDetector: FakeIosVoiceOverDetector;
  let fakeIosClient: FakeIOSCtrlProxy;
  let fakeTimer: FakeTimer;
  let perf: NoOpPerformanceTracker;

  beforeEach(() => {
    fakeVoiceOverDetector = new FakeIosVoiceOverDetector();
    fakeIosClient = new FakeIOSCtrlProxy();
    fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    perf = new NoOpPerformanceTracker();
  });

  test("watch default runner refuses VoiceOver without constructing an iOS client", async () => {
    const { executor: gesture, calls } = makeFakeGestureExecutor();
    const runner = createDefaultVoiceOverSwipeRunner({
      device: { platform: "watchos", deviceId: "watch", name: "Watch" },
      executeGesture: gesture,
      iosVoiceOverDetector: fakeVoiceOverDetector,
      timer: fakeTimer,
    });
    await expect(
      runner.executeSwipeGesture({
        x1: 1,
        y1: 2,
        x2: 3,
        y2: 4,
        direction: "up",
        containerElement: null,
      }),
    ).rejects.toThrow("VoiceOver swipe");
    expect(calls).toEqual([]);
    expect(fakeTimer.getSleepHistory()).toEqual([]);
  });

  test("unsafe return duration rejects before either gesture", async () => {
    const { executor: gesture, calls } = makeFakeGestureExecutor();
    const executor = new VoiceOverSwipeExecutor({
      device: { platform: "android", deviceId: "fake", name: "fake" },
      executeGesture: gesture,
      iosClient: fakeIosClient,
      iosVoiceOverDetector: fakeVoiceOverDetector,
      timer: fakeTimer,
    });
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
      expect(calls).toEqual([]);
      expect(fakeTimer.getSleepHistory()).toEqual([]);
    }
  });

  describe("non-iOS platforms", () => {
    test("uses standard swipe on Android regardless of VoiceOver state", async () => {
      const { executor, calls } = makeFakeGestureExecutor();
      fakeVoiceOverDetector.setVoiceOverEnabled(true);

      const voiceOverExecutor = new VoiceOverSwipeExecutor({
        device: ANDROID_DEVICE,
        executeGesture: executor,
        iosClient: fakeIosClient,
        iosVoiceOverDetector: fakeVoiceOverDetector,
        timer: fakeTimer,
      });

      const result = await voiceOverExecutor.executeSwipeGesture({
        x1: 100,
        y1: 500,
        x2: 100,
        y2: 200,
        direction: "up",
        containerElement: null,
        gestureOptions: { duration: 300 },
        perf,
      });

      expect(result.success).toBe(true);
      expect(calls).toHaveLength(1);
      expect(fakeIosClient.getMultiFingerSwipeHistory()).toHaveLength(0);
      // VoiceOver detector should not be queried for non-iOS
      expect(fakeVoiceOverDetector.getCallCount()).toBe(0);
    });

    test("uses boomerang swipe on Android (standard swipe × 2)", async () => {
      const { executor, calls } = makeFakeGestureExecutor();
      fakeVoiceOverDetector.setVoiceOverEnabled(true);

      const voiceOverExecutor = new VoiceOverSwipeExecutor({
        device: ANDROID_DEVICE,
        executeGesture: executor,
        iosClient: fakeIosClient,
        iosVoiceOverDetector: fakeVoiceOverDetector,
        timer: fakeTimer,
      });

      const result = await voiceOverExecutor.executeSwipeGesture({
        x1: 100,
        y1: 500,
        x2: 100,
        y2: 200,
        direction: "up",
        containerElement: null,
        gestureOptions: { duration: 300 },
        perf,
        boomerang: { apexPauseMs: 50, returnSpeed: 1 },
      });

      expect(result.success).toBe(true);
      expect(calls).toHaveLength(2);
      expect(calls[0]).toMatchObject({ x1: 100, y1: 500, x2: 100, y2: 200 });
      expect(calls[1]).toMatchObject({ x1: 100, y1: 200, x2: 100, y2: 500 });
      expect(fakeIosClient.getMultiFingerSwipeHistory()).toHaveLength(0);
    });
  });

  describe("force-accessibility-mode feature flag threading (#3925)", () => {
    test("forwards the injected featureFlags to isVoiceOverEnabled on iOS", async () => {
      const { executor } = makeFakeGestureExecutor();
      fakeVoiceOverDetector.setVoiceOverEnabled(false);
      const sentinelFlags = { __sentinel: true, isEnabled: () => false };

      const voiceOverExecutor = new VoiceOverSwipeExecutor({
        device: IOS_DEVICE,
        executeGesture: executor,
        iosClient: fakeIosClient,
        iosVoiceOverDetector: fakeVoiceOverDetector,
        timer: fakeTimer,
        featureFlags: sentinelFlags,
      });

      await voiceOverExecutor.executeSwipeGesture({
        x1: 100,
        y1: 500,
        x2: 100,
        y2: 200,
        direction: "up",
        containerElement: null,
        gestureOptions: { duration: 300 },
        perf,
      });

      expect(fakeVoiceOverDetector.isVoiceOverEnabledFeatureFlagsArgs[0]).toBe(sentinelFlags);
    });
  });

  describe("iOS platform with VoiceOver disabled", () => {
    test("uses standard single-finger swipe", async () => {
      const { executor, calls } = makeFakeGestureExecutor();
      fakeVoiceOverDetector.setVoiceOverEnabled(false);

      const voiceOverExecutor = new VoiceOverSwipeExecutor({
        device: IOS_DEVICE,
        executeGesture: executor,
        iosClient: fakeIosClient,
        iosVoiceOverDetector: fakeVoiceOverDetector,
        timer: fakeTimer,
      });

      const result = await voiceOverExecutor.executeSwipeGesture({
        x1: 100,
        y1: 500,
        x2: 100,
        y2: 200,
        direction: "up",
        containerElement: null,
        gestureOptions: { duration: 300 },
        perf,
      });

      expect(result.success).toBe(true);
      expect(calls).toHaveLength(1);
      expect(fakeIosClient.getMultiFingerSwipeHistory()).toHaveLength(0);
    });

    test("uses boomerang with standard swipes when VoiceOver disabled", async () => {
      const { executor, calls } = makeFakeGestureExecutor();
      fakeVoiceOverDetector.setVoiceOverEnabled(false);

      const voiceOverExecutor = new VoiceOverSwipeExecutor({
        device: IOS_DEVICE,
        executeGesture: executor,
        iosClient: fakeIosClient,
        iosVoiceOverDetector: fakeVoiceOverDetector,
        timer: fakeTimer,
      });

      const result = await voiceOverExecutor.executeSwipeGesture({
        x1: 100,
        y1: 500,
        x2: 100,
        y2: 200,
        direction: "up",
        containerElement: null,
        gestureOptions: { duration: 300 },
        perf,
        boomerang: { apexPauseMs: 100, returnSpeed: 1 },
      });

      expect(result.success).toBe(true);
      expect(calls).toHaveLength(2);
      expect(calls[0]).toMatchObject({ x1: 100, y1: 500, x2: 100, y2: 200 });
      expect(calls[1]).toMatchObject({ x1: 100, y1: 200, x2: 100, y2: 500 });
      expect(fakeIosClient.getMultiFingerSwipeHistory()).toHaveLength(0);
    });

    test("sleeps for apexPauseMs between forward and return swipe (VoiceOver disabled)", async () => {
      const { executor } = makeFakeGestureExecutor();
      fakeVoiceOverDetector.setVoiceOverEnabled(false);
      // Use non-auto-advance to verify sleep
      const controlledTimer = new FakeTimer();
      controlledTimer.enableAutoAdvance();

      const voiceOverExecutor = new VoiceOverSwipeExecutor({
        device: IOS_DEVICE,
        executeGesture: executor,
        iosClient: fakeIosClient,
        iosVoiceOverDetector: fakeVoiceOverDetector,
        timer: controlledTimer,
      });

      await voiceOverExecutor.executeSwipeGesture({
        x1: 100,
        y1: 500,
        x2: 100,
        y2: 200,
        direction: "up",
        containerElement: null,
        gestureOptions: { duration: 300 },
        perf,
        boomerang: { apexPauseMs: 150, returnSpeed: 1 },
      });

      expect(controlledTimer.wasSleepCalled(150)).toBe(true);
    });

    test("does not sleep when apexPauseMs is 0 (VoiceOver disabled)", async () => {
      const { executor } = makeFakeGestureExecutor();
      fakeVoiceOverDetector.setVoiceOverEnabled(false);

      const voiceOverExecutor = new VoiceOverSwipeExecutor({
        device: IOS_DEVICE,
        executeGesture: executor,
        iosClient: fakeIosClient,
        iosVoiceOverDetector: fakeVoiceOverDetector,
        timer: fakeTimer,
      });

      await voiceOverExecutor.executeSwipeGesture({
        x1: 100,
        y1: 500,
        x2: 100,
        y2: 200,
        direction: "up",
        containerElement: null,
        gestureOptions: { duration: 300 },
        perf,
        boomerang: { apexPauseMs: 0, returnSpeed: 1 },
      });

      expect(fakeTimer.getSleepCallCount()).toBe(0);
    });

    test("adjusts return duration by returnSpeed (VoiceOver disabled)", async () => {
      const { executor, calls } = makeFakeGestureExecutor();
      fakeVoiceOverDetector.setVoiceOverEnabled(false);

      const voiceOverExecutor = new VoiceOverSwipeExecutor({
        device: IOS_DEVICE,
        executeGesture: executor,
        iosClient: fakeIosClient,
        iosVoiceOverDetector: fakeVoiceOverDetector,
        timer: fakeTimer,
      });

      await voiceOverExecutor.executeSwipeGesture({
        x1: 100,
        y1: 500,
        x2: 100,
        y2: 200,
        direction: "up",
        containerElement: null,
        gestureOptions: { duration: 300 },
        perf,
        boomerang: { apexPauseMs: 0, returnSpeed: 2 },
      });

      expect(calls).toHaveLength(2);
      // Return duration = 300 / 2 = 150
      expect(calls[1].options?.duration).toBe(150);
    });
  });

  describe("iOS platform with an unreadable VoiceOver probe (#10038)", () => {
    const iosDevice: BootedDevice = { platform: "ios", deviceId: "00001234-ABCD", name: "iPhone" };

    test.each([
      { label: "standard swipe", boomerang: undefined, expectedSwipes: 1 },
      {
        label: "boomerang swipe",
        boomerang: { apexPauseMs: 0, returnSpeed: 1 },
        expectedSwipes: 2,
      },
    ])(
      "takes the $label and warns that the state is unknown",
      async ({ boomerang, expectedSwipes }) => {
        const { executor, calls } = makeFakeGestureExecutor();
        fakeVoiceOverDetector.setPersistentResolvedState(null);

        const result = await new VoiceOverSwipeExecutor({
          device: iosDevice,
          executeGesture: executor,
          iosClient: fakeIosClient,
          iosVoiceOverDetector: fakeVoiceOverDetector,
          timer: fakeTimer,
        }).executeSwipeGesture({
          x1: 100,
          y1: 500,
          x2: 100,
          y2: 200,
          direction: "up",
          containerElement: null,
          gestureOptions: { duration: 300 },
          perf,
          boomerang,
        });

        expect(result.success).toBe(true);
        expect(calls).toHaveLength(expectedSwipes);
        expect(result.warnings).toEqual([VOICEOVER_STATE_UNKNOWN_WARNING]);
      },
    );

    test("a confirmed-off probe takes the standard swipe without a warning", async () => {
      const { executor, calls } = makeFakeGestureExecutor();
      fakeVoiceOverDetector.setPersistentResolvedState(false);

      const result = await new VoiceOverSwipeExecutor({
        device: iosDevice,
        executeGesture: executor,
        iosClient: fakeIosClient,
        iosVoiceOverDetector: fakeVoiceOverDetector,
        timer: fakeTimer,
      }).executeSwipeGesture({
        x1: 100,
        y1: 500,
        x2: 100,
        y2: 200,
        direction: "up",
        containerElement: null,
        gestureOptions: { duration: 300 },
        perf,
      });

      expect(calls).toHaveLength(1);
      expect(result.warnings).toBeUndefined();
    });

    test("a confirmed-on probe still refuses the synthesized scroll", async () => {
      const { executor, calls } = makeFakeGestureExecutor();
      fakeVoiceOverDetector.setPersistentResolvedState(true);

      const result = await new VoiceOverSwipeExecutor({
        device: iosDevice,
        executeGesture: executor,
        iosClient: fakeIosClient,
        iosVoiceOverDetector: fakeVoiceOverDetector,
        timer: fakeTimer,
      }).executeSwipeGesture({
        x1: 100,
        y1: 500,
        x2: 100,
        y2: 200,
        direction: "up",
        containerElement: null,
        gestureOptions: { duration: 300 },
        perf,
      });

      expect(result.success).toBe(false);
      expect(calls).toHaveLength(0);
    });
  });

  describe("iOS platform with VoiceOver enabled", () => {
    test("fails clearly instead of reporting a synthesized VoiceOver scroll when no container element exists", async () => {
      const { executor, calls } = makeFakeGestureExecutor();
      fakeVoiceOverDetector.setVoiceOverEnabled(true);

      const voiceOverExecutor = new VoiceOverSwipeExecutor({
        device: IOS_DEVICE,
        executeGesture: executor,
        iosClient: fakeIosClient,
        iosVoiceOverDetector: fakeVoiceOverDetector,
        timer: fakeTimer,
      });

      const result = await voiceOverExecutor.executeSwipeGesture({
        x1: 100,
        y1: 500,
        x2: 100,
        y2: 200,
        direction: "up",
        containerElement: null,
        gestureOptions: { duration: 300 },
        perf,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("not supported");
      expect(result.fallbackReason).toContain("do not reach VoiceOver");
      expect(calls).toHaveLength(0);
      expect(fakeIosClient.getActionHistory()).toHaveLength(0);
      expect(fakeIosClient.getMultiFingerSwipeHistory()).toHaveLength(0);
    });

    test("does not report a VoiceOver scroll when the container has a resource-id", async () => {
      const { executor, calls } = makeFakeGestureExecutor();
      fakeVoiceOverDetector.setVoiceOverEnabled(true);
      const container = makeContainerElement({ "resource-id": "com.example:id/list" });

      const voiceOverExecutor = new VoiceOverSwipeExecutor({
        device: IOS_DEVICE,
        executeGesture: executor,
        iosClient: fakeIosClient,
        iosVoiceOverDetector: fakeVoiceOverDetector,
        timer: fakeTimer,
      });

      const result = await voiceOverExecutor.executeSwipeGesture({
        x1: 100,
        y1: 500,
        x2: 100,
        y2: 200,
        direction: "down",
        containerElement: container,
        gestureOptions: { duration: 300 },
        perf,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("not supported");
      expect(calls).toHaveLength(0);
      expect(fakeIosClient.getMultiFingerSwipeHistory()).toHaveLength(0);
      expect(fakeIosClient.getActionHistory()).toHaveLength(0);
    });

    test("does not report a VoiceOver scroll when the container has a content-desc", async () => {
      const { executor, calls } = makeFakeGestureExecutor();
      fakeVoiceOverDetector.setVoiceOverEnabled(true);
      const container = makeContainerElement({ "content-desc": "My Scrollable List" });

      const voiceOverExecutor = new VoiceOverSwipeExecutor({
        device: IOS_DEVICE,
        executeGesture: executor,
        iosClient: fakeIosClient,
        iosVoiceOverDetector: fakeVoiceOverDetector,
        timer: fakeTimer,
      });

      const result = await voiceOverExecutor.executeSwipeGesture({
        x1: 100,
        y1: 500,
        x2: 100,
        y2: 200,
        direction: "up",
        containerElement: container,
        gestureOptions: { duration: 300 },
        perf,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("not supported");
      expect(calls).toHaveLength(0);
      expect(fakeIosClient.getMultiFingerSwipeHistory()).toHaveLength(0);
      expect(fakeIosClient.getActionHistory()).toHaveLength(0);
    });

    // Both a failing container action (result success:false) and a throwing one
    // must yield the same conservative "not supported" fallback without touching
    // gestures, multi-finger swipes, or reporting a synthesized scroll. The rows
    // preserve the original pair's distinction: swipe direction.
    test.each([
      {
        label: "a configured failing container action",
        direction: "down" as const,
        arrange: () =>
          fakeIosClient.setActionResult({ success: false, error: "Element not found" }),
      },
      {
        label: "a throwing container action",
        direction: "up" as const,
        arrange: () => fakeIosClient.setFailureMode("action", new Error("Connection lost")),
      },
    ])("does not invoke $label while VoiceOver is active", async ({ direction, arrange }) => {
      const { executor, calls } = makeFakeGestureExecutor();
      fakeVoiceOverDetector.setVoiceOverEnabled(true);
      arrange();
      const container = makeContainerElement({ "resource-id": "com.example:id/list" });

      const voiceOverExecutor = new VoiceOverSwipeExecutor({
        device: IOS_DEVICE,
        executeGesture: executor,
        iosClient: fakeIosClient,
        iosVoiceOverDetector: fakeVoiceOverDetector,
        timer: fakeTimer,
      });

      const result = await voiceOverExecutor.executeSwipeGesture({
        x1: 100,
        y1: 500,
        x2: 100,
        y2: 200,
        direction,
        containerElement: container,
        gestureOptions: { duration: 300 },
        perf,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("not supported");
      expect(result.fallbackReason).toContain("do not reach VoiceOver");
      expect(calls).toHaveLength(0);
      expect(fakeIosClient.getMultiFingerSwipeHistory()).toHaveLength(0);
      expect(fakeIosClient.getActionHistory()).toHaveLength(0);
    });

    test("does not report a successful VoiceOver boomerang from synthesized touches", async () => {
      const { executor, calls } = makeFakeGestureExecutor();
      fakeVoiceOverDetector.setVoiceOverEnabled(true);

      const voiceOverExecutor = new VoiceOverSwipeExecutor({
        device: IOS_DEVICE,
        executeGesture: executor,
        iosClient: fakeIosClient,
        iosVoiceOverDetector: fakeVoiceOverDetector,
        timer: fakeTimer,
      });

      const result = await voiceOverExecutor.executeSwipeGesture({
        x1: 100,
        y1: 500,
        x2: 100,
        y2: 200,
        direction: "up",
        containerElement: null,
        gestureOptions: { duration: 300 },
        perf,
        boomerang: { apexPauseMs: 100, returnSpeed: 1 },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("boomerang");
      expect(result.fallbackReason).toContain("do not reach VoiceOver");
      expect(calls).toHaveLength(0);
      expect(fakeIosClient.getMultiFingerSwipeHistory()).toHaveLength(0);
      expect(fakeTimer.getSleepCallCount()).toBe(0);
    });
  });
});
