import { expect, describe, test, beforeEach, afterEach, spyOn } from "bun:test";
import { ImeAction } from "../../../src/features/action/ImeAction";
import { ExecResult, ObserveResult, BootedDevice } from "../../../src/models";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeWindow } from "../../fakes/FakeWindow";
import { FakeAwaitIdle } from "../../fakes/FakeAwaitIdle";
import { FakeCtrlProxy } from "../../fakes/FakeCtrlProxy";
import { FakeTimer } from "../../fakes/FakeTimer";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { IOSCtrlProxyClient } from "../../../src/features/observe/ios";

describe("ImeAction", () => {
  let imeAction: ImeAction;
  let fakeAdb: FakeAdbExecutor;
  let fakeObserveScreen: FakeObserveScreen;
  let fakeWindow: FakeWindow;
  let fakeAwaitIdle: FakeAwaitIdle;
  let fakeA11yService: FakeCtrlProxy;
  let fakeTimer: FakeTimer;

  // Test device for Android platform
  const testDevice: BootedDevice = {
    deviceId: "test-device",
    platform: "android",
    name: "Test Device",
  };

  beforeEach(() => {
    // Create fakes for testing
    fakeAdb = new FakeAdbExecutor();
    fakeObserveScreen = new FakeObserveScreen();
    fakeObserveScreen.enableAutoVaryHierarchy();
    fakeWindow = new FakeWindow();
    fakeAwaitIdle = new FakeAwaitIdle();
    fakeA11yService = new FakeCtrlProxy();
    fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();

    // Set up default fake responses
    fakeWindow.configureCachedActiveWindow(null);
    fakeWindow.configureActiveWindow({
      appId: "com.test.app",
      activityName: "MainActivity",
      layoutSeqSum: 123,
    });

    // Set up default observe screen responses with valid viewHierarchy
    // Use factory to generate new results on each call for change detection
    fakeObserveScreen.setObserveResult(() => createObserveResult());

    // Set up default accessibility service response (success)
    fakeA11yService.setHierarchyData({
      packageName: "com.test.app",
      updatedAt: Date.now(),
    });

    // Pass fake accessibility service and timer to constructor
    imeAction = new ImeAction(testDevice, fakeAdb, fakeA11yService, fakeTimer);

    // Replace the internal managers with our fakes
    (imeAction as any).observeScreen = fakeObserveScreen;
    (imeAction as any).window = fakeWindow;
    (imeAction as any).awaitIdle = fakeAwaitIdle;
  });

  // Helper function to create mock ExecResult
  const createExecResult = (stdout: string = ""): ExecResult => ({
    stdout,
    stderr: "",
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (searchString: string) => stdout.includes(searchString),
  });

  // Helper function to create mock ObserveResult
  const createObserveResult = (): ObserveResult => ({
    timestamp: Date.now(),
    screenSize: { width: 1080, height: 1920 },
    systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
    viewHierarchy: { hierarchy: { node: { $: {} } } },
  });

  describe("execute", () => {
    test("should execute IME action 'done' via accessibility service", async () => {
      fakeA11yService.clearHistory();
      fakeA11yService.setHierarchyData({
        packageName: "com.test.app",
        updatedAt: Date.now(),
      });
      fakeObserveScreen.setObserveResult(() => createObserveResult());
      fakeAdb.clearHistory();

      const result = await imeAction.execute("done");

      expect(result.success).toBe(true);
      expect(result.action).toBe("done");
      expect(result.observation).toBeDefined();

      // Verify accessibility service was called with correct action
      expect(fakeA11yService.wasImeActionCalled("done")).toBe(true);
      // Should NOT call ADB when accessibility service succeeds
      const executedCommands = fakeAdb.getExecutedCommands();
      expect(executedCommands.length).toBe(0);
    });

    test("should execute IME action 'next' via accessibility service", async () => {
      fakeA11yService.clearHistory();
      fakeA11yService.setHierarchyData({
        packageName: "com.test.app",
        updatedAt: Date.now(),
      });
      fakeObserveScreen.setObserveResult(() => createObserveResult());
      fakeAdb.clearHistory();

      const result = await imeAction.execute("next");

      expect(result.success).toBe(true);
      expect(result.action).toBe("next");

      expect(fakeA11yService.wasImeActionCalled("next")).toBe(true);
    });

    test("should execute IME action 'search' via accessibility service", async () => {
      fakeA11yService.clearHistory();
      fakeA11yService.setHierarchyData({
        packageName: "com.test.app",
        updatedAt: Date.now(),
      });
      fakeObserveScreen.setObserveResult(() => createObserveResult());
      fakeAdb.clearHistory();

      const result = await imeAction.execute("search");

      expect(result.success).toBe(true);
      expect(result.action).toBe("search");

      expect(fakeA11yService.wasImeActionCalled("search")).toBe(true);
    });

    test("should execute IME action 'send' via accessibility service", async () => {
      fakeA11yService.clearHistory();
      fakeA11yService.setHierarchyData({
        packageName: "com.test.app",
        updatedAt: Date.now(),
      });
      fakeObserveScreen.setObserveResult(() => createObserveResult());
      fakeAdb.clearHistory();

      const result = await imeAction.execute("send");

      expect(result.success).toBe(true);
      expect(result.action).toBe("send");

      expect(fakeA11yService.wasImeActionCalled("send")).toBe(true);
    });

    test("should execute IME action 'go' via accessibility service", async () => {
      fakeA11yService.clearHistory();
      fakeA11yService.setHierarchyData({
        packageName: "com.test.app",
        updatedAt: Date.now(),
      });
      fakeObserveScreen.setObserveResult(() => createObserveResult());
      fakeAdb.clearHistory();

      const result = await imeAction.execute("go");

      expect(result.success).toBe(true);
      expect(result.action).toBe("go");

      expect(fakeA11yService.wasImeActionCalled("go")).toBe(true);
    });

    test("should execute IME action 'previous' via accessibility service", async () => {
      fakeA11yService.clearHistory();
      fakeA11yService.setHierarchyData({
        packageName: "com.test.app",
        updatedAt: Date.now(),
      });
      fakeObserveScreen.setObserveResult(() => createObserveResult());
      fakeAdb.clearHistory();

      const result = await imeAction.execute("previous");

      expect(result.success).toBe(true);
      expect(result.action).toBe("previous");

      expect(fakeA11yService.wasImeActionCalled("previous")).toBe(true);
    });

    test("should handle empty action string", async () => {
      const result = await imeAction.execute("" as any);

      expect(result.success).toBe(false);
      expect(result.action).toBe("");
      expect(result.error).toBe("No IME action provided");

      // Should not call accessibility service or ADB commands
      expect(fakeA11yService.getImeActionHistory().length).toBe(0);
      const executedCommands = fakeAdb.getExecutedCommands();
      expect(executedCommands.length).toBe(0);
    });

    test("should work with progress callback", async () => {
      fakeA11yService.setHierarchyData({
        packageName: "com.test.app",
        updatedAt: Date.now(),
      });
      fakeObserveScreen.setObserveResult(() => createObserveResult());

      let callbackCalled = false;
      const progressCallback = async () => {
        callbackCalled = true;
      };
      const result = await imeAction.execute("done", progressCallback);

      expect(result.success).toBe(true);
      // Progress callback should be called by BaseVisualChange
      expect(callbackCalled).toBe(true);
    });

    test("should fall back to ADB when accessibility service fails", async () => {
      // Accessibility service fails
      fakeA11yService.setFailureMode("imeAction", new Error("No focused element"));
      fakeAdb.setCommandResponse("shell input keyevent KEYCODE_ENTER", createExecResult());
      fakeObserveScreen.setObserveResult(() => createObserveResult());

      const result = await imeAction.execute("done");

      expect(result.success).toBe(true);
      expect(result.action).toBe("done");

      // Verify timer was called with 100ms delay
      expect(fakeTimer.wasCalledWithDuration(100)).toBe(true);

      // Then ADB fallback was used
      const executedCommands = fakeAdb.getExecutedCommands();
      expect(
        executedCommands.some((cmd) => cmd.includes("shell input keyevent KEYCODE_ENTER")),
      ).toBe(true);
    });

    test("should fall back to ADB for multi-key actions when accessibility service fails", async () => {
      // Accessibility service fails
      fakeA11yService.setFailureMode("imeAction", new Error("No focused element"));
      fakeAdb.setCommandResponse("shell input keyevent KEYCODE_SHIFT_LEFT", createExecResult());
      fakeAdb.setCommandResponse("shell input keyevent KEYCODE_TAB", createExecResult());
      fakeObserveScreen.setObserveResult(() => createObserveResult());

      const result = await imeAction.execute("previous");

      expect(result.success).toBe(true);
      expect(result.action).toBe("previous");

      // Verify timer was called with 100ms delay
      expect(fakeTimer.wasCalledWithDuration(100)).toBe(true);

      // Then ADB fallback was used with both key events for Shift+Tab
      const executedCommands = fakeAdb.getExecutedCommands();
      expect(
        executedCommands.some((cmd) => cmd.includes("shell input keyevent KEYCODE_SHIFT_LEFT")),
      ).toBe(true);
      expect(executedCommands.some((cmd) => cmd.includes("shell input keyevent KEYCODE_TAB"))).toBe(
        true,
      );
    });
  });

  describe("AdbClientFactory wiring (regression for #2230)", () => {
    let getInstanceSpy: ReturnType<typeof spyOn> | null = null;

    afterEach(() => {
      getInstanceSpy?.mockRestore();
      getInstanceSpy = null;
    });

    // Regression for https://github.com/kaeawc/auto-mobile/issues/2230.
    // executeAndroidImeAction called AndroidCtrlProxyClient.getInstance(device, this.adb),
    // but getInstance expects an AdbClientFactory and immediately invokes
    // `.create(device)`. After bundler minification this surfaced as
    // `TypeError: <minified>.create is not a function` and crashed any
    // imeAction call on a fresh device with no injected a11yService.
    test("passes the AdbClientFactory (not AdbExecutor) to AndroidCtrlProxyClient.getInstance", async () => {
      const factory = new FakeAdbClientFactory();
      const fakeClient = {
        requestImeAction: async () => ({
          success: true,
          totalTimeMs: 1,
        }),
      } as unknown as AndroidCtrlProxyClient;

      getInstanceSpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(fakeClient);

      const ime = new ImeAction(testDevice, factory as any, null, fakeTimer);
      (ime as any).observeScreen = fakeObserveScreen;
      (ime as any).window = fakeWindow;
      (ime as any).awaitIdle = fakeAwaitIdle;

      const result = await ime.execute("done");

      expect(result.success).toBe(true);
      expect(getInstanceSpy).toHaveBeenCalled();
      const passed = getInstanceSpy!.mock.calls[0][1] as { create?: unknown };
      expect(typeof passed).toBe("object");
      expect(typeof passed.create).toBe("function");
    });
  });

  describe("timing", () => {
    test("should complete quickly via accessibility service", async () => {
      fakeA11yService.setHierarchyData({
        packageName: "com.test.app",
        updatedAt: Date.now(),
      });
      fakeObserveScreen.setObserveResult(() => createObserveResult());

      const result = await imeAction.execute("done");

      expect(result.success).toBe(true);
      // Accessibility service path should not fall back to ADB
      expect(fakeAdb.getExecutedCommands().length).toBe(0);
    });

    test("should include delay when falling back to ADB keyevent", async () => {
      // Make accessibility service fail to trigger ADB fallback
      fakeA11yService.setFailureMode("imeAction", new Error("No focused element"));
      fakeAdb.setCommandResponse("shell input keyevent KEYCODE_ENTER", createExecResult());
      fakeObserveScreen.setObserveResult(() => createObserveResult());

      const result = await imeAction.execute("done");

      expect(result.success).toBe(true);
      // Verify that timer.sleep(100) was called in ADB fallback path
      expect(fakeTimer.wasCalledWithDuration(100)).toBe(true);
    });
  });

  describe("error handling", () => {
    test("should handle missing view hierarchy gracefully", async () => {
      // Set observe screen to fail
      fakeObserveScreen.setFailureMode(
        "getMostRecentCachedObserveResult",
        new Error("Cannot perform action without view hierarchy"),
      );
      fakeObserveScreen.setFailureMode(
        "execute",
        new Error("Cannot perform action without view hierarchy"),
      );

      await expect(imeAction.execute("done")).rejects.toThrow(
        "Cannot perform action without view hierarchy",
      );
    });

    test("should handle observation failure", async () => {
      // Set up valid initial result but make execute fail
      fakeObserveScreen.setObserveResult(() => createObserveResult());

      fakeA11yService.setHierarchyData({
        packageName: "com.test.app",
        updatedAt: Date.now(),
      });
      const observationError = new Error("Failed to observe screen");
      fakeObserveScreen.setFailureMode("execute", observationError);

      await expect(imeAction.execute("done")).rejects.toThrow("Failed to observe screen");
    });

    test("should handle null action gracefully", async () => {
      const result = await imeAction.execute(null as any);

      expect(result.success).toBe(false);
      expect(result.action).toBe("");
      expect(result.error).toBe("No IME action provided");
    });

    test("should handle undefined action gracefully", async () => {
      const result = await imeAction.execute(undefined as any);

      expect(result.success).toBe(false);
      expect(result.action).toBe("");
      expect(result.error).toBe("No IME action provided");
    });
  });

  describe("edge cases", () => {
    test("should handle all valid IME actions via accessibility service", async () => {
      fakeObserveScreen.setObserveResult(() => createObserveResult());

      const validActions: Array<"done" | "next" | "search" | "send" | "go" | "previous"> = [
        "done",
        "next",
        "search",
        "send",
        "go",
        "previous",
      ];

      for (const action of validActions) {
        fakeA11yService.clearHistory();
        fakeA11yService.setHierarchyData({
          packageName: "com.test.app",
          updatedAt: Date.now(),
        });
        fakeAdb.clearHistory();
        const result = await imeAction.execute(action);

        expect(result.success, `Action '${action}' should succeed`).toBe(true);
        expect(result.action).toBe(action);
        expect(fakeA11yService.wasImeActionCalled(action)).toBe(true);
      }
    });

    test("should handle rapid consecutive calls", async () => {
      fakeObserveScreen.setObserveResult(() => createObserveResult());
      fakeA11yService.clearHistory();
      fakeAdb.clearHistory();

      // Set up fake to return success for each action
      fakeA11yService.setHierarchyData({
        packageName: "com.test.app",
        updatedAt: Date.now(),
      });

      const promises = [
        imeAction.execute("done"),
        imeAction.execute("next"),
        imeAction.execute("search"),
      ];

      const results = await Promise.all(promises);

      results.forEach((result, index) => {
        expect(result.success, `Call ${index} should succeed`).toBe(true);
      });

      // Should have called accessibility service for each action
      expect(fakeA11yService.getImeActionHistory().length).toBe(3);
    });
  });

  describe("key mapping (ADB fallback)", () => {
    // These tests verify the ADB fallback behavior when accessibility service fails

    beforeEach(() => {
      // Make accessibility service fail to trigger ADB fallback
      fakeA11yService.setFailureMode("imeAction", new Error("No focused element"));
    });

    test("should map done to KEYCODE_ENTER in ADB fallback", async () => {
      fakeAdb.setCommandResponse("shell input keyevent KEYCODE_ENTER", createExecResult());
      fakeObserveScreen.setObserveResult(() => createObserveResult());

      const result = await imeAction.execute("done");

      expect(result.success).toBe(true);
      expect(fakeAdb.wasCommandExecuted("shell input keyevent KEYCODE_ENTER")).toBe(true);
    });

    test("should map next to KEYCODE_TAB in ADB fallback", async () => {
      fakeAdb.setCommandResponse("shell input keyevent KEYCODE_TAB", createExecResult());
      fakeObserveScreen.setObserveResult(() => createObserveResult());

      const result = await imeAction.execute("next");

      expect(result.success).toBe(true);
      expect(fakeAdb.wasCommandExecuted("shell input keyevent KEYCODE_TAB")).toBe(true);
    });

    test("should map search to KEYCODE_SEARCH in ADB fallback", async () => {
      fakeAdb.setCommandResponse("shell input keyevent KEYCODE_SEARCH", createExecResult());
      fakeObserveScreen.setObserveResult(() => createObserveResult());

      const result = await imeAction.execute("search");

      expect(result.success).toBe(true);
      expect(fakeAdb.wasCommandExecuted("shell input keyevent KEYCODE_SEARCH")).toBe(true);
    });

    test("should map send to KEYCODE_ENTER in ADB fallback", async () => {
      fakeAdb.setCommandResponse("shell input keyevent KEYCODE_ENTER", createExecResult());
      fakeObserveScreen.setObserveResult(() => createObserveResult());

      const result = await imeAction.execute("send");

      expect(result.success).toBe(true);
      expect(fakeAdb.wasCommandExecuted("shell input keyevent KEYCODE_ENTER")).toBe(true);
    });

    test("should map go to KEYCODE_ENTER in ADB fallback", async () => {
      fakeAdb.setCommandResponse("shell input keyevent KEYCODE_ENTER", createExecResult());
      fakeObserveScreen.setObserveResult(() => createObserveResult());

      const result = await imeAction.execute("go");

      expect(result.success).toBe(true);
      expect(fakeAdb.wasCommandExecuted("shell input keyevent KEYCODE_ENTER")).toBe(true);
    });

    test("should map previous to SHIFT+TAB combination in ADB fallback", async () => {
      fakeAdb.setCommandResponse("shell input keyevent KEYCODE_SHIFT_LEFT", createExecResult());
      fakeAdb.setCommandResponse("shell input keyevent KEYCODE_TAB", createExecResult());
      fakeObserveScreen.setObserveResult(() => createObserveResult());

      const result = await imeAction.execute("previous");

      expect(result.success).toBe(true);
      expect(fakeAdb.wasCommandExecuted("shell input keyevent KEYCODE_SHIFT_LEFT")).toBe(true);
      expect(fakeAdb.wasCommandExecuted("shell input keyevent KEYCODE_TAB")).toBe(true);
      // At least 2 calls for the key combination, but BaseVisualChange might make additional calls
      expect(fakeAdb.getExecutedCommands().length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("iOS platform (#6249 stalled-runner guard)", () => {
    const iosDevice: BootedDevice = {
      deviceId: "ios-device",
      platform: "ios",
      name: "iPhone",
    };
    let getInstanceSpy: ReturnType<typeof spyOn> | null = null;

    afterEach(() => {
      getInstanceSpy?.mockRestore();
      getInstanceSpy = null;
    });

    test("succeeds promptly when the CtrlProxy request resolves", async () => {
      let calledAction: string | null = null;
      getInstanceSpy = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue({
        requestImeAction: async (action: string) => {
          calledAction = action;
          return { success: true, action, totalTimeMs: 5 };
        },
      } as any);

      const ios = new ImeAction(iosDevice, null, null, fakeTimer);
      const result = await (ios as any).executeiOSImeAction("done", createObserveResult());

      expect(result.success).toBe(true);
      expect(result.action).toBe("done");
      expect(calledAction).toBe("done");
      // The bounded deadline never had to fire.
      expect(fakeTimer.getCurrentTime()).toBe(0);
    });

    test("propagates a runner-reported failure without waiting for the local deadline", async () => {
      getInstanceSpy = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue({
        requestImeAction: async (action: string) => ({
          success: false,
          action,
          totalTimeMs: 3,
          error: "No focused element",
        }),
      } as any);

      const ios = new ImeAction(iosDevice, null, null, fakeTimer);
      const result = await (ios as any).executeiOSImeAction("done", createObserveResult());

      expect(result.success).toBe(false);
      expect(result.error).toBe("No focused element");
      expect(fakeTimer.getCurrentTime()).toBe(0);
    });

    test("bounds a stalled CtrlProxy request to the local deadline instead of hanging (#6249)", async () => {
      // Simulates the real repro: `ensureConnected()` (WebSocket reconnect, auto-setup,
      // a dying runner) never settles within the request's own configured timeout
      // because that internal timeout only starts counting AFTER a connection is
      // established. The underlying request here simply never resolves.
      const request = new Promise(() => {
        /* never settles — mirrors a wedged connection/runner */
      });
      getInstanceSpy = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue({
        requestImeAction: async () => request,
      } as any);

      const ios = new ImeAction(iosDevice, null, null, fakeTimer);
      const result = await (ios as any).executeiOSImeAction("done", createObserveResult());

      expect(result.success).toBe(false);
      expect(result.action).toBe("done");
      expect(result.error).toBe("IME action timed out after 5000ms");
      // Returned via the independent local deadline, not a hang.
      expect(fakeTimer.getCurrentTime()).toBe(5000);
    });

    test("full execute() succeeds promptly on the fast path (#6249 follow-up)", async () => {
      getInstanceSpy = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue({
        requestImeAction: async (action: string) => ({ success: true, action, totalTimeMs: 5 }),
      } as any);

      const ios = new ImeAction(iosDevice, null, null, fakeTimer);
      (ios as any).observeScreen = fakeObserveScreen;
      (ios as any).window = fakeWindow;
      (ios as any).awaitIdle = fakeAwaitIdle;

      const result = await ios.execute("done");

      expect(result.success).toBe(true);
      expect(result.action).toBe("done");
      // Neither the request-level nor the outer execute()-level deadline had
      // to fire on the fast path.
      expect(fakeTimer.getCurrentTime()).toBe(0);
    });

    test("bounds a stalled pre-action observation to the deadline and fails with an ActionableError instead of hanging (#6249 follow-up)", async () => {
      // Simulates entering `BaseVisualChange.observedInteraction` with no
      // usable cached hierarchy: the pre-action observe falls through to
      // `observeScreen.execute()`, which goes through the same unbounded iOS
      // `ensureConnected()` path as the IME request itself. Here it simply
      // never resolves.
      const stallingObserveScreen = new FakeObserveScreen();
      (stallingObserveScreen as any).getMostRecentCachedObserveResult = () =>
        new Promise(() => {
          /* never settles */
        });
      (stallingObserveScreen as any).execute = () =>
        new Promise(() => {
          /* never settles */
        });

      getInstanceSpy = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue({
        requestImeAction: async (action: string) => ({ success: true, action, totalTimeMs: 5 }),
      } as any);

      const ios = new ImeAction(iosDevice, null, null, fakeTimer);
      (ios as any).observeScreen = stallingObserveScreen;
      (ios as any).window = fakeWindow;
      (ios as any).awaitIdle = fakeAwaitIdle;

      await expect(ios.execute("done")).rejects.toThrow(/timed out after 5000ms/);
      // Bounded by the deadline, not a hang.
      expect(fakeTimer.getCurrentTime()).toBe(5000);
    });

    test("a stalled pre-action observation does not corrupt a subsequent call (#6249 follow-up)", async () => {
      const stallingObserveScreen = new FakeObserveScreen();
      (stallingObserveScreen as any).getMostRecentCachedObserveResult = () =>
        new Promise(() => {
          /* never settles */
        });
      (stallingObserveScreen as any).execute = () =>
        new Promise(() => {
          /* never settles */
        });

      getInstanceSpy = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue({
        requestImeAction: async (action: string) => ({ success: true, action, totalTimeMs: 5 }),
      } as any);

      const first = new ImeAction(iosDevice, null, null, fakeTimer);
      (first as any).observeScreen = stallingObserveScreen;
      (first as any).window = fakeWindow;
      (first as any).awaitIdle = fakeAwaitIdle;

      await expect(first.execute("done")).rejects.toThrow(/timed out after 5000ms/);

      // A fresh call (e.g. after recovery) against a healthy pipeline must
      // not be affected by the first call's still-pending (abandoned) observe.
      const second = new ImeAction(iosDevice, null, null, fakeTimer);
      (second as any).observeScreen = fakeObserveScreen;
      (second as any).window = fakeWindow;
      (second as any).awaitIdle = fakeAwaitIdle;

      const result = await second.execute("next");
      expect(result.success).toBe(true);
      expect(result.action).toBe("next");
    });

    test("a stalled iOS imeAction request does not corrupt a subsequent call against the same client (#6249)", async () => {
      // First call: the CtrlProxy request stalls forever (wedged runner).
      const stalledRequest = new Promise(() => {
        /* never settles */
      });
      let callCount = 0;
      getInstanceSpy = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue({
        requestImeAction: async (action: string) => {
          callCount++;
          if (callCount === 1) {
            return stalledRequest;
          }
          // Second call: a healthy runner (or a fresh client after recovery)
          // answers normally — this must NOT be affected by the first call's
          // still-pending (abandoned) promise.
          return { success: true, action, totalTimeMs: 5 };
        },
      } as any);

      const ios = new ImeAction(iosDevice, null, null, fakeTimer);

      const first = await (ios as any).executeiOSImeAction("done", createObserveResult());
      expect(first.success).toBe(false);
      expect(first.error).toBe("IME action timed out after 5000ms");

      const second = await (ios as any).executeiOSImeAction("next", createObserveResult());
      expect(second.success).toBe(true);
      expect(second.action).toBe("next");
      expect(callCount).toBe(2);
    });
  });
});
