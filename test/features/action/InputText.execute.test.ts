import { recordObservationRead } from "../../../src/features/observe/observationReadScope";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { AdbClient } from "../../../src/utils/android-cmdline-tools/AdbClient";
import { DefaultRetryExecutor } from "../../../src/utils/retry/RetryExecutor";
import type { ExecResult } from "../../../src/models";
import { FakeProcessExecutor } from "../../fakes/FakeProcessExecutor";
import { FakeTapStrategy } from "../../fakes/FakeTapStrategy";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { DefaultElementParser } from "../../../src/features/utility/ElementParser";
import { FakeElementSelector } from "../../fakes/FakeElementSelector";
import { imeOcclusionHierarchy } from "../../fixtures/observe/imeOcclusion";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { InputText } from "../../../src/features/action/InputText";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { IOSCtrlProxyClient } from "../../../src/features/observe/ios";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeCtrlProxy } from "../../fakes/FakeCtrlProxy";
import { FakeIOSCtrlProxy } from "../../fakes/FakeIOSCtrlProxy";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeWindow } from "../../fakes/FakeWindow";
import { FakeAwaitIdle } from "../../fakes/FakeAwaitIdle";
import { FakeTimer } from "../../fakes/FakeTimer";
import { serverConfig } from "../../../src/utils/ServerConfig";
import type { BootedDevice, ObserveResult } from "../../../src/models";
import { runWithAbortSignal } from "../../../src/utils/AbortContext";
import {
  TextRequestState,
  runWithTextRequestContext,
} from "../../../src/features/action/textTransportTimeout";
import { drainMicrotasks, drainUntil, settleByFakeEvents } from "../../helpers/fakeTimerStepping";

