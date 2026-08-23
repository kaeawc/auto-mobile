import { describe, expect, spyOn, test } from "bun:test";
import { PressButton } from "../../../src/features/action/PressButton";
import { IOSCtrlProxyClient } from "../../../src/features/observe/ios";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { BootedDevice } from "../../../src/models";
import { FakeTimer } from "../../fakes/FakeTimer";

describe("PressButton", () => {
  const iosDevice: BootedDevice = {
    deviceId: "ios-device",
    platform: "ios",
    name: "iPhone",
  };

  const iosSimulator: BootedDevice = {
    deviceId: "A1B2C3D4-E5F6-7890-ABCD-EF1234567890",
    platform: "ios",
    name: "iPhone Simulator",
  };

  test("ios back delegates to CtrlProxy pressBack", async () => {
    let backCalls = 0;
    const getInstanceSpy = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue({
      requestPressBack: async () => {
        backCalls++;
        return { success: true, totalTimeMs: 5 };
      },
      requestPressHome: async () => ({ success: true, totalTimeMs: 5 }),
      requestRecentApps: async () => ({ success: true, totalTimeMs: 5 }),
    } as any);

    try {
      const pressButton = new PressButton(iosDevice);
      const result = await (pressButton as any).executeiOSButtonPress("back");

      expect(result.success).toBe(true);
      expect(backCalls).toBe(1);
      expect(getInstanceSpy).toHaveBeenCalled();
    } finally {
      getInstanceSpy.mockRestore();
    }
  });

  test("ios recent delegates to CtrlProxy recent apps", async () => {
    let recentCalls = 0;
    const getInstanceSpy = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue({
      requestPressBack: async () => ({ success: true, totalTimeMs: 5 }),
      requestPressHome: async () => ({ success: true, totalTimeMs: 5 }),
      requestRecentApps: async () => {
        recentCalls++;
        return { success: true, totalTimeMs: 5 };
      },
    } as any);

    try {
      const pressButton = new PressButton(iosDevice);
      const result = await (pressButton as any).executeiOSButtonPress("recent");

      expect(result.success).toBe(true);
      expect(recentCalls).toBe(1);
      expect(getInstanceSpy).toHaveBeenCalled();
    } finally {
      getInstanceSpy.mockRestore();
    }
  });

  test("press delegates to platform button handling without observing", async () => {
    let homeCalls = 0;
    const getInstanceSpy = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue({
      requestPressBack: async () => ({ success: true, totalTimeMs: 5 }),
      requestPressHome: async () => {
        homeCalls++;
        return { success: true, totalTimeMs: 5 };
      },
      requestRecentApps: async () => ({ success: true, totalTimeMs: 5 }),
    } as any);

    try {
      const pressButton = new PressButton(iosDevice);
      (pressButton as any).observeScreen = {
        getMostRecentCachedObserveResult: async () => {
          throw new Error("press should not read cached observations");
        },
        execute: async () => {
          throw new Error("press should not observe");
        },
      };

      const result = await pressButton.press("home");

      expect(result.success).toBe(true);
      expect(homeCalls).toBe(1);
      expect(getInstanceSpy).toHaveBeenCalled();
    } finally {
      getInstanceSpy.mockRestore();
    }
  });

  test("ios button presses retain their desktop frame context through the runner request", async () => {
    const contexts: string[] = [];
    const getInstanceSpy = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue({
      requestPressBack: async (_timeoutMs?: number, _perf?: unknown, frameContext?: string) => {
        contexts.push(frameContext ?? "");
        return { success: true, totalTimeMs: 5 };
      },
      requestPressHome: async (_timeoutMs?: number, _perf?: unknown, frameContext?: string) => {
        contexts.push(frameContext ?? "");
        return { success: true, totalTimeMs: 5 };
      },
      requestRecentApps: async (_timeoutMs?: number, _perf?: unknown, frameContext?: string) => {
        contexts.push(frameContext ?? "");
        return { success: true, totalTimeMs: 5 };
      },
      requestPressButton: async (
        _button: string,
        _timeoutMs?: number,
        _perf?: unknown,
        frameContext?: string,
      ) => {
        contexts.push(frameContext ?? "");
        return { success: true, totalTimeMs: 5 };
      },
    } as any);

    try {
      const pressButton = new PressButton(iosDevice);
      await pressButton.press("home", undefined, "desktop-frame");
      await pressButton.press("back", undefined, "desktop-frame");
      await pressButton.press("recent", undefined, "desktop-frame");
      await pressButton.press("volume_up", undefined, "desktop-frame");

      expect(contexts).toEqual([
        "desktop-frame",
        "desktop-frame",
        "desktop-frame",
        "desktop-frame",
      ]);
    } finally {
      getInstanceSpy.mockRestore();
    }
  });

  test("android ADB keyevent honors the caller timeout budget", async () => {
    const androidDevice: BootedDevice = {
      deviceId: "android-device",
      platform: "android",
      name: "Pixel",
    };

    const fakeTimer = new FakeTimer();
    const capturedTimeouts: (number | undefined)[] = [];
    const fakeAdb = {
      execute: async (_args: string[], options?: { timeoutMs?: number }) => {
        capturedTimeouts.push(options?.timeoutMs);
        return {
          stdout: "",
          stderr: "",
          toString: () => "",
          trim: () => "",
          includes: () => false,
        };
      },
    } as any;

    // "menu" is not a global-action button, so it goes straight to the ADB keyevent path.
    const pressButton = new PressButton(androidDevice, fakeAdb);
    (pressButton as any).timer = fakeTimer;
    const result = await pressButton.press("menu", 500);

    expect(result.success).toBe(true);
    expect(capturedTimeouts).toEqual([500]);
  });

  test("android ADB keyevent leaves timeout unset when no budget is given", async () => {
    const androidDevice: BootedDevice = {
      deviceId: "android-device",
      platform: "android",
      name: "Pixel",
    };

    const capturedTimeouts: (number | undefined)[] = [];
    const fakeAdb = {
      execute: async (_args: string[], options?: { timeoutMs?: number }) => {
        capturedTimeouts.push(options?.timeoutMs);
        return {
          stdout: "",
          stderr: "",
          toString: () => "",
          trim: () => "",
          includes: () => false,
        };
      },
    } as any;

    const pressButton = new PressButton(androidDevice, fakeAdb);
    const result = await pressButton.press("menu");

    expect(result.success).toBe(true);
    expect(capturedTimeouts).toEqual([undefined]);
  });

  test("android global-action fallback shares the deadline budget with the ADB keyevent", async () => {
    const androidDevice: BootedDevice = {
      deviceId: "android-device",
      platform: "android",
      name: "Pixel",
    };

    const fakeTimer = new FakeTimer();
    const globalActionTimeouts: number[] = [];
    const adbTimeouts: (number | undefined)[] = [];

    // Fails the accessibility path (forcing the ADB fallback) after consuming
    // part of the shared deadline.
    const getInstanceSpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue({
      requestGlobalAction: async (action: string, timeoutMs: number) => {
        globalActionTimeouts.push(timeoutMs);
        fakeTimer.advanceTime(300);
        return { success: false, action, totalTimeMs: 300, error: "WebSocket not connected" };
      },
    } as any);

    const fakeAdb = {
      execute: async (_args: string[], options?: { timeoutMs?: number }) => {
        adbTimeouts.push(options?.timeoutMs);
        return {
          stdout: "",
          stderr: "",
          toString: () => "",
          trim: () => "",
          includes: () => false,
        };
      },
    } as any;

    try {
      const pressButton = new PressButton(androidDevice, fakeAdb);
      (pressButton as any).timer = fakeTimer;

      // "back" is a global-action button, so this exercises the two-call path.
      const result = await pressButton.press("back", 500);

      expect(result.success).toBe(true);
      // Global action capped at min(3000, 500).
      expect(globalActionTimeouts).toEqual([500]);
      // ADB fallback receives the REMAINING budget after 300ms was consumed,
      // proving total time is bounded by the caller's budget, not the sum of
      // per-transport defaults.
      expect(adbTimeouts).toEqual([200]);
    } finally {
      getInstanceSpy.mockRestore();
    }
  });

  test("android fails fast when the global action exhausts the deadline before the ADB fallback", async () => {
    const androidDevice: BootedDevice = {
      deviceId: "android-device",
      platform: "android",
      name: "Pixel",
    };

    const fakeTimer = new FakeTimer();
    let adbCalled = false;

    const getInstanceSpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue({
      requestGlobalAction: async (action: string, timeoutMs: number) => {
        // Consume the entire budget.
        fakeTimer.advanceTime(timeoutMs);
        return { success: false, action, totalTimeMs: timeoutMs, error: "timeout" };
      },
    } as any);

    const fakeAdb = {
      executeCommand: async () => {
        adbCalled = true;
        return {
          stdout: "",
          stderr: "",
          toString: () => "",
          trim: () => "",
          includes: () => false,
        };
      },
    } as any;

    try {
      const pressButton = new PressButton(androidDevice, fakeAdb);
      (pressButton as any).timer = fakeTimer;

      const result = await pressButton.press("back", 500);

      // Deadline exhausted -> structured failure, and the unbounded ADB keyevent
      // is never dispatched.
      expect(result.success).toBe(false);
      expect(result.error).toContain("deadline exhausted");
      expect(adbCalled).toBe(false);
    } finally {
      getInstanceSpy.mockRestore();
    }
  });

  test("ios menu remains unsupported", async () => {
    const pressButton = new PressButton(iosDevice);
    const result = await (pressButton as any).executeiOSButtonPress("menu");

    expect(result.success).toBe(false);
    expect(result.error).toContain("no menu hardware button");
  });

  test("ios hardware buttons delegate to generic CtrlProxy pressButton on physical devices", async () => {
    const pressButtonCalls: string[] = [];
    const getInstanceSpy = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue({
      requestPressBack: async () => ({ success: true, totalTimeMs: 5 }),
      requestPressHome: async () => ({ success: true, totalTimeMs: 5 }),
      requestRecentApps: async () => ({ success: true, totalTimeMs: 5 }),
      requestPressButton: async (button: string) => {
        pressButtonCalls.push(button);
        return { success: true, totalTimeMs: 5 };
      },
    } as any);

    try {
      const pressButton = new PressButton(iosDevice);

      for (const button of ["volume_up", "volume_down", "power"]) {
        const result = await (pressButton as any).executeiOSButtonPress(button);
        expect(result).toEqual({ success: true, button, keyCode: -1 });
      }

      expect(pressButtonCalls).toEqual(["volume_up", "volume_down", "power"]);
      expect(getInstanceSpy).toHaveBeenCalledTimes(3);
    } finally {
      getInstanceSpy.mockRestore();
    }
  });

  test("ios simulator rejects hardware buttons without contacting CtrlProxy", async () => {
    const getInstanceSpy = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue({
      requestPressButton: async () => {
        throw new Error("should not be called");
      },
    } as any);

    try {
      const pressButton = new PressButton(iosSimulator);

      for (const button of ["volume_up", "volume_down", "power"]) {
        const result = await (pressButton as any).executeiOSButtonPress(button);
        expect(result.success).toBe(false);
        expect(result.button).toBe(button);
        expect(result.keyCode).toBe(-1);
        expect(result.error).toContain("unavailable on the iOS simulator");
      }

      expect(getInstanceSpy).not.toHaveBeenCalled();
    } finally {
      getInstanceSpy.mockRestore();
    }
  });

  test("ios press threads the caller timeout budget into the runner", async () => {
    const homeTimeouts: (number | undefined)[] = [];
    const buttonTimeouts: (number | undefined)[] = [];
    const getInstanceSpy = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue({
      requestPressBack: async () => ({ success: true, totalTimeMs: 5 }),
      requestPressHome: async (timeoutMs?: number) => {
        homeTimeouts.push(timeoutMs);
        return { success: true, totalTimeMs: 5 };
      },
      requestRecentApps: async () => ({ success: true, totalTimeMs: 5 }),
      requestPressButton: async (_button: string, timeoutMs?: number) => {
        buttonTimeouts.push(timeoutMs);
        return { success: true, totalTimeMs: 5 };
      },
    } as any);

    try {
      const pressButton = new PressButton(iosDevice);

      await pressButton.press("home", 500);
      await pressButton.press("volume_up", 750);

      expect(homeTimeouts).toEqual([500]);
      expect(buttonTimeouts).toEqual([750]);
    } finally {
      getInstanceSpy.mockRestore();
    }
  });

  test("ios press without a budget leaves runner defaults untouched", async () => {
    const homeTimeouts: (number | undefined)[] = [];
    const getInstanceSpy = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue({
      requestPressBack: async () => ({ success: true, totalTimeMs: 5 }),
      requestPressHome: async (timeoutMs?: number) => {
        homeTimeouts.push(timeoutMs);
        return { success: true, totalTimeMs: 5 };
      },
      requestRecentApps: async () => ({ success: true, totalTimeMs: 5 }),
    } as any);

    try {
      const pressButton = new PressButton(iosDevice);
      await pressButton.press("home");

      expect(homeTimeouts).toEqual([undefined]);
    } finally {
      getInstanceSpy.mockRestore();
    }
  });

  test("ios hardware button runner failures return structured errors", async () => {
    const getInstanceSpy = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue({
      requestPressButton: async () => ({
        success: false,
        error: "Power/lock button is not supported on this device",
        totalTimeMs: 5,
      }),
    } as any);

    try {
      const pressButton = new PressButton(iosDevice);
      const result = await (pressButton as any).executeiOSButtonPress("power");

      expect(result.success).toBe(false);
      expect(result.button).toBe("power");
      expect(result.keyCode).toBe(-1);
      expect(result.error).toBe("Power/lock button is not supported on this device");
    } finally {
      getInstanceSpy.mockRestore();
    }
  });
});
