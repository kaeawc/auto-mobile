import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { InputText } from "../../../src/features/action/InputText";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeAwaitIdle } from "../../fakes/FakeAwaitIdle";
import { FakeTimer } from "../../fakes/FakeTimer";
import type { InputTextMode } from "../../../src/features/action/InputText";
import type {
  ObserveScreen,
  ObserveScreenExecuteOptions,
} from "../../../src/features/observe/interfaces/ObserveScreen";
import type { BootedDevice, ExecResult, ObserveResult } from "../../../src/models";
import type { AdbClientFactory } from "../../../src/utils/android-cmdline-tools/AdbClientFactory";
import {
  AdbClient,
  AdbCommandTimeoutError,
} from "../../../src/utils/android-cmdline-tools/AdbClient";
import { DeviceLostError } from "../../../src/server/deviceLossOutcome";

interface TestInputText {
  executeAndroidTextInput: (
    text: string,
    imeAction?: undefined,
    dismissKeyboard?: boolean,
    mode?: InputTextMode,
    previousObserveResult?: ObserveResult,
    signal?: AbortSignal,
  ) => Promise<{ success: boolean; error?: string; method?: string }>;
}

type RequestSetText = (
  text: string,
  options?: {
    resourceId?: string;
    timeoutMs?: number;
    perf?: unknown;
    dismissKeyboard?: boolean;
  }
) => Promise<{ success: boolean; error?: string; totalTimeMs: number }>;

function testInputText(inputText: InputText): TestInputText {
  return inputText as unknown as TestInputText;
}

function stubAndroidSetText(requestSetText: RequestSetText): void {
  AndroidCtrlProxyClient.getInstance = (() => ({
    requestSetText
  })) as typeof AndroidCtrlProxyClient.getInstance;
}

function execResult(stdout: string): ExecResult {
  return {
    stdout,
    stderr: "",
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (search: string) => stdout.includes(search),
  };
}

function inputCommands(factory: FakeAdbClientFactory): string[] {
  return factory.getFakeClient().getAllCommands()
    .filter(command => command.startsWith("shell input "));
}

function observeResultWithFocusedText(
  text: string,
  properties: Record<string, unknown> = {}
): ObserveResult {
  return {
    viewHierarchy: {
      hierarchy: {
        node: {
          focused: true,
          class: "android.widget.EditText",
          text,
          ...properties
        }
      }
    }
  } as ObserveResult;
}

