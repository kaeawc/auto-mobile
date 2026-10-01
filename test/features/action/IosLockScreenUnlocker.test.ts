import { describe, expect, test } from "bun:test";
import {
  IosLockScreenUnlocker,
  type IosUnlockActions,
} from "../../../src/features/action/IosLockScreenUnlocker";
import type { BootedDevice } from "../../../src/models";
import { SwipeOn } from "../../../src/features/action/swipeon/SwipeOn";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeTimer } from "../../fakes/FakeTimer";

const device: BootedDevice = { deviceId: "ios-unlock", platform: "ios", name: "iOS" };

class FakeIosActions implements IosUnlockActions {
  calls: string[] = [];
  homeResult: { success: boolean; error?: string } = { success: true };
  swipeResult: { success: boolean; error?: string; warning?: string } = { success: true };

  async pressHome(_timeoutMs: number): Promise<{ success: boolean; error?: string }> {
    this.calls.push("home");
    return this.homeResult;
  }

  async swipeUp(
    _timeoutMs: number,
  ): Promise<{ success: boolean; error?: string; warning?: string }> {
    this.calls.push("swipe");
    return this.swipeResult;
  }
}

describe("IosLockScreenUnlocker", () => {
  test("presses Home then swipes the locked screen", async () => {
    const actions = new FakeIosActions();
    expect(await new IosLockScreenUnlocker(device, actions).wakeAndDismiss()).toEqual({
      success: true,
      error: undefined,
    });
    expect(actions.calls).toEqual(["home", "swipe"]);
  });

  test("failed Home press still attempts the swipe", async () => {
    const actions = new FakeIosActions();
    actions.homeResult = { success: false, error: "runner unavailable" };
    expect(await new IosLockScreenUnlocker(device, actions).wakeAndDismiss()).toEqual({
      success: true,
      error: undefined,
    });
    expect(actions.calls).toEqual(["home", "swipe"]);
  });

  test("Home that consumes the budget prevents the swipe", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const actions = new FakeIosActions();
    actions.pressHome = async () => {
      actions.calls.push("home");
      await timer.sleep(1_000);
      return { success: false };
    };
    const unlocker = new IosLockScreenUnlocker(device, actions, timer);
    await expect(unlocker.wakeAndDismiss(() => 1_000 - timer.now())).rejects.toThrow(
      /budget exhausted before swipe/,
    );
    expect(actions.calls).toEqual(["home"]);
    expect(timer.now()).toBe(1_000);
  });

  test("timed-out swipe is a failure with no later action", async () => {
    const actions = new FakeIosActions();
    actions.swipeResult = { success: false, error: "Swipe timed out after 5000ms" };
    expect(await new IosLockScreenUnlocker(device, actions).wakeAndDismiss()).toEqual({
      success: false,
      error: "Swipe timed out after 5000ms",
    });
    expect(actions.calls).toEqual(["home", "swipe"]);
  });

  test("wake swipe timeout skips post-action runner observation", async () => {
    const observe = new FakeObserveScreen();
    observe.setObserveResult({
      timestamp: 0,
      screenSize: { width: 1000, height: 2000 },
      systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
      viewHierarchy: { hierarchy: { node: { $: { _id: "lock" } } } },
    });
    let gestures = 0;
    const swipe = new SwipeOn(device, null, {
      observeScreen: observe,
      stopAfterIosGestureFailure: true,
      voiceOverExecutor: {
        async executeSwipeGesture() {
          gestures++;
          return {
            success: false,
            x1: 500,
            y1: 1600,
            x2: 500,
            y2: 400,
            duration: 300,
            error: "Swipe timed out after 5000ms",
          };
        },
      },
    });

    const result = await swipe.execute({ direction: "up", autoTarget: false });
    expect(result).toMatchObject({ success: false, error: expect.stringContaining("timed out") });
    expect(gestures).toBe(1);
    expect(observe.getExecuteCallCount()).toBe(0);
  });
});
