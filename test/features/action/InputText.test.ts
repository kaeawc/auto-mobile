import { createFlatNodeForTest } from "../observe/flatHierarchyBuilders";
import { buildObserveResult } from "../../helpers/observeFixture";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { InputText } from "../../../src/features/action/InputText";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeAwaitIdle } from "../../fakes/FakeAwaitIdle";
import { FakeTimer } from "../../fakes/FakeTimer";
import type { BootedDevice, ExecResult, ObserveResult } from "../../../src/models";
import type { AdbClientFactory } from "../../../src/utils/android-cmdline-tools/AdbClientFactory";
import {
  AdbClient,
  AdbCommandTimeoutError,
} from "../../../src/utils/android-cmdline-tools/AdbClient";
import { DeviceLostError } from "../../../src/utils/deviceLossOutcome";

type RequestSetText = (
  text: string,
  options?: {
    resourceId?: string;
    timeoutMs?: number;
    perf?: unknown;
    dismissKeyboard?: boolean;
  },
) => Promise<{ success: boolean; error?: string; totalTimeMs: number }>;

function stubAndroidSetText(requestSetText: RequestSetText): void {
  AndroidCtrlProxyClient.getInstance = (device, factory = new FakeAdbClientFactory()) => {
    const client = AndroidCtrlProxyClient.createForTesting(device, factory.create(device));
    client.requestSetText = requestSetText;
    return client;
  };
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
  return factory
    .getFakeClient()
    .getAllCommands()
    .filter((command) => command.startsWith("shell input "));
}

