import { FakeElementFinder } from "../../../fakes/FakeElementFinder";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { SwipeOn } from "../../../../src/features/action/swipeon/SwipeOn";
import { FakeObserveScreen } from "../../../fakes/FakeObserveScreen";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { FakeTalkBackSwipeExecutor } from "../../../fakes/FakeTalkBackSwipeExecutor";
import { FakeAccessibilityDetector } from "../../../fakes/FakeAccessibilityDetector";
import fixture from "../../../fixtures/observe/ios-reminders-xctest-noise-after.json";
import type { ObserveResult } from "../../../../src/models";
import type { AdbClient } from "../../../../src/utils/android-cmdline-tools/AdbClient";
import { FakeAdbClient } from "../../../fakes/FakeAdbClient";
import { FakeGestureExecutor } from "../../../fakes/FakeGestureExecutor";
import { FakeScreenshotCapturer } from "../../../fakes/FakeScreenshotCapturer";
import { FakeFeatureFlagRepository } from "../../../fakes/FakeFeatureFlagRepository";
import { FakeFeatureFlagApplier } from "../../../fakes/FakeFeatureFlagApplier";
import { FeatureFlagService } from "../../../../src/features/featureFlags/FeatureFlagService";
import { screenshotPathProtection } from "../../../../src/features/observe/ScreenshotPathProtection";
import { defaultTimer } from "../../../../src/utils/SystemTimer";

// An injected observer must also prevent constructor-time screenshot directory I/O
// and retention intervals, including the cold first test in this file.
let restoreHostWorkGuards = () => {};
beforeEach(() => {
  const guards = [
    spyOn(screenshotPathProtection, "start"),
    spyOn(defaultTimer, "sleep"),
    spyOn(defaultTimer, "setTimeout"),
    spyOn(defaultTimer, "setInterval"),
  ];
  for (const guard of guards) {
    guard.mockImplementation(() => {
      throw new Error("iOS chrome tests must not start real retention or timer waits");
    });
  }
  restoreHostWorkGuards = () => guards.forEach((guard) => guard.mockRestore());
});
afterEach(() => restoreHostWorkGuards());

function harness() {
  const observation = {
    ...(fixture as ObserveResult),
    systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
  };
  const observeScreen = new FakeObserveScreen();
  observeScreen.setObserveResult(observation);
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const voiceOverExecutor = new FakeTalkBackSwipeExecutor();
  const finder = new FakeElementFinder();
  const action = new SwipeOn(
    { name: "iOS fake", deviceId: "ios-chrome", platform: "ios" },
    new FakeAdbClient() as unknown as AdbClient,
    {
      observeScreen,
      executeGesture: new FakeGestureExecutor(),
      screenshotCapturer: new FakeScreenshotCapturer(),
      featureFlags: new FeatureFlagService(
        new FakeFeatureFlagRepository(),
        new FakeFeatureFlagApplier(),
      ),
      finder,
      timer,
      voiceOverExecutor,
      accessibilityDetector: new FakeAccessibilityDetector(),
    },
  );
  action.observedInteraction = async (run) => ({ ...(await run(observation)), observation });
  return { action, voiceOverExecutor, finder };
}

describe("plain iOS screen swipe chrome", () => {
  test("starts below the navigation bar with zero observed insets", async () => {
    const { action, voiceOverExecutor } = harness();
    const result = await action.execute({ direction: "down", autoTarget: false });
    expect(result.success).toBe(true);
    expect(voiceOverExecutor.getSwipeCalls()[0].y1).toBeGreaterThanOrEqual(104);
    expect(voiceOverExecutor.getSwipeCalls()[0].y2).toBeLessThanOrEqual(772);
    expect(result.warning).toBeUndefined();
  });
  test("warns when includeSystemInsets leaves the start inside the navigation bar", async () => {
    const { action, voiceOverExecutor } = harness();
    const result = await action.execute({
      direction: "down",
      autoTarget: false,
      includeSystemInsets: true,
    });
    expect(result.warning).toContain("swipe started in the navigation bar");
    expect(voiceOverExecutor.getSwipeCalls()[0].y1).toBeLessThan(104);
  });
});

test("preserves the chrome warning when auto-target falls back to a screen swipe", async () => {
  const { action, finder } = harness();
  finder.nextScrollableElements = [
    { bounds: { left: 0, top: 120, right: 393, bottom: 150 }, scrollable: true },
  ];
  const result = await action.execute({
    direction: "down",
    autoTarget: true,
    includeSystemInsets: true,
  });
  expect(result.success).toBe(true);
  expect(result.targetType).toBe("screen");
  expect(result.warning).toContain("swipe started in the navigation bar");
});
