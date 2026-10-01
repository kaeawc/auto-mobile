import { afterEach, describe, expect, test } from "bun:test";
import {
  IosLockScreenUnlocker,
  type IosUnlockActions,
} from "../../../src/features/action/IosLockScreenUnlocker";
import type { BootedDevice } from "../../../src/models";
import { SwipeOn } from "../../../src/features/action/swipeon/SwipeOn";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { displayTransitions } from "../../../src/features/observe/DisplayTransition";
import type { SwipeOnDependencies } from "../../../src/features/action/swipeon/types";
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
  afterEach(() => displayTransitions.reset(device.deviceId));

  for (const skipCallerDisplayFence of [true, false]) {
    test(
      skipCallerDisplayFence
        ? "unlock swipe is not fenced by the caller's stale display revision"
        : "caller screen swipe is fenced by a stale display revision",
      async () => {
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
          ...(skipCallerDisplayFence ? { skipCallerDisplayFence: true } : {}),
          renderedDisplayRevision: () => 0,
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
        displayTransitions.notifyTransition(device.deviceId, "test");
        const result = await swipe.execute({ direction: "up", autoTarget: false });
        expect(result.success).toBe(false);
        expect(result.error).toContain(
          skipCallerDisplayFence
            ? "Swipe timed out after 5000ms"
            : "Display changed since these coordinates were chosen",
        );
        expect(gestures).toBe(skipCallerDisplayFence ? 1 : 0);
      },
    );
  }

  for (const isFresh of [false, true, undefined]) {
    test(`unlock swipe refreshes geometry unless cache freshness is true (${isFresh})`, async () => {
      const observe = new FakeObserveScreen();
      const cached = {
        timestamp: 0,
        screenSize: { width: 1000, height: 2000 },
        systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
        viewHierarchy: { hierarchy: { node: { $: { _id: "lock" } } } },
        freshness: { isFresh },
      };
      displayTransitions.notifyTransition(device.deviceId, "Home");
      observe.setObserveSequence([
        cached,
        { ...cached, screenSize: { width: 600, height: 1200 }, freshness: { isFresh: true } },
      ]);
      const coordinates: number[][] = [];
      const swipe = new SwipeOn(device, null, {
        observeScreen: observe,
        skipCallerDisplayFence: true,
        stopAfterIosGestureFailure: true,
        voiceOverExecutor: {
          async executeSwipeGesture(x1, y1, x2, y2) {
            coordinates.push([x1, y1, x2, y2]);
            return { success: false, x1, y1, x2, y2, duration: 300, error: "swipe failed" };
          },
        },
      });
      await swipe.execute({ direction: "up", autoTarget: false });
      expect(coordinates).toEqual([
        isFresh === true ? [500, 1800, 500, 200] : [300, 1080, 300, 120],
      ]);
      expect(observe.getExecuteCallCount()).toBe(isFresh === true ? 0 : 1);
      if (isFresh !== true) {
        expect(observe.getExecuteOptions()[0].freshness).toBe("fresh");
      }
    });
  }

  test("fresh geometry read shares the unlock swipe budget and abort signal", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const observe = new FakeObserveScreen();
    observe.setObserveResult({
      timestamp: 0,
      viewHierarchy: { hierarchy: { node: { $: { _id: "lock" } } } },
      freshness: { isFresh: false },
    });
    let observeSignal: AbortSignal | undefined;
    let freshness: string | undefined;
    observe.execute = async (options) => {
      observeSignal = options?.signal;
      freshness = options?.freshness;
      return new Promise(() => {});
    };
    let gestures = 0;
    const unlocker = new IosLockScreenUnlocker(
      device,
      undefined,
      timer,
      (d, dependencies) =>
        new SwipeOn(d, null, {
          ...dependencies,
          observeScreen: observe,
          voiceOverExecutor: {
            async executeSwipeGesture(x1, y1, x2, y2) {
              gestures++;
              return { success: false, x1, y1, x2, y2, duration: 300 };
            },
          },
        }),
    );
    let budgetReads = 0;
    const result = await unlocker.wakeAndDismiss(() => (budgetReads++ === 0 ? 0 : 1_000));
    expect(result.success).toBe(false);
    expect(timer.now()).toBe(1_000);
    expect(freshness).toBe("fresh");
    expect(observeSignal?.aborted).toBe(true);
    expect(gestures).toBe(0);
  });

  test("unlocker builds its swipe with the internal flags", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    let captured: SwipeOnDependencies | undefined;
    const calls: unknown[] = [];
    const unlocker = new IosLockScreenUnlocker(
      device,
      undefined,
      timer,
      (_device, dependencies) => {
        captured = dependencies;
        return {
          async execute(options) {
            calls.push(options);
            return { success: true, duration: 300 };
          },
        };
      },
    );
    // Keep the default Home action out of the runner by exhausting only its budget.
    let budgetReads = 0;
    await unlocker.wakeAndDismiss(() => (budgetReads++ === 0 ? 0 : 5_000));
    expect(captured?.skipCallerDisplayFence).toBe(true);
    expect(captured?.stopAfterIosGestureFailure).toBe(true);
    expect(captured?.iosGestureTimeoutMs).toBeInstanceOf(Function);
    expect(calls).toEqual([{ direction: "up", autoTarget: false }]);
  });

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
