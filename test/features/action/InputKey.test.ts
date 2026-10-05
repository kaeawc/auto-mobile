import { describe, expect, mock, spyOn, test } from "bun:test";
import { InputKey } from "../../../src/features/action/InputKey";
import { ActionableError, type BootedDevice } from "../../../src/models";
import { DeviceLostError } from "../../../src/models/DeviceLostError";
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
  test.each(["cancelled", "timed out", "closed"])(
    "reports an indeterminate outcome when ADB fails after dispatch: %s",
    async (reason) => {
      const fakeAdb = new FakeAdbExecutor();
      const controller = new AbortController();
      const onDispatch = mock(() => {});
      spyOn(fakeAdb, "execute").mockImplementation(async (_args, options) => {
        await options?.beforeDispatch?.(options.timeoutMs);
        if (reason === "cancelled") {
          controller.abort();
        }
        throw new Error(`ADB keyevent ${reason}`);
      });
      const inputKey = new InputKey(
        androidDevice,
        createAdbFactory(fakeAdb),
        undefined,
        new FakeTimer(),
      );
      const result = inputKey.press("enter", 500, undefined, [], {
        signal: controller.signal,
        onDispatch,
      });

      await expect(result).rejects.toBeInstanceOf(ActionableError);
      await expect(result).rejects.toThrow(
        `Key outcome is indeterminate: the request was dispatched but did not complete normally (ADB keyevent ${reason}). The key may have been delivered. Do not retry automatically.`,
      );
      expect(onDispatch).toHaveBeenCalledTimes(1);
    },
  );

  test("tracks dispatch even when the direct caller supplies no onDispatch", async () => {
    const fakeAdb = new FakeAdbExecutor();
    fakeAdb.setCommandError("KEYCODE_ENTER", new Error("ADB reply timed out"));
    const inputKey = new InputKey(
      androidDevice,
      createAdbFactory(fakeAdb),
      undefined,
      new FakeTimer(),
    );

    await expect(inputKey.press("enter", 500)).rejects.toThrow("Key outcome is indeterminate");
    expect(fakeAdb.getExecutedCommands()).toEqual(["shell input keyevent KEYCODE_ENTER"]);
  });

  test.each([undefined, new DeviceLostError(androidDevice.deviceId, "device disconnected")])(
    "preserves pre-dispatch cancellation without invoking ADB: %s",
    async (reason) => {
      const fakeAdb = new FakeAdbExecutor();
      const execute = spyOn(fakeAdb, "execute");
      const controller = new AbortController();
      controller.abort(reason);
      const onDispatch = mock(() => {});
      const inputKey = new InputKey(
        androidDevice,
        createAdbFactory(fakeAdb),
        undefined,
        new FakeTimer(),
      );
      const result = inputKey.press("enter", 500, undefined, [], {
        signal: controller.signal,
        onDispatch,
      });

      if (reason) {
        await expect(result).rejects.toBe(reason);
      } else {
        await expect(result).rejects.toThrow("Operation cancelled");
      }
      expect(execute).not.toHaveBeenCalled();
      expect(fakeAdb.getExecutedCommands()).toEqual([]);
      expect(onDispatch).not.toHaveBeenCalled();
    },
  );

  test.each([false, true])(
    "does not dispatch when cancellation arrives during frame validation: %s",
    async (success) => {
      const fakeAdb = new FakeAdbExecutor();
      const controller = new AbortController();
      const onDispatch = mock(() => {});
      const validator = {
        validateFrameContext: async () => {
          controller.abort();
          return { success, error: success ? undefined : "Stale frame context" };
        },
      };
      const inputKey = new InputKey(
        androidDevice,
        createAdbFactory(fakeAdb),
        validator,
        new FakeTimer(),
      );

      await expect(
        inputKey.press("enter", 500, "frame-1", [], { signal: controller.signal, onDispatch }),
      ).rejects.toThrow("Operation cancelled");
      expect(onDispatch).not.toHaveBeenCalled();
      expect(fakeAdb.getExecutedCommands()).toEqual([]);
    },
  );

  test("reports an indeterminate outcome if ADB resolves after cancellation", async () => {
    const fakeAdb = new FakeAdbExecutor();
    const controller = new AbortController();
    fakeAdb.abortAfterCommand("KEYCODE_ENTER", controller);
    const inputKey = new InputKey(
      androidDevice,
      createAdbFactory(fakeAdb),
      undefined,
      new FakeTimer(),
    );

    const result = inputKey.press("enter", 500, undefined, [], { signal: controller.signal });
    await expect(result).rejects.toThrow("Key outcome is indeterminate");
    await expect(result).rejects.toThrow("Do not retry automatically");
    await expect(result).rejects.not.toThrow("no result was confirmed");
    expect(fakeAdb.getExecutedCommands()).toEqual(["shell input keyevent KEYCODE_ENTER"]);
  });

  test("throws Operation cancelled when the ADB keyevent is cancelled", async () => {
    const fakeAdb = new FakeAdbExecutor();
    const controller = new AbortController();
    const execute = spyOn(fakeAdb, "execute").mockImplementation(async (_args, options) => {
      expect(options?.signal).toBe(controller.signal);
      controller.abort();
      throw new Error("ADB keyevent cancelled");
    });
    const inputKey = new InputKey(
      androidDevice,
      createAdbFactory(fakeAdb),
      undefined,
      new FakeTimer(),
    );

    await expect(
      inputKey.press("enter", 500, undefined, [], { signal: controller.signal }),
    ).rejects.toThrow("Operation cancelled");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  test("preserves an iOS arrow failure and an unverified result from the runner", async () => {
    let response = {
      success: false,
      error:
        "arrow keys have no effect on this iOS runtime; use Cmd+arrow (line start/end) or sendKeys text editing instead",
      verified: undefined as boolean | undefined,
    };
    const requestPressKey = mock(async () => response);
    const inputKey = new InputKey(
      iosDevice,
      createAdbFactory(new FakeAdbExecutor()),
      undefined,
      new FakeTimer(),
      () => ({ requestPressKey }),
    );

    expect(await inputKey.press("arrow_left")).toMatchObject({
      success: false,
      error:
        "arrow keys have no effect on this iOS runtime; use Cmd+arrow (line start/end) or sendKeys text editing instead",
    });
    response = { success: true, error: undefined, verified: false };
    expect(await inputKey.press("arrow_left")).toMatchObject({ success: true, verified: false });
  });

  test("carries an iOS delete warning and preserves a reliable-field failure", async () => {
    const requestPressKey = mock(async () => ({
      success: true,
      warning: "Key 'backspace' value did not change; delivery could not be confirmed",
      error: undefined as string | undefined,
    }));
    const inputKey = new InputKey(
      iosDevice,
      createAdbFactory(new FakeAdbExecutor()),
      undefined,
      new FakeTimer(),
      () => ({ requestPressKey }),
    );
    expect(await inputKey.press("backspace")).toMatchObject({
      success: true,
      warning: "Key 'backspace' value did not change; delivery could not be confirmed",
    });
    requestPressKey.mockImplementation(async () => ({
      success: false,
      warning: undefined,
      error: "Key 'backspace' did not decrease text length: before 4, observed 4",
    }));
    expect(await inputKey.press("backspace")).toMatchObject({
      success: false,
      error: "Key 'backspace' did not decrease text length: before 4, observed 4",
    });
  });

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

  test("sends modifier chords through Android input keycombination", async () => {
    const fakeAdb = new FakeAdbExecutor();
    fakeAdb.setAndroidApiLevel(31);
    const inputKey = new InputKey(androidDevice, createAdbFactory(fakeAdb));

    const result = await inputKey.press("tab", 500, undefined, ["shift", "ctrl"]);

    expect(result.success).toBe(true);
    expect(fakeAdb.getExecutedCommands()).toEqual([
      "shell input keycombination KEYCODE_SHIFT_LEFT KEYCODE_CTRL_LEFT KEYCODE_TAB",
    ]);
  });

  test("rejects modifier chords below Android API 31", async () => {
    const fakeAdb = new FakeAdbExecutor();
    fakeAdb.setAndroidApiLevel(30);
    const inputKey = new InputKey(androidDevice, createAdbFactory(fakeAdb));

    const result = await inputKey.press("tab", 500, undefined, ["shift"]);

    expect(result.success).toBe(false);
    expect(result.error).toContain("Android API 31+");
    expect(fakeAdb.getExecutedCommands()).toEqual([]);
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

  test.each([
    new Error("device offline"),
    new Error("device 'x' not found"),
    Object.assign(new Error("spawn adb ENOENT"), { code: "ENOENT" }),
    Object.assign(new Error("spawn adb EACCES"), { code: "EACCES" }),
    new Error("ADB unavailable", {
      cause: Object.assign(new Error("spawn adb ENOENT"), { code: "ENOENT" }),
    }),
    new Error("ADB unavailable", {
      cause: Object.assign(new Error("spawn adb EACCES"), { code: "EACCES" }),
    }),
    Object.assign(new Error("spawn adb ENOENT", { cause: new Error("unknown") }), {
      code: "ENOENT",
    }),
    new Error("executable not found: adb"),
    new Error("error: no devices/emulators found"),
    new Error("error: cannot connect to daemon at tcp:5037"),
    new Error("error: cannot connect to the daemon at tcp:5037"),
    new Error("error: cannot connect to adb at tcp:5037"),
    Object.assign(new Error("Command failed: adb shell input keyevent KEYCODE_TAB"), {
      stderr: "error: device offline",
    }),
    Object.assign(new Error("Command failed: adb shell input keyevent KEYCODE_TAB"), {
      stderr: Buffer.from("error: device 'x' not found"),
    }),
    new Error("ADB command failed", {
      cause: Object.assign(new Error("Command failed: adb shell input keyevent KEYCODE_TAB"), {
        stderr: "error: cannot connect to daemon",
      }),
    }),
  ])("wraps an ADB keyevent failure in a stable error envelope: %s", async (error) => {
    const fakeAdb = new FakeAdbExecutor();
    const onDispatch = mock(() => {});
    spyOn(fakeAdb, "execute").mockImplementation(async (_args, options) => {
      await options?.beforeDispatch?.(options.timeoutMs);
      throw error;
    });
    const inputKey = new InputKey(
      androidDevice,
      createAdbFactory(fakeAdb),
      undefined,
      new FakeTimer(),
    );

    const result = await inputKey.press("tab", 500, undefined, [], {
      signal: new AbortController().signal,
      onDispatch,
    });

    expect(result).toEqual({
      success: false,
      key: "tab",
      keyCode: "KEYCODE_TAB",
      error: `Failed to press key "tab": ${error.message}`,
    });
    expect(onDispatch).toHaveBeenCalledTimes(1);
  });

  test("preserves plain cancellation for a provably undelivered key after the hook", async () => {
    const fakeAdb = new FakeAdbExecutor();
    const controller = new AbortController();
    spyOn(fakeAdb, "execute").mockImplementation(async (_args, options) => {
      await options?.beforeDispatch?.(options.timeoutMs);
      controller.abort();
      throw new Error("device offline");
    });
    const inputKey = new InputKey(
      androidDevice,
      createAdbFactory(fakeAdb),
      undefined,
      new FakeTimer(),
    );

    const result = inputKey.press("tab", 500, undefined, [], { signal: controller.signal });
    await expect(result).rejects.toThrow("Operation cancelled");
    await expect(result).rejects.not.toThrow("Key outcome is indeterminate");
  });

  test.each([
    new Error("Command failed: adb shell input keyevent 'device offline'"),
    new Error("Command failed: adb shell input keyevent \"device 'x' not found\""),
    new Error("Command failed: adb shell input keyevent 'no devices/emulators found'"),
    new Error("Command failed: adb shell input keyevent 'cannot connect to daemon'"),
    new Error("Command failed: adb shell input keyevent 'cannot connect to the daemon'"),
    new Error("Command failed: adb shell input keyevent 'cannot connect to adb'"),
    Object.assign(new Error("Command failed: adb shell input keyevent 'device offline'"), {
      stderr: "closed",
    }),
    Object.assign(new Error("device offline"), { stderr: "unknown ADB failure" }),
  ])(
    "keeps unknown failures indeterminate without trusting command arguments: %s",
    async (error) => {
      const fakeAdb = new FakeAdbExecutor();
      fakeAdb.setCommandError("KEYCODE_TAB", error);
      const inputKey = new InputKey(
        androidDevice,
        createAdbFactory(fakeAdb),
        undefined,
        new FakeTimer(),
      );

      await expect(inputKey.press("tab", 500)).rejects.toThrow("Key outcome is indeterminate");
    },
  );

  test("routes iOS discrete keys and modifiers through CtrlProxy", async () => {
    const fakeAdb = new FakeAdbExecutor();
    const requestPressKey = mock(async () => ({ success: true }));
    const inputKey = new InputKey(
      iosDevice,
      createAdbFactory(fakeAdb),
      undefined,
      new FakeTimer(),
      () => ({ requestPressKey }),
    );

    const result = await inputKey.press("enter", 500, undefined, ["meta"]);

    expect(result).toEqual({
      success: true,
      key: "enter",
      keyCode: "enter",
    });
    expect(requestPressKey).toHaveBeenCalledWith(
      "enter",
      ["meta"],
      500,
      undefined,
      undefined,
      undefined,
    );
    expect(fakeAdb.getExecutedCommands()).toEqual([]);
  });
});
