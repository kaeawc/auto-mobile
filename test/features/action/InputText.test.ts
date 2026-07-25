import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { InputText } from "../../../src/features/action/InputText";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import type { InputTextMode } from "../../../src/features/action/InputText";
import type { BootedDevice, ObserveResult } from "../../../src/models";
import type { AdbClientFactory } from "../../../src/utils/android-cmdline-tools/AdbClientFactory";

interface TestInputText {
  executeAndroidTextInput: (
    text: string,
    imeAction?: undefined,
    dismissKeyboard?: boolean,
    mode?: InputTextMode,
    previousObserveResult?: ObserveResult
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

    const result = await testInputText(inputText).executeAndroidTextInput(
      "next",
      undefined,
      false,
      "eventOnly",
      observeResultWithFocusedText("existing", properties)
    );

    expect(result.success).toBe(false);
    expect(result.method).toBe("eventOnly");
    expect(result.error).toBe("eventOnly requires a focused editable field");
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
});
