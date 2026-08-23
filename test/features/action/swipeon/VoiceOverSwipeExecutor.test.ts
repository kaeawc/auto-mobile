import { beforeEach, describe, expect, test } from "bun:test";
import { VoiceOverSwipeExecutor } from "../../../../src/features/action/swipeon/VoiceOverSwipeExecutor";
import { FakeIosVoiceOverDetector } from "../../../fakes/FakeIosVoiceOverDetector";
import { FakeIOSCtrlProxy } from "../../../fakes/FakeIOSCtrlProxy";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { NoOpPerformanceTracker } from "../../../../src/utils/PerformanceTracker";
import type { GestureExecutor } from "../../../../src/features/action/swipeon/types";
import type { SwipeResult } from "../../../../src/models/SwipeResult";
import type { Element } from "../../../../src/models";
import type { FeatureFlagService } from "../../../../src/features/featureFlags/FeatureFlagService";

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
    swipe: async (x1, y1, x2, y2, options, perf) => {
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

  describe("non-iOS platforms", () => {
    test("uses standard swipe on Android regardless of VoiceOver state", async () => {
      const { executor, calls } = makeFakeGestureExecutor();
      fakeVoiceOverDetector.setVoiceOverEnabled(true);

      const voiceOverExecutor = new VoiceOverSwipeExecutor(
        { platform: "android", id: "emulator-5554" } as any,
        executor,
        fakeIosClient as any,
        fakeVoiceOverDetector,
        fakeTimer,
      );

      const result = await voiceOverExecutor.executeSwipeGesture(
        100,
        500,
        100,
        200,
        "up",
        null,
        { duration: 300 },
        perf,
      );

      expect(result.success).toBe(true);
      expect(calls).toHaveLength(1);
      expect(fakeIosClient.getMultiFingerSwipeHistory()).toHaveLength(0);
      // VoiceOver detector should not be queried for non-iOS
      expect(fakeVoiceOverDetector.getCallCount()).toBe(0);
    });

    test("uses boomerang swipe on Android (standard swipe × 2)", async () => {
      const { executor, calls } = makeFakeGestureExecutor();
      fakeVoiceOverDetector.setVoiceOverEnabled(true);

      const voiceOverExecutor = new VoiceOverSwipeExecutor(
        { platform: "android", id: "emulator-5554" } as any,
        executor,
        fakeIosClient as any,
        fakeVoiceOverDetector,
        fakeTimer,
      );

      const result = await voiceOverExecutor.executeSwipeGesture(
        100,
        500,
        100,
        200,
        "up",
        null,
        { duration: 300 },
        perf,
        { apexPauseMs: 50, returnSpeed: 1 },
      );

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
      const sentinelFlags = { __sentinel: true } as unknown as FeatureFlagService;

      const voiceOverExecutor = new VoiceOverSwipeExecutor(
        { platform: "ios", deviceId: "00001234-ABCD" } as any,
        executor,
        fakeIosClient as any,
        fakeVoiceOverDetector,
        fakeTimer,
        sentinelFlags,
      );

      await voiceOverExecutor.executeSwipeGesture(
        100,
        500,
        100,
        200,
        "up",
        null,
        { duration: 300 },
        perf,
      );

      expect(fakeVoiceOverDetector.isVoiceOverEnabledFeatureFlagsArgs[0]).toBe(sentinelFlags);
    });
  });

  describe("iOS platform with VoiceOver disabled", () => {
    test("uses standard single-finger swipe", async () => {
      const { executor, calls } = makeFakeGestureExecutor();
      fakeVoiceOverDetector.setVoiceOverEnabled(false);

      const voiceOverExecutor = new VoiceOverSwipeExecutor(
        { platform: "ios", id: "00001234-ABCD" } as any,
        executor,
        fakeIosClient as any,
        fakeVoiceOverDetector,
        fakeTimer,
      );

      const result = await voiceOverExecutor.executeSwipeGesture(
        100,
        500,
        100,
        200,
        "up",
        null,
        { duration: 300 },
        perf,
      );

      expect(result.success).toBe(true);
      expect(calls).toHaveLength(1);
      expect(fakeIosClient.getMultiFingerSwipeHistory()).toHaveLength(0);
    });

    test("uses boomerang with standard swipes when VoiceOver disabled", async () => {
      const { executor, calls } = makeFakeGestureExecutor();
      fakeVoiceOverDetector.setVoiceOverEnabled(false);

      const voiceOverExecutor = new VoiceOverSwipeExecutor(
        { platform: "ios", id: "00001234-ABCD" } as any,
        executor,
        fakeIosClient as any,
        fakeVoiceOverDetector,
        fakeTimer,
      );

      const result = await voiceOverExecutor.executeSwipeGesture(
        100,
        500,
        100,
        200,
        "up",
        null,
        { duration: 300 },
        perf,
        { apexPauseMs: 100, returnSpeed: 1 },
      );

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

      const voiceOverExecutor = new VoiceOverSwipeExecutor(
        { platform: "ios", id: "00001234-ABCD" } as any,
        executor,
        fakeIosClient as any,
        fakeVoiceOverDetector,
        controlledTimer,
      );

      await voiceOverExecutor.executeSwipeGesture(
        100,
        500,
        100,
        200,
        "up",
        null,
        { duration: 300 },
        perf,
        { apexPauseMs: 150, returnSpeed: 1 },
      );

      expect(controlledTimer.wasSleepCalled(150)).toBe(true);
    });

    test("does not sleep when apexPauseMs is 0 (VoiceOver disabled)", async () => {
      const { executor } = makeFakeGestureExecutor();
      fakeVoiceOverDetector.setVoiceOverEnabled(false);

      const voiceOverExecutor = new VoiceOverSwipeExecutor(
        { platform: "ios", id: "00001234-ABCD" } as any,
        executor,
        fakeIosClient as any,
        fakeVoiceOverDetector,
        fakeTimer,
      );

      await voiceOverExecutor.executeSwipeGesture(
        100,
        500,
        100,
        200,
        "up",
        null,
        { duration: 300 },
        perf,
        { apexPauseMs: 0, returnSpeed: 1 },
      );

      expect(fakeTimer.getSleepCallCount()).toBe(0);
    });

    test("adjusts return duration by returnSpeed (VoiceOver disabled)", async () => {
      const { executor, calls } = makeFakeGestureExecutor();
      fakeVoiceOverDetector.setVoiceOverEnabled(false);

      const voiceOverExecutor = new VoiceOverSwipeExecutor(
        { platform: "ios", id: "00001234-ABCD" } as any,
        executor,
        fakeIosClient as any,
        fakeVoiceOverDetector,
        fakeTimer,
      );

      await voiceOverExecutor.executeSwipeGesture(
        100,
        500,
        100,
        200,
        "up",
        null,
        { duration: 300 },
        perf,
        { apexPauseMs: 0, returnSpeed: 2 },
      );

      expect(calls).toHaveLength(2);
      // Return duration = 300 / 2 = 150
      expect(calls[1].options?.duration).toBe(150);
    });
  });

  describe("iOS platform with VoiceOver enabled", () => {
    test("fails clearly instead of reporting a synthesized VoiceOver scroll when no container element exists", async () => {
      const { executor, calls } = makeFakeGestureExecutor();
      fakeVoiceOverDetector.setVoiceOverEnabled(true);

      const voiceOverExecutor = new VoiceOverSwipeExecutor(
        { platform: "ios", id: "00001234-ABCD" } as any,
        executor,
        fakeIosClient as any,
        fakeVoiceOverDetector,
        fakeTimer,
      );

      const result = await voiceOverExecutor.executeSwipeGesture(
        100,
        500,
        100,
        200,
        "up",
        null,
        { duration: 300 },
        perf,
      );

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

      const voiceOverExecutor = new VoiceOverSwipeExecutor(
        { platform: "ios", id: "00001234-ABCD" } as any,
        executor,
        fakeIosClient as any,
        fakeVoiceOverDetector,
      );

      const result = await voiceOverExecutor.executeSwipeGesture(
        100,
        500,
        100,
        200,
        "down",
        container,
        { duration: 300 },
        perf,
      );

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

      const voiceOverExecutor = new VoiceOverSwipeExecutor(
        { platform: "ios", id: "00001234-ABCD" } as any,
        executor,
        fakeIosClient as any,
        fakeVoiceOverDetector,
      );

      const result = await voiceOverExecutor.executeSwipeGesture(
        100,
        500,
        100,
        200,
        "up",
        container,
        { duration: 300 },
        perf,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("not supported");
      expect(calls).toHaveLength(0);
      expect(fakeIosClient.getMultiFingerSwipeHistory()).toHaveLength(0);
      expect(fakeIosClient.getActionHistory()).toHaveLength(0);
    });

    // Both a failing container action (result success:false) and a throwing one
    // must yield the same conservative "not supported" fallback without touching
    // gestures, multi-finger swipes, or reporting a synthesized scroll. The rows
    // preserve the original pair's distinctions: swipe direction and whether a
    // FakeTimer is injected.
    test.each([
      {
        label: "a configured failing container action",
        direction: "down" as const,
        arrange: () =>
          fakeIosClient.setActionResult({ success: false, error: "Element not found" }),
        withTimer: false,
      },
      {
        label: "a throwing container action",
        direction: "up" as const,
        arrange: () => fakeIosClient.setFailureMode("action", new Error("Connection lost")),
        withTimer: true,
      },
    ])(
      "does not invoke $label while VoiceOver is active",
      async ({ direction, arrange, withTimer }) => {
        const { executor, calls } = makeFakeGestureExecutor();
        fakeVoiceOverDetector.setVoiceOverEnabled(true);
        arrange();
        const container = makeContainerElement({ "resource-id": "com.example:id/list" });

        const device = { platform: "ios", id: "00001234-ABCD" } as any;
        const voiceOverExecutor = withTimer
          ? new VoiceOverSwipeExecutor(
              device,
              executor,
              fakeIosClient as any,
              fakeVoiceOverDetector,
              fakeTimer,
            )
          : new VoiceOverSwipeExecutor(
              device,
              executor,
              fakeIosClient as any,
              fakeVoiceOverDetector,
            );

        const result = await voiceOverExecutor.executeSwipeGesture(
          100,
          500,
          100,
          200,
          direction,
          container,
          { duration: 300 },
          perf,
        );

        expect(result.success).toBe(false);
        expect(result.error).toContain("not supported");
        expect(result.fallbackReason).toContain("do not reach VoiceOver");
        expect(calls).toHaveLength(0);
        expect(fakeIosClient.getMultiFingerSwipeHistory()).toHaveLength(0);
        expect(fakeIosClient.getActionHistory()).toHaveLength(0);
      },
    );

    test("does not report a successful VoiceOver boomerang from synthesized touches", async () => {
      const { executor, calls } = makeFakeGestureExecutor();
      fakeVoiceOverDetector.setVoiceOverEnabled(true);

      const voiceOverExecutor = new VoiceOverSwipeExecutor(
        { platform: "ios", id: "00001234-ABCD" } as any,
        executor,
        fakeIosClient as any,
        fakeVoiceOverDetector,
        fakeTimer,
      );

      const result = await voiceOverExecutor.executeSwipeGesture(
        100,
        500,
        100,
        200,
        "up",
        null,
        { duration: 300 },
        perf,
        { apexPauseMs: 100, returnSpeed: 1 },
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("boomerang");
      expect(result.fallbackReason).toContain("do not reach VoiceOver");
      expect(calls).toHaveLength(0);
      expect(fakeIosClient.getMultiFingerSwipeHistory()).toHaveLength(0);
      expect(fakeTimer.getSleepCallCount()).toBe(0);
    });
  });
});
