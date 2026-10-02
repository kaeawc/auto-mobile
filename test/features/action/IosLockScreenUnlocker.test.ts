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
  swipes: Array<{ timeoutMs: number; lockScreen?: true }> = [];
  homeResult: { success: boolean; error?: string } = { success: true };
  swipeResult: { success: boolean; error?: string; warning?: string } = { success: true };

  async pressHome(_timeoutMs: number): Promise<{ success: boolean; error?: string }> {
    this.calls.push("home");
    return this.homeResult;
  }

  async swipeUp(
    timeoutMs: number,
    options?: { signal?: AbortSignal; lockScreen?: true },
  ): Promise<{ success: boolean; error?: string; warning?: string }> {
    this.calls.push("swipe");
    this.swipes.push({ timeoutMs, lockScreen: options?.lockScreen });
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

  test("only the unlock swipe forwards the internal lock-screen option", async () => {
    for (const lockScreen of [true, false]) {
      const timer = new FakeTimer();
      timer.enableAutoAdvance();
      const observe = new FakeObserveScreen();
      observe.setObserveResult({
        timestamp: 0,
        screenSize: { width: 1000, height: 2000 },
        systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
        viewHierarchy: { hierarchy: { node: { $: { _id: "lock" } } } },
      });
      let captured:
        | import("../../../src/features/action/ExecuteGesture").FencedGestureOptions
        | undefined;
      const dependencies: SwipeOnDependencies = {
        timer,
        observeScreen: observe,
        skipCallerDisplayFence: true,
        stopAfterIosGestureFailure: true,
        voiceOverExecutor: {
          async executeSwipeGesture(x1, y1, x2, y2, _direction, _container, options) {
            captured = options;
            return { success: false, x1, y1, x2, y2, duration: 300, error: "bounded" };
          },
        },
      };
      if (lockScreen) {
        let reads = 0;
        await new IosLockScreenUnlocker(
          device,
          undefined,
          timer,
          (d, internal) => new SwipeOn(d, null, { ...dependencies, ...internal }),
        ).wakeAndDismiss(() => (reads++ === 0 ? 0 : 5000));
      } else {
        await new SwipeOn(device, null, dependencies).execute({
          direction: "up",
          autoTarget: false,
        });
      }
      expect(captured).toBeDefined();
      if (lockScreen) {
        expect(captured?.lockScreen).toBe(true);
      } else {
        expect(captured?.lockScreen).toBeUndefined();
      }
    }
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
    expect(captured?.iosLockScreenSwipe).toBe(true);
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

describe("two-stage swipe budgets", () => {
  test("unlocked after Home reads before any swipe and reports no swipe needed", async () => {
    const timer = new FakeTimer();
    const actions = new FakeIosActions();
    const result = await new IosLockScreenUnlocker(device, actions, timer).wakeAndDismiss({
      remainingMs: () => 5000 - timer.now(),
      readUnlocked: async () => {
        actions.calls.push("read");
        return true;
      },
    });
    expect(actions.calls).toEqual(["home", "read"]);
    expect(actions.swipes).toEqual([]);
    expect(result).toEqual({
      success: true,
      warning: "device unlocked after wake; no swipe was needed",
    });
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  for (const state of [false, undefined, new Error("probe failed"), "rejected"]) {
    test(`post-wake probe ${String(state)} still tries the fast swipe without false success`, async () => {
      const timer = new FakeTimer();
      const actions = new FakeIosActions();
      actions.swipeResult = { success: false, error: "runner_busy" };
      const result = await new IosLockScreenUnlocker(device, actions, timer).wakeAndDismiss({
        remainingMs: () => 5000 - timer.now(),
        readUnlocked: () => {
          actions.calls.push("read");
          if (state instanceof Error) {
            throw state;
          }
          if (state === "rejected") {
            return Promise.reject(new Error("probe rejected"));
          }
          return Promise.resolve(state);
        },
      });
      expect(actions.calls).toEqual(["home", "read", "swipe"]);
      expect(actions.swipes).toEqual([{ timeoutMs: 2500, lockScreen: true }]);
      expect(result).toEqual({ success: false, error: "runner_busy" });
    });
  }

  for (const remaining of [5000, 1000]) {
    test(`hung post-wake probe reserves swipe budget (${remaining}ms remaining)`, async () => {
      const timer = new FakeTimer();
      timer.enableAutoAdvance();
      const actions = new FakeIosActions();
      actions.swipeResult = { success: false, error: "runner_busy" };
      let probeSignal: AbortSignal | undefined;
      const result = await new IosLockScreenUnlocker(device, actions, timer).wakeAndDismiss({
        remainingMs: () => remaining - timer.now(),
        readUnlocked: (options) => {
          actions.calls.push("read");
          probeSignal = options?.signal;
          return new Promise(() => {});
        },
      });
      expect(timer.now()).toBe(remaining / 4);
      expect(probeSignal?.aborted).toBe(true);
      expect(actions.swipes).toEqual([{ timeoutMs: (remaining * 3) / 8, lockScreen: true }]);
      expect(result.success).toBe(false);
      expect(timer.getPendingTimeoutCount()).toBe(0);
    });
  }

  test("cancellation during the pre-swipe probe propagates without a swipe", async () => {
    const timer = new FakeTimer();
    const actions = new FakeIosActions();
    const controller = new AbortController();
    const reason = new Error("caller cancelled");
    await expect(
      new IosLockScreenUnlocker(device, actions, timer).wakeAndDismiss({
        remainingMs: () => 5000,
        signal: controller.signal,
        readUnlocked: () => {
          controller.abort(reason);
          return new Promise(() => {});
        },
      }),
    ).rejects.toThrow("Operation cancelled");
    expect(actions.swipes).toEqual([]);
    expect(timer.now()).toBe(0);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("stage-local timeout aborts fast swipe and gives legacy swipe only the remainder", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const budgets: number[] = [];
    const signals: Array<AbortSignal | undefined> = [];
    const flags: Array<true | undefined> = [];
    const actions: IosUnlockActions = {
      async pressHome() {
        return { success: true };
      },
      swipeUp(timeoutMs, options) {
        budgets.push(timeoutMs);
        signals.push(options?.signal);
        flags.push(options?.lockScreen);
        return new Promise(() => {});
      },
    };
    const result = await new IosLockScreenUnlocker(device, actions, timer).wakeAndDismiss({
      remainingMs: () => 5000 - timer.now(),
      readUnlocked: async () => false,
    });
    expect(budgets).toEqual([2500, 2500]);
    expect(flags).toEqual([true, undefined]);
    expect(signals.every((signal) => signal?.aborted)).toBe(true);
    expect(timer.now()).toBe(5000);
    expect(result.success).toBe(false);
  });

  test("probe exhausting the swipe budget prevents fallback", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const actions = new FakeIosActions();
    let reads = 0;
    await new IosLockScreenUnlocker(device, actions, timer).wakeAndDismiss({
      remainingMs: () => 5000 - timer.now(),
      readUnlocked: async () => {
        if (++reads === 2) {
          await timer.sleep(5000);
        }
        return false;
      },
    });
    expect(actions.calls).toEqual(["home", "swipe"]);
    expect(timer.now()).toBe(5000);
  });

  test("default swipe factory omits the lock-screen flag on legacy fallback", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const flags: Array<boolean | undefined> = [];
    let reads = 0;
    const unlocker = new IosLockScreenUnlocker(device, undefined, timer, (_device, deps) => {
      flags.push(deps.iosLockScreenSwipe);
      return {
        async execute() {
          return { success: true, duration: 300 };
        },
      };
    });
    await unlocker.wakeAndDismiss({
      remainingMs: () => (reads++ === 0 ? 0 : 5000),
      readUnlocked: async () => false,
    });
    expect(flags).toEqual([true, undefined]);
  });
});