describe("InputText", () => {
  const androidDevice: BootedDevice = {
    deviceId: "input-text-device",
    platform: "android",
    name: "Test Device",
  };

  let originalGetInstance: typeof AndroidCtrlProxyClient.getInstance;

  beforeEach(() => {
    originalGetInstance = AndroidCtrlProxyClient.getInstance;
    AndroidCtrlProxyClient.resetInstances();
  });

  afterEach(() => {
    AndroidCtrlProxyClient.getInstance = originalGetInstance;
    AndroidCtrlProxyClient.resetInstances();
  });

  // Regression for https://github.com/kaeawc/auto-mobile/issues/2229.
  // executeAndroidTextInput calls AndroidCtrlProxyClient.getInstance, which
  // invokes `.create(device)` on its second argument. Passing the AdbExecutor
  // (this.adb) instead of the AdbClientFactory (this.adbFactory) surfaces in
  // production as `TypeError: <minified>.create is not a function` on the
  // first ctrl-proxy call per device. Asserts the factory is forwarded.
  test("forwards adbFactory (not adb executor) to AndroidCtrlProxyClient.getInstance (regression for #2229)", async () => {
    const factory = new FakeAdbClientFactory();
    const inputText = new InputText(androidDevice, factory as AdbClientFactory);

    let capturedFactory: unknown = undefined;
    AndroidCtrlProxyClient.getInstance = ((device: BootedDevice, adbFactory: AdbClientFactory) => {
      capturedFactory = adbFactory;
      return originalGetInstance(device, adbFactory);
    }) as typeof AndroidCtrlProxyClient.getInstance;

    try {
      await (inputText as unknown as {
        executeAndroidTextInput: (text: string) => Promise<unknown>;
      }).executeAndroidTextInput("hello");
    } catch {
      // Ignore downstream failures — we only care that getInstance was
      // handed a factory, not an executor.
    }

    expect(capturedFactory).toBeDefined();
    expect(typeof (capturedFactory as AdbClientFactory).create).toBe("function");
    expect(capturedFactory).toBe(factory as unknown as AdbClientFactory);
  });

  test("does not turn device-loss cancellation into a success:false input result", async () => {
    const controller = new AbortController();
    const deviceLoss = new DeviceLostError(
      androidDevice.deviceId,
      `device-disconnected:${androidDevice.deviceId}`,
    );
    stubAndroidSetText(async () => {
      controller.abort(deviceLoss);
      return { success: false, error: "disconnected", totalTimeMs: 1 };
    });
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const inputText = new InputText(androidDevice, new FakeAdbClientFactory(), undefined, timer);
    const observe = new FakeObserveScreen();
    observe.setObserveResult(observeResultWithFocusedText(""));
    (inputText as any).observeScreen = observe;
    (inputText as any).awaitIdle = new FakeAwaitIdle();

    await expect(
      inputText.execute("hello", undefined, false, undefined, controller.signal),
    ).rejects.toBe(deviceLoss);
  });

  test("forwards cancellation through post-input observation", async () => {
    const controller = new AbortController();
    stubAndroidSetText(async () => ({ success: true, totalTimeMs: 1 }));
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const inputText = new InputText(androidDevice, new FakeAdbClientFactory(), undefined, timer);
    const observe = new FakeObserveScreen();
    observe.setObserveResult(observeResultWithFocusedText(""));
    observe.enableAutoVaryHierarchy();
    (inputText as any).observeScreen = observe;
    (inputText as any).awaitIdle = new FakeAwaitIdle();

    await inputText.execute("hello", undefined, false, undefined, controller.signal);

    expect(observe.getExecuteOptions()).not.toHaveLength(0);
    expect(observe.getExecuteOptions().every(options => options.signal === controller.signal))
      .toBe(true);
  });

  test("eventLast sets prefix with a11y and sends final ASCII key event", async () => {
    const factory = new FakeAdbClientFactory();
    const inputText = new InputText(androidDevice, factory as AdbClientFactory);
    const setTextCalls: Array<{ text: string; dismissKeyboard?: boolean }> = [];

    stubAndroidSetText(async (text, options) => {
      setTextCalls.push({ text, dismissKeyboard: options?.dismissKeyboard });
      return { success: true, totalTimeMs: 1 };
    });

    const result = await testInputText(inputText).executeAndroidTextInput("@Jason Pearson", undefined, false, "eventLast");

    expect(result.success).toBe(true);
    expect(result.method).toBe("eventLast");
    expect(setTextCalls).toEqual([{ text: "@Jason Pearso", dismissKeyboard: undefined }]);
    expect(inputCommands(factory)).toEqual(["shell input keyevent KEYCODE_N"]);
  });

  test("eventLast restores suffix with final a11y setText", async () => {
    const factory = new FakeAdbClientFactory();
    const inputText = new InputText(androidDevice, factory as AdbClientFactory);
    const setTextCalls: Array<{ text: string; dismissKeyboard?: boolean }> = [];

    stubAndroidSetText(async (text, options) => {
      setTextCalls.push({ text, dismissKeyboard: options?.dismissKeyboard });
      return { success: true, totalTimeMs: 1 };
    });

    const result = await testInputText(inputText).executeAndroidTextInput("abc def  ", undefined, false, "eventLast");

    expect(result.success).toBe(true);
    expect(setTextCalls).toEqual([
      { text: "abc de", dismissKeyboard: undefined },
      { text: "abc def  ", dismissKeyboard: false },
    ]);
    expect(inputCommands(factory)).toEqual(["shell input keyevent KEYCODE_F"]);
  });

  test("eventLast uses shifted key combination for uppercase ASCII on Android 12+", async () => {
    const factory = new FakeAdbClientFactory();
    const inputText = new InputText(androidDevice, factory as AdbClientFactory);
    factory.getFakeClient().setCommandResult("shell getprop ro.build.version.sdk", "31\n");

    stubAndroidSetText(async () => ({ success: true, totalTimeMs: 1 }));

    const result = await testInputText(inputText).executeAndroidTextInput("HellO", undefined, false, "eventLast");

    expect(result.success).toBe(true);
    expect(inputCommands(factory)).toEqual([
      "shell input keycombination KEYCODE_SHIFT_LEFT KEYCODE_O"
    ]);
  });

  test("eventLast falls back to a11y for shifted ASCII before Android 12", async () => {
    const factory = new FakeAdbClientFactory();
    const inputText = new InputText(androidDevice, factory as AdbClientFactory);
    const setTextCalls: Array<{ text: string; dismissKeyboard?: boolean }> = [];
    factory.getFakeClient().setCommandResult("shell getprop ro.build.version.sdk", "30\n");

    stubAndroidSetText(async (text, options) => {
      setTextCalls.push({ text, dismissKeyboard: options?.dismissKeyboard });
      return { success: true, totalTimeMs: 1 };
    });

    const result = await testInputText(inputText).executeAndroidTextInput("HellO", undefined, false, "eventLast");

    expect(result.success).toBe(true);
    expect(result.method).toBe("a11y");
    expect(setTextCalls).toEqual([
      { text: "HellO", dismissKeyboard: false },
    ]);
    expect(inputCommands(factory)).toEqual([]);
  });

  test("eventLast falls back to a11y when no printable non-whitespace ASCII exists", async () => {
    const factory = new FakeAdbClientFactory();
    const inputText = new InputText(androidDevice, factory as AdbClientFactory);
    const setTextCalls: string[] = [];

    stubAndroidSetText(async text => {
      setTextCalls.push(text);
      return { success: true, totalTimeMs: 1 };
    });

    const result = await testInputText(inputText).executeAndroidTextInput("  你好  ", undefined, false, "eventLast");

    expect(result.success).toBe(true);
    expect(result.method).toBe("a11y");
    expect(setTextCalls).toEqual(["  你好  "]);
    expect(inputCommands(factory)).toEqual([]);
  });

  test("eventAll sends mappable ASCII text as key events", async () => {
    const factory = new FakeAdbClientFactory();
    const inputText = new InputText(androidDevice, factory as AdbClientFactory);
    const setTextCalls: string[] = [];
    factory.getFakeClient().setCommandResult("shell getprop ro.build.version.sdk", "31\n");

    stubAndroidSetText(async text => {
      setTextCalls.push(text);
      return { success: true, totalTimeMs: 1 };
    });

    const result = await testInputText(inputText).executeAndroidTextInput("@ab C", undefined, false, "eventAll");

    expect(result.success).toBe(true);
    expect(result.method).toBe("eventAll");
    expect(setTextCalls).toEqual([""]);
    expect(inputCommands(factory)).toEqual([
      "shell input keyevent KEYCODE_AT",
      "shell input keyevent KEYCODE_A",
      "shell input keyevent KEYCODE_B",
      "shell input keyevent KEYCODE_SPACE",
      "shell input keycombination KEYCODE_SHIFT_LEFT KEYCODE_C"
    ]);
  });

  test("eventAll stops sending key events after device-loss cancellation", async () => {
    const controller = new AbortController();
    const deviceLoss = new DeviceLostError(
      androidDevice.deviceId,
      `device-disconnected:${androidDevice.deviceId}`,
    );
    const factory = new FakeAdbClientFactory();
    const fakeClient = factory.getFakeClient();
    const inputText = new InputText(androidDevice, factory as AdbClientFactory);
    factory.getFakeClient().setCommandResult("shell getprop ro.build.version.sdk", "31\n");
    stubAndroidSetText(async () => ({ success: true, totalTimeMs: 1 }));
    const originalExecuteCommand = fakeClient.executeCommand.bind(fakeClient);
    const executeSpy = spyOn(fakeClient, "executeCommand").mockImplementation(
      async (command, timeoutMs, maxBuffer, noRetry, signal) => {
        const result = await originalExecuteCommand(command, timeoutMs, maxBuffer, noRetry, signal);
        if (command === "shell input keyevent KEYCODE_A") {
          controller.abort(deviceLoss);
        }
        return result;
      },
    );

    try {
      await expect(
        testInputText(inputText).executeAndroidTextInput(
          "abc",
          undefined,
          false,
          "eventAll",
          undefined,
          controller.signal,
        ),
      ).rejects.toBe(deviceLoss);
      expect(inputCommands(factory)).toEqual([
        "shell input keyevent KEYCODE_A",
      ]);
    } finally {
      executeSpy.mockRestore();
    }
  });

  test("eventAll alternates a11y for Unicode runs and key events for ASCII", async () => {
    const factory = new FakeAdbClientFactory();
    const inputText = new InputText(androidDevice, factory as AdbClientFactory);
    const setTextCalls: string[] = [];

    stubAndroidSetText(async text => {
      setTextCalls.push(text);
      return { success: true, totalTimeMs: 1 };
    });

    const result = await testInputText(inputText).executeAndroidTextInput("ab你好c😊d", undefined, false, "eventAll");

    expect(result.success).toBe(true);
    expect(result.method).toBe("eventAll");
    expect(setTextCalls).toEqual(["", "ab你好", "ab你好c😊"]);
    expect(inputCommands(factory)).toEqual([
      "shell input keyevent KEYCODE_A",
      "shell input keyevent KEYCODE_B",
      "shell input keyevent KEYCODE_C",
      "shell input keyevent KEYCODE_D"
    ]);
  });

  test("eventAll fails before key events when initial a11y clear fails", async () => {
    const factory = new FakeAdbClientFactory();
    const inputText = new InputText(androidDevice, factory as AdbClientFactory);

    stubAndroidSetText(async () => ({ success: false, error: "focused field missing", totalTimeMs: 1 }));

    const result = await testInputText(inputText).executeAndroidTextInput("abc", undefined, false, "eventAll");

    expect(result.success).toBe(false);
    expect(result.method).toBe("eventAll");
    expect(result.error).toContain("focused field missing");
    expect(inputCommands(factory)).toEqual([]);
  });

  test("eventAll uses a11y instead of shifted keyevents before Android 12", async () => {
    const factory = new FakeAdbClientFactory();
    const inputText = new InputText(androidDevice, factory as AdbClientFactory);
    const setTextCalls: string[] = [];
    factory.getFakeClient().setCommandResult("shell getprop ro.build.version.sdk", "30\n");

    stubAndroidSetText(async text => {
      setTextCalls.push(text);
      return { success: true, totalTimeMs: 1 };
    });

    const result = await testInputText(inputText).executeAndroidTextInput("a+B", undefined, false, "eventAll");

    expect(result.success).toBe(true);
    expect(result.method).toBe("eventAll");
    expect(setTextCalls).toEqual(["", "a+B"]);
    expect(inputCommands(factory)).toEqual([
      "shell input keyevent KEYCODE_A"
    ]);
  });

  test("eventAll falls back to a11y for shifted-only text before Android 12", async () => {
    const factory = new FakeAdbClientFactory();
    const inputText = new InputText(androidDevice, factory as AdbClientFactory);
    const setTextCalls: string[] = [];
    factory.getFakeClient().setCommandResult("shell getprop ro.build.version.sdk", "30\n");

    stubAndroidSetText(async text => {
      setTextCalls.push(text);
      return { success: true, totalTimeMs: 1 };
    });

    const result = await testInputText(inputText).executeAndroidTextInput("B+", undefined, false, "eventAll");

    expect(result.success).toBe(true);
    expect(result.method).toBe("a11y");
    expect(setTextCalls).toEqual(["B+"]);
    expect(inputCommands(factory)).toEqual([]);
  });

  test("eventAll falls back to a11y when there are no key-event-mappable characters", async () => {
    const factory = new FakeAdbClientFactory();
    const inputText = new InputText(androidDevice, factory as AdbClientFactory);
    const setTextCalls: string[] = [];

    stubAndroidSetText(async text => {
      setTextCalls.push(text);
      return { success: true, totalTimeMs: 1 };
    });

    const result = await testInputText(inputText).executeAndroidTextInput("你好😊", undefined, false, "eventAll");

    expect(result.success).toBe(true);
    expect(result.method).toBe("a11y");
    expect(setTextCalls).toEqual(["你好😊"]);
    expect(inputCommands(factory)).toEqual([]);
  });

  test("eventOnly clears and types mappable text without requestSetText", async () => {
    const factory = new FakeAdbClientFactory();
    const inputText = new InputText(androidDevice, factory as AdbClientFactory);
    const setTextCalls: string[] = [];
    factory.getFakeClient().setCommandResult("shell getprop ro.build.version.sdk", "31\n");

    stubAndroidSetText(async text => {
      setTextCalls.push(text);
      return { success: true, totalTimeMs: 1 };
    });

    const result = await testInputText(inputText).executeAndroidTextInput(
      "@ab C",
      undefined,
      false,
      "eventOnly",
      observeResultWithFocusedText("old")
    );

    expect(result).toEqual({
      success: true,
      text: "@ab C",
      imeAction: undefined,
      method: "eventOnly"
    });
    expect(setTextCalls).toEqual([]);
    expect(inputCommands(factory)).toEqual([
      "shell input keyevent KEYCODE_MOVE_END",
      "shell input keyevent KEYCODE_DEL",
      "shell input keyevent KEYCODE_DEL",
      "shell input keyevent KEYCODE_DEL",
      "shell input keyevent KEYCODE_AT",
      "shell input keyevent KEYCODE_A",
      "shell input keyevent KEYCODE_B",
      "shell input keyevent KEYCODE_SPACE",
      "shell input keycombination KEYCODE_SHIFT_LEFT KEYCODE_C"
    ]);
  });

  test("eventOnly rejects unsupported text without requestSetText or key events", async () => {
    const factory = new FakeAdbClientFactory();
    const inputText = new InputText(androidDevice, factory as AdbClientFactory);
    const setTextCalls: string[] = [];

    stubAndroidSetText(async text => {
      setTextCalls.push(text);
      return { success: true, totalTimeMs: 1 };
    });

    const result = await testInputText(inputText).executeAndroidTextInput(
      "hello 你好",
      undefined,
      false,
      "eventOnly",
      observeResultWithFocusedText("existing")
    );

    expect(result.success).toBe(false);
    expect(result.method).toBe("eventOnly");
    expect(result.error).toContain("cannot type");
    expect(setTextCalls).toEqual([]);
    expect(inputCommands(factory)).toEqual([]);
  });

  test("eventOnly rejects shifted ASCII before Android 12 without requestSetText or key events", async () => {
    const factory = new FakeAdbClientFactory();
    const inputText = new InputText(androidDevice, factory as AdbClientFactory);
    const setTextCalls: string[] = [];
    factory.getFakeClient().setCommandResult("shell getprop ro.build.version.sdk", "30\n");

    stubAndroidSetText(async text => {
      setTextCalls.push(text);
      return { success: true, totalTimeMs: 1 };
    });

    const result = await testInputText(inputText).executeAndroidTextInput(
      "A",
      undefined,
      false,
      "eventOnly",
      observeResultWithFocusedText("existing")
    );

    expect(result.success).toBe(false);
    expect(result.method).toBe("eventOnly");
    expect(result.error).toContain("cannot type");
    expect(setTextCalls).toEqual([]);
    expect(inputCommands(factory)).toEqual([]);
  });

  test.each([
    ["no focused node", { focused: false }],
    ["a focused non-input node", { class: "android.widget.TextView" }]
  ])("eventOnly rejects %s before sending input events", async (_description, properties) => {
    const factory = new FakeAdbClientFactory();
    const inputText = new InputText(androidDevice, factory as AdbClientFactory);
    const observeResult = observeResultWithFocusedText("existing", properties);
    const observeScreen = new FakeObserveScreen();
    observeScreen.setObserveResult(observeResult);
    inputText.observeScreen = observeScreen;

    const result = await testInputText(inputText).executeAndroidTextInput(
      "next",
      undefined,
      false,
      "eventOnly",
      observeResult
    );

    expect(result.success).toBe(false);
    expect(result.method).toBe("eventOnly");
    expect(result.error).toBe("eventOnly requires a focused editable field");
    expect(observeScreen.getExecuteCallCount()).toBe(1);
    expect(inputCommands(factory)).toEqual([]);
  });

  test("eventOnly refreshes a stale cached hierarchy before rejecting the focused-field precondition", async () => {
    const factory = new FakeAdbClientFactory();
    const inputText = new InputText(androidDevice, factory as AdbClientFactory);
    const observeScreen = new FakeObserveScreen();
    observeScreen.setObserveSequence([
      {
        viewHierarchy: {
          hierarchy: {
            node: {
              class: "android.view.inputmethod.SoftInputWindow"
            }
          }
        }
      } as ObserveResult,
      observeResultWithFocusedText("old")
    ]);
    inputText.observeScreen = observeScreen;

    const result = await inputText.execute("next", undefined, false, "eventOnly");

    expect(result.success).toBe(true);
    expect(result.method).toBe("eventOnly");
    expect(observeScreen.getGetMostRecentCachedObserveResultCallCount()).toBe(1);
    expect(observeScreen.getExecuteCallCount()).toBe(2);
    expect(observeScreen.getExecuteOptions()[0]?.skipWaitForFresh).toBe(false);
    expect(inputCommands(factory)).toEqual([
      "shell input keyevent KEYCODE_MOVE_END",
      "shell input keyevent KEYCODE_DEL",
      "shell input keyevent KEYCODE_DEL",
      "shell input keyevent KEYCODE_DEL",
      "shell input keyevent KEYCODE_N",
      "shell input keyevent KEYCODE_E",
      "shell input keyevent KEYCODE_X",
      "shell input keyevent KEYCODE_T"
    ]);
  });

  test("eventOnly rejects after a refreshed hierarchy still lacks a focused editable field", async () => {
    const inputText = new InputText(androidDevice, new FakeAdbExecutor());
    const observeScreen = new FakeObserveScreen();
    const unfocused = {
      viewHierarchy: {
        updatedAt: 42,
        hierarchy: {
          node: {
            class: "android.view.inputmethod.SoftInputWindow"
          }
        }
      }
    } as ObserveResult;
    observeScreen.setObserveSequence([unfocused, unfocused]);
    inputText.observeScreen = observeScreen;

    const result = await testInputText(inputText).executeAndroidTextInput(
      "next",
      undefined,
      false,
      "eventOnly",
      unfocused
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("eventOnly requires a focused editable field");
    expect(observeScreen.getExecuteCallCount()).toBe(1);
    expect(observeScreen.getExecuteOptions()[0]?.skipWaitForFresh).toBe(false);
    expect(observeScreen.getExecuteOptions()[0]?.minTimestamp).toBe(43);
  });

  test("eventOnly rejects a stale focused refresh from the same second without sending key events", async () => {
    const factory = new FakeAdbClientFactory();
    const inputText = new InputText(androidDevice, factory as AdbClientFactory);
    const observeScreen = new FakeObserveScreen();
    const staleCachedHierarchy = {
      viewHierarchy: {
        updatedAt: 1_700_000_000_500,
        hierarchy: {
          node: {
            class: "android.view.inputmethod.SoftInputWindow"
          }
        }
      }
    } as ObserveResult;
    observeScreen.setObserveSequence([
      {
        ...observeResultWithFocusedText("old"),
        freshness: {
          requestedAfter: 1_700_000_000_501,
          actualTimestamp: 1_700_000_000_500,
          isFresh: false,
          staleDurationMs: 1
        }
      }
    ]);
    inputText.observeScreen = observeScreen;

    const result = await testInputText(inputText).executeAndroidTextInput(
      "next",
      undefined,
      false,
      "eventOnly",
      staleCachedHierarchy
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("eventOnly requires a focused editable field");
    expect(observeScreen.getExecuteOptions()[0]?.minTimestamp).toBe(1_700_000_000_501);
    expect(inputCommands(factory)).toEqual([]);
  });

  test("eventOnly accepts a newer fresh focused refresh", async () => {
    const factory = new FakeAdbClientFactory();
    const inputText = new InputText(androidDevice, factory as AdbClientFactory);
    const observeScreen = new FakeObserveScreen();
    const staleCachedHierarchy = {
      viewHierarchy: {
        updatedAt: 1_700_000_000_500,
        hierarchy: {
          node: {
            class: "android.view.inputmethod.SoftInputWindow"
          }
        }
      }
    } as ObserveResult;
    observeScreen.setObserveSequence([
      {
        ...observeResultWithFocusedText("old"),
        freshness: {
          requestedAfter: 1_700_000_000_501,
          actualTimestamp: 1_700_000_000_501,
          isFresh: true
        }
      }
    ]);
    inputText.observeScreen = observeScreen;

    const result = await testInputText(inputText).executeAndroidTextInput(
      "next",
      undefined,
      false,
      "eventOnly",
      staleCachedHierarchy
    );

    expect(result.success).toBe(true);
    expect(observeScreen.getExecuteOptions()[0]?.minTimestamp).toBe(1_700_000_000_501);
    expect(inputCommands(factory)).toEqual([
      "shell input keyevent KEYCODE_MOVE_END",
      "shell input keyevent KEYCODE_DEL",
      "shell input keyevent KEYCODE_DEL",
      "shell input keyevent KEYCODE_DEL",
      "shell input keyevent KEYCODE_N",
      "shell input keyevent KEYCODE_E",
      "shell input keyevent KEYCODE_X",
      "shell input keyevent KEYCODE_T"
    ]);
  });

  // Regression for https://github.com/kaeawc/auto-mobile/issues/4617.
  // When the failed cached hierarchy carries no `updatedAt`, the refresh lower
  // bound must be derived from the DEVICE clock (getDeviceTimestampMs), not the
  // host FakeTimer/wall clock. Android interprets `minTimestamp` in the
  // device-authored hierarchy clock domain, so a device clock running AHEAD of
  // the host would let an older cached focused hierarchy satisfy a host-clock
  // lower bound and be wrongly accepted as fresh — dispatching key events.
  test("eventOnly derives the no-updatedAt refresh lower bound from the device clock, not the host", async () => {
    const factory = new FakeAdbClientFactory();
    factory.getFakeClient().setCommandResult("shell getprop ro.build.version.sdk", "31\n");
    // Device clock is far ahead of the host FakeTimer (which starts at 0).
    const deviceNowMs = 1_700_000_000_000;
    factory.getFakeClient().setDeviceTimestampMs(deviceNowMs);
    const hostTimer = new FakeTimer(); // now() === 0, strictly behind the device clock
    const inputText = new InputText(androidDevice, factory as AdbClientFactory, undefined, hostTimer);

    // A cached focused hierarchy captured EARLIER in device time than "now" —
    // stale — but still newer than the host clock (0). Under the old host-clock
    // fallback its timestamp satisfies minTimestamp and it is wrongly accepted.
    const cachedFocusedDeviceTs = 1_699_999_999_000;
    const observeExecuteOptions: ObserveScreenExecuteOptions[] = [];
    const focused = observeResultWithFocusedText("old");
    const observe = {
      execute: async (options?: ObserveScreenExecuteOptions): Promise<ObserveResult> => {
        observeExecuteOptions.push({ ...(options ?? {}) });
        const lowerBound = options?.minTimestamp ?? 0;
        return {
          ...focused,
          viewHierarchy: { ...focused.viewHierarchy, updatedAt: cachedFocusedDeviceTs },
          freshness: {
            requestedAfter: lowerBound,
            actualTimestamp: cachedFocusedDeviceTs,
            isFresh: cachedFocusedDeviceTs >= lowerBound,
            staleDurationMs: Math.max(0, lowerBound - cachedFocusedDeviceTs),
          },
        } as ObserveResult;
      },
    };
    inputText.observeScreen = observe as unknown as ObserveScreen;

    // The cached hierarchy that FAILED the focused-editable check: no focus, no updatedAt.
    const cachedUnfocused = {
      viewHierarchy: {
        hierarchy: { node: { class: "android.view.inputmethod.SoftInputWindow" } },
      },
    } as ObserveResult;

    const result = await testInputText(inputText).executeAndroidTextInput(
      "next",
      undefined,
      false,
      "eventOnly",
      cachedUnfocused
    );

    // Device-domain lower bound rejects the stale cached focused hierarchy: no
    // key events are dispatched. The host-clock fallback (minTimestamp 0) would
    // have accepted it and typed.
    expect(result.success).toBe(false);
    expect(result.error).toBe("eventOnly requires a focused editable field");
    expect(observeExecuteOptions[0]?.minTimestamp).toBe(deviceNowMs);
    expect(inputCommands(factory)).toEqual([]);
  });

  test("eventOnly advances a second-granularity lower bound past the current second", async () => {
    const fakeAdb = new FakeAdbClient();
    fakeAdb.setDeviceTimestampMs(1_700_000_000_000);
    fakeAdb.setDeviceTimestampSource("device-seconds");
    const factory = new FakeAdbClientFactory(fakeAdb);
    const inputText = new InputText(androidDevice, factory as AdbClientFactory);
    const observeExecuteOptions: ObserveScreenExecuteOptions[] = [];
    inputText.observeScreen = {
      execute: async (options?: ObserveScreenExecuteOptions): Promise<ObserveResult> => {
        observeExecuteOptions.push({ ...(options ?? {}) });
        const lowerBound = options?.minTimestamp ?? 0;
        const actualTimestamp = 1_700_000_000_500;
        return {
          viewHierarchy: observeResultWithFocusedText("old").viewHierarchy,
          freshness: {
            requestedAfter: lowerBound,
            actualTimestamp,
            isFresh: actualTimestamp >= lowerBound,
            staleDurationMs: Math.max(0, lowerBound - actualTimestamp),
          },
        } as ObserveResult;
      },
    } as unknown as ObserveScreen;

    const result = await testInputText(inputText).executeAndroidTextInput(
      "next",
      undefined,
      false,
      "eventOnly",
      { viewHierarchy: { hierarchy: { node: { class: "android.view.View" } } } } as ObserveResult
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("eventOnly requires a focused editable field");
    expect(observeExecuteOptions[0]?.minTimestamp).toBe(1_700_000_001_000);
    expect(inputCommands(factory)).toEqual([]);
  });

  test("eventOnly fails closed when the device timestamp falls back to the host clock", async () => {
    const fakeAdb = new FakeAdbClient();
    fakeAdb.setDeviceTimestampMs(0);
    fakeAdb.setDeviceTimestampSource("host");
    const factory = new FakeAdbClientFactory(fakeAdb);
    const inputText = new InputText(androidDevice, factory as AdbClientFactory);
    const observeExecuteOptions: ObserveScreenExecuteOptions[] = [];
    inputText.observeScreen = {
      execute: async (options?: ObserveScreenExecuteOptions): Promise<ObserveResult> => {
        observeExecuteOptions.push({ ...(options ?? {}) });
        return {
          viewHierarchy: observeResultWithFocusedText("old").viewHierarchy,
          freshness: {
            requestedAfter: options?.minTimestamp ?? 0,
            actualTimestamp: 1,
            isFresh: true,
          },
        } as ObserveResult;
      },
    } as unknown as ObserveScreen;

    const result = await testInputText(inputText).executeAndroidTextInput(
      "next",
      undefined,
      false,
      "eventOnly",
      { viewHierarchy: { hierarchy: { node: { class: "android.view.View" } } } } as ObserveResult
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("eventOnly requires a focused editable field");
    expect(observeExecuteOptions).toEqual([]);
    expect(inputCommands(factory)).toEqual([]);
  });

  test("eventOnly delegates keyboard dismissal to the keyboard closer", async () => {
    const factory = new FakeAdbClientFactory();
    const closeCalls: string[] = [];
    factory.getFakeClient().setCommandResult("shell getprop ro.build.version.sdk", "31\n");
    const inputText = new InputText(
      androidDevice,
      factory as AdbClientFactory,
      () => ({
        close: async () => {
          closeCalls.push("close");
          return { success: true, open: false, message: "Keyboard already closed" };
        }
      })
    );

    const result = await testInputText(inputText).executeAndroidTextInput(
      "next",
      undefined,
      true,
      "eventOnly",
      observeResultWithFocusedText("old")
    );

    expect(result.success).toBe(true);
    expect(closeCalls).toEqual(["close"]);
    expect(inputCommands(factory)).toEqual([
      "shell input keyevent KEYCODE_MOVE_END",
      "shell input keyevent KEYCODE_DEL",
      "shell input keyevent KEYCODE_DEL",
      "shell input keyevent KEYCODE_DEL",
      "shell input keyevent KEYCODE_N",
      "shell input keyevent KEYCODE_E",
      "shell input keyevent KEYCODE_X",
      "shell input keyevent KEYCODE_T"
    ]);
  });

  test("eventOnly reports a keyboard dismissal failure without sending raw Back", async () => {
    const factory = new FakeAdbClientFactory();
    factory.getFakeClient().setCommandResult("shell getprop ro.build.version.sdk", "31\n");
    const inputText = new InputText(
      androidDevice,
      factory as AdbClientFactory,
      () => ({
        close: async () => ({
          success: false,
          open: true,
          error: "Keyboard state unavailable"
        })
      })
    );

    const result = await testInputText(inputText).executeAndroidTextInput(
      "next",
      undefined,
      true,
      "eventOnly",
      observeResultWithFocusedText("old")
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("Keyboard state unavailable");
    expect(inputCommands(factory)).toEqual([
      "shell input keyevent KEYCODE_MOVE_END",
      "shell input keyevent KEYCODE_DEL",
      "shell input keyevent KEYCODE_DEL",
      "shell input keyevent KEYCODE_DEL",
      "shell input keyevent KEYCODE_N",
      "shell input keyevent KEYCODE_E",
      "shell input keyevent KEYCODE_X",
      "shell input keyevent KEYCODE_T"
    ]);
  });

  test("a11y reports setText timeouts without sending key events", async () => {
    const factory = new FakeAdbClientFactory();
    const inputText = new InputText(androidDevice, factory as AdbClientFactory);
    const setTextCalls: string[] = [];

    stubAndroidSetText(async text => {
      setTextCalls.push(text);
      return { success: false, error: "Set text timed out after 5000ms", totalTimeMs: 5000 };
    });

    const result = await testInputText(inputText).executeAndroidTextInput(
      "next",
      undefined,
      false,
      "a11y",
      observeResultWithFocusedText("old")
    );

    expect(result.success).toBe(false);
    expect(result.method).toBe("a11y");
    expect(result.error).toContain("Set text timed out after 5000ms");
    expect(setTextCalls).toEqual(["next"]);
    expect(inputCommands(factory)).toEqual([]);
  });

  test("a11y does not fall back to eventOnly for non-timeout failures", async () => {
    const factory = new FakeAdbClientFactory();
    const inputText = new InputText(androidDevice, factory as AdbClientFactory);
    const setTextCalls: string[] = [];

    stubAndroidSetText(async text => {
      setTextCalls.push(text);
      return { success: false, error: "No focused editable node found", totalTimeMs: 1 };
    });

    const result = await testInputText(inputText).executeAndroidTextInput(
      "next",
      undefined,
      false,
      "a11y",
      observeResultWithFocusedText("old")
    );

    expect(result.success).toBe(false);
    expect(result.method).toBe("a11y");
    expect(result.error).toContain("No focused editable node found");
    expect(setTextCalls).toEqual(["next"]);
    expect(inputCommands(factory)).toEqual([]);
  });

  // Issue #3351: an interactive client mirroring a keyboard sends one call per
  // keystroke. Every other Android mode is replace-shaped (a11y sets the whole
  // string; eventAll/eventOnly clear first), so per-keystroke typing through
  // them leaves only the last character and wipes whatever was in the field.
  test("append types with key events and never clears or sets text", async () => {
    const factory = new FakeAdbClientFactory();
    const inputText = new InputText(androidDevice, factory as AdbClientFactory);
    const setTextCalls: string[] = [];
    factory.getFakeClient().setCommandResult("shell getprop ro.build.version.sdk", "31\n");

    stubAndroidSetText(async text => {
      setTextCalls.push(text);
      return { success: true, totalTimeMs: 1 };
    });

    const result = await testInputText(inputText).executeAndroidTextInput(
      "ab",
      undefined,
      false,
      "append"
    );

    expect(result.success).toBe(true);
    expect(result.method).toBe("append");
    // The whole point: no ACTION_SET_TEXT at all, so the field's existing
    // contents survive.
    expect(setTextCalls).toEqual([]);
    // And no clear either - unlike eventOnly, which deletes the field first.
    const commands = inputCommands(factory);
    expect(commands.length).toBeGreaterThan(0);
    expect(commands.some(command => command.includes("KEYCODE_DEL"))).toBe(false);
  });

  test("append sends one keystroke per call without disturbing earlier ones", async () => {
    // Three separate single-character calls, as a keyboard-mirroring client
    // makes them. None may clear, or "abc" would end up as "c".
    const factory = new FakeAdbClientFactory();
    const inputText = new InputText(androidDevice, factory as AdbClientFactory);
    const setTextCalls: string[] = [];
    factory.getFakeClient().setCommandResult("shell getprop ro.build.version.sdk", "31\n");

    stubAndroidSetText(async text => {
      setTextCalls.push(text);
      return { success: true, totalTimeMs: 1 };
    });

    for (const char of ["a", "b", "c"]) {
      const result = await inputText.appendText(char);
      expect(result.success).toBe(true);
    }

    expect(setTextCalls).toEqual([]);
    expect(inputCommands(factory).some(command => command.includes("KEYCODE_DEL"))).toBe(false);
  });

  test("append fails rather than falling back to a destructive a11y setText", async () => {
    // The fallback every other mode performs would REPLACE the field, which is
    // exactly what append exists to avoid. An actionable error is correct.
    const factory = new FakeAdbClientFactory();
    const inputText = new InputText(androidDevice, factory as AdbClientFactory);
    const setTextCalls: string[] = [];

    stubAndroidSetText(async text => {
      setTextCalls.push(text);
      return { success: true, totalTimeMs: 1 };
    });

    const result = await testInputText(inputText).executeAndroidTextInput(
      "😊",
      undefined,
      false,
      "append"
    );

    expect(result.success).toBe(false);
    expect(result.method).toBe("append");
    expect(result.error).toContain("append cannot type");
    expect(setTextCalls).toEqual([]);
    expect(inputCommands(factory)).toEqual([]);
  });

  // Issue #3351 review: the API-level capability is needed ONLY for uppercase/
  // shifted characters, so a lowercase/digit/space/unshifted append must not probe
  // `ro.build.version.sdk` at all — the probe is a wasted device round trip that
  // could even consume the budget and drop the keystroke.
  test("append does not probe the API level for characters that never need it (cold cache)", async () => {
    const factory = new FakeAdbClientFactory();
    const inputText = new InputText(androidDevice, factory as AdbClientFactory);
    // Cold cache: no getprop result configured, and the probe must never run.
    const result = await inputText.appendText("a1 .");

    expect(result.success).toBe(true);
    const allCommands = factory.getFakeClient().getAllCommands();
    expect(allCommands.some(command => command.includes("getprop ro.build.version.sdk"))).toBe(false);
    // The key events still went out — skipping the probe did not skip the typing.
    expect(inputCommands(factory)).toEqual([
      "shell input keyevent KEYCODE_A",
      "shell input keyevent KEYCODE_1",
      "shell input keyevent KEYCODE_SPACE",
      "shell input keyevent KEYCODE_PERIOD",
    ]);
  });

  test("append still probes the API level when a character needs the capability (cold cache)", async () => {
    // The other direction: an uppercase character DOES need `input keycombination`,
    // so the probe must run — skipping it for the whole batch would be wrong.
    const factory = new FakeAdbClientFactory();
    const inputText = new InputText(androidDevice, factory as AdbClientFactory);
    factory.getFakeClient().setCommandResult("shell getprop ro.build.version.sdk", "31\n");

    const result = await inputText.appendText("A");

    expect(result.success).toBe(true);
    const allCommands = factory.getFakeClient().getAllCommands();
    expect(allCommands.some(command => command.includes("getprop ro.build.version.sdk"))).toBe(true);
    expect(inputCommands(factory)).toEqual([
      "shell input keycombination KEYCODE_SHIFT_LEFT KEYCODE_A",
    ]);
  });

  // Issue #3351: append is best-effort and char-by-char, so a partial failure must
  // report how much of `text` landed. A caller retrying the whole string after a
  // prefix already typed would corrupt the field ("ab" after "a" -> "aab").
  test("append reports charsSent for a fully successful batch", async () => {
    const factory = new FakeAdbClientFactory();
    const inputText = new InputText(androidDevice, factory as AdbClientFactory);

    const result = await inputText.appendText("abc");

    expect(result.success).toBe(true);
    expect(result.charsSent).toBe(3);
  });

  test("append reports charsSent up to the failing character, not a generic failure", async () => {
    // "abc": KEYCODE_A lands, KEYCODE_B rejects (device offline mid-batch), so the
    // field holds "a". The result must say charsSent=1 and KEYCODE_C must never run,
    // so a caller resumes from text.slice(1) instead of re-appending "abc".
    const factory = new FakeAdbClientFactory();
    const inputText = new InputText(androidDevice, factory as AdbClientFactory);
    factory.getFakeClient().setCommandError(
      "shell input keyevent KEYCODE_B",
      new Error("device offline")
    );

    const result = await inputText.appendText("abc");

    expect(result.success).toBe(false);
    expect(result.charsSent).toBe(1);
    expect(result.error).toContain("append key event failed");
    expect(inputCommands(factory)).toEqual([
      "shell input keyevent KEYCODE_A",
      "shell input keyevent KEYCODE_B",
    ]);
  });

  // Issue #3351 review: the client forwards every printable ASCII character, but
  // uppercase and shifted symbols need `input keycombination` (API 31+). The client
  // cannot see the API level, so the daemon has to REPORT the failure — the one
  // outcome that must never happen is a silent success that typed nothing.
  test("append reports an actionable failure for uppercase below API 31", async () => {
    const factory = new FakeAdbClientFactory();
    const inputText = new InputText(androidDevice, factory as AdbClientFactory);
    const setTextCalls: string[] = [];
    factory.getFakeClient().setCommandResult("shell getprop ro.build.version.sdk", "30\n");

    stubAndroidSetText(async text => {
      setTextCalls.push(text);
      return { success: true, totalTimeMs: 1 };
    });

    const result = await inputText.appendText("A");

    expect(result.success).toBe(false);
    expect(result.error).toContain("append cannot type \"A\"");
    // Not typed, and emphatically not repaired by a setText that would wipe the field.
    expect(setTextCalls).toEqual([]);
    expect(inputCommands(factory)).toEqual([]);
  });

  test("append still types uppercase on API 31 and above", async () => {
    // The other direction: the failure above must be the device's limitation, not
    // the append path refusing capitals outright.
    const factory = new FakeAdbClientFactory();
    const inputText = new InputText(androidDevice, factory as AdbClientFactory);
    factory.getFakeClient().setCommandResult("shell getprop ro.build.version.sdk", "31\n");
    stubAndroidSetText(async () => ({ success: true, totalTimeMs: 1 }));

    const result = await inputText.appendText("A");

    expect(result.success).toBe(true);
    expect(inputCommands(factory)).toEqual([
      "shell input keycombination KEYCODE_SHIFT_LEFT KEYCODE_A"
    ]);
  });

  test("an OUR-timeout API probe does not permanently disable SHIFT for a cached instance", async () => {
    // The daemon keeps one InputText+AdbClient per device for minutes (#3351
    // finding 4). A single budget-timed-out probe must not disable SHIFT chords
    // for that whole window: the next keystroke, with a fresh budget, must re-probe
    // and recover. Drives a REAL AdbClient so the actual probe/cache path runs; the
    // authoritative not-cached assertion lives in AdbClientApiLevelTimeout.test.ts.
    let timeOut = true;
    const exec = (command: string): Promise<ExecResult> => {
      if (command.includes("getprop ro.build.version.sdk")) {
        if (timeOut) {
          // Exactly what execWithSignal throws when the threaded timeoutMs expires.
          return Promise.reject(
            new AdbCommandTimeoutError("Command timed out after 5ms: adb shell getprop ro.build.version.sdk")
          );
        }
        return Promise.resolve(execResult("31\n"));
      }
      // Key events (and anything else) succeed.
      return Promise.resolve(execResult(""));
    };
    const adb = new AdbClient(androidDevice, exec, null, undefined, new FakeTimer());
    // Inject a FakeTimer into InputText too: createBudget reads THIS clock, so a
    // wall clock here would race the 5ms budget against the char-unmappable path
    // (repo rule: no real timers in unit tests). Never advanced, so the budget
    // stays positive and the "cannot type" path is exercised deterministically.
    const inputText = new InputText(androidDevice, adb, undefined, new FakeTimer());

    const whileTimedOut = await inputText.appendText("A", 5);
    expect(whileTimedOut.success).toBe(false);
    expect(whileTimedOut.error).toContain("append cannot type");

    // Fresh budget on the next keystroke: neither InputText nor AdbClient may have
    // cached the timed-out probe as "unsupported", so the capital now types.
    timeOut = false;
    const afterRetry = await inputText.appendText("A", 5000);
    expect(afterRetry.success).toBe(true);
  });

  test("a timed-out append key event is attempted ONCE, not retried up to 4x", async () => {
    // Production AdbClient retries a retryable failure (a timeout IS retryable —
    // "timed out" is not in the non-retryable list) up to MAX_ADB_RETRIES+1 = 4
    // attempts, each charged the SAME budget. Because runInputOperationWithTimeout
    // awaits the losing operation before releasing the per-device queue, an
    // unbounded retry would hold the queue for ~4x the request deadline. The
    // append path must pass noRetry so the whole append stays inside one budget.
    let keyEventCalls = 0;
    const exec = (command: string): Promise<ExecResult> => {
      if (command.includes("getprop ro.build.version.sdk")) {
        return Promise.resolve(execResult("31\n"));
      }
      if (command.includes("input keyevent")) {
        keyEventCalls += 1;
        // A retryable timeout: its message is NOT in AdbClient's non-retryable set,
        // so without noRetry the retry executor would attempt it four times.
        return Promise.reject(
          new AdbCommandTimeoutError("Command timed out after 5ms: adb shell input keyevent KEYCODE_A")
        );
      }
      return Promise.resolve(execResult(""));
    };
    const adb = new AdbClient(androidDevice, exec, null, undefined, new FakeTimer());
    // FakeTimer into InputText as well, so createBudget never reads the wall clock
    // (repo rule: no real timers). Never advanced, so the budget cannot expire and
    // the assertion is purely about the retry count, not timing.
    const inputText = new InputText(androidDevice, adb, undefined, new FakeTimer());

    const result = await inputText.appendText("a", 5000);

    expect(result.success).toBe(false);
    expect(result.error).toContain("append key event failed");
    expect(result.charsSent).toBeUndefined();
    // Exactly one attempt: the deadline is not multiplied by the retry count.
    expect(keyEventCalls).toBe(1);
  });

  test("a timed-out later append key leaves the retry boundary ambiguous", async () => {
    const exec = (command: string): Promise<ExecResult> => {
      if (command.includes("input keyevent KEYCODE_B")) {
        return Promise.reject(
          new AdbCommandTimeoutError("Command timed out after 5ms: adb shell input keyevent KEYCODE_B")
        );
      }
      return Promise.resolve(execResult(""));
    };
    const adb = new AdbClient(androidDevice, exec, null, undefined, new FakeTimer());
    const inputText = new InputText(androidDevice, adb, undefined, new FakeTimer());

    const result = await inputText.appendText("ab", 5000);

    expect(result.success).toBe(false);
    expect(result.error).toContain("append key event failed");
    // KEYCODE_A was confirmed, but Android may have accepted KEYCODE_B before
    // adb timed out, so `1` would be an unsafe retry boundary.
    expect(result.charsSent).toBeUndefined();
  });

  test("append charges the API probe and every key event against the caller's budget", async () => {
    // Without this the daemon's per-device queue is held by an unbounded subprocess:
    // the socket race only REPORTS the timeout, it still waits for the operation.
    const factory = new FakeAdbClientFactory();
    const timer = new FakeTimer();
    const inputText = new InputText(androidDevice, factory as AdbClientFactory, undefined, timer);
    factory.getFakeClient().setCommandResult("shell getprop ro.build.version.sdk", "31\n");
    stubAndroidSetText(async () => ({ success: true, totalTimeMs: 1 }));

    const result = await inputText.appendText("ab", 5_000);

    expect(result.success).toBe(true);
    const calls = factory.getFakeClient().getCommandCalls();
    expect(calls.length).toBeGreaterThan(1);
    for (const call of calls) {
      expect(call.timeoutMs).toBeDefined();
      expect(call.timeoutMs).toBeLessThanOrEqual(5_000);
    }
  });

  test("append gives up once the budget is spent instead of issuing more key events", async () => {
    const factory = new FakeAdbClientFactory();
    const timer = new FakeTimer();
    const inputText = new InputText(androidDevice, factory as AdbClientFactory, undefined, timer);
    factory.getFakeClient().setCommandResult("shell getprop ro.build.version.sdk", "31\n");
    stubAndroidSetText(async () => ({ success: true, totalTimeMs: 1 }));

    // The budget is already gone by the time the first device round trip is due.
    const result = await inputText.appendText("a", 0);

    expect(result.success).toBe(false);
    expect(result.error).toContain("append exceeded its 0ms budget");
    expect(inputCommands(factory)).toEqual([]);
  });

});