describe("InputText.execute", () => {
  const androidDevice: BootedDevice = {
    deviceId: "test-device",
    platform: "android",
    name: "Test Device",
  };
  const iosDevice: BootedDevice = {
    deviceId: "ios-test-device",
    platform: "ios",
    name: "Test iPhone",
  };

  let fakeAdb: FakeAdbExecutor;
  let fakeObserveScreen: FakeObserveScreen;
  let fakeWindow: FakeWindow;
  let fakeAwaitIdle: FakeAwaitIdle;
  let fakeA11yService: FakeCtrlProxy;
  let fakeIosCtrlProxy: FakeIOSCtrlProxy;
  let fakeTimer: FakeTimer;
  let getInstanceSpy: ReturnType<typeof spyOn> | null = null;
  let iosGetInstanceSpy: ReturnType<typeof spyOn> | null = null;
  let savedMarkers: readonly string[];

  const createObserveResult = (): ObserveResult => ({
    timestamp: Date.now(),
    screenSize: { width: 1080, height: 1920 },
    systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
    viewHierarchy: { hierarchy: { node: { $: {} } } },
  });

  const wireFakes = (inputText: InputText): void => {
    (inputText as any).observeScreen = fakeObserveScreen;
    (inputText as any).window = fakeWindow;
    (inputText as any).awaitIdle = fakeAwaitIdle;
    (inputText as any).timer = fakeTimer;
  };

  beforeEach(() => {
    savedMarkers = serverConfig.getEventAllMarkers();
    fakeAdb = new FakeAdbExecutor();
    fakeAdb.setAndroidApiLevel(34);
    fakeObserveScreen = new FakeObserveScreen();
    fakeObserveScreen.enableAutoVaryHierarchy();
    fakeObserveScreen.setObserveResult(() => createObserveResult());
    fakeWindow = new FakeWindow();
    fakeWindow.configureCachedActiveWindow(null);
    fakeWindow.configureActiveWindow({
      appId: "com.test.app",
      activityName: "MainActivity",
      layoutSeqSum: 1,
    });
    fakeAwaitIdle = new FakeAwaitIdle();
    fakeA11yService = new FakeCtrlProxy();
    fakeIosCtrlProxy = new FakeIOSCtrlProxy();
    fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
  });

  afterEach(() => {
    serverConfig.setEventAllMarkers(savedMarkers);
    getInstanceSpy?.mockRestore();
    iosGetInstanceSpy?.mockRestore();
    getInstanceSpy = null;
    iosGetInstanceSpy = null;
    AndroidCtrlProxyClient.resetInstances();
  });

  test("returns a no-text failure without invoking any transport when text is undefined", async () => {
    const inputText = new InputText(androidDevice, fakeAdb as any);
    wireFakes(inputText);

    const result = await inputText.execute(undefined as any);

    expect(result).toMatchObject({
      success: false,
      text: "",
      error: "No text provided",
      method: "a11y",
    });
    // Early return: never reaches the accessibility service or ADB.
    expect(fakeAdb.getExecutedCommands()).toEqual([]);
  });

  test("uses the atomic a11y setText (no key events) when no marker matches", async () => {
    serverConfig.setEventAllMarkers([]);
    getInstanceSpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(
      fakeA11yService as unknown as AndroidCtrlProxyClient,
    );

    const inputText = new InputText(androidDevice, fakeAdb as any);
    wireFakes(inputText);

    const result = await inputText.execute("/a");

    expect(result.success).toBe(true);
    expect(result.method).toBe("a11y");
    // a11y mode sets the whole string atomically and issues no per-character keyevents.
    expect(fakeA11yService.getTextInputHistory()).toEqual([{ text: "/a", resourceId: undefined }]);
    expect(fakeAdb.getExecutedCommands().some((cmd) => cmd.includes("keyevent"))).toBe(false);
  });

  test.each([false, true])("a11y dispatch settles when rejected=%s", async (reject) => {
    serverConfig.setEventAllMarkers([]);
    getInstanceSpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(
      fakeA11yService as unknown as AndroidCtrlProxyClient,
    );
    const state = new TextRequestState();
    const entered = Promise.withResolvers<void>();
    const reply = Promise.withResolvers<Awaited<ReturnType<FakeCtrlProxy["requestSetText"]>>>();
    const transport = spyOn(fakeA11yService, "requestSetText").mockImplementation(() => {
      entered.resolve();
      expect(state.hasPending()).toBe(true);
      return reply.promise;
    });
    const input = new InputText(androidDevice, fakeAdb);
    wireFakes(input);
    const error = new Error("setText failed");
    const result = runWithAbortSignal(undefined, () => input.execute("hi"), { textState: state });
    const outcome = result.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await entered.promise;
    let settled = false;
    const waiter = state.settled().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    if (reject) {
      reply.reject(error);
      expect(await outcome).toMatchObject({
        value: { success: false, error: "Failed to send text input: setText failed" },
      });
      expect(state.timeoutError(error)).toBeUndefined();
    } else {
      reply.resolve({ success: true, totalTimeMs: 0 });
      expect(await result).toMatchObject({ success: true });
    }
    await waiter;
    expect(state.hasPending()).toBe(false);
    transport.mockRestore();
  });

  for (const path of ["key-event plan", "IME done", "IME previous"] as const) {
    test.each(["child exit", "bounded grace"] as const)(
      `${path} keeps aborted text pending until %s`,
      async (settlement) => {
        fakeTimer = new FakeTimer();
        getInstanceSpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(
          fakeA11yService as unknown as AndroidCtrlProxyClient,
        );
        const child = new EventEmitter() as ChildProcess;
        const signals: (string | number | undefined)[] = [];
        child.kill = (signal) => {
          signals.push(signal);
          return true;
        };
        const childResult = Promise.withResolvers<ExecResult>();
        // execFile's callback reports termination after the child's exit, not on kill().
        child.once("exit", () => childResult.reject(new Error("child exited")));
        const host = new FakeProcessExecutor();
        const dispatch = spyOn(host, "executeCommandWithChild").mockReturnValue({
          child,
          result: childResult.promise,
        });
        const adb = new AdbClient(
          androidDevice,
          null,
          null,
          new DefaultRetryExecutor(fakeTimer),
          fakeTimer,
          undefined,
          undefined,
          undefined,
          undefined,
          host,
        );
        // Exercise real cancellation/settlement without SDK lookup or a real process.
        const internals = adb as unknown as {
          isTestMode: boolean;
          getBaseCommandParts: () => Promise<{ adbPath: string; baseArgs: string[] }>;
        };
        internals.isTestMode = false;
        internals.getBaseCommandParts = async () => ({ adbPath: "adb", baseArgs: [] });
        spyOn(adb, "getDeviceTimestampMs").mockImplementation(async () => fakeTimer.now());
        const input = new InputText(androidDevice, adb);
        wireFakes(input);
        const controller = new AbortController();
        const reason = new Error("text cancelled");
        const state = new TextRequestState();
        const result = runWithAbortSignal(controller.signal, () =>
          runWithTextRequestContext({ getDeadlineMs: () => undefined, textState: state }, () =>
            path === "key-event plan"
              ? input.appendText("a", undefined, undefined, controller.signal)
              : input.execute(
                  "hi",
                  path === "IME done" ? "done" : "previous",
                  false,
                  "a11y",
                  controller.signal,
                ),
          ),
        );
        const outcome = result.then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
        if (path !== "key-event plan") {
          await drainUntil(() => fakeTimer.getPendingSleepCount() > 0, {
            description: "IME action delay",
          });
          fakeTimer.advanceTime(100);
        }
        await drainUntil(() => dispatch.mock.calls.length === 1, {
          description: "adb text dispatch",
        });
        expect(dispatch.mock.calls[0]?.[1]?.join(" ")).toBe(
          `shell input keyevent ${path === "key-event plan" ? "KEYCODE_A" : path === "IME done" ? "KEYCODE_ENTER" : "KEYCODE_SHIFT_LEFT"}`,
        );
        expect(state.hasPending()).toBe(true);
        let settled = false;
        const waiter = state.settled().then(() => {
          settled = true;
        });

        try {
          controller.abort(reason);
          await drainMicrotasks(100);
          expect(signals).toEqual(["SIGTERM"]);
          expect(settled).toBe(false);
          expect(state.hasPending()).toBe(true);

          if (settlement === "child exit") {
            child.emit("exit", null, "SIGTERM");
          } else {
            // Use the existing AdbClient grace timers; no real-time sleeps.
            expect(fakeTimer.getMsUntilNextDueEvent()).toBe(1_000);
            fakeTimer.advanceTime(1_000);
            await drainMicrotasks(100);
            expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
            expect(settled).toBe(false);
            fakeTimer.advanceTime(999);
            await drainMicrotasks(100);
            expect(settled).toBe(false);
            fakeTimer.advanceTime(1);
          }

          expect(await outcome).toEqual({ error: reason });
          await waiter;
          expect(settled).toBe(true);
          expect(state.hasPending()).toBe(false);
          expect(fakeTimer.getPendingTimeoutCount()).toBe(0);
          expect(dispatch).toHaveBeenCalledTimes(1);
        } finally {
          child.emit("exit", null, "SIGKILL");
          await outcome;
          dispatch.mockRestore();
        }
      },
    );
  }

  test.each(["eventLast", "eventAll", "append"] as const)(
    "%s marks every in-flight adb key command and settles afterwards",
    async (mode) => {
      serverConfig.setEventAllMarkers([]);
      getInstanceSpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(
        fakeA11yService as unknown as AndroidCtrlProxyClient,
      );
      const state = new TextRequestState();
      const entered = Promise.withResolvers<void>();
      const reply = Promise.withResolvers<void>();
      const execute = fakeAdb.execute.bind(fakeAdb);
      let keyCommands = 0;
      const transport = spyOn(fakeAdb, "execute").mockImplementation(async (args, options) => {
        if (args.includes("keyevent")) {
          entered.resolve();
          expect(state.hasPending()).toBe(true);
          keyCommands++;
          await reply.promise;
        }
        return execute(args, options);
      });
      const input = new InputText(androidDevice, fakeAdb);
      wireFakes(input);
      const result = runWithAbortSignal(
        undefined,
        () => input.execute("hi", undefined, false, mode),
        {
          textState: state,
        },
      );
      await entered.promise;
      let settled = false;
      const waiter = state.settled().then(() => {
        settled = true;
      });
      await drainMicrotasks(5);
      expect(settled).toBe(false);
      reply.resolve();
      expect(await result).toMatchObject({ success: true, method: mode });
      await waiter;
      expect(keyCommands).toBeGreaterThan(0);
      expect(state.hasPending()).toBe(false);
      transport.mockRestore();
    },
  );

  test.each([
    ["eventLast", "a ", "", false],
    ["eventLast", "a ", "a ", false],
    ["eventAll", "a", "", false],
    ["eventAll", "a", "a", true],
    ["eventAll", "a🙂", "a🙂", false],
  ] as const)(
    "%s text %j marks setText(%j) until settled",
    async (mode, text, dispatchedText, dismissKeyboard) => {
      fakeTimer = new FakeTimer();
      getInstanceSpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(
        fakeA11yService as unknown as AndroidCtrlProxyClient,
      );
      const state = new TextRequestState();
      const entered = Promise.withResolvers<void>();
      const reply = Promise.withResolvers<void>();
      const setText = fakeA11yService.requestSetText.bind(fakeA11yService);
      let pendingAtDispatch = false;
      const transport = spyOn(fakeA11yService, "requestSetText").mockImplementation(
        async (value, options) => {
          if (value === dispatchedText) {
            pendingAtDispatch = state.hasPending();
            entered.resolve();
            await reply.promise;
          }
          return setText(value, options);
        },
      );
      const input = new InputText(androidDevice, fakeAdb, () => ({
        close: async () => ({ success: true, action: "close" }),
      }));
      wireFakes(input);
      const result = runWithAbortSignal(
        undefined,
        () => input.execute(text, undefined, dismissKeyboard, mode),
        { textState: state },
      );
      try {
        await settleByFakeEvents(fakeTimer, entered.promise, { description: "setText dispatch" });
        expect(pendingAtDispatch).toBe(true);
        expect(state.hasPending()).toBe(true);
        let settled = false;
        const waiter = state.settled().then(() => {
          settled = true;
        });
        await drainMicrotasks(5);
        expect(settled).toBe(false);
        reply.resolve();
        await waiter;
        expect(settled).toBe(true);
        expect(
          await settleByFakeEvents(fakeTimer, result, { description: "text result" }),
        ).toMatchObject({
          success: true,
          method: mode,
        });
        expect(state.hasPending()).toBe(false);
      } finally {
        reply.resolve();
        await settleByFakeEvents(fakeTimer, result, { description: "text cleanup" });
        transport.mockRestore();
      }
    },
  );

  test.each([
    ["next", "KEYCODE_TAB"],
    ["previous", "KEYCODE_SHIFT_LEFT"],
    ["previous", "KEYCODE_TAB"],
  ] as const)("IME %s marks %s until settled", async (imeAction, key) => {
    fakeTimer = new FakeTimer();
    serverConfig.setEventAllMarkers([]);
    getInstanceSpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(
      fakeA11yService as unknown as AndroidCtrlProxyClient,
    );
    const state = new TextRequestState();
    const entered = Promise.withResolvers<void>();
    const reply = Promise.withResolvers<void>();
    const execute = fakeAdb.executeCommand.bind(fakeAdb);
    let pendingAtDispatch = false;
    const transport = spyOn(fakeAdb, "executeCommand").mockImplementation(async (command) => {
      if (command === `shell input keyevent ${key}`) {
        pendingAtDispatch = state.hasPending();
        entered.resolve();
        await reply.promise;
      }
      return execute(command);
    });
    const input = new InputText(androidDevice, fakeAdb);
    wireFakes(input);
    const result = runWithAbortSignal(undefined, () => input.execute("hi", imeAction), {
      textState: state,
    });
    try {
      await settleByFakeEvents(fakeTimer, entered.promise, { description: "IME dispatch" });
      expect(pendingAtDispatch).toBe(true);
      expect(state.hasPending()).toBe(true);
      let settled = false;
      const waiter = state.settled().then(() => {
        settled = true;
      });
      await drainMicrotasks(5);
      expect(settled).toBe(false);
      reply.resolve();
      await waiter;
      expect(settled).toBe(true);
      expect(
        await settleByFakeEvents(fakeTimer, result, { description: "IME result" }),
      ).toMatchObject({
        success: true,
        imeAction,
      });
      expect(state.hasPending()).toBe(false);
    } finally {
      reply.resolve();
      await settleByFakeEvents(fakeTimer, result, { description: "IME cleanup" });
      transport.mockRestore();
    }
  });

  test.each(["a11y", "eventAll"] as const)(
    "%s works without a request text state",
    async (mode) => {
      serverConfig.setEventAllMarkers([]);
      getInstanceSpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(
        fakeA11yService as unknown as AndroidCtrlProxyClient,
      );
      const input = new InputText(androidDevice, fakeAdb);
      wireFakes(input);
      expect(
        await runWithAbortSignal(undefined, () => input.execute("hi", undefined, false, mode)),
      ).toMatchObject({ success: true, method: mode });
    },
  );

  test("auto-promotes to eventAll key events when the text matches a configured marker", async () => {
    serverConfig.setEventAllMarkers(["/"]);
    getInstanceSpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(
      fakeA11yService as unknown as AndroidCtrlProxyClient,
    );

    const inputText = new InputText(androidDevice, fakeAdb as any);
    wireFakes(inputText);

    const result = await inputText.execute("/a");

    expect(result.success).toBe(true);
    expect(result.method).toBe("eventAll");
    // eventAll types character-by-character via real key events so keystroke-driven
    // autocomplete (slash/@ popups) actually opens.
    expect(fakeAdb.getExecutedCommands().some((cmd) => cmd.includes("keyevent"))).toBe(true);
  });

  test("routes iOS input through the CtrlProxy client and ignores Android modes", async () => {
    iosGetInstanceSpy = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue(
      fakeIosCtrlProxy as unknown as IOSCtrlProxyClient,
    );

    const inputText = new InputText(iosDevice, fakeAdb as any);
    wireFakes(inputText);

    const result = await inputText.execute("hello", undefined, false, "eventAll");

    expect(result.success).toBe(true);
    // iOS always reports the a11y method regardless of the requested Android mode.
    expect(result.method).toBe("a11y");
    expect(fakeIosCtrlProxy.getTextInputHistory()).toEqual([
      { text: "hello", resourceId: undefined },
    ]);
    expect(fakeAdb.getExecutedCommands()).toEqual([]);
  });

  test("IME-occluded Android selector focus keeps the InputText failure shape", async () => {
    const device = androidDevice;
    const hierarchy = imeOcclusionHierarchy();
    const element = new DefaultElementParser()
      .flattenViewHierarchy(hierarchy, { includeWindows: true })
      .find(({ element }) => element.text === "Continue as Guest")!.element;
    element.class = "android.widget.EditText";
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const adb = new FakeAdbExecutor();
    const tap = new TapOnElement(device, adb, {
      timer,
      elementSelector: new FakeElementSelector(element),
      tapStrategy: new FakeTapStrategy(),
      selectionStateTracker: { prepare: async () => null, finalize: async () => [] },
    });
    const observation: ObserveResult = {
      observationId: "occluded-focus",
      updatedAt: 1,
      screenSize: { width: 400, height: 240 },
      systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
      viewHierarchy: hierarchy,
    };
    tap.observedInteraction = async (action) => ({
      ...(await action(recordObservationRead(observation))),
      observation,
    });
    const error =
      'Failed to perform tap on element: Target "Continue as Guest" is covered by the soft keyboard; dismiss the keyboard first.';
    const input = new InputText(device, adb, undefined, timer, () => ({
      focus: async (selector, signal) => {
        const result = await tap.execute({ ...selector, action: "focus" }, { signal });
        return {
          success: result.success,
          error: result.error,
          focusVerified: result.focusVerified === true,
          matchedId: result.selectedElement?.resourceId,
          matchedText: result.selectedElement?.text,
        };
      },
    }));
    expect(
      await input.execute("secret", undefined, false, "a11y", undefined, {
        text: "Continue as Guest",
      }),
    ).toEqual({ success: false, text: "secret", error, method: "a11y" });
    expect(adb.getExecutedCommands()).toEqual([]);
  });

  // A `selector` focuses the field first, collapsing the mandatory focus-then-type
  // pair into a single call (issue #5872 AC3).
  describe("selector focuses the target before typing (#5872)", () => {
    test("focuses the selected element, then types into it", async () => {
      serverConfig.setEventAllMarkers([]);
      getInstanceSpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(
        fakeA11yService as unknown as AndroidCtrlProxyClient,
      );

      const focusCalls: unknown[] = [];
      const inputText = new InputText(androidDevice, fakeAdb as any);
      wireFakes(inputText);
      (inputText as any).targetFocuser = {
        focus: async (selector: unknown) => {
          focusCalls.push(selector);
          return {
            success: true,
            focusVerified: true,
            matchedId: "com.test:id/first_name",
            matchedText: "First name",
          };
        },
      };

      const result = await inputText.execute("Ada", undefined, false, undefined, undefined, {
        text: "First name",
      });

      expect(result.success).toBe(true);
      expect(result.matchedId).toBe("com.test:id/first_name");
      expect(result.matchedText).toBe("First name");
      // The field was focused with the caller's selector before any text landed.
      expect(focusCalls).toEqual([{ text: "First name" }]);
      expect(fakeA11yService.getTextInputHistory()).toEqual([
        { text: "Ada", resourceId: undefined },
      ]);
    });

    test("returns the focus failure without typing when the selector cannot be focused", async () => {
      const inputText = new InputText(androidDevice, fakeAdb as any);
      wireFakes(inputText);
      (inputText as any).targetFocuser = {
        focus: async () => ({ success: false, error: "no element matches text=Missing" }),
      };

      const result = await inputText.execute("Ada", undefined, false, undefined, undefined, {
        text: "Missing",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("no element matches");
      // Focus failed, so nothing was ever typed.
      expect(fakeA11yService.getTextInputHistory()).toEqual([]);
      expect(fakeAdb.getExecutedCommands().some((cmd) => cmd.includes("keyevent"))).toBe(false);
    });

    test("does not type into the previously focused field when focus is not verified", async () => {
      serverConfig.setEventAllMarkers([]);
      getInstanceSpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(
        fakeA11yService as unknown as AndroidCtrlProxyClient,
      );

      const inputText = new InputText(androidDevice, fakeAdb as any);
      wireFakes(inputText);
      (inputText as any).targetFocuser = {
        focus: async () => ({
          success: true,
          focusVerified: false,
          matchedText: "Phone notification: ",
        }),
      };

      const result = await inputText.execute("555-0100", undefined, false, undefined, undefined, {
        text: "Phone",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Phone notification");
      expect(fakeA11yService.getTextInputHistory()).toEqual([]);
    });
  });
});
