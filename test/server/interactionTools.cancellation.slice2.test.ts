import {
  cancellationHandlers,
  cancellationTests,
  pausedSleep,
} from "../helpers/interactionCancellation";
import { CtrlProxyClipboard } from "../../src/features/observe/ios/CtrlProxyClipboard";
import { RequestManager } from "../../src/utils/RequestManager";
import { getAbortSignal, runWithAbortSignal } from "../../src/utils/AbortContext";
import { describe, expect, spyOn } from "bun:test";
import type { BootedDevice } from "../../src/models";
import { Shake } from "../../src/features/action/Shake";
import { RecentApps } from "../../src/features/action/RecentApps";
import { Clipboard } from "../../src/features/action/Clipboard";
import { WakeAndUnlock } from "../../src/features/action/WakeAndUnlock";
import { IosLockScreenUnlocker } from "../../src/features/action/IosLockScreenUnlocker";
import { getStructuredPayload } from "../../src/utils/toolUtils";
import {
  setShakeFactory,
  resetShakeFactory,
  setRecentAppsFactory,
  resetRecentAppsFactory,
  setClipboardFactory,
  resetClipboardFactory,
  setWakeAndUnlockFactory,
  resetWakeAndUnlockFactory,
} from "../../src/server/interactionTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeObserveScreen } from "../fakes/FakeObserveScreen";
import { FakeWindow } from "../fakes/FakeWindow";
import { FakeAwaitIdle } from "../fakes/FakeAwaitIdle";

const devices: BootedDevice[] = [
  { name: "Android", platform: "android", deviceId: "emulator-5554" },
  { name: "iOS", platform: "ios", deviceId: "A1B2C3D4-E5F6-7890-ABCD-EF1234567890" },
];
const handler = cancellationHandlers(["shake", "recentApps", "clipboard", "wakeAndUnlock"]);
function observed(command: Shake | RecentApps) {
  const screen = new FakeObserveScreen();
  screen.setObserveResult({
    timestamp: 0,
    screenSize: { width: 100, height: 200 },
    systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
    viewHierarchy: { hierarchy: { node: { $: { class: "android.widget.FrameLayout" } } } },
  });
  command.observeScreen = screen;
  command.window = new FakeWindow();
  command.awaitIdle = new FakeAwaitIdle();
}

