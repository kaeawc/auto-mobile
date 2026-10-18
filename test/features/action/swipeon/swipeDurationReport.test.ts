import { describe, expect, spyOn, test } from "bun:test";
import { clampedIosCoordinateSwipeDuration } from "../../../../src/features/action/swipeon/swipeDurationReport";
import { TalkBackSwipeExecutor } from "../../../../src/features/action/swipeon/TalkBackSwipeExecutor";
import type { BootedDevice, Element } from "../../../../src/models";
import { NoOpPerformanceTracker } from "../../../../src/utils/PerformanceTracker";
import { FakeAccessibilityDetector } from "../../../fakes/FakeAccessibilityDetector";
import { FakeAdbClient } from "../../../fakes/FakeAdbClient";
import { FakeCtrlProxy } from "../../../fakes/FakeCtrlProxy";
import { FakeGestureExecutor } from "../../../fakes/FakeGestureExecutor";
import { FakeTimer } from "../../../fakes/FakeTimer";

describe("clampedIosCoordinateSwipeDuration (#12987)", () => {
  test("a slow request is clamped to the 100 pt/s floor", () => {
    const clamped = clampedIosCoordinateSwipeDuration(100, 3000);
    expect(clamped?.effectiveDurationMs).toBe(1000);
    expect(clamped?.warning).toContain("XCUICoordinate");
  });

  test("a very fast request is clamped to the 10000 pt/s ceiling", () => {
    expect(clampedIosCoordinateSwipeDuration(500, 10)?.effectiveDurationMs).toBe(50);
  });

  test("an in-range request is not reported", () => {
    expect(clampedIosCoordinateSwipeDuration(300, 300)).toBeUndefined();
  });

  test("a zero-length swipe has nothing to clamp", () => {
    expect(clampedIosCoordinateSwipeDuration(0, 300)).toBeUndefined();
  });
});

describe("TalkBack semantic scroll route reports an ignored duration (#12987)", () => {
  const device = { name: "d", platform: "android", deviceId: "emulator-5554" } as BootedDevice;
  const container = {
    bounds: { left: 0, top: 100, right: 400, bottom: 800 },
    "resource-id": "test:id/scrollView",
    scrollable: true,
  } as Element;

  function executor() {
    const detector = new FakeAccessibilityDetector();
    detector.setTalkBackEnabled(true);
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const proxy = new FakeCtrlProxy();
    spyOn(proxy, "getAccessibilityHierarchy").mockResolvedValue({
      hierarchy: { node: { $: { "resource-id": "test:id/scrollView" } } },
    });
    return new TalkBackSwipeExecutor(
      device,
      new FakeGestureExecutor(),
      proxy,
      detector,
      new FakeAdbClient(),
      timer,
    );
  }

  test("an explicit durationMs is flagged as ignored with the route named", async () => {
    const result = await executor().executeAndroidSwipeWithAccessibility(
      100,
      500,
      100,
      200,
      "up",
      container,
      { duration: 3000, durationExplicit: true },
      new NoOpPerformanceTracker(),
    );
    expect(result.durationIgnored).toBe(true);
    expect(result.warnings?.[0]).toContain("TalkBack semantic scroll");
  });

  test("a speed preset stays quiet but still marks the duration nominal", async () => {
    const result = await executor().executeAndroidSwipeWithAccessibility(
      100,
      500,
      100,
      200,
      "up",
      container,
      { duration: 300 },
      new NoOpPerformanceTracker(),
    );
    expect(result.durationIgnored).toBe(true);
    expect(result.warnings).toBeUndefined();
  });
});
