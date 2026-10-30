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
import { createExecResult } from "../../../src/utils/execResult";
import {
  PressButton,
  acceptIosHomeAlreadyOnSpringboard,
  isIosHomePressOnSpringboard,
  isIosSpringboardFallbackPress,
} from "../../../src/features/action/PressButton";
import type { ObserveResult } from "../../../src/models";
import { IOSCtrlProxyClient } from "../../../src/features/observe/ios";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { BootedDevice, ExecResult } from "../../../src/models";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { OPERATION_CANCELLED_MESSAGE } from "../../../src/utils/constants";
import { holdDispatchedRequest } from "../../../src/daemon/dispatchedRequestHold";
import { drainMicrotasks, drainUntil } from "../../helpers/fakeTimerStepping";
import { FakeIOSCtrlProxy } from "../../fakes/FakeIOSCtrlProxy";
import { SimctlCommandTimeoutError } from "../../../src/utils/ios-cmdline-tools/SimctlCommandTimeoutError";
import { IosHomeLaunchTimeoutError } from "../../../src/models/IosHomeLaunchTimeoutError";
import { spyOnIosClientInstance } from "../../helpers/iosCtrlProxyClientSpies";

/** Fails the test if a press reads or captures an observation. */
class ThrowingObserveScreen extends FakeObserveScreen {
  override async getMostRecentCachedObserveResult(): ReturnType<
    FakeObserveScreen["getMostRecentCachedObserveResult"]
  > {
    throw new Error("press should not read cached observations");
  }
  override async execute(): ReturnType<FakeObserveScreen["execute"]> {
    throw new Error("press should not observe");
  }
}

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
    const getInstanceSpy = spyOnIosClientInstance(client);
    const invalidated: string[] = [];
    const launches: string[][] = [];
    try {
      const pressButton = new PressButton(
        iosSimulator,
        null,
        timer,
        {
          executeCommandArgs: async (args) => {
            launches.push(args);
            return createExecResult("", "");
          },
        },
        undefined,
        {
          iosLockStateInvalidator: {
            invalidate: (id) => {
              invalidated.push(id);
            },
          },
        },
      );

      const result = await pressButton.press("home");
      expect(result.success).toBe(true);
      expect(invalidated).toEqual([iosSimulator.deviceId]);
      expect(launches).toEqual([["launch", iosSimulator.deviceId, "com.apple.springboard"]]);
      expect(client.getPressHomeRequestCount()).toBe(0);
    } finally {
      getInstanceSpy.mockRestore();
    }
  });

  test("held simulator Home stops verification reads on caller cancellation", async () => {
    const timer = new FakeTimer();
    const controller = new AbortController();
    const client = new FakeIOSCtrlProxy(timer);
    const hierarchy =
      Promise.withResolvers<Awaited<ReturnType<typeof client.requestHierarchySync>>>();
    const instance = spyOnIosClientInstance(client);
    const reads = spyOn(client, "requestHierarchySync").mockImplementation(() => hierarchy.promise);
    let launches = 0;
    let marks = 0;
    const action = new PressButton(
      iosSimulator,
      null,
      timer,
      {
        executeCommandArgs: async () => {
          launches++;
          return createExecResult("", "");
        },
      },
      (signal, timeoutMs, send, onDispatch) =>
        holdDispatchedRequest({
          timer,
          signal,
          timeoutMs: timeoutMs ?? 5000,
          label: "Home launch",
          send,
          onDispatch,
        }),
    );
    let answered = false;
    const pending = action
      .press("home", 500, undefined, controller.signal, () => marks++)
      .finally(() => {
        answered = true;
      });
    void pending.catch(() => {});
    try {
      await drainUntil(() => reads.mock.calls.length === 1, {
        description: "home verification read",
      });
      controller.abort(new Error("cancel home verification"));
      await drainMicrotasks(100);
      expect(answered).toBe(true);
      await expect(pending).rejects.toThrow(OPERATION_CANCELLED_MESSAGE);
      hierarchy.resolve({
        hierarchy: {
          packageName: "com.example.app",
          updatedAt: 1,
          hierarchy: { className: "XCUIApplication" },
        },
      });
      timer.advanceTime(500);
      await drainMicrotasks(100);
      expect(reads).toHaveBeenCalledTimes(1);
      expect(launches).toBe(1);
      expect(marks).toBe(1);
    } finally {
      controller.abort();
      hierarchy.resolve({
        hierarchy: {
          packageName: "com.apple.springboard",
          updatedAt: 1,
          hierarchy: { className: "XCUIApplication" },
        },
      });
      await pending.catch(() => {});
      reads.mockRestore();
      instance.mockRestore();
      expect(timer.getPendingTimeoutCount()).toBe(0);
    }
  });

  test.each(["reply", "deadline"] as const)(
    "held simulator Home keeps only the launch in flight until %s after cancellation",
    async (end) => {
      const timer = new FakeTimer();
      const controller = new AbortController();
      const client = new FakeIOSCtrlProxy(timer);
      const launch = Promise.withResolvers<ExecResult>();
      const instance = spyOnIosClientInstance(client);
      const reads = spyOn(client, "requestHierarchySync");
      let sent = false;
      let marks = 0;
      const action = new PressButton(
        iosSimulator,
        null,
        timer,
        {
          executeCommandArgs: () => {
            sent = true;
            return launch.promise;
          },
        },
        (signal, timeoutMs, send, onDispatch) =>
          holdDispatchedRequest({
            timer,
            signal,
            timeoutMs: timeoutMs ?? 5000,
            label: "Home launch",
            send,
            onDispatch,
          }),
      );
      let answered = false;
      const pending = action
        .press("home", 500, undefined, controller.signal, () => marks++)
        .finally(() => {
          answered = true;
        });
      void pending.catch(() => {});
      try {
        await drainUntil(() => sent, { description: "simctl launch dispatch" });
        timer.advanceTime(200);
        controller.abort(new Error("cancel launch"));
        await drainMicrotasks(100);
        expect(answered).toBe(false);
        expect(reads).not.toHaveBeenCalled();
        if (end === "deadline") {
          timer.advanceTime(299);
          await drainMicrotasks(100);
          expect(answered).toBe(false);
          timer.advanceTime(1);
        } else {
          launch.resolve(createExecResult("", ""));
        }
        await expect(pending).rejects.toThrow(OPERATION_CANCELLED_MESSAGE);
        expect(reads).not.toHaveBeenCalled();
        expect(marks).toBe(1);
      } finally {
        controller.abort();
        launch.resolve(createExecResult("", ""));
        await pending.catch(() => {});
        reads.mockRestore();
        instance.mockRestore();
        expect(timer.getPendingTimeoutCount()).toBe(0);
      }
    },
  );

  test("simulator launch budget regression retries a timed-out Home launch", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const client = new FakeIOSCtrlProxy(timer);
    client.setHierarchyData({
      packageName: "com.apple.springboard",
      updatedAt: 1,
      hierarchy: { className: "XCUIApplication" },
    });
    const instance = spyOnIosClientInstance(client);
    const timeouts: number[] = [];
    try {
      const action = new PressButton(iosSimulator, null, timer, {
        executeCommandArgs: async (_args, timeoutMs = 0) => {
          timeouts.push(timeoutMs);
          if (timeouts.length === 1) {
            await timer.sleep(timeoutMs);
            throw new SimctlCommandTimeoutError("busy host launch timed out");
          }
          return createExecResult("", "");
        },
      });
      expect((await action.press("home")).success).toBe(true);
      expect(timeouts).toEqual([2500, 2400]);
      expect(timer.getSleepHistory()).toEqual([2500, 100]);
      expect(client.getPressHomeRequestCount()).toBe(0);
      expect(client.getHierarchyRequestCount()).toBe(1);
    } finally {
      instance.mockRestore();
    }
  });

  test.each([false, true])("simulator Home marks at launch, abort=%s", async (aborted) => {
    const timer = new FakeTimer();
    const controller = new AbortController();
    const client = new FakeIOSCtrlProxy(timer);
    client.setHierarchyData({
      packageName: "com.apple.springboard",
      updatedAt: 1,
      hierarchy: { className: "XCUIApplication" },
    });
    const instance = spyOnIosClientInstance(client);
    let marks = 0;
    let launches = 0;
    const action = new PressButton(iosSimulator, null, timer, {
      executeCommandArgs: async () => {
        expect(marks).toBe(1);
        launches++;
        return createExecResult("", "");
      },
    });
    try {
      if (aborted) {
        controller.abort();
      }
      const pending = action.press("home", 500, undefined, controller.signal, () => {
        expect(launches).toBe(0);
        marks++;
      });
      if (aborted) {
        await expect(pending).rejects.toThrow();
      } else {
        expect((await pending).success).toBe(true);
      }
      expect(marks).toBe(aborted ? 0 : 1);
      expect(launches).toBe(aborted ? 0 : 1);
    } finally {
      instance.mockRestore();
      expect((IOSCtrlProxyClient.getInstance as { mock?: unknown }).mock).toBeUndefined();
    }
  });

  test.each(["home", "back", "recent", "volume_up"])(
    "iOS %s threads dispatch to the runner",
    async (button) => {
      let marks = 0;
      const request = async (...args: unknown[]) => {
        expect(marks).toBe(0);
        const hook = args.at(-1);
        expect(typeof hook).toBe("function");
        if (typeof hook === "function") {
          hook();
        }
        expect(marks).toBe(1);
        return { success: true };
      };
      const instance = spyOnIosClientInstance({
        requestPressHome: request,
        requestPressBack: request,
        requestRecentApps: request,
        requestPressButton: request,
      });
      try {
        expect(
          (
            await new PressButton(iosDevice, null, new FakeTimer()).press(
              button,
              500,
              undefined,
              undefined,
              () => marks++,
            )
          ).success,
        ).toBe(true);
        expect(marks).toBe(1);
      } finally {
        instance.mockRestore();
      }
    },
  );

  test("ios back delegates to CtrlProxy pressBack", async () => {
    let backCalls = 0;
    const getInstanceSpy = spyOnIosClientInstance({
      requestPressBack: async () => {
        backCalls++;
        return { success: true, totalTimeMs: 5 };
      },
      requestPressHome: async () => ({ success: true, totalTimeMs: 5 }),
      requestRecentApps: async () => ({ success: true, totalTimeMs: 5 }),
    });

    try {
      const pressButton = new PressButton(iosDevice);
      const result = await dispatch(pressButton, "back");

      expect(result.success).toBe(true);
      expect(backCalls).toBe(1);
      expect(getInstanceSpy).toHaveBeenCalled();
    } finally {
      getInstanceSpy.mockRestore();
    }
  });

  test("ios recent delegates to CtrlProxy recent apps", async () => {
    let recentCalls = 0;
    const getInstanceSpy = spyOnIosClientInstance({
      requestPressBack: async () => ({ success: true, totalTimeMs: 5 }),
      requestPressHome: async () => ({ success: true, totalTimeMs: 5 }),
      requestRecentApps: async () => {
        recentCalls++;
        return { success: true, totalTimeMs: 5 };
      },
    });

    try {
      const pressButton = new PressButton(iosDevice);
      const result = await dispatch(pressButton, "recent");

      expect(result.success).toBe(true);
      expect(recentCalls).toBe(1);
      expect(getInstanceSpy).toHaveBeenCalled();
    } finally {
      getInstanceSpy.mockRestore();
    }
  });

  test("press delegates to platform button handling without observing", async () => {
    let homeCalls = 0;
    const getInstanceSpy = spyOnIosClientInstance({
      requestPressBack: async () => ({ success: true, totalTimeMs: 5 }),
      requestPressHome: async () => {
        homeCalls++;
        return { success: true, totalTimeMs: 5 };
      },
      requestRecentApps: async () => ({ success: true, totalTimeMs: 5 }),
    });

    try {
      const pressButton = new PressButton(iosDevice, null, undefined, undefined, undefined, {
        observeScreen: new ThrowingObserveScreen(),
      });

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
    const getInstanceSpy = spyOnIosClientInstance({
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
    });

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
    const fakeAdb = new FakeAdbExecutor();

    // "menu" is not a global-action button, so it goes straight to the ADB keyevent path.
    const pressButton = new PressButton(androidDevice, fakeAdb, fakeTimer);
    const result = await pressButton.press("menu", 500);

    expect(result.success).toBe(true);
    expect(fakeAdb.getCommandCalls().map((call) => call.timeoutMs)).toEqual([500]);
  });

  test("android ADB keyevent leaves timeout unset when no budget is given", async () => {
    const androidDevice: BootedDevice = {
      deviceId: "android-device",
      platform: "android",
      name: "Pixel",
    };

    const fakeAdb = new FakeAdbExecutor();

    const pressButton = new PressButton(androidDevice, fakeAdb);
    const result = await pressButton.press("menu");

    expect(result.success).toBe(true);
    expect(fakeAdb.getCommandCalls().map((call) => call.timeoutMs)).toEqual([undefined]);
  });

  test("android global-action fallback shares the deadline budget with the ADB keyevent", async () => {
    const androidDevice: BootedDevice = {
      deviceId: "android-device",
      platform: "android",
      name: "Pixel",
    };

    const fakeTimer = new FakeTimer();
    const globalActionTimeouts: number[] = [];

    // Fails the accessibility path (forcing the ADB fallback) after consuming
    // part of the shared deadline.
    const globalActionClient = {
      requestGlobalAction: async (action: string, timeoutMs: number) => {
        globalActionTimeouts.push(timeoutMs);
        fakeTimer.advanceTime(300);
        return { success: false, action, totalTimeMs: 300, error: "WebSocket not connected" };
      },
    };

    const fakeAdb = new FakeAdbExecutor();

    const pressButton = new PressButton(androidDevice, fakeAdb, fakeTimer, undefined, undefined, {
      globalActionClient,
    });

    // "back" is a global-action button, so this exercises the two-call path.
    const result = await pressButton.press("back", 500);

    expect(result.success).toBe(true);
    // Global action capped at min(3000, 500).
    expect(globalActionTimeouts).toEqual([500]);
    // ADB fallback receives the REMAINING budget after 300ms was consumed,
    // proving total time is bounded by the caller's budget, not the sum of
    // per-transport defaults.
    expect(fakeAdb.getCommandCalls().map((call) => call.timeoutMs)).toEqual([200]);
  });

  test("android reports an indeterminate press when a dispatched global action exhausts the deadline", async () => {
    const androidDevice: BootedDevice = {
      deviceId: "android-device",
      platform: "android",
      name: "Pixel",
    };

    const fakeTimer = new FakeTimer();

    const globalActionClient = {
      requestGlobalAction: async (
        ...args: Parameters<AndroidCtrlProxyClient["requestGlobalAction"]>
      ) => {
        const [action, timeoutMs = 5000] = args;
        args[3]?.onDispatch?.();
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
    };

    const fakeAdb = new FakeAdbExecutor();

    const pressButton = new PressButton(androidDevice, fakeAdb, fakeTimer, undefined, undefined, {
      globalActionClient,
    });

    const result = await pressButton.press("back", 500);

    // A lost reply after dispatch is indeterminate even when the deadline is exhausted.
    expect(result.success).toBe(false);
    expect(result.error).toContain("may have been applied");
    expect(result.error).toContain("timeout");
    expect(fakeAdb.getCommandCalls()).toEqual([]);
  });

  test("ios menu remains unsupported", async () => {
    const pressButton = new PressButton(iosDevice);
    const result = await pressButton.press("menu");

    expect(result.success).toBe(false);
    expect(result.error).toContain("no menu hardware button");
    expect(result).toMatchObject({ code: "unsupported_button", retryable: false });
  });

  test("unsupported iOS button is typed and terminal", async () => {
    const result = await new PressButton(iosDevice).press("menuish");
    expect(result).toMatchObject({ code: "unsupported_button", retryable: false });
  });

  // Issue #14100: XCUIDevice.Button.action / .camera, gated by hasHardwareButton.
  test.each(["action", "camera"])(
    "ios %s forwards to the CtrlProxy pressButton",
    async (button) => {
      const pressButtonCalls: string[] = [];
      const getInstanceSpy = spyOnIosClientInstance({
        requestPressButton: async (requested: string) => {
          pressButtonCalls.push(requested);
          return { success: true, totalTimeMs: 5 };
        },
      });
      try {
        const result = await dispatch(new PressButton(iosDevice), button.toUpperCase());
        expect(result).toEqual({ success: true, button: button.toUpperCase(), keyCode: -1 });
        expect(pressButtonCalls).toEqual([button]);
      } finally {
        getInstanceSpy.mockRestore();
      }
    },
  );

  test.each([
    ["action", "Feature not supported: action button requires hardware with an Action button"],
    ["camera", "Feature not supported: Button: camera"],
  ])(
    "ios %s on hardware without the button is a typed, non-retryable unsupported error",
    async (button, runnerError) => {
      const client = new FakeIOSCtrlProxy();
      client.setPressButtonResult({
        success: false,
        dispatched: true,
        acknowledged: true,
        totalTimeMs: 0,
        error: runnerError,
      });
      const getInstanceSpy = spyOnIosClientInstance(client);
      try {
        const result = await new PressButton(iosDevice).press(button);
        expect(result).toMatchObject({
          success: false,
          code: "unsupported_button",
          retryable: false,
        });
        expect(result.error).toContain(runnerError);
        expect(result.error).toContain("Xcode 16.3");
      } finally {
        getInstanceSpy.mockRestore();
      }
    },
  );

  test("iOS dispatched without acknowledgement is typed indeterminate", async () => {
    const client = new FakeIOSCtrlProxy();
    client.setPressButtonResult({
      success: false,
      dispatched: true,
      acknowledged: false,
      totalTimeMs: 0,
      error: "reply lost",
    });
    const getInstanceSpy = spyOnIosClientInstance(client);
    try {
      const result = await new PressButton(iosDevice).press("power");
      expect(result).toMatchObject({ code: "indeterminate_outcome", retryable: false });
    } finally {
      getInstanceSpy.mockRestore();
    }
  });

  test("iOS runner error is typed as terminal press failure", async () => {
    const client = new FakeIOSCtrlProxy();
    client.setPressButtonResult({
      success: false,
      dispatched: true,
      acknowledged: true,
      totalTimeMs: 0,
      error: "runner failed",
    });
    const getInstanceSpy = spyOnIosClientInstance(client);
    try {
      const result = await new PressButton(iosDevice).press("power");
      expect(result).toMatchObject({ code: "press_failed", retryable: false });
    } finally {
      getInstanceSpy.mockRestore();
    }
  });

  test("thrown iOS Home timeout preserves retryable typing", async () => {
    const client = new FakeIOSCtrlProxy();
    client.setFailureMode(
      "pressHome",
      new IosHomeLaunchTimeoutError("SpringBoard launch exhausted"),
    );
    const getInstanceSpy = spyOnIosClientInstance(client);
    try {
      const result = await new PressButton(iosDevice).press("home");
      expect(result).toMatchObject({ code: "timeout", retryable: true });
    } finally {
      getInstanceSpy.mockRestore();
    }
  });

  test("generic thrown iOS error is typed as terminal press failure", async () => {
    const client = new FakeIOSCtrlProxy();
    client.setFailureMode("pressButton", new Error("runner unavailable"));
    const getInstanceSpy = spyOnIosClientInstance(client);
    try {
      const result = await new PressButton(iosDevice).press("power");
      expect(result).toMatchObject({ code: "press_failed", retryable: false });
    } finally {
      getInstanceSpy.mockRestore();
    }
  });

  test("successful button result has no refusal fields", async () => {
    const client = new FakeIOSCtrlProxy();
    const getInstanceSpy = spyOnIosClientInstance(client);
    try {
      const result = await new PressButton(iosDevice).press("power");
      expect(result).not.toHaveProperty("code");
      expect(result).not.toHaveProperty("retryable");
    } finally {
      getInstanceSpy.mockRestore();
    }
  });

  test("thrown typed iOS error preserves non-timeout code and retryability", async () => {
    const client = new FakeIOSCtrlProxy();
    client.setFailureMode(
      "pressButton",
      Object.assign(new Error("device is offline"), { code: "device_offline", retryable: true }),
    );
    const getInstanceSpy = spyOnIosClientInstance(client);
    try {
      const result = await new PressButton(iosDevice).press("power");
      expect(result).toMatchObject({ code: "device_offline", retryable: true });
    } finally {
      getInstanceSpy.mockRestore();
    }
  });

  test("ios hardware buttons delegate to generic CtrlProxy pressButton on physical devices", async () => {
    const pressButtonCalls: string[] = [];
    const getInstanceSpy = spyOnIosClientInstance({
      requestPressBack: async () => ({ success: true, totalTimeMs: 5 }),
      requestPressHome: async () => ({ success: true, totalTimeMs: 5 }),
      requestRecentApps: async () => ({ success: true, totalTimeMs: 5 }),
      requestPressButton: async (button: string) => {
        pressButtonCalls.push(button);
        return { success: true, totalTimeMs: 5 };
      },
    });

    try {
      const pressButton = new PressButton(iosDevice);

      for (const button of ["volume_up", "volume_down", "power"]) {
        const result = await dispatch(pressButton, button);
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
    const getInstanceSpy = spyOnIosClientInstance({
      requestPressButton: async (button: string) => {
        pressButtonCalls.push(button);
        return { success: true, totalTimeMs: 5 };
      },
    });

    try {
      const pressButton = new PressButton(iosSimulator);

      for (const button of ["volume_up", "volume_down", "power"]) {
        const result = await dispatch(pressButton, button);
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
    const getInstanceSpy = spyOnIosClientInstance({
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
    });

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
    const getInstanceSpy = spyOnIosClientInstance({
      requestPressBack: async () => ({ success: true, totalTimeMs: 5 }),
      requestPressHome: async (timeoutMs?: number) => {
        homeTimeouts.push(timeoutMs);
        return { success: true, totalTimeMs: 5 };
      },
      requestRecentApps: async () => ({ success: true, totalTimeMs: 5 }),
    });

    try {
      const pressButton = new PressButton(iosDevice);
      await pressButton.press("home");

      expect(homeTimeouts).toEqual([undefined]);
    } finally {
      getInstanceSpy.mockRestore();
    }
  });

  test("ios hardware button runner failures return structured errors", async () => {
    const getInstanceSpy = spyOnIosClientInstance({
      requestPressButton: async () => ({
        success: false,
        error: "Power/lock button is not supported on this device",
        totalTimeMs: 5,
      }),
    });

    try {
      const pressButton = new PressButton(iosDevice);
      const result = await dispatch(pressButton, "power");

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

// Dispatch tests drive the transport seam through testHooks and still validate the result schema.
async function dispatch(
  pressButton: PressButton,
  ...args: Parameters<PressButton["press"]>
): ReturnType<PressButton["press"]> {
  const result = await pressButton.testHooks.executeiOSButtonPress(...args);
  expect(pressButtonResultSchema.parse({ message: "Result", ...result })).toBeDefined();
  return result;
}

describe("isIosHomePressOnSpringboard (#14954)", () => {
  const observation = (packageName: string, fallbackToSpringboard?: boolean): ObserveResult =>
    ({
      viewHierarchy: {
        packageName,
        ...(fallbackToSpringboard === undefined ? {} : { fallbackToSpringboard }),
        hierarchy: {},
      },
    }) as ObserveResult;

  test("is true for a Home press that starts on a real SpringBoard", () => {
    expect(isIosHomePressOnSpringboard("ios", "home", observation("com.apple.springboard"))).toBe(
      true,
    );
  });

  test.each([
    ["android", "home", observation("com.apple.springboard")],
    ["ios", "back", observation("com.apple.springboard")],
    ["ios", "home", observation("com.apple.Maps")],
    ["ios", "home", observation("com.apple.springboard", true)],
    ["ios", "home", undefined],
  ] as const)("is false for %s %s %#", (platform, button, previous) => {
    expect(isIosHomePressOnSpringboard(platform, button, previous)).toBe(false);
  });
});

describe("iOS Home press on the real home screen (#14954, runner reports fallbackToSpringboard)", () => {
  // Shape captured from the runner on SpringBoard: ios-c/item2-fallback-flag.txt.
  const capturedHomeScreen = (error?: unknown): ObserveResult =>
    ({
      viewHierarchy: {
        packageName: "com.apple.springboard",
        fallbackToSpringboard: true,
        hierarchy: error ? { error } : {},
      },
    }) as ObserveResult;
  const noChange = (observation: ObserveResult) => ({
    success: false,
    error: "No visual change observed",
    observation,
  });

  test("recognizes the captured fallback flag on SpringBoard", () => {
    expect(isIosSpringboardFallbackPress("ios", "home", capturedHomeScreen())).toBe(true);
    expect(isIosSpringboardFallbackPress("ios", "back", capturedHomeScreen())).toBe(false);
    expect(isIosSpringboardFallbackPress("ios", "home", capturedHomeScreen("boom"))).toBe(false);
  });

  test("no visual change on a healthy SpringBoard becomes success", () => {
    const result = noChange(capturedHomeScreen());
    acceptIosHomeAlreadyOnSpringboard(result, true);
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
  });

  test("still fails when the press did not start on SpringBoard or ended elsewhere", () => {
    const fresh = noChange(capturedHomeScreen());
    acceptIosHomeAlreadyOnSpringboard(fresh, false);
    expect(fresh.success).toBe(false);
    const elsewhere = noChange({
      viewHierarchy: { packageName: "com.apple.Maps", hierarchy: {} },
    } as ObserveResult);
    acceptIosHomeAlreadyOnSpringboard(elsewhere, true);
    expect(elsewhere.success).toBe(false);
  });
});

for (const platform of ["ios", "android"] as const) {
  test(`${platform} press invalidates iOS lock state only for iOS, including failures`, async () => {
    const invalidated: string[] = [];
    const device: BootedDevice = { platform, deviceId: "fake-device", name: "fake" };
    const press = new PressButton(
      device,
      new FakeAdbExecutor(),
      new FakeTimer(),
      undefined,
      undefined,
      {
        iosLockStateInvalidator: {
          invalidate: (id) => {
            invalidated.push(id);
          },
        },
      },
    );
    // Unsupported input completes without touching a transport on either platform.
    await press.press("unsupported");
    expect(invalidated).toEqual(platform === "ios" ? [device.deviceId] : []);
  });
}
