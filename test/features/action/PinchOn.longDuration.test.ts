import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { PinchOn } from "../../../src/features/action/PinchOn";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { IOSCtrlProxyClient } from "../../../src/features/observe/ios";
import { AndroidCtrlProxyManager } from "../../../src/ctrlProxy/CtrlProxyManager";
import type { BootedDevice, ObserveResult } from "../../../src/models";
import { FakeCtrlProxy } from "../../fakes/FakeCtrlProxy";
import { FakeIOSCtrlProxy } from "../../fakes/FakeIOSCtrlProxy";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeAwaitIdle } from "../../fakes/FakeAwaitIdle";
import { FakeWindow } from "../../fakes/FakeWindow";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeHierarchyCapture } from "../../fakes/FakeHierarchyCapture";

for (const platform of ["android", "ios"] as const) {
  describe(`PinchOn long duration (${platform})`, () => {
    let timer: FakeTimer;
    let android: FakeCtrlProxy;
    let ios: FakeIOSCtrlProxy;
    let pinch: PinchOn;
    const restores: Array<() => void> = [];

    beforeEach(() => {
      timer = new FakeTimer();
      android = new FakeCtrlProxy(timer);
      ios = new FakeIOSCtrlProxy(timer);
      const device: BootedDevice = {
        deviceId: `pinch-long-duration-${platform}`,
        name: "Fake device",
        platform,
      };
      const screen: ObserveResult = {
        updatedAt: timer.now(),
        screenSize: { width: 1080, height: 1920 },
        systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
        viewHierarchy: {
          hierarchy: { node: [] },
          packageName: "com.test.app",
          updatedAt: timer.now(),
        },
      };
      const observe = new FakeObserveScreen();
      observe.setObserveResult(screen);
      const window = new FakeWindow();
      window.configureCachedActiveWindow(null);
      window.configureActiveWindow({
        appId: "com.test.app",
        activityName: "MainActivity",
        layoutSeqSum: 123,
      });
      const androidSpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(
        android as unknown as AndroidCtrlProxyClient,
      );
      const iosSpy = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue(
        ios as unknown as IOSCtrlProxyClient,
      );
      const availableSpy = spyOn(AndroidCtrlProxyManager, "getInstance").mockReturnValue({
        isAvailable: async () => true,
      } as unknown as AndroidCtrlProxyManager);
      restores.push(
        () => androidSpy.mockRestore(),
        () => iosSpy.mockRestore(),
        () => availableSpy.mockRestore(),
      );
      pinch = new PinchOn(device, null, {
        timer,
        capture: new FakeHierarchyCapture(async () => screen.viewHierarchy!, platform),
      });
      Object.assign(pinch, {
        observeScreen: observe,
        awaitIdle: new FakeAwaitIdle(),
        window,
        adb: new FakeAdbExecutor(),
      });
    });

    afterEach(() => {
      restores
        .splice(0)
        .reverse()
        .forEach((restore) => restore());
      timer.reset();
    });

    const history = () =>
      platform === "android" ? android.getPinchHistory() : ios.getPinchHistory();
    const fake = () => (platform === "android" ? android : ios);
    const waitForDelayedPinch = async () => {
      for (let turn = 0; turn < 100 && timer.getPendingSleepCount() === 0; turn++) {
        await Promise.resolve();
      }
      expect(timer.getPendingSleeps()).toEqual([6000]);
    };

    test.each([
      [10000, 12000],
      [9000, 11000],
      [300, 5000],
    ])("duration %s uses transport budget %s", async (duration, budget) => {
      timer.enableAutoAdvance();
      const result = await pinch.execute({ direction: "in", autoTarget: false, duration });
      expect(result.success).toBe(true);
      expect(history()).toHaveLength(1);
      expect(history()[0]).toMatchObject({ duration, timeoutMs: budget });
    });

    test("default duration retains the 5000ms floor", async () => {
      timer.enableAutoAdvance();
      expect((await pinch.execute({ direction: "in", autoTarget: false })).success).toBe(true);
      expect(history()[0]).toMatchObject({ duration: 300, timeoutMs: 5000 });
    });

    test("reply after the old 5s budget still succeeds", async () => {
      // The existing fake delays the reply and records the budget, but does not enforce it.
      fake().setOperationDelay("pinch", 6000);
      let settled = false;
      const pending = pinch.execute({ direction: "in", autoTarget: false, duration: 10000 });
      void pending.then(() => {
        settled = true;
      });
      await waitForDelayedPinch();
      await timer.advanceTimeAsync(5001);
      expect(settled).toBe(false);
      timer.enableAutoAdvance();
      await timer.advanceTimeAsync(999);
      expect((await pending).success).toBe(true);
      expect(history()[0]?.timeoutMs).toBe(12000);
    });

    test("outer abort ends the wait promptly before the transport budget", async () => {
      fake().setOperationDelay("pinch", 6000);
      const controller = new AbortController();
      const pending = pinch.execute(
        { direction: "in", autoTarget: false, duration: 10000 },
        undefined,
        controller.signal,
      );
      const rejected = pending.then(
        () => {
          throw new Error("Expected cancellation");
        },
        (error: unknown) => error,
      );
      await waitForDelayedPinch();
      timer.advanceTime(100);
      controller.abort();
      expect(await rejected).toEqual(new Error("Operation cancelled"));
      expect(timer.now()).toBe(100);
      expect(timer.getPendingSleeps()).toEqual([6000]);
      // Settle the uncancellable fake reply; the caller has already stopped waiting.
      await timer.advanceTimeAsync(5900);
      if (platform === "android") {
        expect(android.getPinchHistory()[0]?.signal).toBe(controller.signal);
      }
    });

    test("iOS forwards the abort signal to the pinch request", async () => {
      if (platform !== "ios") {
        return;
      }
      timer.enableAutoAdvance();
      const controller = new AbortController();
      await pinch.execute(
        { direction: "in", autoTarget: false, duration: 300 },
        undefined,
        controller.signal,
      );
      expect(ios.getPinchHistory()[0]?.signal).toBe(controller.signal);
    });

    test("iOS request sent but unanswered (socket close) is indeterminate, not retryable", async () => {
      if (platform !== "ios") {
        return;
      }
      timer.enableAutoAdvance();
      ios.setPinchResult({
        success: false,
        totalTimeMs: 40,
        error: "WebSocket connection closed",
        dispatched: true,
        acknowledged: false,
        retryable: false,
      });
      const result = await pinch.execute({ direction: "in", autoTarget: false });
      expect(result.success).toBe(false);
      expect(result.error).toBe(
        "Pinch outcome is indeterminate: the request was dispatched but no result was confirmed (WebSocket connection closed). Do not retry automatically.",
      );
      expect(history()).toHaveLength(1);
    });

    test("iOS pre-dispatch failure stays a plain failure", async () => {
      if (platform !== "ios") {
        return;
      }
      timer.enableAutoAdvance();
      ios.setPinchResult({
        success: false,
        totalTimeMs: 0,
        error: "Not connected",
        dispatched: false,
        acknowledged: false,
      });
      const result = await pinch.execute({ direction: "in", autoTarget: false });
      expect(result.error).toBe("Not connected");
    });

    test("transport timeout reports an indeterminate outcome without retrying", async () => {
      timer.enableAutoAdvance();
      fake().setPinchResult({
        success: false,
        totalTimeMs: 12000,
        error: "Pinch timed out after 12000ms",
      });
      const result = await pinch.execute({ direction: "in", autoTarget: false, duration: 10000 });
      expect(result.success).toBe(false);
      expect(result.error).toBe(
        "Pinch outcome is indeterminate: the request was dispatched but no result was confirmed (Pinch timed out after 12000ms). Do not retry automatically.",
      );
      expect(history()).toHaveLength(1);
    });
  });
}
