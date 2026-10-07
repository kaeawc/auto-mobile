import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { IosLockScreenUnlocker } from "../../../src/features/action/IosLockScreenUnlocker";
import { SwipeOn } from "../../../src/features/action/swipeon/SwipeOn";
import { IOSCtrlProxyClient } from "../../../src/features/observe/ios";
import type { BootedDevice } from "../../../src/models";
import { FakeIOSCtrlProxy } from "../../fakes/FakeIOSCtrlProxy";
import { FakeIosVoiceOverDetector } from "../../fakes/FakeIosVoiceOverDetector";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeTimer } from "../../fakes/FakeTimer";

const device: BootedDevice = { deviceId: "ios-unlock-real-swipe", platform: "ios", name: "iOS" };

let clientSpy: ReturnType<typeof spyOn> | undefined;

afterEach(() => {
  clientSpy?.mockRestore();
  clientSpy = undefined;
});

/** The REAL SwipeOn and ExecuteGesture over a runner fake, driven by the REAL unlocker. */
async function unlockWith(swipeResult: Parameters<FakeIOSCtrlProxy["setSwipeResult"]>[0]) {
  const proxy = new FakeIOSCtrlProxy();
  proxy.setSwipeResult(swipeResult);
  clientSpy = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue(
    proxy as unknown as IOSCtrlProxyClient,
  );
  const observe = new FakeObserveScreen();
  observe.setObserveResult({
    timestamp: 0,
    screenSize: { width: 1000, height: 2000 },
    systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
    viewHierarchy: { hierarchy: { node: { $: { _id: "lock" } } } },
  });
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const lockPhases: Array<string | undefined> = [];
  const unlocker = new IosLockScreenUnlocker(
    device,
    undefined,
    timer,
    (d, internal) =>
      new SwipeOn(d, null, {
        ...internal,
        timer,
        observeScreen: observe,
        iosVoiceOverDetector: new FakeIosVoiceOverDetector(),
      }),
  );
  // Exhaust only the Home budget on the first read so the default Home action never runs.
  let budgetReads = 0;
  const result = await unlocker.wakeAndDismiss({
    remainingMs: () => (budgetReads++ === 0 ? 0 : 10_000),
    readUnlocked: async (readOptions) => {
      lockPhases.push(readOptions?.phase);
      return false;
    },
  });
  return { result, swipes: proxy.getSwipeHistory().length, lockPhases };
}

describe("iOS lock-screen swipe lost to a closed connection (real SwipeOn path)", () => {
  test("the indeterminate marker survives SwipeOn, so no fallback swipe follows", async () => {
    const { result, swipes, lockPhases } = await unlockWith({
      success: false,
      error: "WebSocket connection closed",
      dispatched: true,
      acknowledged: false,
    });

    expect(swipes).toBe(1);
    // The attempt ended before the post-swipe lock-state read.
    expect(lockPhases).toEqual(["afterWake"]);
    expect(result).toMatchObject({ success: false, outcomeIndeterminate: true });
    expect(result.error).toContain("indeterminate");
  });

  test("a runner reply typed deadline_completed_late stops the fallback swipe, whatever its text", async () => {
    const { result, swipes } = await unlockWith({
      success: false,
      error: "runner reply with different wording",
      errorCode: "deadline_completed_late",
      totalTimeMs: 5000,
    });

    expect(swipes).toBe(1);
    expect(result).toMatchObject({ success: false, outcomeIndeterminate: true });
  });

  test("a runner reply typed deadline_not_started keeps the fallback swipe", async () => {
    const { swipes } = await unlockWith({
      success: false,
      error: "Command request_swipe exceeded deadline at 5000ms (gesture was not started)",
      errorCode: "deadline_not_started",
      totalTimeMs: 1,
    });

    expect(swipes).toBe(2);
  });

  test("a definite runner refusal keeps the fallback swipe", async () => {
    const { result, swipes } = await unlockWith({
      success: false,
      error: "runner refused the swipe",
    });

    expect(swipes).toBe(2);
    expect(result).toMatchObject({ success: false });
    expect(result).not.toHaveProperty("outcomeIndeterminate");
  });
});
