import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { SwipeOn } from "../../../../src/features/action/swipeon/SwipeOn";
import { IOSCtrlProxyClient } from "../../../../src/features/observe/ios";
import { loadIosRemindersNoiseObservePair } from "../../../fixtures/observe/observeFixture";
import { FakeAccessibilityDetector } from "../../../fakes/FakeAccessibilityDetector";
import { FakeElementFinder } from "../../../fakes/FakeElementFinder";
import { FakeObserveScreen } from "../../../fakes/FakeObserveScreen";
import { FakeTalkBackSwipeExecutor } from "../../../fakes/FakeTalkBackSwipeExecutor";
import { FakeTimer } from "../../../fakes/FakeTimer";

const indeterminateError =
  "Swipe outcome is indeterminate: the request was dispatched but no result was confirmed (Swipe timed out after 5000ms). The swipe may have been applied. Do not retry automatically.";

let existingSpy: ReturnType<typeof spyOn> | undefined;

afterEach(() => {
  existingSpy?.mockRestore();
  existingSpy = undefined;
});

function harness() {
  const fixture = loadIosRemindersNoiseObservePair().after;
  const observation = { ...fixture, systemInsets: { top: 0, right: 0, bottom: 0, left: 0 } };
  const observeScreen = new FakeObserveScreen();
  observeScreen.setObserveResult(observation);
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const voiceOverExecutor = new FakeTalkBackSwipeExecutor();
  const action = new SwipeOn({ name: "iOS fake", deviceId: "ios-9972", platform: "ios" }, null, {
    observeScreen,
    finder: new FakeElementFinder(),
    timer,
    voiceOverExecutor,
    accessibilityDetector: new FakeAccessibilityDetector(),
  });
  action.observedInteraction = async (run) => ({ ...(await run(observation)), observation });
  const invalidations: string[] = [];
  existingSpy = spyOn(IOSCtrlProxyClient, "getExistingInstance").mockReturnValue({
    invalidateCache: () => invalidations.push("ios"),
  } as unknown as IOSCtrlProxyClient);
  return { action, voiceOverExecutor, invalidations };
}

describe("iOS screen swipe with an unconfirmed outcome (#9972)", () => {
  test("surfaces the indeterminate flag and invalidates the hierarchy cache", async () => {
    const { action, voiceOverExecutor, invalidations } = harness();
    voiceOverExecutor.setFailureResult({
      success: false,
      outcomeIndeterminate: true,
      error: indeterminateError,
    });

    const result = await action.execute({ direction: "up", autoTarget: false });

    expect(result).toMatchObject({
      success: false,
      outcomeIndeterminate: true,
      error: indeterminateError,
    });
    expect(voiceOverExecutor.getSwipeCalls()).toHaveLength(1);
    expect(invalidations).toEqual(["ios"]);
  });

  test("a definite failure keeps its plain error and leaves the cache alone", async () => {
    const { action, voiceOverExecutor, invalidations } = harness();
    voiceOverExecutor.setFailureResult({ success: false, error: "runner refused" });

    const result = await action.execute({ direction: "up", autoTarget: false });

    expect(result).toMatchObject({ success: false, error: "runner refused" });
    expect(result.outcomeIndeterminate).toBeUndefined();
    expect(invalidations).toEqual([]);
  });

  test("a confirmed swipe still invalidates the cache", async () => {
    const { action, invalidations } = harness();

    const result = await action.execute({ direction: "up", autoTarget: false });

    expect(result.success).toBe(true);
    expect(invalidations).toEqual(["ios"]);
  });
});
