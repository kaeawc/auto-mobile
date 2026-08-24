import { describe, expect, test } from "bun:test";
import { InputKey } from "../../../src/features/action/InputKey";
import type { BootedDevice } from "../../../src/models";
import type { AdbClientFactory } from "../../../src/utils/android-cmdline-tools/AdbClientFactory";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../fakes/FakeTimer";

const androidDevice: BootedDevice = {
  deviceId: "emulator-5554",
  name: "Pixel",
  platform: "android",
};

const iosDevice: BootedDevice = {
  deviceId: "ios-sim-1",
  name: "iPhone 16",
  platform: "ios",
};

function createAdbFactory(fakeAdb: FakeAdbExecutor): AdbClientFactory {
  return {
    create: () => fakeAdb,
  };
}

describe("InputKey", () => {
  test("sends supported Android keys through ADB keyevent with the caller timeout", async () => {
    const fakeAdb = new FakeAdbExecutor();
    // Inject a FakeTimer so `now()` is constant: with the real timer, a 1ms tick between the two
    // `timer.now()` calls in press() intermittently made the forwarded timeout 1233 not 1234 (#4696).
    const inputKey = new InputKey(
      androidDevice,
      createAdbFactory(fakeAdb),
      undefined,
      new FakeTimer(),
    );

    const result = await inputKey.press("enter", 1234);

    expect(result).toEqual({
      success: true,
      key: "enter",
      keyCode: "KEYCODE_ENTER",
    });
    expect(fakeAdb.getExecutedCommands()).toEqual(["shell input keyevent KEYCODE_ENTER"]);
    expect(fakeAdb.getCommandCalls()).toEqual([
      {
        command: "shell input keyevent KEYCODE_ENTER",
        timeoutMs: 1234,
        maxBuffer: undefined,
        noRetry: true,
        signal: undefined,
      },
    ]);
  });

  test("maps the full first-version key set to Android keyevents", async () => {
    const fakeAdb = new FakeAdbExecutor();
    const inputKey = new InputKey(androidDevice, createAdbFactory(fakeAdb));

    for (const key of [
      "enter",
      "tab",
      "escape",
      "backspace",
      "delete",
      "arrow_up",
      "arrow_down",
      "arrow_left",
      "arrow_right",
    ] as const) {
      await inputKey.press(key, 500);
    }

    expect(fakeAdb.getExecutedCommands()).toEqual([
      "shell input keyevent KEYCODE_ENTER",
      "shell input keyevent KEYCODE_TAB",
      "shell input keyevent KEYCODE_ESCAPE",
      "shell input keyevent KEYCODE_DEL",
      "shell input keyevent KEYCODE_FORWARD_DEL",
      "shell input keyevent KEYCODE_DPAD_UP",
      "shell input keyevent KEYCODE_DPAD_DOWN",
      "shell input keyevent KEYCODE_DPAD_LEFT",
      "shell input keyevent KEYCODE_DPAD_RIGHT",
    ]);
  });

  test("does not issue an ADB keyevent when device validation rejects a frame context", async () => {
    const fakeAdb = new FakeAdbExecutor();
    const validator = {
      validateFrameContext: async () => ({
        success: false,
        error: "Stale frame context for input/key; observe a fresh frame before retrying",
      }),
    };
    const inputKey = new InputKey(
      androidDevice,
      createAdbFactory(fakeAdb),
      validator,
      new FakeTimer(),
    );

    const result = await inputKey.press("enter", 1234, "epoch:2");

    expect(result).toEqual({
      success: false,
      key: "enter",
      keyCode: "KEYCODE_ENTER",
      error: "Stale frame context for input/key; observe a fresh frame before retrying",
    });
    expect(fakeAdb.getExecutedCommands()).toEqual([]);
  });

  test("validates a supplied frame context before issuing an ADB keyevent", async () => {
    const fakeAdb = new FakeAdbExecutor();
    const calls: Array<[string, number | undefined]> = [];
    const validator = {
      validateFrameContext: async (frameContext: string, timeoutMs?: number) => {
        calls.push([frameContext, timeoutMs]);
        return { success: true };
      },
    };
    const inputKey = new InputKey(
      androidDevice,
      createAdbFactory(fakeAdb),
      validator,
      new FakeTimer(),
    );

    await inputKey.press("tab", 1234, "epoch:3");

    expect(calls).toEqual([["epoch:3", 1234]]);
    expect(fakeAdb.getExecutedCommands()).toEqual(["shell input keyevent KEYCODE_TAB"]);
  });

  test("shares one deadline between frame validation and the ADB keyevent", async () => {
    const fakeAdb = new FakeAdbExecutor();
    const timer = new FakeTimer();
    const validationTimeouts: number[] = [];
    const validator = {
      validateFrameContext: async (_frameContext: string, timeoutMs?: number) => {
        validationTimeouts.push(timeoutMs ?? -1);
        timer.advanceTime(400);
        return { success: true };
      },
    };
    const inputKey = new InputKey(androidDevice, createAdbFactory(fakeAdb), validator, timer);

    const result = await inputKey.press("tab", 1_000, "epoch:4");

    expect(result.success).toBe(true);
    expect(validationTimeouts).toEqual([1_000]);
    expect(fakeAdb.getCommandCalls()).toEqual([
      {
        command: "shell input keyevent KEYCODE_TAB",
        timeoutMs: 1_000,
        maxBuffer: undefined,
        noRetry: true,
        signal: undefined,
      },
    ]);
  });

  test("does not issue an ADB keyevent after validation exhausts the shared deadline", async () => {
    const fakeAdb = new FakeAdbExecutor();
    const timer = new FakeTimer();
    const validator = {
      validateFrameContext: async () => {
        timer.advanceTime(1_000);
        return { success: true };
      },
    };
    const inputKey = new InputKey(androidDevice, createAdbFactory(fakeAdb), validator, timer);

    const result = await inputKey.press("tab", 1_000, "epoch:5");

    expect(result.success).toBe(false);
    expect(result.error).toContain("deadline exhausted");
    expect(fakeAdb.getExecutedCommands()).toEqual([]);
  });

  test("wraps an ADB keyevent failure in a stable error envelope", async () => {
    const fakeAdb = new FakeAdbExecutor();
    fakeAdb.setCommandError("KEYCODE_TAB", new Error("device offline"));
    const inputKey = new InputKey(androidDevice, createAdbFactory(fakeAdb));

    const result = await inputKey.press("tab", 500);

    expect(result).toEqual({
      success: false,
      key: "tab",
      keyCode: "KEYCODE_TAB",
      error: 'Failed to press key "tab": device offline',
    });
  });

  test("returns an explicit unsupported-platform result for iOS", async () => {
    const fakeAdb = new FakeAdbExecutor();
    const inputKey = new InputKey(iosDevice, createAdbFactory(fakeAdb));

    const result = await inputKey.press("enter", 500);

    expect(result).toEqual({
      success: false,
      key: "enter",
      keyCode: "",
      error: "input/key is unsupported on ios; CtrlProxy does not expose discrete key events",
    });
    expect(fakeAdb.getExecutedCommands()).toEqual([]);
  });
});
