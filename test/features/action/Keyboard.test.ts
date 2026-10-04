import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import { logger } from "../../../src/utils/logger";
import {
  Keyboard,
  DefaultKeyboardHierarchyProvider,
  selectKeyboardHierarchyCache,
  type KeyboardHierarchyReadOptions,
} from "../../../src/features/action/Keyboard";
import { IOSCtrlProxyClient } from "../../../src/features/observe/ios";
import { decodeCtrlProxyMessage } from "../../../src/features/observe/ios/decodeCtrlProxyMessage";
import type {
  CtrlProxyKeyboardResult,
  WebSocketMessage,
} from "../../../src/features/observe/ios/types";
import { BootedDevice, ViewHierarchyResult } from "../../../src/models";
import { AdbClientFactory } from "../../../src/utils/android-cmdline-tools/AdbClientFactory";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeKeyboardHierarchyProvider } from "../../fakes/FakeKeyboardHierarchyProvider";
import {
  iosKeyboardVisibleHierarchy,
  iosKeyboardMinimizedHierarchy,
} from "../../fixtures/observe/iosKeyboardStates";
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

  // The a11y service reports window metadata, but none of it is an IME window —
  // yet an app control exposes a content-desc the heuristic matches ("Delete").
  // The IME is genuinely closed; detect/open must agree and close must not send Back.
  const heuristicFalsePositiveHierarchy = (contentDesc = "Delete"): ViewHierarchyResult => ({
    hierarchy: {
      node: {
        $: {
          "content-desc": contentDesc,
        },
      },
    },
    windows: [{ type: 1, bounds: { left: 0, top: 0, right: 1080, bottom: 1920 } }],
  });

  // A real IME window is present (type 2) but exposes no usable bounds; the
  // content-desc heuristic corroborates it. This is the "IME known not to expose
  // window bounds" case — close() must still send Back.
  const boundlessImeWindowHierarchy = (): ViewHierarchyResult => ({
    hierarchy: {
      node: {
        $: {
          "content-desc": "Delete",
        },
      },
    },
    windows: [{ type: 2 }],
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

  test.each(["missing", "empty"])(
    "detect falls back to hierarchy when window info is missing (%s)",
    async (windowInfo) => {
      const hierarchy = {
        ...keyboardNodeHierarchy(),
        windows: windowInfo === "missing" ? undefined : [],
      };
      fakeHierarchy.setResults([hierarchy]);
      const keyboard = new Keyboard(testDevice, fakeAdbFactory, fakeHierarchy, fakeTimer);

      const result = await keyboard.execute("detect");

      expect(result.success).toBe(true);
      expect(result.open).toBe(true);
      expect(result.bounds).toBeUndefined();
      expect(result.message).toBe("Keyboard is open");
      expect(keyboard["resolveKeyboardState"](hierarchy)).toMatchObject({
        open: true,
        source: "heuristic",
        windowInfoAvailable: false,
        imeWindowPresent: false,
      });
    },
  );

  test.each(["Delete", "Enter code"])(
    "detect rejects app label %s when window info has no IME",
    async (contentDesc) => {
      fakeHierarchy.setResults([heuristicFalsePositiveHierarchy(contentDesc)]);
      const keyboard = new Keyboard(testDevice, fakeAdbFactory, fakeHierarchy, fakeTimer);

      const result = await keyboard.execute("detect");

      expect(result).toMatchObject({ success: true, open: false, message: "Keyboard is closed" });
      expect(fakeAdb.getExecutedCommands()).toEqual([]);
    },
  );

  test("detect accepts a bounds-less IME window corroborated by the heuristic", async () => {
    const hierarchy = boundlessImeWindowHierarchy();
    fakeHierarchy.setResults([hierarchy]);
    const keyboard = new Keyboard(testDevice, fakeAdbFactory, fakeHierarchy, fakeTimer);

    const result = await keyboard.execute("detect");

    expect(result).toMatchObject({ success: true, open: true, message: "Keyboard is open" });
    expect(result.bounds).toBeUndefined();
    expect(keyboard["resolveKeyboardState"](hierarchy)).toMatchObject({
      open: true,
      source: "heuristic",
      windowInfoAvailable: true,
      imeWindowPresent: true,
    });
  });

  test("open taps focused input and polls past an app label without an IME window", async () => {
    const closedHierarchy = {
      ...heuristicFalsePositiveHierarchy("Enter code"),
      hierarchy: {
        node: {
          $: {},
          node: [
            focusedInputHierarchy().hierarchy.node,
            heuristicFalsePositiveHierarchy("Enter code").hierarchy.node,
          ],
        },
      },
    };
    fakeHierarchy.setResults([closedHierarchy, closedHierarchy, keyboardWindowHierarchy()]);
    const keyboard = new Keyboard(testDevice, fakeAdbFactory, fakeHierarchy, fakeTimer);

    const result = await keyboard.execute("open");

    expect(result).toMatchObject({ success: true, open: true, message: "Keyboard opened" });
    expect(fakeAdb.wasCommandExecuted("shell input tap 110 70")).toBe(true);
    expect(fakeHierarchy.getCallCount()).toBe(3);
    expect(fakeHierarchy.getReadOptions().slice(1)).toEqual([
      { timeoutMs: 2000, forceFresh: true },
      { timeoutMs: 1900, forceFresh: true },
    ]);
    expect(fakeTimer.getSleepHistory()).toEqual([100]);
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
    expect(result.message).toBe("Keyboard already open");
    expect(fakeHierarchy.getCallCount()).toBe(1);
    expect(fakeAdb.getExecutedCommands().length).toBe(0);
  });

  test("close sends back keyevent when keyboard is open", async () => {
    fakeHierarchy.setResults([keyboardWindowHierarchy(), baseHierarchy()]);
    const keyboard = new Keyboard(testDevice, fakeAdbFactory, fakeHierarchy, fakeTimer);

    const result = await keyboard.execute("close");

    expect(result.success).toBe(true);
    expect(result.open).toBe(false);
    expect(result.message).toBe("Keyboard closed");
    expect(fakeAdb.wasCommandExecuted("shell input keyevent KEYCODE_BACK")).toBe(true);
  });

  test("close does not send Back when only the content-desc heuristic matches and window info is available", async () => {
    // Windows are reported and none is an IME window, so a lone content-desc
    // match is app content, not the keyboard. Sending Back here would navigate
    // the app (#5899).
    fakeHierarchy.setResults([heuristicFalsePositiveHierarchy()]);
    const keyboard = new Keyboard(testDevice, fakeAdbFactory, fakeHierarchy, fakeTimer);

    const result = await keyboard.execute("close");

    expect(result.success).toBe(true);
    expect(result.open).toBe(false);
    expect(fakeAdb.wasCommandExecuted("shell input keyevent KEYCODE_BACK")).toBe(false);
    // No Back means no confirmation polling either.
    expect(fakeTimer.getSleepCallCount()).toBe(0);
  });

  test("close sends Back for a real IME window that exposes no bounds", async () => {
    fakeHierarchy.setResults([boundlessImeWindowHierarchy(), baseHierarchy()]);
    const keyboard = new Keyboard(testDevice, fakeAdbFactory, fakeHierarchy, fakeTimer);

    const result = await keyboard.execute("close");

    expect(result.success).toBe(true);
    expect(result.open).toBe(false);
    expect(fakeAdb.wasCommandExecuted("shell input keyevent KEYCODE_BACK")).toBe(true);
  });

  test("close falls back to the heuristic and sends Back when window info is unavailable", async () => {
    // keyboardNodeHierarchy exposes no window metadata at all — the deliberate
    // fallback for IMEs that never surface an IME window.
    fakeHierarchy.setResults([keyboardNodeHierarchy(), baseHierarchy()]);
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

    await expect(keyboard.execute("open", controller.signal)).rejects.toThrow(
      "Operation cancelled",
    );
    expect(fakeAdb.getExecutedCommands()).toEqual([]);
    expect(fakeHierarchy.getCallCount()).toBe(0);
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

    await expect(keyboard.execute("close", controller.signal)).rejects.toThrow(
      "Operation cancelled",
    );
    expect(fakeAdb.getExecutedCommands()).toEqual([]);
    expect(fakeHierarchy.getCallCount()).toBe(0);
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

  // Synthetic boundary geometry and unavailable/error hierarchies are not raw captures.
  const syntheticIOSKeyboard = (top: number, bottom = 1144): ViewHierarchyResult => ({
    screenWidth: 402,
    screenHeight: 874,
    hierarchy: {
      node: {
        $: { class: "UIKeyboard", clickable: true, bounds: { left: 0, top, right: 402, bottom } },
      },
    },
  });

  test.each([
    ["real visible capture", iosKeyboardVisibleHierarchy, true],
    ["real minimized capture", iosKeyboardMinimizedHierarchy, false],
    ["synthetic keyboard at screen bottom", syntheticIOSKeyboard(874), false],
    ["synthetic sub-point visible sliver", syntheticIOSKeyboard(873.5), false],
    ["synthetic zero height", syntheticIOSKeyboard(600, 600), false],
    ["synthetic no keyboard", { ...baseHierarchy(), screenWidth: 402, screenHeight: 874 }, false],
    ["synthetic unavailable hierarchy", null, true],
    ["synthetic unknown screen dimensions", baseHierarchy(), true],
    [
      "synthetic hierarchy error",
      { screenWidth: 402, screenHeight: 874, hierarchy: { error: "unavailable" } },
      true,
    ],
  ] as const)("ios detect cross-checks %s", async (_name, hierarchy, open) => {
    fakeHierarchy.setDefaultResult(hierarchy);
    const spy = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue({
      requestKeyboard: async () => ({ success: true, open: true, totalTimeMs: 1 }),
    } as IOSCtrlProxyClient);
    try {
      const result = await new Keyboard(
        iosDevice,
        fakeAdbFactory,
        fakeHierarchy,
        fakeTimer,
      ).execute("detect");
      expect(result.success).toBe(true);
      expect(result.open).toBe(open);
      expect(result.message).toStartWith(open ? "Keyboard is open" : "Keyboard is closed");
      expect(fakeHierarchy.getCallCount()).toBe(1);
      expect(fakeHierarchy.getReadOptions()).toEqual([{ timeoutMs: 2000, forceFresh: true }]);
    } finally {
      spy.mockRestore();
    }
  });

  test("ios open with the real visible capture preserves the existing result", async () => {
    fakeHierarchy.setDefaultResult(iosKeyboardVisibleHierarchy);
    const spy = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue({
      requestKeyboard: async () => ({ success: true, open: true, totalTimeMs: 1 }),
    } as IOSCtrlProxyClient);
    try {
      expect(
        await new Keyboard(iosDevice, fakeAdbFactory, fakeHierarchy, fakeTimer).execute("open"),
      ).toEqual({ success: true, open: true, message: "Keyboard opened" });
    } finally {
      spy.mockRestore();
    }
  });

  test("ios open fails clearly for the real minimized capture", async () => {
    fakeHierarchy.setDefaultResult(iosKeyboardMinimizedHierarchy);
    const spy = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue({
      requestKeyboard: async () => ({ success: true, open: true, totalTimeMs: 1 }),
    } as IOSCtrlProxyClient);
    try {
      const result = await new Keyboard(
        iosDevice,
        fakeAdbFactory,
        fakeHierarchy,
        fakeTimer,
      ).execute("open");
      expect(result.success).toBe(false);
      expect(result.open).toBe(false);
      expect(result.error).toContain("minimized off screen");
      expect(result.error).toContain("hardware keyboard");
      expect(fakeHierarchy.getCallCount()).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  test.each(["detect", "open"] as const)(
    "ios %s trusts closed runner without reading hierarchy",
    async (action) => {
      const spy = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue({
        requestKeyboard: async () => ({ success: true, open: false, totalTimeMs: 1 }),
      } as IOSCtrlProxyClient);
      try {
        const result = await new Keyboard(
          iosDevice,
          fakeAdbFactory,
          fakeHierarchy,
          fakeTimer,
        ).execute(action);
        expect(result.open).toBe(false);
        expect(fakeHierarchy.getCallCount()).toBe(0);
      } finally {
        spy.mockRestore();
      }
    },
  );

  test.each(["detect", "open"] as const)(
    "ios %s bounds a hanging visibility read and falls back to runner",
    async (action) => {
      const spy = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue({
        requestKeyboard: async () => ({ success: true, open: true, totalTimeMs: 1 }),
      } as IOSCtrlProxyClient);
      const warning = spyOn(logger, "warn").mockImplementation(() => {});
      const options: Array<KeyboardHierarchyReadOptions | undefined> = [];
      const provider = {
        getViewHierarchy: (_signal?: AbortSignal, readOptions?: KeyboardHierarchyReadOptions) => {
          options.push(readOptions);
          return new Promise<ViewHierarchyResult>(() => {});
        },
      };
      try {
        const result = await new Keyboard(iosDevice, fakeAdbFactory, provider, fakeTimer).execute(
          action,
        );
        expect(result).toMatchObject({ success: true, open: true });
        expect(fakeTimer.now()).toBe(2000);
        expect(options).toEqual([{ timeoutMs: 2000, forceFresh: true }]);
        expect(warning).toHaveBeenCalledWith(
          "iOS keyboard visibility hierarchy read failed; using runner state",
          expect.objectContaining({
            message: "iOS keyboard visibility hierarchy timed out after 2000ms",
          }),
        );
      } finally {
        spy.mockRestore();
        warning.mockRestore();
      }
    },
  );

  test("ios visibility read propagates caller cancellation without falling back", async () => {
    const controller = new AbortController();
    const reason = new Error("caller cancelled visibility read");
    const spy = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue({
      requestKeyboard: async () => ({ success: true, open: true, totalTimeMs: 1 }),
    } as IOSCtrlProxyClient);
    const warning = spyOn(logger, "warn").mockImplementation(() => {});
    const provider = {
      getViewHierarchy: (signal?: AbortSignal) => {
        expect(signal).toBe(controller.signal);
        controller.abort(reason);
        return new Promise<ViewHierarchyResult>(() => {});
      },
    };
    try {
      await expect(
        new Keyboard(iosDevice, fakeAdbFactory, provider, fakeTimer).execute(
          "detect",
          controller.signal,
        ),
      ).rejects.toThrow("Operation cancelled");
      expect(warning).not.toHaveBeenCalled();
      expect(fakeTimer.now()).toBe(0);
      expect(fakeTimer.getPendingTimeoutCount()).toBe(0);
    } finally {
      spy.mockRestore();
      warning.mockRestore();
    }
  });

  test.each(["ios", "android"] as const)(
    "default provider invalidates only the %s cache and forwards the read deadline",
    async (platform) => {
      const invalidations: string[] = [];
      const selections: string[] = [];
      const cache = selectKeyboardHierarchyCache(
        platform,
        () => {
          selections.push("ios");
          return { invalidateCache: () => invalidations.push("ios") };
        },
        () => {
          selections.push("android");
          return { invalidateCache: () => invalidations.push("android") };
        },
      );
      const controller = new AbortController();
      const reads: unknown[][] = [];
      const provider = new DefaultKeyboardHierarchyProvider(
        {
          getViewHierarchy: async (...args) => {
            reads.push(args);
            return iosKeyboardVisibleHierarchy;
          },
        },
        cache,
      );
      await provider.getViewHierarchy(controller.signal, { timeoutMs: 2000, forceFresh: true });
      expect(selections).toEqual([platform]);
      expect(invalidations).toEqual([platform]);
      expect(reads[0]?.slice(2)).toEqual([false, 0, controller.signal, 2000]);
      await provider.getViewHierarchy();
      expect(invalidations).toEqual([platform]);
    },
  );

  test("ios visibility forces past a pre-action cached minimized keyboard", async () => {
    fakeHierarchy.setCachedResult(iosKeyboardMinimizedHierarchy);
    fakeHierarchy.setDefaultResult(iosKeyboardVisibleHierarchy);
    const spy = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue({
      requestKeyboard: async () => ({ success: true, open: true, totalTimeMs: 1 }),
    } as IOSCtrlProxyClient);
    try {
      expect(
        await new Keyboard(iosDevice, fakeAdbFactory, fakeHierarchy, fakeTimer).execute("open"),
      ).toMatchObject({ success: true, open: true });
      expect(fakeHierarchy.getReadOptions()).toEqual([{ timeoutMs: 2000, forceFresh: true }]);
    } finally {
      spy.mockRestore();
    }
  });

  test("ios stale fallback cannot override the runner's keyboard state", async () => {
    fakeHierarchy.setDefaultResult({ ...iosKeyboardMinimizedHierarchy, fresh: false });
    const spy = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue({
      requestKeyboard: async () => ({ success: true, open: true, totalTimeMs: 1 }),
    } as IOSCtrlProxyClient);
    const warning = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      expect(
        await new Keyboard(iosDevice, fakeAdbFactory, fakeHierarchy, fakeTimer).execute("detect"),
      ).toMatchObject({ success: true, open: true });
      expect(warning).toHaveBeenCalledWith(
        "iOS keyboard visibility hierarchy is stale; using runner state",
      );
    } finally {
      spy.mockRestore();
      warning.mockRestore();
    }
  });

  test("ios hierarchy exception warns and falls back to runner", async () => {
    const spy = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue({
      requestKeyboard: async () => ({ success: true, open: true, totalTimeMs: 1 }),
    } as IOSCtrlProxyClient);
    const warning = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const provider = {
        getViewHierarchy: async () => {
          throw new Error("read failed");
        },
      };
      const result = await new Keyboard(iosDevice, fakeAdbFactory, provider, fakeTimer).execute(
        "detect",
      );
      expect(result.open).toBe(true);
      expect(warning).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      warning.mockRestore();
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

  test("ios close surfaces the multiline dismissal error from the Swift response", async () => {
    const error =
      "Keyboard did not close: the focused field is multiline and has no dismiss key; tap outside the field or use a different action";
    const wire = JSON.parse(
      JSON.stringify({
        type: "keyboard_result",
        timestamp: 1_780_000_000_000,
        requestId: "keyboard-multiline",
        success: false,
        open: true,
        totalTimeMs: 418,
        error,
        method: null,
      }),
    ) as WebSocketMessage;
    const decoded = decodeCtrlProxyMessage(wire);
    const getInstanceSpy = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue({
      requestKeyboard: async () => decoded?.result as CtrlProxyKeyboardResult,
    } as IOSCtrlProxyClient);

    try {
      const keyboard = new Keyboard(iosDevice, fakeAdbFactory, fakeHierarchy, fakeTimer);
      const result = await keyboard.execute("close");
      expect(result).toMatchObject({ success: false, open: true, error, message: error });
    } finally {
      getInstanceSpy.mockRestore();
    }
  });

  test.each([
    ["escape", "Keyboard closed"],
    ["dismissKey", "Keyboard closed"],
    [
      "returnKey",
      "Keyboard closed with Return; the field may have submitted or committed autocorrect",
    ],
  ] as const)("ios close passes through %s", async (method, message) => {
    const getInstanceSpy = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue({
      requestKeyboard: async () => ({
        success: true,
        open: false,
        totalTimeMs: 5,
        method,
      }),
    } as IOSCtrlProxyClient);

    try {
      const keyboard = new Keyboard(iosDevice, fakeAdbFactory, fakeHierarchy, fakeTimer);
      const result = await keyboard.execute("close");

      expect(result).toMatchObject({ success: true, open: false, method, message });
    } finally {
      getInstanceSpy.mockRestore();
    }
  });

  test("ios close preserves the method and warning from a Swift-shaped JSON response", async () => {
    const wire = JSON.parse(
      JSON.stringify({
        type: "keyboard_result",
        timestamp: 1_780_000_000_000,
        requestId: "keyboard-1",
        success: true,
        open: false,
        totalTimeMs: 418,
        error: null,
        method: "returnKey",
      }),
    ) as WebSocketMessage;
    const decoded = decodeCtrlProxyMessage(wire);
    expect(decoded?.requestId).toBe("keyboard-1");
    const getInstanceSpy = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue({
      requestKeyboard: async () => decoded?.result as CtrlProxyKeyboardResult,
    } as IOSCtrlProxyClient);

    try {
      const keyboard = new Keyboard(iosDevice, fakeAdbFactory, fakeHierarchy, fakeTimer);
      const result = await keyboard.execute("close");
      expect(result).toMatchObject({
        success: true,
        open: false,
        method: "returnKey",
        message:
          "Keyboard closed with Return; the field may have submitted or committed autocorrect",
      });
    } finally {
      getInstanceSpy.mockRestore();
    }
  });

  test("ios close timeout succeeds if one bounded detect confirms closed", async () => {
    const calls: Array<{ action: string; timeoutMs?: number }> = [];
    const getInstanceSpy = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue({
      requestKeyboard: async (action: string, timeoutMs?: number) => {
        calls.push({ action, timeoutMs });
        return action === "close"
          ? {
              success: false,
              open: false,
              totalTimeMs: 8000,
              error: "Keyboard timed out after 8000ms",
            }
          : { success: true, open: false, totalTimeMs: 10 };
      },
    } as IOSCtrlProxyClient);

    try {
      const keyboard = new Keyboard(iosDevice, fakeAdbFactory, fakeHierarchy, fakeTimer);
      const result = await keyboard.execute("close");
      expect(result.success).toBe(true);
      expect(result.open).toBe(false);
      expect(result.message).toContain("dismissal method unknown");
      expect(calls).toEqual([
        { action: "close", timeoutMs: undefined },
        { action: "detect", timeoutMs: 2000 },
      ]);
    } finally {
      getInstanceSpy.mockRestore();
    }
  });

  test("ios close timeout makes one detect and returns the original error after a 2s probe cap", async () => {
    const calls: string[] = [];
    const getInstanceSpy = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue({
      requestKeyboard: async (action: string) => {
        calls.push(action);
        if (action === "close") {
          return {
            success: false,
            open: false,
            totalTimeMs: 8000,
            error: "Keyboard timed out after 8000ms",
          };
        }
        return new Promise<CtrlProxyKeyboardResult>(() => {});
      },
    } as IOSCtrlProxyClient);

    try {
      const keyboard = new Keyboard(iosDevice, fakeAdbFactory, fakeHierarchy, fakeTimer);
      const result = await keyboard.execute("close");
      expect(result).toMatchObject({ success: false, error: "Keyboard timed out after 8000ms" });
      expect(calls).toEqual(["close", "detect"]);
      expect(fakeTimer.now()).toBe(2000);
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