function observeResultWithFocusedText(
  text: string,
  properties: Record<string, unknown> = {},
): ObserveResult {
  return buildObserveResult({
    updatedAt: 0,
    screenSize: { width: 1080, height: 1920 },
    systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
    viewHierarchy: {
      hierarchy: {
        node: createFlatNodeForTest({
          focused: true,
          class: "android.widget.EditText",
          text,
          ...properties,
        }),
      },
    },
  });
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
    const inputText = new InputText(androidDevice, factory);

    let capturedFactory: AdbClientFactory | undefined;
    AndroidCtrlProxyClient.getInstance = (device, adbFactory = factory) => {
      capturedFactory = adbFactory;
      const client = AndroidCtrlProxyClient.createForTesting(device, adbFactory.create(device));
      client.requestSetText = async () => ({ success: false, totalTimeMs: 0 });
      return client;
    };

    await inputText.testHooks.executeAndroidTextInput("hello");

    expect(capturedFactory).toBeDefined();
    expect(typeof capturedFactory?.create).toBe("function");
    expect(capturedFactory).toBe(factory);
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
    const observe = new FakeObserveScreen();
    observe.setObserveResult(observeResultWithFocusedText(""));
    const inputText = new InputText(androidDevice, new FakeAdbClientFactory(), {
      timer,
      observeScreen: observe,
      awaitIdle: new FakeAwaitIdle(),
    });

    await expect(inputText.execute("hello", {}, { signal: controller.signal })).rejects.toBe(
      deviceLoss,
    );
  });

  test("forwards cancellation through post-input observation", async () => {
    const controller = new AbortController();
    stubAndroidSetText(async () => ({ success: true, totalTimeMs: 1 }));
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const observe = new FakeObserveScreen();
    observe.setObserveResult(observeResultWithFocusedText(""));
    const inputText = new InputText(androidDevice, new FakeAdbClientFactory(), {
      timer,
      observeScreen: observe,
      awaitIdle: new FakeAwaitIdle(),
    });
    observe.enableAutoVaryHierarchy();

    await inputText.execute("hello", {}, { signal: controller.signal });

    expect(observe.getExecuteOptions()).not.toHaveLength(0);
    expect(
      observe.getExecuteOptions().every((options) => options.signal === controller.signal),
    ).toBe(true);
  });

  test("eventLast sets prefix with a11y and sends final ASCII key event", async () => {
    const factory = new FakeAdbClientFactory();
    const inputText = new InputText(androidDevice, factory);
    const setTextCalls: Array<{ text: string; dismissKeyboard?: boolean }> = [];

    stubAndroidSetText(async (text, options) => {
      setTextCalls.push({ text, dismissKeyboard: options?.dismissKeyboard });
      return { success: true, totalTimeMs: 1 };
    });

    const result = await inputText.testHooks.executeAndroidTextInput("@Jason Pearson", {
      dismissKeyboard: false,
      mode: "eventLast",
    });

    expect(result.success).toBe(true);
    expect(result.method).toBe("eventLast");
    expect(setTextCalls).toEqual([{ text: "@Jason Pearso", dismissKeyboard: undefined }]);
    expect(inputCommands(factory)).toEqual(["shell input keyevent KEYCODE_N"]);
  });

  test("eventLast restores suffix with final a11y setText", async () => {
    const factory = new FakeAdbClientFactory();
    const inputText = new InputText(androidDevice, factory);
    const setTextCalls: Array<{ text: string; dismissKeyboard?: boolean }> = [];

    stubAndroidSetText(async (text, options) => {
      setTextCalls.push({ text, dismissKeyboard: options?.dismissKeyboard });
      return { success: true, totalTimeMs: 1 };
    });

    const result = await inputText.testHooks.executeAndroidTextInput("abc def  ", {
      dismissKeyboard: false,
      mode: "eventLast",
    });

    expect(result.success).toBe(true);
    expect(setTextCalls).toEqual([
      { text: "abc de", dismissKeyboard: undefined },
      { text: "abc def  ", dismissKeyboard: undefined },
    ]);
    expect(inputCommands(factory)).toEqual(["shell input keyevent KEYCODE_F"]);
  });

  test("eventLast uses shifted key combination for uppercase ASCII on Android 12+", async () => {
    const factory = new FakeAdbClientFactory();
    const inputText = new InputText(androidDevice, factory);
    factory.getFakeClient().setCommandResult("shell getprop ro.build.version.sdk", "31\n");

    stubAndroidSetText(async () => ({ success: true, totalTimeMs: 1 }));

    const result = await inputText.testHooks.executeAndroidTextInput("HellO", {
      dismissKeyboard: false,
      mode: "eventLast",
    });

    expect(result.success).toBe(true);
    expect(inputCommands(factory)).toEqual([
      "shell input keycombination KEYCODE_SHIFT_LEFT KEYCODE_O",
    ]);
  });

  test("eventLast falls back to a11y for shifted ASCII before Android 12", async () => {
    const factory = new FakeAdbClientFactory();
    const inputText = new InputText(androidDevice, factory);
    const setTextCalls: Array<{ text: string; dismissKeyboard?: boolean }> = [];
    factory.getFakeClient().setCommandResult("shell getprop ro.build.version.sdk", "30\n");

    stubAndroidSetText(async (text, options) => {
      setTextCalls.push({ text, dismissKeyboard: options?.dismissKeyboard });
      return { success: true, totalTimeMs: 1 };
    });

    const result = await inputText.testHooks.executeAndroidTextInput("HellO", {
      dismissKeyboard: false,
      mode: "eventLast",
    });

    expect(result.success).toBe(true);
    expect(result.method).toBe("a11y");
    expect(setTextCalls).toEqual([{ text: "HellO", dismissKeyboard: undefined }]);
    expect(inputCommands(factory)).toEqual([]);
  });

  test("eventLast falls back to a11y when no printable non-whitespace ASCII exists", async () => {
    const factory = new FakeAdbClientFactory();
    const inputText = new InputText(androidDevice, factory);
    const setTextCalls: string[] = [];

    stubAndroidSetText(async (text) => {
      setTextCalls.push(text);
      return { success: true, totalTimeMs: 1 };
    });

    const result = await inputText.testHooks.executeAndroidTextInput("  你好  ", {
      dismissKeyboard: false,
      mode: "eventLast",
    });

    expect(result.success).toBe(true);
    expect(result.method).toBe("a11y");
    expect(setTextCalls).toEqual(["  你好  "]);
    expect(inputCommands(factory)).toEqual([]);
  });

  test("eventAll sends mappable ASCII text as key events", async () => {
    const factory = new FakeAdbClientFactory();
    const inputText = new InputText(androidDevice, factory);
    const setTextCalls: string[] = [];
    factory.getFakeClient().setCommandResult("shell getprop ro.build.version.sdk", "31\n");

    stubAndroidSetText(async (text) => {
      setTextCalls.push(text);
      return { success: true, totalTimeMs: 1 };
    });

    const result = await inputText.testHooks.executeAndroidTextInput("@ab C", {
      dismissKeyboard: false,
      mode: "eventAll",
    });

    expect(result.success).toBe(true);
    expect(result.method).toBe("eventAll");
    expect(setTextCalls).toEqual([""]);
    expect(inputCommands(factory)).toEqual([
      "shell input keyevent KEYCODE_AT",
      "shell input keyevent KEYCODE_A",
      "shell input keyevent KEYCODE_B",
      "shell input keyevent KEYCODE_SPACE",
      "shell input keycombination KEYCODE_SHIFT_LEFT KEYCODE_C",
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
    const inputText = new InputText(androidDevice, factory);
    factory.getFakeClient().setCommandResult("shell getprop ro.build.version.sdk", "31\n");
    stubAndroidSetText(async () => ({ success: true, totalTimeMs: 1 }));
    const originalExecuteCommand = fakeClient.executeCommand.bind(fakeClient);
    const executeSpy = spyOn(fakeClient, "executeCommand").mockImplementation(
      async (command, options) => {
        const result = await originalExecuteCommand(command, options);
        if (command === "shell input keyevent KEYCODE_A") {
          controller.abort(deviceLoss);
        }
        return result;
      },
    );

    try {
      await expect(
        inputText.testHooks.executeAndroidTextInput("abc", {
          dismissKeyboard: false,
          mode: "eventAll",
          signal: controller.signal,
        }),
      ).rejects.toBe(deviceLoss);
      expect(inputCommands(factory)).toEqual(["shell input keyevent KEYCODE_A"]);
    } finally {
      executeSpy.mockRestore();
    }
  });

  test("eventAll alternates a11y for Unicode runs and key events for ASCII", async () => {
    const factory = new FakeAdbClientFactory();
    const inputText = new InputText(androidDevice, factory);
    const setTextCalls: string[] = [];

    stubAndroidSetText(async (text) => {
      setTextCalls.push(text);
      return { success: true, totalTimeMs: 1 };
    });

    const result = await inputText.testHooks.executeAndroidTextInput("ab你好c😊d", {
      dismissKeyboard: false,
      mode: "eventAll",
    });

    expect(result.success).toBe(true);
    expect(result.method).toBe("eventAll");
    expect(setTextCalls).toEqual(["", "ab你好", "ab你好c😊"]);
    expect(inputCommands(factory)).toEqual([
      "shell input keyevent KEYCODE_A",
      "shell input keyevent KEYCODE_B",
      "shell input keyevent KEYCODE_C",
      "shell input keyevent KEYCODE_D",
    ]);
  });

  test("eventAll stops at a failed Unicode run without sending later keys or dismissing", async () => {
    const factory = new FakeAdbClientFactory();
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const calls: string[] = [];
    const inputText = new InputText(androidDevice, factory, {
      keyboardCloserFactory: () => ({
        close: async () => {
          calls.push("close");
          return { success: true, open: false };
        },
      }),
      timer,
    });
    const execute = spyOn(factory.getFakeClient(), "executeCommand");
    stubAndroidSetText(async (text) => {
      calls.push(`set:${text}`);
      return {
        success: text === "",
        error: text === "" ? undefined : "field disappeared",
        totalTimeMs: 1,
      };
    });
    try {
      const result = await inputText.testHooks.executeAndroidTextInput("a你好b", {
        dismissKeyboard: true,
        mode: "eventAll",
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain("field disappeared");
      expect(result.method).toBe("eventAll");
      expect(calls).toEqual(["set:", "set:a你好"]);
      expect(execute.mock.calls.map(([command]) => command)).toEqual([
        "shell getprop ro.build.version.sdk",
        "shell getprop ro.build.version.sdk",
        "shell input keyevent KEYCODE_A",
        "shell getprop ro.build.version.sdk",
        "shell getprop ro.build.version.sdk",
        "shell getprop ro.build.version.sdk",
      ]);
    } finally {
      execute.mockRestore();
    }
  });

  test("eventAll fails before key events when initial a11y clear fails", async () => {
    const factory = new FakeAdbClientFactory();
    const inputText = new InputText(androidDevice, factory);

    stubAndroidSetText(async () => ({
      success: false,
      error: "focused field missing",
      totalTimeMs: 1,
    }));

    const result = await inputText.testHooks.executeAndroidTextInput("abc", {
      dismissKeyboard: false,
      mode: "eventAll",
    });

    expect(result.success).toBe(false);
    expect(result.method).toBe("eventAll");
    expect(result.error).toContain("focused field missing");
    expect(inputCommands(factory)).toEqual([]);
  });

  test.each([
    ["eventLast with no printable ASCII", "eventLast", "  你好  ", "31\n"],
    ["eventLast with an unmappable shifted char", "eventLast", "HellO", "30\n"],
    ["eventAll with an unmappable shifted char", "eventAll", "A", "30\n"],
  ] as const)(
    "%s falls back to a11y and still runs the IME action and keyboard dismissal",
    async (_label, mode, text, sdk) => {
      const factory = new FakeAdbClientFactory();
      factory.getFakeClient().setCommandResult("shell getprop ro.build.version.sdk", sdk);
      const closeCalls: string[] = [];
      const timer = new FakeTimer();
      timer.enableAutoAdvance();
      const inputText = new InputText(androidDevice, factory as AdbClientFactory, {
        keyboardCloserFactory: () => ({
          close: async () => {
            closeCalls.push("close");
            return { success: true, open: false, message: "Keyboard closed" };
          },
        }),
        timer,
      });
      stubAndroidSetText(async () => ({ success: true, totalTimeMs: 1 }));

      const result = await inputText.testHooks.executeAndroidTextInput(text, {
        imeAction: "done",
        dismissKeyboard: true,
        mode,
      });

      expect(result.method).toBe("a11y");
      expect(result.success).toBe(true);
      expect(result.imeAction).toBe("done");
      expect(closeCalls).toEqual(["close"]);
      expect(inputCommands(factory)).toContain("shell input keyevent KEYCODE_ENTER");
    },
  );

  test.each([
    ["eventLast", "ab", [false], "failed before real key event: boom"],
    ["eventLast", "ab  ", [true, false], "failed after real key event: boom"],
    ["eventAll", "abc", [false], "failed before eventAll input: boom"],
    ["eventAll", "a你b", [true, false], "failed during eventAll input: boom"],
  ] as const)(
    "%s names the failing setText phase and keeps its method: %s",
    async (mode, text, outcomes, message) => {
      const factory = new FakeAdbClientFactory();
      factory.getFakeClient().setCommandResult("shell getprop ro.build.version.sdk", "31\n");
      const inputText = new InputText(androidDevice, factory as AdbClientFactory);
      let call = 0;
      stubAndroidSetText(async () => {
        const succeeds = outcomes[call++] ?? false;
        return succeeds
          ? { success: true, totalTimeMs: 1 }
          : { success: false, error: "boom", totalTimeMs: 1 };
      });

      const result = await inputText.testHooks.executeAndroidTextInput(text, {
        dismissKeyboard: false,
        mode,
      });

      expect(result.success).toBe(false);
      expect(result.method).toBe(mode);
      expect(result.error).toContain(message);
    },
  );

  test("eventAll names the failing final setText phase when dismissing the keyboard", async () => {
    const factory = new FakeAdbClientFactory();
    factory.getFakeClient().setCommandResult("shell getprop ro.build.version.sdk", "31\n");
    const inputText = new InputText(androidDevice, factory as AdbClientFactory, {
      keyboardCloserFactory: () => ({
        close: async () => ({ success: true, open: false }),
      }),
    });
    const outcomes = [true, false];
    let call = 0;
    stubAndroidSetText(async () =>
      outcomes[call++]
        ? { success: true, totalTimeMs: 1 }
        : { success: false, error: "boom", totalTimeMs: 1 },
    );

    const result = await inputText.testHooks.executeAndroidTextInput("ab", {
      dismissKeyboard: true,
      mode: "eventAll",
    });

    expect(result.success).toBe(false);
    expect(result.method).toBe("eventAll");
    expect(result.error).toContain("failed after eventAll input: boom");
  });

  test("eventAll uses a11y instead of shifted keyevents before Android 12", async () => {
    const factory = new FakeAdbClientFactory();
    const inputText = new InputText(androidDevice, factory);
    const setTextCalls: string[] = [];
    factory.getFakeClient().setCommandResult("shell getprop ro.build.version.sdk", "30\n");

    stubAndroidSetText(async (text) => {
      setTextCalls.push(text);
      return { success: true, totalTimeMs: 1 };
    });

    const result = await inputText.testHooks.executeAndroidTextInput("a+B", {
      dismissKeyboard: false,
      mode: "eventAll",
    });

    expect(result.success).toBe(true);
    expect(result.method).toBe("eventAll");
    expect(setTextCalls).toEqual(["", "a+B"]);
    expect(inputCommands(factory)).toEqual(["shell input keyevent KEYCODE_A"]);
  });

  test("eventAll falls back to a11y for shifted-only text before Android 12", async () => {
    const factory = new FakeAdbClientFactory();
    const inputText = new InputText(androidDevice, factory);
    const setTextCalls: string[] = [];
    factory.getFakeClient().setCommandResult("shell getprop ro.build.version.sdk", "30\n");

    stubAndroidSetText(async (text) => {
      setTextCalls.push(text);
      return { success: true, totalTimeMs: 1 };
    });

    const result = await inputText.testHooks.executeAndroidTextInput("B+", {
      dismissKeyboard: false,
      mode: "eventAll",
    });

    expect(result.success).toBe(true);
    expect(result.method).toBe("a11y");
    expect(setTextCalls).toEqual(["B+"]);
    expect(inputCommands(factory)).toEqual([]);
  });

  test("eventAll falls back to a11y when there are no key-event-mappable characters", async () => {
    const factory = new FakeAdbClientFactory();
    const inputText = new InputText(androidDevice, factory);
    const setTextCalls: string[] = [];

    stubAndroidSetText(async (text) => {
      setTextCalls.push(text);
      return { success: true, totalTimeMs: 1 };
    });

    const result = await inputText.testHooks.executeAndroidTextInput("你好😊", {
      dismissKeyboard: false,
      mode: "eventAll",
    });

    expect(result.success).toBe(true);
    expect(result.method).toBe("a11y");
    expect(setTextCalls).toEqual(["你好😊"]);
    expect(inputCommands(factory)).toEqual([]);
  });

  // Regression for https://github.com/kaeawc/auto-mobile/issues/5887.
  // The default a11y path implemented dismissKeyboard:true by forwarding the flag
  // to the runner's requestSetText (SHOW_MODE_HIDDEN), which suppresses re-showing
  // the keyboard but does not dismiss an already-visible IME window — so the IME
  // (SoftInputWindow) stayed foregrounded after inputText. The confirmed dismissal
  // must go through the Keyboard.close() route the event/append modes already use.
  test("a11y dismisses the keyboard via the keyboard closer when dismissKeyboard is true", async () => {
    const factory = new FakeAdbClientFactory();
    const closeCalls: string[] = [];
    const setTextCalls: Array<{ text: string; dismissKeyboard?: boolean }> = [];
    const inputText = new InputText(androidDevice, factory as AdbClientFactory, {
      keyboardCloserFactory: () => ({
        close: async () => {
          closeCalls.push("close");
          return { success: true, open: false, message: "Keyboard closed" };
        },
      }),
    });

    stubAndroidSetText(async (text, options) => {
      setTextCalls.push({ text, dismissKeyboard: options?.dismissKeyboard });
      return { success: true, totalTimeMs: 1 };
    });

    const result = await inputText.testHooks.executeAndroidTextInput("hello", {
      dismissKeyboard: true,
    });

    expect(result.success).toBe(true);
    expect(result.method).toBe("a11y");
    expect(result.keyboardDismissed).toBe(true);
    expect(result.warnings).toBeUndefined();
    // setText must NOT carry the runner dismissKeyboard flag — the confirmed
    // Keyboard.close() route owns dismissal so close() never decides to send Back
    // off a cached "IME open" tree the runner had already hidden (issue #5887).
    expect(setTextCalls).toEqual([{ text: "hello", dismissKeyboard: undefined }]);
    expect(closeCalls).toEqual(["close"]);
  });

  test("a11y does not invoke the keyboard closer when dismissKeyboard is false", async () => {
    const factory = new FakeAdbClientFactory();
    const closeCalls: string[] = [];
    const inputText = new InputText(androidDevice, factory as AdbClientFactory, {
      keyboardCloserFactory: () => ({
        close: async () => {
          closeCalls.push("close");
          return { success: true, open: false, message: "Keyboard closed" };
        },
      }),
    });

    stubAndroidSetText(async () => ({ success: true, totalTimeMs: 1 }));

    const result = await inputText.testHooks.executeAndroidTextInput("hello", {
      dismissKeyboard: false,
    });

    expect(result.success).toBe(true);
    expect(closeCalls).toEqual([]);
  });

  // Regression for the #5887 review: the IME action must run BEFORE the keyboard
  // dismiss, so a dismissal failure cannot skip the action the caller asked for
  // (and dismissing first can't move focus out from under Enter/Tab/Search).
  test("a11y runs the IME action even when the keyboard dismissal fails", async () => {
    const factory = new FakeAdbClientFactory();
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const inputText = new InputText(androidDevice, factory as AdbClientFactory, {
      keyboardCloserFactory: () => ({
        close: async () => ({
          success: false,
          open: true,
          error: "Keyboard state unavailable",
        }),
      }),
      timer,
    });

    stubAndroidSetText(async () => ({ success: true, totalTimeMs: 1 }));

    const result = await inputText.testHooks.executeAndroidTextInput("hello", {
      imeAction: "done",
      dismissKeyboard: true,
    });

    // The dismissal failure surfaces as a warning on a SUCCESSFUL result (#6868),
    // and the IME action (Enter) already ran — pre-#5887 the dismiss-first
    // ordering would have skipped it entirely.
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.keyboardDismissed).toBe(false);
    expect(result.warnings).toEqual(["keyboard dismissal failed: Keyboard state unavailable"]);
    expect(inputCommands(factory)).toContain("shell input keyevent KEYCODE_ENTER");
    // The completed action is carried on the failure result so a consumer can tell
    // a post-submit cleanup failure from a no-op and not double-submit (#5887).
    expect((result as { imeAction?: string }).imeAction).toBe("done");
  });

  test("a11y warns about a keyboard dismissal failure instead of failing the write", async () => {
    const factory = new FakeAdbClientFactory();
    const inputText = new InputText(androidDevice, factory as AdbClientFactory, {
      keyboardCloserFactory: () => ({
        close: async () => ({
          success: false,
          open: true,
          error: "Keyboard state unavailable",
        }),
      }),
    });

    stubAndroidSetText(async () => ({ success: true, totalTimeMs: 1 }));

    const result = await inputText.testHooks.executeAndroidTextInput("hello", {
      dismissKeyboard: true,
    });

    // #6868: the text landed; only the dismissal epilogue failed.
    expect(result.success).toBe(true);
    expect(result.method).toBe("a11y");
    expect(result.error).toBeUndefined();
    expect(result.keyboardDismissed).toBe(false);
    expect(result.warnings).toEqual(["keyboard dismissal failed: Keyboard state unavailable"]);
  });

  test("eventAll dismisses the keyboard via the keyboard closer when dismissKeyboard is true", async () => {
    const factory = new FakeAdbClientFactory();
    const closeCalls: string[] = [];
    const inputText = new InputText(androidDevice, factory as AdbClientFactory, {
      keyboardCloserFactory: () => ({
        close: async () => {
          closeCalls.push("close");
          return { success: true, open: false, message: "Keyboard closed" };
        },
      }),
    });

    stubAndroidSetText(async () => ({ success: true, totalTimeMs: 1 }));

    const result = await inputText.testHooks.executeAndroidTextInput("ab", {
      dismissKeyboard: true,
      mode: "eventAll",
    });

    expect(result.success).toBe(true);
    expect(result.method).toBe("eventAll");
    expect(closeCalls).toEqual(["close"]);
  });

  test("eventLast dismisses the keyboard via the keyboard closer when dismissKeyboard is true", async () => {
    const factory = new FakeAdbClientFactory();
    const closeCalls: string[] = [];
    const inputText = new InputText(androidDevice, factory as AdbClientFactory, {
      keyboardCloserFactory: () => ({
        close: async () => {
          closeCalls.push("close");
          return { success: true, open: false, message: "Keyboard closed" };
        },
      }),
    });

    stubAndroidSetText(async () => ({ success: true, totalTimeMs: 1 }));

    const result = await inputText.testHooks.executeAndroidTextInput("abc", {
      dismissKeyboard: true,
      mode: "eventLast",
    });

    expect(result.success).toBe(true);
    expect(result.method).toBe("eventLast");
    expect(closeCalls).toEqual(["close"]);
  });

  // #6868: every Android mode routes dismissKeyboard through the same
  // best-effort epilogue, so a dismissal failure must degrade to a warning on a
  // successful result in the append mode too — where the characters have
  // definitively landed and a retry would double them.
  test("append warns about a keyboard dismissal failure instead of failing the typed text", async () => {
    const factory = new FakeAdbClientFactory();
    factory.getFakeClient().setCommandResult("shell getprop ro.build.version.sdk", "31\n");
    const inputText = new InputText(androidDevice, factory as AdbClientFactory, {
      keyboardCloserFactory: () => ({
        close: async () => ({
          success: false,
          open: true,
          error: "Keyboard state unavailable",
        }),
      }),
    });

    const result = await inputText.testHooks.executeAndroidTextInput("abc", {
      dismissKeyboard: true,
      mode: "append",
    });

    expect(result.success).toBe(true);
    expect(result.method).toBe("append");
    expect(result.error).toBeUndefined();
    expect(result.keyboardDismissed).toBe(false);
    expect(result.warnings).toEqual(["keyboard dismissal failed: Keyboard state unavailable"]);
    // The retry boundary is still reported, and it covers the whole string.
    expect((result as { charsSent?: number }).charsSent).toBe(3);
  });

  test("eventAll warns about a keyboard dismissal failure instead of failing the write", async () => {
    const factory = new FakeAdbClientFactory();
    const inputText = new InputText(androidDevice, factory as AdbClientFactory, {
      keyboardCloserFactory: () => ({
        close: async () => ({
          success: false,
          open: true,
          error: "Keyboard state unavailable",
        }),
      }),
    });

    stubAndroidSetText(async () => ({ success: true, totalTimeMs: 1 }));

    const result = await inputText.testHooks.executeAndroidTextInput("ab", {
      dismissKeyboard: true,
      mode: "eventAll",
    });

    expect(result.success).toBe(true);
    expect(result.method).toBe("eventAll");
    expect(result.keyboardDismissed).toBe(false);
    expect(result.warnings).toEqual(["keyboard dismissal failed: Keyboard state unavailable"]);
  });

  test("eventLast warns about a keyboard dismissal failure instead of failing the write", async () => {
    const factory = new FakeAdbClientFactory();
    const inputText = new InputText(androidDevice, factory as AdbClientFactory, {
      keyboardCloserFactory: () => ({
        close: async () => ({
          success: false,
          open: true,
          error: "Keyboard state unavailable",
        }),
      }),
    });

    stubAndroidSetText(async () => ({ success: true, totalTimeMs: 1 }));

    const result = await inputText.testHooks.executeAndroidTextInput("abc", {
      dismissKeyboard: true,
      mode: "eventLast",
    });

    expect(result.success).toBe(true);
    expect(result.method).toBe("eventLast");
    expect(result.keyboardDismissed).toBe(false);
    expect(result.warnings).toEqual(["keyboard dismissal failed: Keyboard state unavailable"]);
  });

  // A REJECTING closer is the same outcome as a closer that reports
  // `success:false`: the text already landed, so a dismissal epilogue that throws
  // (hierarchy read blew up, KEYCODE_BACK failed) must degrade to the warning
  // shape too, not escape into `execute()`'s outer catch and hand the caller a
  // `success:false` they might answer by re-typing text that is already there.
  test("a11y warns instead of failing when the keyboard closer rejects", async () => {
    const factory = new FakeAdbClientFactory();
    const inputText = new InputText(androidDevice, factory as AdbClientFactory, {
      keyboardCloserFactory: () => ({
        close: async () => {
          throw new Error("KEYCODE_BACK failed");
        },
      }),
    });

    stubAndroidSetText(async () => ({ success: true, totalTimeMs: 1 }));

    const result = await inputText.testHooks.executeAndroidTextInput("hello", {
      dismissKeyboard: true,
    });

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.keyboardDismissed).toBe(false);
    expect(result.warnings).toEqual(["keyboard dismissal failed: KEYCODE_BACK failed"]);
  });

  // Cancellation is NOT a best-effort epilogue failure: a closer that rejects
  // because the device went away must still cancel the call.
  test("a rejecting keyboard closer still propagates cancellation", async () => {
    const controller = new AbortController();
    const deviceLoss = new DeviceLostError(
      androidDevice.deviceId,
      `device-disconnected:${androidDevice.deviceId}`,
    );
    const factory = new FakeAdbClientFactory();
    const inputText = new InputText(androidDevice, factory as AdbClientFactory, {
      keyboardCloserFactory: () => ({
        close: async () => {
          controller.abort(deviceLoss);
          throw new Error("closer aborted");
        },
      }),
    });

    stubAndroidSetText(async () => ({ success: true, totalTimeMs: 1 }));

    await expect(
      inputText.testHooks.executeAndroidTextInput("hello", {
        dismissKeyboard: true,
        mode: "a11y",
        signal: controller.signal,
      }),
    ).rejects.toBe(deviceLoss);
  });

  // A failed TEXT WRITE is still a real error — `isError` stays reserved for it.
  test("a failed setText stays a failure even with dismissKeyboard requested", async () => {
    const factory = new FakeAdbClientFactory();
    const inputText = new InputText(androidDevice, factory as AdbClientFactory, {
      keyboardCloserFactory: () => ({
        close: async () => ({ success: true, open: false, message: "Keyboard closed" }),
      }),
    });

    stubAndroidSetText(async () => ({
      success: false,
      error: "accessibility service unavailable",
      totalTimeMs: 1,
    }));

    const result = await inputText.testHooks.executeAndroidTextInput("hello", {
      dismissKeyboard: true,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("accessibility service unavailable");
    expect(result.warnings).toBeUndefined();
  });

  test("a11y reports setText timeouts without sending key events", async () => {
    const factory = new FakeAdbClientFactory();
    const inputText = new InputText(androidDevice, factory);
    const setTextCalls: string[] = [];

    stubAndroidSetText(async (text) => {
      setTextCalls.push(text);
      return { success: false, error: "Set text timed out after 5000ms", totalTimeMs: 5000 };
    });

    const result = await inputText.testHooks.executeAndroidTextInput("next", {
      dismissKeyboard: false,
      mode: "a11y",
    });

    expect(result.success).toBe(false);
    expect(result.method).toBe("a11y");
    expect(result.error).toContain("Set text timed out after 5000ms");
    expect(setTextCalls).toEqual(["next"]);
    expect(inputCommands(factory)).toEqual([]);
  });

  test("a11y does not fall back to key events for non-timeout failures", async () => {
    const factory = new FakeAdbClientFactory();
    const inputText = new InputText(androidDevice, factory);
    const setTextCalls: string[] = [];

    stubAndroidSetText(async (text) => {
      setTextCalls.push(text);
      return { success: false, error: "No focused editable node found", totalTimeMs: 1 };
    });

    const result = await inputText.testHooks.executeAndroidTextInput("next", {
      dismissKeyboard: false,
      mode: "a11y",
    });

    expect(result.success).toBe(false);
    expect(result.method).toBe("a11y");
    expect(result.error).toContain("No focused editable node found");
    expect(setTextCalls).toEqual(["next"]);
    expect(inputCommands(factory)).toEqual([]);
  });

  test.each(["sent", "refused", "cancelled", "deadline"] as const)(
    "append marks once at its first keyevent after validation: %s",
    async (outcome) => {
      const factory = new FakeAdbClientFactory();
      const timer = new FakeTimer();
      const input = new InputText(androidDevice, factory, { timer });
      const controller = new AbortController();
      let marks = 0;
      const validate = async () => {
        expect(marks).toBe(0);
        if (outcome === "cancelled") {
          controller.abort();
        }
        if (outcome === "deadline") {
          timer.advanceTime(500);
        }
        return { success: outcome !== "refused", error: "stale", failureSource: "runner" as const };
      };
      const pending = input.appendText("abc", {
        timeoutMs: 500,
        beforeKeyEvents: validate,
        signal: controller.signal,
        onDispatch: () => {
          expect(inputCommands(factory)).toEqual([]);
          marks++;
        },
      });
      if (outcome === "cancelled") {
        await expect(pending).rejects.toThrow();
      } else {
        expect((await pending).success).toBe(outcome === "sent");
      }
      expect(marks).toBe(outcome === "sent" ? 1 : 0);
      expect(inputCommands(factory).length).toBe(outcome === "sent" ? 3 : 0);
    },
  );

  // Issue #3351: an interactive client mirroring a keyboard sends one call per
  // keystroke. Every other Android mode is replace-shaped (a11y sets the whole
  // string; eventAll clears first), so per-keystroke typing through
  // them leaves only the last character and wipes whatever was in the field.
  test("append types with key events and never clears or sets text", async () => {
    const factory = new FakeAdbClientFactory();
    const inputText = new InputText(androidDevice, factory);
    const setTextCalls: string[] = [];
    factory.getFakeClient().setCommandResult("shell getprop ro.build.version.sdk", "31\n");

    stubAndroidSetText(async (text) => {
      setTextCalls.push(text);
      return { success: true, totalTimeMs: 1 };
    });

    const result = await inputText.testHooks.executeAndroidTextInput("ab", {
      dismissKeyboard: false,
      mode: "append",
    });

    expect(result.success).toBe(true);
    expect(result.method).toBe("append");
    // The whole point: no ACTION_SET_TEXT at all, so the field's existing
    // contents survive.
    expect(setTextCalls).toEqual([]);
    // And no clear either - unlike eventAll, which clears the field first.
    const commands = inputCommands(factory);
    expect(commands.length).toBeGreaterThan(0);
    expect(commands.some((command) => command.includes("KEYCODE_DEL"))).toBe(false);
  });

  test("append sends one keystroke per call without disturbing earlier ones", async () => {
    // Three separate single-character calls, as a keyboard-mirroring client
    // makes them. None may clear, or "abc" would end up as "c".
    const factory = new FakeAdbClientFactory();
    const inputText = new InputText(androidDevice, factory);
    const setTextCalls: string[] = [];
    factory.getFakeClient().setCommandResult("shell getprop ro.build.version.sdk", "31\n");

    stubAndroidSetText(async (text) => {
      setTextCalls.push(text);
      return { success: true, totalTimeMs: 1 };
    });

    for (const char of ["a", "b", "c"]) {
      const result = await inputText.appendText(char);
      expect(result.success).toBe(true);
    }

    expect(setTextCalls).toEqual([]);
    expect(inputCommands(factory).some((command) => command.includes("KEYCODE_DEL"))).toBe(false);
  });

  test("append fails rather than falling back to a destructive a11y setText", async () => {
    // The fallback every other mode performs would REPLACE the field, which is
    // exactly what append exists to avoid. An actionable error is correct.
    const factory = new FakeAdbClientFactory();
    const inputText = new InputText(androidDevice, factory);
    const setTextCalls: string[] = [];

    stubAndroidSetText(async (text) => {
      setTextCalls.push(text);
      return { success: true, totalTimeMs: 1 };
    });

    const result = await inputText.testHooks.executeAndroidTextInput("😊", {
      dismissKeyboard: false,
      mode: "append",
    });

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
    const inputText = new InputText(androidDevice, factory);
    // Cold cache: no getprop result configured, and the probe must never run.
    const result = await inputText.appendText("a1 .");

    expect(result.success).toBe(true);
    const allCommands = factory.getFakeClient().getAllCommands();
    expect(allCommands.some((command) => command.includes("getprop ro.build.version.sdk"))).toBe(
      false,
    );
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
    const inputText = new InputText(androidDevice, factory);
    factory.getFakeClient().setCommandResult("shell getprop ro.build.version.sdk", "31\n");

    const result = await inputText.appendText("A");

    expect(result.success).toBe(true);
    const allCommands = factory.getFakeClient().getAllCommands();
    expect(allCommands.some((command) => command.includes("getprop ro.build.version.sdk"))).toBe(
      true,
    );
    expect(inputCommands(factory)).toEqual([
      "shell input keycombination KEYCODE_SHIFT_LEFT KEYCODE_A",
    ]);
  });

  // Issue #3351: append is best-effort and char-by-char, so a partial failure must
  // report how much of `text` landed. A caller retrying the whole string after a
  // prefix already typed would corrupt the field ("ab" after "a" -> "aab").
  test("append reports charsSent for a fully successful batch", async () => {
    const factory = new FakeAdbClientFactory();
    const inputText = new InputText(androidDevice, factory);

    const result = await inputText.appendText("abc");

    expect(result.success).toBe(true);
    expect(result.charsSent).toBe(3);
  });

  test("append reports charsSent up to the failing character, not a generic failure", async () => {
    // "abc": KEYCODE_A lands, KEYCODE_B rejects (device offline mid-batch), so the
    // field holds "a". The result must say charsSent=1 and KEYCODE_C must never run,
    // so a caller resumes from text.slice(1) instead of re-appending "abc".
    const factory = new FakeAdbClientFactory();
    const inputText = new InputText(androidDevice, factory);
    factory
      .getFakeClient()
      .setCommandError("shell input keyevent KEYCODE_B", new Error("device offline"));

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
    const inputText = new InputText(androidDevice, factory);
    const setTextCalls: string[] = [];
    factory.getFakeClient().setCommandResult("shell getprop ro.build.version.sdk", "30\n");

    stubAndroidSetText(async (text) => {
      setTextCalls.push(text);
      return { success: true, totalTimeMs: 1 };
    });

    const result = await inputText.appendText("A");

    expect(result.success).toBe(false);
    expect(result.error).toContain('append cannot type "A"');
    // Not typed, and emphatically not repaired by a setText that would wipe the field.
    expect(setTextCalls).toEqual([]);
    expect(inputCommands(factory)).toEqual([]);
  });

  test("append still types uppercase on API 31 and above", async () => {
    // The other direction: the failure above must be the device's limitation, not
    // the append path refusing capitals outright.
    const factory = new FakeAdbClientFactory();
    const inputText = new InputText(androidDevice, factory);
    factory.getFakeClient().setCommandResult("shell getprop ro.build.version.sdk", "31\n");
    stubAndroidSetText(async () => ({ success: true, totalTimeMs: 1 }));

    const result = await inputText.appendText("A");

    expect(result.success).toBe(true);
    expect(inputCommands(factory)).toEqual([
      "shell input keycombination KEYCODE_SHIFT_LEFT KEYCODE_A",
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
            new AdbCommandTimeoutError(
              "Command timed out after 5ms: adb shell getprop ro.build.version.sdk",
            ),
          );
        }
        return Promise.resolve(execResult("31\n"));
      }
      // Key events (and anything else) succeed.
      return Promise.resolve(execResult(""));
    };
    const adb = new AdbClient(androidDevice, exec, { timer: new FakeTimer() });
    // Inject a FakeTimer into InputText too: createBudget reads THIS clock, so a
    // wall clock here would race the 5ms budget against the char-unmappable path
    // (repo rule: no real timers in unit tests). Never advanced, so the budget
    // stays positive and the "cannot type" path is exercised deterministically.
    const inputText = new InputText(androidDevice, adb, { timer: new FakeTimer() });

    const whileTimedOut = await inputText.appendText("A", { timeoutMs: 5 });
    expect(whileTimedOut.success).toBe(false);
    expect(whileTimedOut.error).toContain("append cannot type");

    // Fresh budget on the next keystroke: neither InputText nor AdbClient may have
    // cached the timed-out probe as "unsupported", so the capital now types.
    timeOut = false;
    const afterRetry = await inputText.appendText("A", { timeoutMs: 5000 });
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
          new AdbCommandTimeoutError(
            "Command timed out after 5ms: adb shell input keyevent KEYCODE_A",
          ),
        );
      }
      return Promise.resolve(execResult(""));
    };
    const adb = new AdbClient(androidDevice, exec, { timer: new FakeTimer() });
    // FakeTimer into InputText as well, so createBudget never reads the wall clock
    // (repo rule: no real timers). Never advanced, so the budget cannot expire and
    // the assertion is purely about the retry count, not timing.
    const inputText = new InputText(androidDevice, adb, { timer: new FakeTimer() });

    const result = await inputText.appendText("a", { timeoutMs: 5000 });

    expect(result.success).toBe(false);
    expect(result.error).toContain("append key event failed");
    expect(result.charsSent).toBeUndefined();
    // Exactly one attempt: the deadline is not multiplied by the retry count.
    expect(keyEventCalls).toBe(1);
  });

  test("append dispatches every key event with noRetry so one budget covers the whole append", async () => {
    const exec = (command: string): Promise<ExecResult> =>
      Promise.resolve(execResult(command.includes("getprop ro.build.version.sdk") ? "31\n" : ""));
    const adb = new AdbClient(androidDevice, exec, { timer: new FakeTimer() });
    const execute = spyOn(adb, "execute");
    const inputText = new InputText(androidDevice, adb, { timer: new FakeTimer() });

    const result = await inputText.appendText("ab", { timeoutMs: 5000 });

    expect(result.success).toBe(true);
    const keyEventOptions = execute.mock.calls
      .filter(([args]) => args.includes("keyevent"))
      .map(([, options]) => options?.noRetry);
    expect(keyEventOptions).toEqual([true, true]);
  });

  test("a timed-out later append key leaves the retry boundary ambiguous", async () => {
    const exec = (command: string): Promise<ExecResult> => {
      if (command.includes("input keyevent KEYCODE_B")) {
        return Promise.reject(
          new AdbCommandTimeoutError(
            "Command timed out after 5ms: adb shell input keyevent KEYCODE_B",
          ),
        );
      }
      return Promise.resolve(execResult(""));
    };
    const adb = new AdbClient(androidDevice, exec, { timer: new FakeTimer() });
    const inputText = new InputText(androidDevice, adb, { timer: new FakeTimer() });

    const result = await inputText.appendText("ab", { timeoutMs: 5000 });

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
    const inputText = new InputText(androidDevice, factory as AdbClientFactory, { timer });
    factory.getFakeClient().setCommandResult("shell getprop ro.build.version.sdk", "31\n");
    stubAndroidSetText(async () => ({ success: true, totalTimeMs: 1 }));

    const result = await inputText.appendText("ab", { timeoutMs: 5_000 });

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
    const inputText = new InputText(androidDevice, factory as AdbClientFactory, { timer });
    factory.getFakeClient().setCommandResult("shell getprop ro.build.version.sdk", "31\n");
    stubAndroidSetText(async () => ({ success: true, totalTimeMs: 1 }));

    // The budget is already gone by the time the first device round trip is due.
    const result = await inputText.appendText("a", { timeoutMs: 0 });

    expect(result.success).toBe(false);
    expect(result.error).toContain("append exceeded its 0ms budget");
    expect(inputCommands(factory)).toEqual([]);
  });
});
