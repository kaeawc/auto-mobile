import { FakeElementFinder } from "../../../fakes/FakeElementFinder";
import { describe, expect, test } from "bun:test";
import { SwipeOn } from "../../../../src/features/action/swipeon/SwipeOn";
import { loadIosRemindersNoiseObservePair } from "../../../fixtures/observe/observeFixture";
import { FakeObserveScreen } from "../../../fakes/FakeObserveScreen";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { FakeTalkBackSwipeExecutor } from "../../../fakes/FakeTalkBackSwipeExecutor";
import { FakeAccessibilityDetector } from "../../../fakes/FakeAccessibilityDetector";

function harness() {
  const fixture = loadIosRemindersNoiseObservePair().after;
  const observation = { ...fixture, systemInsets: { top: 0, right: 0, bottom: 0, left: 0 } };
  const observeScreen = new FakeObserveScreen();
  observeScreen.setObserveResult(observation);
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const voiceOverExecutor = new FakeTalkBackSwipeExecutor();
  const finder = new FakeElementFinder();
  const action = new SwipeOn({ name: "iOS fake", deviceId: "ios-chrome", platform: "ios" }, null, {
    observeScreen,
    finder,
    timer,
    voiceOverExecutor,
    accessibilityDetector: new FakeAccessibilityDetector(),
  });
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
