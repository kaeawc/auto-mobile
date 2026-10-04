import {
  beforeEach as beforeOutputSchema,
  afterEach as afterOutputSchema,
  spyOn as spyOnOutputSchema,
} from "bun:test";
import { pressButtonResultSchema } from "../../../src/server/toolOutputSchemas";
import { finalizeToolResponse } from "../../../src/server/finalizeToolResponse";
import { createStructuredToolResponse } from "../../../src/utils/toolUtils";
import { FakeArtifactWriter } from "../../fakes/FakeArtifactWriter";
import { describe, expect, spyOn, test } from "bun:test";
import { PressButton } from "../../../src/features/action/PressButton";
import { IOSCtrlProxyClient } from "../../../src/features/observe/ios";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { BootedDevice } from "../../../src/models";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeIOSCtrlProxy } from "../../fakes/FakeIOSCtrlProxy";

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

  test("simulator home button uses simctl without runner Home and verifies foreground", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const client = new FakeIOSCtrlProxy(timer);
    client.setHierarchyData({
      packageName: "com.apple.springboard",
      updatedAt: 1,
      hierarchy: { className: "XCUIApplication" },
    });
    const getInstanceSpy = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue(
      client as unknown as IOSCtrlProxyClient,
    );
    const launches: string[][] = [];
    try {
      const pressButton = new PressButton(iosSimulator, null, timer, {
        executeCommandArgs: async (args) => {
          launches.push(args);
          return { stdout: "", stderr: "" };
        },
      });

      const result = await pressButton.press("home");
      expect(result.success).toBe(true);
      expect(launches).toEqual([["launch", iosSimulator.deviceId, "com.apple.springboard"]]);
      expect(client.getPressHomeRequestCount()).toBe(0);
    } finally {
      getInstanceSpy.mockRestore();
    }
  });

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

  test("android reports an indeterminate press when a dispatched global action exhausts the deadline", async () => {
    const androidDevice: BootedDevice = {
      deviceId: "android-device",
      platform: "android",
      name: "Pixel",
    };

    const fakeTimer = new FakeTimer();
    let adbCalled = false;

    const getInstanceSpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue({
      requestGlobalAction: async (
        ...args: Parameters<AndroidCtrlProxyClient["requestGlobalAction"]>
      ) => {
        const [action, timeoutMs = 5000] = args;
        args[5]?.();
        // Consume the entire budget after the request was sent.
        fakeTimer.advanceTime(timeoutMs);
        return {
          success: false,
          action,
          totalTimeMs: timeoutMs,
          error: "timeout",
          acknowledged: false,
        };
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

      // A lost reply after dispatch is indeterminate even when the deadline is exhausted.
      expect(result.success).toBe(false);
      expect(result.error).toContain("may have been applied");
      expect(result.error).toContain("timeout");
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

  test("ios simulator forwards hardware buttons to CtrlProxy", async () => {
    const pressButtonCalls: string[] = [];
    const getInstanceSpy = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue({
      requestPressButton: async (button: string) => {
        pressButtonCalls.push(button);
        return { success: true, totalTimeMs: 5 };
      },
    } as any);

    try {
      const pressButton = new PressButton(iosSimulator);

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

// Validate the actual fake-backed branch results before and after finalization.
const executeForOutputSchema = PressButton.prototype.execute;
let executeOutputSchemaSpy: ReturnType<typeof spyOnOutputSchema>;
beforeOutputSchema(() => {
  executeOutputSchemaSpy = spyOnOutputSchema(PressButton.prototype, "execute").mockImplementation(
    async function (this: PressButton, ...args: Parameters<PressButton["execute"]>) {
      const result = await executeForOutputSchema.apply(this, args);
      const payload = { message: "Result", ...result };
      expect(pressButtonResultSchema.parse(payload)).toBeDefined();
      const finalized = finalizeToolResponse(createStructuredToolResponse(payload), {
        name: "pressButton",
        outputSchema: pressButtonResultSchema,
        artifactWriter: new FakeArtifactWriter(),
      });
      expect(pressButtonResultSchema.parse(finalized.structuredContent)).toBeDefined();
      return result;
    },
  );
});
afterOutputSchema(() => executeOutputSchemaSpy.mockRestore());
// Validate the actual fake-backed branch results before and after finalization.
const pressForOutputSchema = PressButton.prototype.press;
let pressOutputSchemaSpy: ReturnType<typeof spyOnOutputSchema>;
beforeOutputSchema(() => {
  pressOutputSchemaSpy = spyOnOutputSchema(PressButton.prototype, "press").mockImplementation(
    async function (this: PressButton, ...args: Parameters<PressButton["press"]>) {
      const result = await pressForOutputSchema.apply(this, args);
      const payload = { message: "Result", ...result };
      expect(pressButtonResultSchema.parse(payload)).toBeDefined();
      const finalized = finalizeToolResponse(createStructuredToolResponse(payload), {
        name: "pressButton",
        outputSchema: pressButtonResultSchema,
        artifactWriter: new FakeArtifactWriter(),
      });
      expect(pressButtonResultSchema.parse(finalized.structuredContent)).toBeDefined();
      return result;
    },
  );
});
afterOutputSchema(() => pressOutputSchemaSpy.mockRestore());

// Existing dispatch tests intentionally exercise the private transport seam.
const dispatchPrototype = PressButton.prototype as unknown as {
  executeiOSButtonPress: PressButton["press"];
};
const dispatchForOutputSchema = dispatchPrototype.executeiOSButtonPress;
let dispatchOutputSchemaSpy: ReturnType<typeof spyOnOutputSchema>;
beforeOutputSchema(() => {
  dispatchOutputSchemaSpy = spyOnOutputSchema(
    dispatchPrototype,
    "executeiOSButtonPress",
  ).mockImplementation(async function (
    this: PressButton,
    ...args: Parameters<PressButton["press"]>
  ) {
    const result = await dispatchForOutputSchema.apply(this, args);
    expect(pressButtonResultSchema.parse({ message: "Result", ...result })).toBeDefined();
    return result;
  });
});
afterOutputSchema(() => dispatchOutputSchemaSpy.mockRestore());
