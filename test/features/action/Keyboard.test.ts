import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Keyboard } from "../../../src/features/action/Keyboard";
import { IOSCtrlProxyClient } from "../../../src/features/observe/ios";
import { BootedDevice, ViewHierarchyResult } from "../../../src/models";
import { AdbClientFactory } from "../../../src/utils/android-cmdline-tools/AdbClientFactory";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeKeyboardHierarchyProvider } from "../../fakes/FakeKeyboardHierarchyProvider";
import { FakeTimer } from "../../fakes/FakeTimer";

describe("Keyboard", () => {
  let fakeAdb: FakeAdbExecutor;
  let fakeAdbFactory: AdbClientFactory;
  let fakeHierarchy: FakeKeyboardHierarchyProvider;
  let fakeTimer: FakeTimer;

  const testDevice: BootedDevice = {
    deviceId: "test-device",
    platform: "android",
    name: "Test Device",
  };

  const iosDevice: BootedDevice = {
    deviceId: "ios-device",
    platform: "ios",
    name: "iPhone",
  };

  const baseHierarchy = (): ViewHierarchyResult => ({
    hierarchy: {
      node: {
        $: {},
      },
    },
  });

  const keyboardWindowHierarchy = (): ViewHierarchyResult => ({
    ...baseHierarchy(),
    windows: [
      {
        type: 2,
        bounds: { left: 0, top: 1200, right: 1080, bottom: 1920 },
      },
    ],
  });

  const keyboardNodeHierarchy = (): ViewHierarchyResult => ({
    hierarchy: {
      node: {
        $: {
          "content-desc": "Delete",
        },
      },
    },
  });

  const focusedInputHierarchy = (): ViewHierarchyResult => ({
    hierarchy: {
      node: {
        $: {
          focused: "true",
          class: "android.widget.EditText",
          bounds: { left: 10, top: 20, right: 210, bottom: 120 },
        },
      },
    },
  });

  beforeEach(() => {
    fakeAdb = new FakeAdbExecutor();
    fakeAdbFactory = { create: () => fakeAdb };
    fakeHierarchy = new FakeKeyboardHierarchyProvider();
    fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
  });

  test("detect returns bounds from input method window", async () => {
    fakeHierarchy.setResults([keyboardWindowHierarchy()]);
    const keyboard = new Keyboard(testDevice, fakeAdbFactory, fakeHierarchy, fakeTimer);

    const result = await keyboard.execute("detect");

    expect(result.success).toBe(true);
    expect(result.open).toBe(true);
    expect(result.bounds).toEqual([{ left: 0, top: 1200, right: 1080, bottom: 1920 }]);
  });

  test("detect falls back to hierarchy when window info is missing", async () => {
    fakeHierarchy.setResults([keyboardNodeHierarchy()]);
    const keyboard = new Keyboard(testDevice, fakeAdbFactory, fakeHierarchy, fakeTimer);

    const result = await keyboard.execute("detect");

    expect(result.success).toBe(true);
    expect(result.open).toBe(true);
    expect(result.bounds).toBeUndefined();
  });

  test("open taps focused input when keyboard is closed", async () => {
    fakeHierarchy.setResults([focusedInputHierarchy(), keyboardWindowHierarchy()]);
    const keyboard = new Keyboard(testDevice, fakeAdbFactory, fakeHierarchy, fakeTimer);

    const result = await keyboard.execute("open");

    expect(result.success).toBe(true);
    expect(result.open).toBe(true);
    expect(fakeAdb.wasCommandExecuted("shell input tap")).toBe(true);
  });

  test("open is idempotent when keyboard is already open", async () => {
    fakeHierarchy.setResults([keyboardWindowHierarchy()]);
    const keyboard = new Keyboard(testDevice, fakeAdbFactory, fakeHierarchy, fakeTimer);

    const result = await keyboard.execute("open");

    expect(result.success).toBe(true);
    expect(result.open).toBe(true);
    expect(fakeAdb.getExecutedCommands().length).toBe(0);
  });

  test("close sends back keyevent when keyboard is open", async () => {
    fakeHierarchy.setResults([keyboardWindowHierarchy(), baseHierarchy()]);
    const keyboard = new Keyboard(testDevice, fakeAdbFactory, fakeHierarchy, fakeTimer);

    const result = await keyboard.execute("close");

    expect(result.success).toBe(true);
    expect(result.open).toBe(false);
    expect(fakeAdb.wasCommandExecuted("shell input keyevent KEYCODE_BACK")).toBe(true);
  });

  test("open succeeds when the IME animation settles after several polls", async () => {
    // Tap read, then three stale reads (IME still animating), then open.
    fakeHierarchy.setResults([
      focusedInputHierarchy(),
      baseHierarchy(),
      baseHierarchy(),
      baseHierarchy(),
      keyboardWindowHierarchy(),
    ]);
    const keyboard = new Keyboard(testDevice, fakeAdbFactory, fakeHierarchy, fakeTimer);

    const result = await keyboard.execute("open");

    expect(result.success).toBe(true);
    expect(result.open).toBe(true);
    expect(fakeHierarchy.getCallCount()).toBe(5);
    expect(fakeTimer.getSleepHistory()).toEqual([100, 100, 100]);
  });

  test("close succeeds when the IME animation settles after several polls", async () => {
    fakeHierarchy.setResults([
      keyboardWindowHierarchy(),
      keyboardWindowHierarchy(),
      baseHierarchy(),
    ]);
    const keyboard = new Keyboard(testDevice, fakeAdbFactory, fakeHierarchy, fakeTimer);

    const result = await keyboard.execute("close");

    expect(result.success).toBe(true);
    expect(result.open).toBe(false);
    expect(fakeTimer.getSleepHistory()).toEqual([100]);
  });

  test("open gives up within the bounded timeout when state never settles", async () => {
    fakeHierarchy.setResults([focusedInputHierarchy()]);
    fakeHierarchy.setDefaultResult(baseHierarchy());
    const keyboard = new Keyboard(testDevice, fakeAdbFactory, fakeHierarchy, fakeTimer);

    const result = await keyboard.execute("open");

    expect(result.success).toBe(false);
    expect(result.open).toBe(false);
    expect(result.message).toBe("Failed to open keyboard");
    const slept = fakeTimer.getSleepHistory();
    expect(slept.reduce((total, ms) => total + ms, 0)).toBe(2000);
    expect(fakeTimer.getCurrentTime()).toBe(2000);
  });

  test("close gives up within the bounded timeout when state never settles", async () => {
    fakeHierarchy.setResults([keyboardWindowHierarchy()]);
    fakeHierarchy.setDefaultResult(keyboardWindowHierarchy());
    const keyboard = new Keyboard(testDevice, fakeAdbFactory, fakeHierarchy, fakeTimer);

    const result = await keyboard.execute("close");

    expect(result.success).toBe(false);
    expect(result.open).toBe(true);
    expect(result.message).toBe("Failed to close keyboard");
    expect(fakeTimer.getCurrentTime()).toBe(2000);
  });

  test("close is idempotent when keyboard is already closed", async () => {
    fakeHierarchy.setResults([baseHierarchy()]);
    const keyboard = new Keyboard(testDevice, fakeAdbFactory, fakeHierarchy, fakeTimer);

    const result = await keyboard.execute("close");

    expect(result.success).toBe(true);
    expect(result.open).toBe(false);
    expect(result.message).toBe("Keyboard already closed");
    expect(fakeAdb.getExecutedCommands().length).toBe(0);
    expect(fakeTimer.getSleepCallCount()).toBe(0);
  });

  test("open stops polling promptly once the signal aborts", async () => {
    const controller = new AbortController();
    fakeHierarchy.setResults([focusedInputHierarchy()]);
    fakeHierarchy.setDefaultResult(baseHierarchy());
    controller.abort();
    const keyboard = new Keyboard(testDevice, fakeAdbFactory, fakeHierarchy, fakeTimer);

    const result = await keyboard.execute("open", controller.signal);

    expect(result.success).toBe(false);
    expect(result.open).toBe(false);
    // One post-action read, then the abort short-circuits before any sleep.
    expect(fakeHierarchy.getCallCount()).toBe(2);
    expect(fakeTimer.getSleepCallCount()).toBe(0);
  });

  test("each confirmation read is bounded by the remaining budget", async () => {
    fakeHierarchy.setResults([focusedInputHierarchy()]);
    fakeHierarchy.setDefaultResult(baseHierarchy());
    const keyboard = new Keyboard(testDevice, fakeAdbFactory, fakeHierarchy, fakeTimer);

    await keyboard.execute("open");

    const options = fakeHierarchy.getReadOptions();
    // The pre-action read is a plain read; every confirmation read is bounded.
    expect(options[0]).toBeUndefined();
    const confirmationTimeouts = options.slice(1).map((option) => option?.timeoutMs);
    expect(confirmationTimeouts[0]).toBe(2000);
    expect(confirmationTimeouts[1]).toBe(1900);
    expect(confirmationTimeouts[confirmationTimeouts.length - 1]).toBe(100);
    // Never zero and never more than what is left of the 2s window.
    confirmationTimeouts.forEach((timeoutMs, index) => {
      expect(timeoutMs).toBe(2000 - index * 100);
      expect(timeoutMs!).toBeGreaterThan(0);
    });
  });

  test("a stale cached hierarchy does not cause a false timeout", async () => {
    // The cache keeps serving the pre-action (closed) sample; only a forced-fresh
    // read observes the IME that actually opened.
    fakeHierarchy.setCachedResult(focusedInputHierarchy());
    fakeHierarchy.setResults([keyboardWindowHierarchy()]);
    const keyboard = new Keyboard(testDevice, fakeAdbFactory, fakeHierarchy, fakeTimer);

    const result = await keyboard.execute("open");

    expect(result.success).toBe(true);
    expect(result.open).toBe(true);
    // Pre-action read served from cache, one forced-fresh confirmation read.
    expect(fakeHierarchy.getCallCount()).toBe(2);
    expect(fakeHierarchy.getReadOptions()[1]?.forceFresh).toBe(true);
    expect(fakeTimer.getSleepCallCount()).toBe(0);
  });

  test("close does not send Back off a stale cached IME-open sample", async () => {
    // The cache still serves a pre-action sample showing the IME open, but a
    // forced-fresh read sees it already closed (an IME action or navigation hid
    // it). close() must decide off the fresh read and NOT send a stray
    // KEYCODE_BACK that would navigate the destination screen (#5887 / #5899).
    fakeHierarchy.setCachedResult(keyboardWindowHierarchy());
    fakeHierarchy.setResults([baseHierarchy()]);
    const keyboard = new Keyboard(testDevice, fakeAdbFactory, fakeHierarchy, fakeTimer);

    const result = await keyboard.execute("close");

    expect(result.success).toBe(true);
    expect(result.open).toBe(false);
    expect(result.message).toBe("Keyboard already closed");
    expect(fakeAdb.wasCommandExecuted("shell input keyevent KEYCODE_BACK")).toBe(false);
    // The send-Back decision read forced past the cache.
    expect(fakeHierarchy.getReadOptions()[0]?.forceFresh).toBe(true);
    expect(fakeHierarchy.getCallCount()).toBe(1);
  });

  test("every confirmation read forces past the hierarchy cache", async () => {
    fakeHierarchy.setResults([focusedInputHierarchy(), baseHierarchy(), keyboardWindowHierarchy()]);
    const keyboard = new Keyboard(testDevice, fakeAdbFactory, fakeHierarchy, fakeTimer);

    await keyboard.execute("open");

    const confirmationOptions = fakeHierarchy.getReadOptions().slice(1);
    expect(confirmationOptions.length).toBe(2);
    confirmationOptions.forEach((option) => expect(option?.forceFresh).toBe(true));
  });

  test("close stops polling promptly once the signal aborts", async () => {
    const controller = new AbortController();
    fakeHierarchy.setResults([keyboardWindowHierarchy()]);
    fakeHierarchy.setDefaultResult(keyboardWindowHierarchy());
    controller.abort();
    const keyboard = new Keyboard(testDevice, fakeAdbFactory, fakeHierarchy, fakeTimer);

    const result = await keyboard.execute("close", controller.signal);

    expect(result.success).toBe(false);
    expect(result.open).toBe(true);
    expect(fakeHierarchy.getCallCount()).toBe(2);
    expect(fakeTimer.getSleepCallCount()).toBe(0);
  });

  test("detect does not poll or sleep", async () => {
    fakeHierarchy.setResults([baseHierarchy()]);
    const keyboard = new Keyboard(testDevice, fakeAdbFactory, fakeHierarchy, fakeTimer);

    const result = await keyboard.execute("detect");

    expect(result.success).toBe(true);
    expect(result.open).toBe(false);
    expect(result.message).toBe("Keyboard is closed");
    expect(fakeHierarchy.getCallCount()).toBe(1);
    expect(fakeTimer.getSleepCallCount()).toBe(0);
  });

  test("ios detect delegates to CtrlProxy keyboard request", async () => {
    const getInstanceSpy = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue({
      requestKeyboard: async (action: string) => ({
        success: true,
        open: action === "detect",
        totalTimeMs: 5,
      }),
    } as any);

    try {
      const keyboard = new Keyboard(iosDevice, fakeAdbFactory, fakeHierarchy, fakeTimer);
      const result = await keyboard.execute("detect");

      expect(result.success).toBe(true);
      expect(result.open).toBe(true);
      expect(getInstanceSpy).toHaveBeenCalled();
    } finally {
      getInstanceSpy.mockRestore();
    }
  });

  test("ios close returns CtrlProxy failure", async () => {
    const getInstanceSpy = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue({
      requestKeyboard: async () => ({
        success: false,
        open: true,
        totalTimeMs: 5,
        error: "No keyboard focus",
      }),
    } as any);

    try {
      const keyboard = new Keyboard(iosDevice, fakeAdbFactory, fakeHierarchy, fakeTimer);
      const result = await keyboard.execute("close");

      expect(result.success).toBe(false);
      expect(result.open).toBe(true);
      expect(result.error).toBe("No keyboard focus");
    } finally {
      getInstanceSpy.mockRestore();
    }
  });

  test("ios open fails when keyboard remains closed", async () => {
    const getInstanceSpy = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue({
      requestKeyboard: async () => ({
        success: true,
        open: false,
        totalTimeMs: 5,
      }),
    } as any);

    try {
      const keyboard = new Keyboard(iosDevice, fakeAdbFactory, fakeHierarchy, fakeTimer);
      const result = await keyboard.execute("open");

      expect(result.success).toBe(false);
      expect(result.open).toBe(false);
      expect(result.error).toBe("Keyboard did not open");
    } finally {
      getInstanceSpy.mockRestore();
    }
  });
});