describe("slice 2 registered handler cancellation", () => {
  const test = cancellationTests(() => {
    resetShakeFactory();
    resetRecentAppsFactory();
    resetClipboardFactory();
    resetWakeAndUnlockFactory();
    ToolRegistry.clearTools();
  });

  test("wakeAndUnlock includes recovery warning in its payload and message", async () => {
    const warning = "iOS runner had not finished recovering; next observe may need a moment";
    setWakeAndUnlockFactory(() => ({
      execute: async () => ({
        success: true,
        platform: "ios",
        wasAsleep: false,
        wasLocked: true,
        unlocked: true,
        warning,
      }),
    }));
    const response = await handler("wakeAndUnlock")(devices[1]!, {});
    expect(getStructuredPayload(response)).toMatchObject({
      warning,
      message: `Device unlocked. Warning: ${warning}`,
    });
    expect(response.content).toContainEqual({
      type: "text",
      text: expect.stringContaining(`Device unlocked. Warning: ${warning}`),
    });
  });

  for (const device of devices) {
    test.each(["shake", "recentApps", "wakeAndUnlock"])(
      `pre-aborted %s dispatches nothing on ${device.platform}`,
      async (name) => {
        const adb = new FakeAdbExecutor();
        const timer = new FakeTimer();
        let reads = 0;
        const wake = spyOn(adb, "getWakefulness").mockImplementation(async () => {
          reads++;
          return "Awake";
        });
        const probe = {
          read: async () => {
            reads++;
            return { locked: true, keyguardShowing: true };
          },
        };
        const shake = new Shake(device, adb, timer);
        const recent = new RecentApps(device, adb, timer);
        observed(shake);
        observed(recent);
        setShakeFactory(() => shake);
        setRecentAppsFactory(() => recent);
        setWakeAndUnlockFactory(
          () =>
            new WakeAndUnlock(device, adb, {
              timer,
              iosLockStateProbe: probe,
              iosUnlocker: {
                wakeAndDismiss: async () => {
                  reads++;
                  return { success: true };
                },
              },
            }),
        );
        const controller = new AbortController();
        controller.abort();
        try {
          await expect(handler(name)(device, {}, undefined, controller.signal)).rejects.toThrow(
            "cancelled",
          );
          expect(adb.getExecutedCommands()).toEqual([]);
          expect(reads).toBe(0);
          expect(timer.getSleepHistory()).toEqual([]);
        } finally {
          wake.mockRestore();
        }
      },
    );

    test.each(["copy", "paste", "clear", "get"] as const)(
      `pre-aborted clipboard %s on ${device.platform}`,
      async (action) => {
        const adb = new FakeAdbExecutor();
        let dispatches = 0;
        setClipboardFactory(
          () =>
            new Clipboard(device, { create: () => adb }, () => ({
              requestClipboard: async () => {
                dispatches++;
                return { success: true, totalTimeMs: 0 };
              },
            })),
        );
        const controller = new AbortController();
        controller.abort();
        await expect(
          handler("clipboard")(device, { action, text: "hello" }, undefined, controller.signal),
        ).rejects.toThrow("cancelled");
        expect(dispatches).toBe(0);
        expect(adb.getExecutedCommands()).toEqual([]);
      },
    );

    test.each(["copy", "paste", "clear", "get"] as const)(
      `clipboard %s cancels a pending proxy wait on ${device.platform}`,
      async (action) => {
        const adb = new FakeAdbExecutor();
        const timer = new FakeTimer();
        const controller = new AbortController();
        const { started, sleep } = pausedSleep(timer);
        setClipboardFactory(
          () =>
            new Clipboard(device, { create: () => adb }, () => ({
              requestClipboard: async () => {
                await timer.sleep(1000);
                return { success: false, totalTimeMs: 0 };
              },
            })),
        );
        try {
          const pending = handler("clipboard")(
            device,
            { action, text: "hello" },
            undefined,
            controller.signal,
          );
          await started;
          controller.abort();
          await expect(pending).rejects.toThrow("cancelled");
          expect(adb.getExecutedCommands()).toEqual([]);
          expect(timer.now()).toBe(0);
          timer.resolveAll();
          await Promise.resolve();
          expect(adb.getExecutedCommands()).toEqual([]);
        } finally {
          timer.resolveAll();
          sleep.mockRestore();
        }
      },
    );
  }

  test.each(["copy", "paste", "clear"] as const)(
    "clipboard %s skips Android fallback after proxy abort",
    async (action) => {
      const adb = new FakeAdbExecutor();
      const controller = new AbortController();
      setClipboardFactory(
        () =>
          new Clipboard(devices[0]!, { create: () => adb }, () => ({
            requestClipboard: async () => {
              controller.abort();
              return { success: false, totalTimeMs: 0 };
            },
          })),
      );
      await expect(
        handler("clipboard")(devices[0]!, { action, text: "hello" }, undefined, controller.signal),
      ).rejects.toThrow("cancelled");
      expect(adb.getExecutedCommands()).toEqual([]);
    },
  );

  test("clipboard paste stops between Android clipboard read and paste", async () => {
    const adb = new FakeAdbExecutor();
    const controller = new AbortController();
    const dispatch = spyOn(adb, "executeCommand").mockImplementation(async () => {
      controller.abort();
      return {
        stdout: "hello",
        stderr: "",
        includes: () => false,
        trim: () => "hello",
        toString: () => "hello",
      };
    });
    setClipboardFactory(
      () =>
        new Clipboard(devices[0]!, { create: () => adb }, () => ({
          requestClipboard: async () => ({ success: false, totalTimeMs: 0 }),
        })),
    );
    try {
      await expect(
        handler("clipboard")(devices[0]!, { action: "paste" }, undefined, controller.signal),
      ).rejects.toThrow("cancelled");
      expect(dispatch).toHaveBeenCalledTimes(1);
    } finally {
      dispatch.mockRestore();
    }
  });

  test.each(["wake", "bouncer", "poll"])(
    "wakeAndUnlock stops during %s wait without timeout advance",
    async (phase) => {
      const adb = new FakeAdbExecutor();
      const timer = new FakeTimer();
      const controller = new AbortController();
      const wake = spyOn(adb, "getWakefulness").mockResolvedValue(
        phase === "wake" ? "Asleep" : "Awake",
      );
      adb.setDeviceLock({ locked: true, keyguardShowing: true, secure: phase === "bouncer" });
      const { started, sleep } = pausedSleep(timer);
      setWakeAndUnlockFactory(() => new WakeAndUnlock(devices[0]!, adb, { timer }));
      try {
        const pending = handler("wakeAndUnlock")(
          devices[0]!,
          { pin: "1234" },
          undefined,
          controller.signal,
        );
        await started;
        const before = adb.getExecutedCommands();
        controller.abort();
        await expect(pending).rejects.toThrow("cancelled");
        expect(timer.now()).toBe(0);
        expect(adb.getExecutedCommands()).toEqual(before);
        timer.resolveAll();
        await Promise.resolve();
        expect(adb.getExecutedCommands()).toEqual(before);
      } finally {
        timer.resolveAll();
        sleep.mockRestore();
        wake.mockRestore();
      }
    },
  );

  test("iOS unlock cancels pending Home and never swipes later", async () => {
    const device = devices[1]!;
    const adb = new FakeAdbExecutor();
    const timer = new FakeTimer();
    const controller = new AbortController();
    const { started, sleep } = pausedSleep(timer);
    let swipes = 0;
    const unlocker = new IosLockScreenUnlocker(
      device,
      {
        pressHome: async () => {
          await timer.sleep(2000);
          return { success: true };
        },
        swipeUp: async () => {
          swipes++;
          return { success: true };
        },
      },
      timer,
    );
    setWakeAndUnlockFactory(
      () =>
        new WakeAndUnlock(device, adb, {
          timer,
          iosUnlocker: unlocker,
          iosLockStateProbe: { read: async () => ({ locked: true, keyguardShowing: true }) },
        }),
    );
    try {
      const pending = handler("wakeAndUnlock")(device, {}, undefined, controller.signal);
      await started;
      controller.abort();
      await expect(pending).rejects.toThrow("cancelled");
      expect(timer.now()).toBe(0);
      expect(swipes).toBe(0);
      expect(timer.getPendingTimeoutCount()).toBe(0);
      timer.resolveAll();
      await Promise.resolve();
      expect(swipes).toBe(0);
    } finally {
      timer.resolveAll();
      sleep.mockRestore();
    }
  });

  test("shake resets acceleration on cancellation without waiting for duration", async () => {
    const adb = new FakeAdbExecutor();
    const timer = new FakeTimer();
    const controller = new AbortController();
    const shake = new Shake(devices[0]!, adb, timer);
    observed(shake);
    const { started, sleep } = pausedSleep(timer);
    setShakeFactory(() => shake);
    try {
      const pending = handler("shake")(
        devices[0]!,
        { duration: 1000 },
        undefined,
        controller.signal,
      );
      await started;
      controller.abort();
      await expect(pending).rejects.toThrow("cancelled");
      expect(adb.getExecutedCommands()).toEqual([
        "emu sensor get acceleration",
        "emu sensor set acceleration 100:100:100",
        "emu sensor set acceleration 0:9.77622:0",
      ]);
      expect(timer.now()).toBe(0);
      expect(timer.getPendingTimeoutCount()).toBe(0);
    } finally {
      timer.resolveAll();
      sleep.mockRestore();
    }
  });
  test("wakeAndUnlock cancels after the last PIN key before ENTER", async () => {
    const adb = new FakeAdbExecutor();
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const controller = new AbortController();
    adb.setDeviceLock({ locked: true, keyguardShowing: true, secure: true });
    adb.setAndroidApiLevel(29);
    adb.abortAfterCommand("KEYCODE_1", controller);
    setWakeAndUnlockFactory(() => new WakeAndUnlock(devices[0]!, adb, { timer }));
    await expect(
      handler("wakeAndUnlock")(devices[0]!, { pin: "1" }, undefined, controller.signal),
    ).rejects.toThrow("cancelled");
    expect(adb.getExecutedCommands()).toEqual([
      "shell wm dismiss-keyguard",
      "shell input keyevent KEYCODE_1",
    ]);
  });

  test("wakeAndUnlock cancels API-level probing before its fallback", async () => {
    const adb = new FakeAdbExecutor();
    const timer = new FakeTimer();
    const controller = new AbortController();
    adb.setDeviceLock({ locked: true, keyguardShowing: true, secure: true });
    adb.abortAfterApiLevel(controller);
    setWakeAndUnlockFactory(() => new WakeAndUnlock(devices[0]!, adb, { timer }));
    await expect(
      handler("wakeAndUnlock")(devices[0]!, { pin: "1" }, undefined, controller.signal),
    ).rejects.toThrow("cancelled");
    expect(adb.getExecutedCommands()).toEqual(["shell wm dismiss-keyguard"]);
    expect(timer.getSleepHistory()).toEqual([]);
  });

  test("shake cleanup escapes ambient cancellation and is bounded by its injected Timer", async () => {
    const adb = new FakeAdbExecutor();
    const timer = new FakeTimer();
    const controller = new AbortController();
    const shake = new Shake(devices[0]!, adb, timer);
    observed(shake);
    let cleanupStarted!: () => void;
    const startedCleanup = new Promise<void>((resolve) => {
      cleanupStarted = resolve;
    });
    const dispatch = spyOn(adb, "executeCommand").mockImplementation(
      async (command, timeout, _buffer, _retry, signal) => {
        if (command.endsWith("0:9.77622:0")) {
          expect(getAbortSignal()).toBeUndefined();
          expect(signal).toBeUndefined();
          expect(timeout).toBe(1000);
          cleanupStarted();
          await timer.sleep(5000);
        }
        return {
          stdout: "",
          stderr: "",
          includes: () => false,
          trim: () => "",
          toString: () => "",
        };
      },
    );
    const { started, sleep } = pausedSleep(timer);
    setShakeFactory(() => shake);
    try {
      const pending = runWithAbortSignal(controller.signal, () =>
        handler("shake")(devices[0]!, { duration: 10000 }, undefined, controller.signal),
      );
      await started;
      controller.abort();
      await startedCleanup;
      expect(timer.getPendingTimeouts()).toEqual([1000]);
      timer.advanceTime(1000);
      await expect(pending).rejects.toThrow("cancelled");
      expect(timer.now()).toBe(1000);
      expect(timer.getPendingTimeoutCount()).toBe(0);
    } finally {
      timer.resolveAll();
      sleep.mockRestore();
      dispatch.mockRestore();
    }
  });
  test.each(["copy", "paste", "clear", "get"] as const)(
    "iOS clipboard %s never registers a request after a cancelled connection wait",
    async (action) => {
      const timer = new FakeTimer();
      const adb = new FakeAdbExecutor();
      const controller = new AbortController();
      const manager = new RequestManager(timer);
      const register = spyOn(manager, "generateId");
      const { started, sleep } = pausedSleep(timer);
      let finished!: () => void;
      const completed = new Promise<void>((resolve) => {
        finished = resolve;
      });
      const proxy = new CtrlProxyClipboard({
        timer,
        requestManager: manager,
        getWebSocket: () => null,
        ensureConnected: async () => {
          await timer.sleep(5000);
          return true;
        },
        cancelScreenshotBackoff: () => {},
      });
      setClipboardFactory(
        () =>
          new Clipboard(devices[1]!, { create: () => adb }, () => ({
            requestClipboard: async (...args) => {
              try {
                return await proxy.requestClipboard(...args);
              } finally {
                finished();
              }
            },
          })),
      );
      try {
        const pending = handler("clipboard")(
          devices[1]!,
          { action, text: "hello" },
          undefined,
          controller.signal,
        );
        await started;
        controller.abort();
        await expect(pending).rejects.toThrow("cancelled");
        timer.resolveAll();
        await completed;
        expect(register).not.toHaveBeenCalled();
        expect(timer.getPendingTimeoutCount()).toBe(0);
      } finally {
        timer.resolveAll();
        sleep.mockRestore();
        register.mockRestore();
      }
    },
  );
});
