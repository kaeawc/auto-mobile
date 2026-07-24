import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { InputText } from "../../../src/features/action/InputText";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import type { InputTextMode } from "../../../src/features/action/InputText";
import type { BootedDevice, DeviceLockState } from "../../../src/models";
import type { AdbClientFactory } from "../../../src/utils/android-cmdline-tools/AdbClientFactory";

interface TestInputText {
  executeAndroidTextInput: (
    text: string,
    imeAction?: undefined,
    dismissKeyboard?: boolean,
    mode?: InputTextMode
  ) => Promise<{ success: boolean; error?: string; method?: string; warnings?: string[] }>;
}

const LOCKED_SECURE: DeviceLockState = { locked: true, keyguardShowing: true, secure: true };
const UNLOCKED: DeviceLockState = { locked: false, keyguardShowing: false, secure: true };

const KEYGUARD_PIN_COMMANDS = [
  "shell input keyevent KEYCODE_WAKEUP",
  "shell input keyevent KEYCODE_MENU",
  "shell input keyevent KEYCODE_1",
  "shell input keyevent KEYCODE_2",
  "shell input keyevent KEYCODE_3",
  "shell input keyevent KEYCODE_4",
  "shell input keyevent KEYCODE_ENTER",
];

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

  // Regression for https://github.com/kaeawc/auto-mobile/issues/4360.
  // A secure PIN bouncer is not an editable a11y node, so a11y setText can
  // never work there; today the call dead-ends on the a11y error even though
  // the credential can still be delivered as key events. When (and only when)
  // the pre-check shows a locked keyguard, InputText raises the bouncer and
  // types the PIN via key events, then grounds the outcome in a re-read of the
  // lock state — never trusting the send.
  describe("keyguard key-event fallback (#4360)", () => {
    test("a11y failure on a locked keyguard: types PIN via key events and reports success", async () => {
      const adb = new FakeAdbExecutor();
      adb.setAndroidApiLevel(35);
      adb.setDeviceLockSequence([LOCKED_SECURE, UNLOCKED]);
      const inputText = new InputText(androidDevice, adb);

      stubAndroidSetText(async () => ({
        success: false,
        error: "No focused editable node found",
        totalTimeMs: 1,
      }));

      const result = await testInputText(inputText).executeAndroidTextInput("1234");

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result.method).toBe("eventAll");
      expect(result.warnings?.[0]).toContain("No focused editable node found");
      expect(adb.getExecutedCommands()).toEqual(KEYGUARD_PIN_COMMANDS);
    });

    test("device not locked: a11y failure is returned unchanged, no key events sent", async () => {
      const adb = new FakeAdbExecutor();
      adb.setDeviceLock(UNLOCKED);
      const inputText = new InputText(androidDevice, adb);

      stubAndroidSetText(async () => ({
        success: false,
        error: "No focused editable node found",
        totalTimeMs: 1,
      }));

      const result = await testInputText(inputText).executeAndroidTextInput("1234");

      expect(result.success).toBe(false);
      expect(result.method).toBe("a11y");
      expect(result.error).toContain("No focused editable node found");
      expect(result.warnings).toBeUndefined();
      expect(adb.getExecutedCommands()).toEqual([]);
    });

    test("keyguard still up after the attempt: failure is attributed to the keyguard leg", async () => {
      const adb = new FakeAdbExecutor();
      adb.setAndroidApiLevel(35);
      adb.setDeviceLockSequence([LOCKED_SECURE, LOCKED_SECURE]);
      const inputText = new InputText(androidDevice, adb);

      stubAndroidSetText(async () => ({
        success: false,
        error: "No focused editable node found",
        totalTimeMs: 1,
      }));

      const result = await testInputText(inputText).executeAndroidTextInput("1234");

      expect(result.success).toBe(false);
      expect(result.error).toContain("remained locked");
      expect(adb.getExecutedCommands()).toEqual(KEYGUARD_PIN_COMMANDS);
    });

    test("locked keyguard but text is not key-event-mappable: original a11y failure preserved", async () => {
      const adb = new FakeAdbExecutor();
      adb.setDeviceLock(LOCKED_SECURE);
      const inputText = new InputText(androidDevice, adb);

      stubAndroidSetText(async () => ({
        success: false,
        error: "No focused editable node found",
        totalTimeMs: 1,
      }));

      const result = await testInputText(inputText).executeAndroidTextInput("你好");

      expect(result.success).toBe(false);
      expect(result.method).toBe("a11y");
      expect(result.error).toContain("No focused editable node found");
      expect(adb.getExecutedCommands()).toEqual([]);
    });

    test("a11y success is unaffected: no lock read, no key events", async () => {
      const adb = new FakeAdbExecutor();
      adb.setDeviceLock(LOCKED_SECURE);
      const inputText = new InputText(androidDevice, adb);

      stubAndroidSetText(async () => ({ success: true, totalTimeMs: 1 }));

      const result = await testInputText(inputText).executeAndroidTextInput("1234");

      expect(result.success).toBe(true);
      expect(result.method).toBe("a11y");
      expect(adb.getExecutedCommands()).toEqual([]);
    });
  });
});
