import { describe, expect, test } from "bun:test";
import { InputKey } from "../../../src/features/action/InputKey";
import type { BootedDevice } from "../../../src/models";
import type { AdbClientFactory } from "../../../src/utils/android-cmdline-tools/AdbClientFactory";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";

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
    const inputKey = new InputKey(androidDevice, createAdbFactory(fakeAdb));

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
