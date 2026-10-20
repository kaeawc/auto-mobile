import { describe, expect, spyOn, test, afterEach, mock, beforeEach } from "bun:test";
import {
  clampedIosCoordinateSwipeDuration,
  iosSwipeDurationReport,
  withSwipeOnVelocity,
} from "../../../../src/features/action/swipeon/swipeDurationReport";
import { TalkBackSwipeExecutor } from "../../../../src/features/action/swipeon/TalkBackSwipeExecutor";
import type { BootedDevice, Element, SwipeResult } from "../../../../src/models";
import { NoOpPerformanceTracker } from "../../../../src/utils/PerformanceTracker";
import { FakeAccessibilityDetector } from "../../../fakes/FakeAccessibilityDetector";
import { FakeAdbClient } from "../../../fakes/FakeAdbClient";
import { FakeCtrlProxy } from "../../../fakes/FakeCtrlProxy";
import { FakeGestureExecutor } from "../../../fakes/FakeGestureExecutor";
import { FakeTimer } from "../../../fakes/FakeTimer";

afterEach(() => {
  mock.restore();
});

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

  let proxy: FakeCtrlProxy;
  beforeEach(() => {
    proxy = new FakeCtrlProxy();
    spyOn(proxy, "getAccessibilityHierarchy").mockResolvedValue({
      hierarchy: { node: { $: { "resource-id": "test:id/scrollView" } } },
    });
  });

  function executor() {
    const detector = new FakeAccessibilityDetector();
    detector.setTalkBackEnabled(true);
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    return new TalkBackSwipeExecutor({
      device,
      executeGesture: new FakeGestureExecutor(),
      accessibilityService: proxy,
      accessibilityDetector: detector,
      adb: new FakeAdbClient(),
      timer,
    });
  }

  test("an explicit durationMs is flagged as ignored with the route named", async () => {
    const result = await executor().executeAndroidSwipeWithAccessibility({
      x1: 100,
      y1: 500,
      x2: 100,
      y2: 200,
      direction: "up",
      containerElement: container,
      gestureOptions: { duration: 3000, durationExplicit: true },
      perf: new NoOpPerformanceTracker(),
    });
    expect(result.durationIgnored).toBe(true);
    expect(result.warnings?.[0]).toContain("TalkBack semantic scroll");
    // #12968: the nominal duration must not become a fabricated velocity.
    expect(withSwipeOnVelocity(result, {}).velocityPxPerSecond).toBeUndefined();
  });

  test("a speed preset stays quiet but still marks the duration nominal", async () => {
    const result = await executor().executeAndroidSwipeWithAccessibility({
      x1: 100,
      y1: 500,
      x2: 100,
      y2: 200,
      direction: "up",
      containerElement: container,
      gestureOptions: { duration: 300 },
      perf: new NoOpPerformanceTracker(),
    });
    expect(result.durationIgnored).toBe(true);
    expect(result.warnings).toBeUndefined();
  });
});

describe("withSwipeOnVelocity (#12968)", () => {
  const base: SwipeResult = { success: true, x1: 0, y1: 0, x2: 300, y2: 400, duration: 500 };

  test("a dispatched swipe reports distance over duration, same as swipeAt", () => {
    expect(withSwipeOnVelocity(base, {}).velocityPxPerSecond).toBe(1000);
  });

  test("the iOS clamp's effectiveDurationMs replaces the requested duration", () => {
    const clamped = { ...base, duration: 100, effectiveDurationMs: 250 };
    expect(withSwipeOnVelocity(clamped, {}).velocityPxPerSecond).toBe(2000);
  });

  test("the TalkBack semantic scroll (durationIgnored) omits velocity", () => {
    const result = withSwipeOnVelocity({ ...base, durationIgnored: true }, {});
    expect(result.velocityPxPerSecond).toBeUndefined();
  });

  test("boomerang, lookFor and failures omit velocity", () => {
    expect(withSwipeOnVelocity(base, { boomerang: {} }).velocityPxPerSecond).toBeUndefined();
    expect(withSwipeOnVelocity(base, { lookFor: {} }).velocityPxPerSecond).toBeUndefined();
    expect(
      withSwipeOnVelocity({ ...base, success: false }, {}).velocityPxPerSecond,
    ).toBeUndefined();
  });
});

describe("iosSwipeDurationReport (#13145)", () => {
  test("a reported synthesized floor drives the velocity, not the requested duration", () => {
    const report = iosSwipeDurationReport(500, 10, {
      swipeRoute: "unpinnedSynthesized",
      effectiveDurationMs: 50,
    });
    expect(report.effectiveDurationMs).toBe(50);
    const swipe: SwipeResult = {
      success: true,
      x1: 0,
      y1: 0,
      x2: 500,
      y2: 0,
      duration: 10,
      ...report,
    };
    // 500 pt over the dispatched 50 ms, not the requested 10 ms (50000 px/s).
    expect(withSwipeOnVelocity(swipe, {}).velocityPxPerSecond).toBe(10_000);
  });

  test("without a report it falls back to the XCUICoordinate assumption", () => {
    expect(iosSwipeDurationReport(100, 3000, {})).toMatchObject({ effectiveDurationMs: 1000 });
    expect(iosSwipeDurationReport(300, 300, {})).toEqual({});
  });

  test("a route with no route name is treated as unreported even if a duration is present", () => {
    expect(iosSwipeDurationReport(100, 3000, { effectiveDurationMs: 3000 })).toMatchObject({
      effectiveDurationMs: 1000,
    });
  });
});
