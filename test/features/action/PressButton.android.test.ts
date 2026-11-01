import { buildObserveResult } from "../../helpers/observeFixture";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeAwaitIdle } from "../../fakes/FakeAwaitIdle";
import { createExecResult } from "../../../src/utils/execResult";
import {
  beforeEach as beforeOutputSchema,
  afterEach as afterOutputSchema,
  spyOn as spyOnOutputSchema,
} from "bun:test";
import { pressButtonResultSchema } from "../../../src/server/toolOutputSchemas";
import { finalizeToolResponse } from "../../../src/server/finalizeToolResponse";
import { createStructuredToolResponse } from "../../../src/utils/toolUtils";
import { FakeArtifactWriter } from "../../fakes/FakeArtifactWriter";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  PressButton,
  acceptAndroidHomeAlreadyOnLauncher,
} from "../../../src/features/action/PressButton";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeWindow } from "../../fakes/FakeWindow";
import { FakeTimer } from "../../fakes/FakeTimer";
import { runWithAbortSignal } from "../../../src/utils/AbortContext";
import {
  clearResolvedHomePackageCache,
  resolveConfiguredHomePackage,
} from "../../../src/features/observe/androidLauncherPackages";
import { setDeviceIncarnationResolver } from "../../../src/utils/deviceIncarnation";
import { OPERATION_CANCELLED_MESSAGE } from "../../../src/utils/constants";
import type { AndroidGlobalActionOptions } from "../../../src/features/observe/android/AndroidClientRequests";
import type { BootedDevice } from "../../../src/models";
import type { ActiveWindowInfo } from "../../../src/models/ActiveWindowInfo";
import type { Window as WindowInterface } from "../../../src/features/observe/interfaces/Window";

// Minimal Window stub that returns a scripted sequence of foreground apps,
// one entry per `getActive` call (last entry repeats once exhausted) --
// lets tests distinguish "the post-global-action check" from "the
// post-ADB-fallback check" (issue #6147).
function sequencedWindow(appIds: string[]): WindowInterface {
  let callIndex = 0;
  const toActiveWindow = (appId: string): ActiveWindowInfo => ({
    appId,
    activityName: "Activity",
    layoutSeqSum: 0,
  });
  return {
    async getActive(): Promise<ActiveWindowInfo> {
      const appId = appIds[Math.min(callIndex, appIds.length - 1)];
      callIndex++;
      return toActiveWindow(appId);
    },
    async getActiveHash(): Promise<string> {
      return "fake-hash";
    },
    async getCachedActiveWindow(): Promise<ActiveWindowInfo | null> {
      return null;
    },
    async setCachedActiveWindow(): Promise<void> {},
    async clearCache(): Promise<void> {},
  };
}

describe("PressButton Android keycode dispatch", () => {
  const androidDevice: BootedDevice = {
    deviceId: "android-device",
    platform: "android",
    name: "Pixel",
  };

  let fakeAdb: FakeAdbExecutor;
  let fakeTimer: FakeTimer;
  let globalActionClient: Pick<AndroidCtrlProxyClient, "requestGlobalAction"> | undefined;
  let frameContextClient: Pick<AndroidCtrlProxyClient, "validateFrameContext"> | undefined;

  beforeEach(() => {
    fakeAdb = new FakeAdbExecutor();
    fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    clearResolvedHomePackageCache();
  });

  afterEach(() => {
    globalActionClient = undefined;
    frameContextClient = undefined;
    setDeviceIncarnationResolver(undefined);
    clearResolvedHomePackageCache();
  });

  test.each([
    ["home", "com.android.launcher3", true],
    ["home", "com.android.settings", false],
    ["back", "com.android.launcher3", false],
  ] as const)("identical hierarchy for %s on %s (#15028)", async (button, appId, success) => {
    const window = new FakeWindow();
    window.configureCachedActiveWindow(null);
    window.configureActiveWindow({ appId, activityName: "Main", layoutSeqSum: 1 });
    const observe = new FakeObserveScreen();
    observe.setObserveResult(
      buildObserveResult({
        updatedAt: 1,
        screenSize: { width: 1080, height: 1920 },
        systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
        viewHierarchy: { packageName: appId, hierarchy: { node: {} } },
      }),
    );
    const action = new PressButton(androidDevice, fakeAdb, fakeTimer, {
      window,
      observeScreen: observe,
      awaitIdle: new FakeAwaitIdle(),
      globalActionClient: {
        requestGlobalAction: async () => ({ success: true, action: button, totalTimeMs: 0 }),
      },
    });
    const result = await action.execute(button);
    expect(result.success).toBe(success);
    if (success) {
      expect(result.error).toBeUndefined();
    } else {
      expect(result.error).toContain(
        button === "home" ? "did not background the foreground app" : "No visual change observed",
      );
    }
  });

  test.each(["plain", "refused", "cancelled", "deadline"] as const)(
    "ADB fallback marks after every pre-dispatch check: %s",
    async (outcome) => {
      const controller = new AbortController();
      let marks = 0;
      frameContextClient = {
        validateFrameContext: async () => {
          expect(marks).toBe(0);
          if (outcome === "cancelled") {
            controller.abort();
          }
          if (outcome === "deadline") {
            fakeTimer.advanceTime(500);
          }
          return { success: outcome !== "refused", totalTimeMs: 0, error: "stale frame" };
        },
      };
      const action = new PressButton(androidDevice, fakeAdb, fakeTimer, {
        globalActionClient,
        frameContextClient,
      });
      const pending = action.press("volume_up", {
        timeoutMs: 500,
        frameContext: outcome === "plain" ? undefined : "frame",
        signal: controller.signal,
        onDispatch: () => {
          expect(fakeAdb.getExecutedArgv()).toEqual([]);
          marks++;
        },
      });
      if (outcome === "cancelled") {
        await expect(pending).rejects.toThrow();
      } else {
        expect((await pending).success).toBe(outcome === "plain");
      }
      expect(marks).toBe(outcome === "plain" ? 1 : 0);
      expect(fakeAdb.getExecutedArgv().length).toBe(outcome === "plain" ? 1 : 0);
    },
  );

  test("global action followed by ADB fallback marks once", async () => {
    let marks = 0;
    globalActionClient = {
      requestGlobalAction: async (
        ...args: Parameters<AndroidCtrlProxyClient["requestGlobalAction"]>
      ) => {
        args[3]?.onDispatch?.();
        expect(marks).toBe(1);
        return {
          success: false,
          action: "back",
          totalTimeMs: 0,
          acknowledged: true,
          error: "global action refused",
        };
      },
    };
    const result = await new PressButton(androidDevice, fakeAdb, fakeTimer, {
      globalActionClient,
      frameContextClient,
    }).press("back", { timeoutMs: 500, onDispatch: () => marks++ });
    expect(result.success).toBe(true);
    expect(fakeAdb.getExecutedArgv()).toEqual([["shell", "input", "keyevent", "4"]]);
    expect(marks).toBe(1);
  });

  const press = async (button: string, window?: WindowInterface) => {
    const pressButton = new PressButton(androidDevice, fakeAdb, fakeTimer, {
      ...(window ? { window } : {}),
      globalActionClient,
      frameContextClient,
    });
    const result = await dispatch(pressButton, button);
    expect(pressButtonResultSchema.parse({ message: "Result", ...result })).toBeDefined();
    return result;
  };

  // Home-press verification (issue #6147) reads the foreground app via
  // `this.window`, so non-home buttons -- which skip verification entirely
  // -- don't need a configured window at all. Home tests below configure
  // one explicitly.
  const launcherWindow = (): FakeWindow => {
    const window = new FakeWindow();
    window.configureActiveWindow({
      appId: "com.android.launcher3",
      activityName: "Launcher",
      layoutSeqSum: 0,
    });
    return window;
  };

  // In-place hardware buttons dispatch straight to an ADB keyevent (no global action).
  test.each<[string, number]>([
    ["menu", 82],
    ["power", 26],
    ["volume_up", 24],
    ["volume_down", 25],
  ])("dispatches keyevent %i for %s", async (button, keyCode) => {
    const result = await press(button);

    expect(result).toEqual({ success: true, button, keyCode });
    expect(fakeAdb.getExecutedCommands()).toEqual([`shell input keyevent ${keyCode}`]);
    expect(fakeAdb.getCommandCalls()).toEqual([
      {
        command: `shell input keyevent ${keyCode}`,
        timeoutMs: undefined,
        maxBuffer: undefined,
        noRetry: true,
        signal: undefined,
      },
    ]);
  });

  test("normalizes the button name case before resolving the keycode", async () => {
    const result = await press("MENU");

    expect(result).toEqual({ success: true, button: "MENU", keyCode: 82 });
    expect(fakeAdb.getExecutedCommands()).toEqual(["shell input keyevent 82"]);
  });

  test("rejects an unknown button without dispatching a keyevent", async () => {
    const result = await press("definitely_not_a_button");

    expect(result.success).toBe(false);
    expect(result.keyCode).toBe(-1);
    expect(result.error).toContain("Unsupported button");
    expect(fakeAdb.getExecutedCommands()).toEqual([]);
  });

  test.each(["action", "camera"])(
    "refuses the iOS-only %s button with a typed error and no keyevent",
    async (button) => {
      const result = await press(button);

      expect(result).toMatchObject({
        success: false,
        keyCode: -1,
        code: "unsupported_button",
        retryable: false,
      });
      expect(result.error).toContain("iOS-only");
      expect(fakeAdb.getExecutedCommands()).toEqual([]);
    },
  );

  // Navigation buttons fall back to an ADB keyevent when the a11y global action
  // is unavailable. This pins the keycode each navigation button maps to — e.g.
  // "back" must be 4 (KEYCODE_BACK), never 3 (KEYCODE_HOME).
  test.each<[string, number]>([
    ["back", 4],
    ["recent", 187],
  ])("falls back to keyevent %i for navigation button %s", async (button, keyCode) => {
    globalActionClient = {
      requestGlobalAction: async () => {
        throw new Error("global action unavailable");
      },
    };

    const result = await press(button);

    expect(result).toEqual({ success: true, button, keyCode });
    expect(fakeAdb.getExecutedCommands()).toEqual([`shell input keyevent ${keyCode}`]);
  });

  describe("global action delivery safety", () => {
    for (const [button, keyCode] of [
      ["back", 4],
      ["recent", 187],
    ] as const) {
      test.each(["timeout", "socket closed", "thrown after send"])(
        `${button} does not repeat a press after %s`,
        async (reason) => {
          globalActionClient = {
            requestGlobalAction: async (
              ...args: Parameters<AndroidCtrlProxyClient["requestGlobalAction"]>
            ) => {
              args[3]?.onDispatch?.();
              if (reason === "thrown after send") {
                throw new Error(reason);
              }
              return {
                success: false,
                action: button,
                totalTimeMs: 3000,
                error: reason,
                acknowledged: false,
              };
            },
          };
          const result = await press(button);
          expect(result.success).toBe(false);
          expect(result.error).toContain("may have been applied");
          expect(result.error).toContain("Observe before retrying");
          expect(fakeAdb.getExecutedCommands()).toEqual([]);
        },
      );
      test.each(["WebSocket not connected", "send failed", "device refused", "unsupported"])(
        `${button} falls back exactly once after %s`,
        async (reason) => {
          globalActionClient = {
            requestGlobalAction: async (
              ...args: Parameters<AndroidCtrlProxyClient["requestGlobalAction"]>
            ) => {
              const acknowledged = reason === "device refused" || reason === "unsupported";
              if (acknowledged) {
                args[3]?.onDispatch?.();
              }
              return {
                success: false,
                action: button,
                totalTimeMs: 0,
                error: reason,
                acknowledged,
              };
            },
          };
          expect(await press(button)).toEqual({ success: true, button, keyCode });
          expect(fakeAdb.getExecutedCommands()).toEqual([`shell input keyevent ${keyCode}`]);
        },
      );
      test(`${button} acknowledged success does not use ADB`, async () => {
        globalActionClient = {
          requestGlobalAction: async (
            ...args: Parameters<AndroidCtrlProxyClient["requestGlobalAction"]>
          ) => {
            args[3]?.onDispatch?.();
            return { success: true, action: button, totalTimeMs: 1, acknowledged: true };
          },
        };
        expect(await press(button)).toEqual({ success: true, button, keyCode });
        expect(fakeAdb.getExecutedCommands()).toEqual([]);
      });
    }
    test("home still falls back after a dispatched timeout and verifies the launcher", async () => {
      globalActionClient = {
        requestGlobalAction: async (
          ...args: Parameters<AndroidCtrlProxyClient["requestGlobalAction"]>
        ) => {
          args[3]?.onDispatch?.();
          return {
            success: false,
            action: "home",
            totalTimeMs: 3000,
            error: "timeout",
            acknowledged: false,
          };
        },
      };
      expect((await press("home", launcherWindow())).success).toBe(true);
      expect(
        fakeAdb.getExecutedCommands().filter((command) => command.includes("input keyevent")),
      ).toEqual(["shell input keyevent 3"]);
    });
  });

  // Home-press verification (issue #6147): "home" additionally must confirm
  // the foreground app actually became the launcher before trusting either
  // the global action or the ADB keyevent fallback.
  describe("home button (issue #6147)", () => {
    test.each([
      ["automotive", "com.android.car.mapsplaceholder", true],
      ["automotive", "com.android.car.mapsplaceholder.fake", false],
      ["automotive", "com.android.car.settings", false],
      ["phone", "com.android.car.mapsplaceholder", false],
    ] as const)("%s Home verifies %s with result %s", async (formFactor, appId, success) => {
      fakeAdb.setCommandResponse(
        "resolve-activity",
        createExecResult("com.android.car.carlauncher/.CarLauncher", ""),
      );
      const action = new PressButton({ ...androidDevice, formFactor }, fakeAdb, fakeTimer, {
        window: sequencedWindow([appId]),
        globalActionClient: {
          requestGlobalAction: async () => ({ success: false, action: "home", totalTimeMs: 0 }),
        },
      });
      const result = await dispatch(action, "home");
      expect(result.success).toBe(success);
      expect(fakeAdb.getExecutedCommands()).toContain("shell input keyevent 3");
    });

    test("AAOS Home on an unchanged launcher host succeeds as a no-op", async () => {
      const appId = "com.android.car.mapsplaceholder";
      fakeAdb.setCommandResponse(
        "resolve-activity",
        createExecResult("com.android.car.carlauncher/.CarLauncher", ""),
      );
      const window = new FakeWindow();
      window.configureCachedActiveWindow(null);
      window.configureActiveWindow({ appId, activityName: "Main", layoutSeqSum: 1 });
      const observe = new FakeObserveScreen();
      observe.setObserveResult(
        buildObserveResult({
          updatedAt: 1,
          screenSize: { width: 1080, height: 1920 },
          systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
          viewHierarchy: { packageName: appId, hierarchy: { node: {} } },
        }),
      );
      const action = new PressButton(
        { ...androidDevice, formFactor: "automotive" },
        fakeAdb,
        fakeTimer,
        {
          window,
          observeScreen: observe,
          awaitIdle: new FakeAwaitIdle(),
          globalActionClient: {
            requestGlobalAction: async () => ({ success: true, action: "home", totalTimeMs: 0 }),
          },
        },
      );
      const result = await action.execute("home");
      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
    });

    test("falls back to keyevent 3 and succeeds once the launcher is confirmed foreground", async () => {
      globalActionClient = {
        requestGlobalAction: async () => {
          throw new Error("global action unavailable");
        },
      };

      const result = await press("home", launcherWindow());

      expect(result).toEqual({ success: true, button: "home", keyCode: 3 });
      // Filter out the configured-HOME-launcher resolution call (issue #6147
      // review, P1) that verification now performs alongside the keyevent.
      expect(fakeAdb.getExecutedCommands().filter((cmd) => cmd.includes("keyevent"))).toEqual([
        "shell input keyevent 3",
      ]);
    });

    // API 28 repro: the accessibility global action for "home" reports
    // success, but the foreground app never actually changes. Must not
    // report success on that self-reported result alone.
    test("does not trust an inert global action on API 28 and falls back to the ADB keyevent", async () => {
      globalActionClient = {
        requestGlobalAction: async () => ({ success: true, action: "home", totalTimeMs: 0 }),
      };
      // The post-global-action verification retries internally (initial
      // attempt + 2 backoff retries) before giving up, so it must see the
      // original app on all 3 of those checks; only the post-ADB-keyevent
      // verification's first check sees the launcher -- proving the ADB
      // fallback genuinely ran rather than being skipped as redundant.
      const result = await press(
        "home",
        sequencedWindow([
          "com.android.settings",
          "com.android.settings",
          "com.android.settings",
          "com.android.launcher3",
        ]),
      );

      expect(result).toEqual({ success: true, button: "home", keyCode: 3 });
      // The inert global action must not short-circuit the ADB fallback.
      // Filter out the configured-HOME-launcher resolution calls (issue #6147
      // review, P1) that verification now performs alongside the keyevent.
      expect(fakeAdb.getExecutedCommands().filter((cmd) => cmd.includes("keyevent"))).toEqual([
        "shell input keyevent 3",
      ]);
    });

    test("surfaces failure instead of false success when neither path reaches the launcher", async () => {
      globalActionClient = {
        requestGlobalAction: async () => ({ success: true, action: "home", totalTimeMs: 0 }),
      };
      const stuckWindow = new FakeWindow();
      stuckWindow.configureActiveWindow({
        appId: "com.android.settings",
        activityName: "Settings",
        layoutSeqSum: 0,
      });

      const result = await press("home", stuckWindow);

      expect(result.success).toBe(false);
      expect(result.keyCode).toBe(-1);
      expect(result.error).toContain("did not background the foreground app");
      // The ADB fallback must actually have been attempted, not skipped.
      // Filter out the configured-HOME-launcher resolution calls (issue #6147
      // review, P1) that verification now performs alongside the keyevent.
      expect(fakeAdb.getExecutedCommands().filter((cmd) => cmd.includes("keyevent"))).toEqual([
        "shell input keyevent 3",
      ]);
    });
  });

  // Deadline/abort plumbing (issue #6289): press() accepts a signal, threaded
  // into the ADB keyevent fallback and the home-foreground verification reads.
  // A failed verification is the only signal available that the cached
  // configured-HOME package may no longer describe the device in front of us
  // (#6863 review): in direct mode there is no incarnation token, so a
  // reconnect or a reused serial leaves the cache looking valid. Evicting on
  // failure lets the next attempt re-resolve instead of reporting a real Home
  // press as failed for the rest of the cache window.
  describe("home verification self-heals a stale launcher cache", () => {
    const verifier = (window: WindowInterface): PressButton => {
      const pressButton = new PressButton(androidDevice, fakeAdb, fakeTimer, {
        globalActionClient,
        frameContextClient,
        window,
      });
      return pressButton;
    };

    test("evicts the cached HOME package when verification fails", async () => {
      // An epoch token is registered, so the entry would otherwise survive the
      // full TTL -- only the failure eviction can make the next call re-resolve.
      setDeviceIncarnationResolver(() => 1);
      fakeAdb.setCommandResponse("resolve-activity", createExecResult("com.launcher.a/.Main", ""));

      await expect(
        verifier(sequencedWindow(["com.other.app"])).testHooks.verifyAndroidHomeForeground({
          retryDelaysMs: [],
        }),
      ).resolves.toBe(false);

      fakeAdb.setCommandResponse("resolve-activity", createExecResult("com.launcher.b/.Main", ""));
      expect(
        await resolveConfiguredHomePackage(fakeAdb, androidDevice.deviceId, fakeTimer, {
          incarnationToken: "1",
        }),
      ).toBe("com.launcher.b");
    });

    test("keeps the cached HOME package when verification succeeds", async () => {
      setDeviceIncarnationResolver(() => 1);
      fakeAdb.setCommandResponse("resolve-activity", createExecResult("com.launcher.a/.Main", ""));

      await expect(
        verifier(sequencedWindow(["com.launcher.a"])).testHooks.verifyAndroidHomeForeground({
          retryDelaysMs: [],
        }),
      ).resolves.toBe(true);

      fakeAdb.setCommandResponse("resolve-activity", createExecResult("com.launcher.b/.Main", ""));
      expect(
        await resolveConfiguredHomePackage(fakeAdb, androidDevice.deviceId, fakeTimer, {
          incarnationToken: "1",
        }),
      ).toBe("com.launcher.a");
    });
  });

  describe("AbortSignal propagation (issue #6289)", () => {
    test("forwards the signal into the ADB keyevent fallback and home verification", async () => {
      globalActionClient = {
        requestGlobalAction: async () => {
          throw new Error("global action unavailable");
        },
      };
      const window = launcherWindow();
      const controller = new AbortController();

      const pressButton = new PressButton(androidDevice, fakeAdb, fakeTimer, {
        globalActionClient,
        frameContextClient,
        window,
      });
      const result = await dispatch(pressButton, "home", { signal: controller.signal });

      expect(result.success).toBe(true);
      const keyeventCall = fakeAdb.getCommandCalls().find((c) => c.command.includes("keyevent 3"));
      expect(keyeventCall?.signal).toBeDefined();
      // The verification read (getActive) also received the forwarded signal.
      expect(window.getLastGetActiveSignal()).toBeDefined();
    });

    test("combined signal: an ambient request abort cancels the ADB keyevent fallback", async () => {
      globalActionClient = {
        requestGlobalAction: async () => {
          throw new Error("global action unavailable");
        },
      };
      fakeAdb.setThrowOnAbortedSignal();
      const controller = new AbortController();
      controller.abort();

      const pressButton = new PressButton(androidDevice, fakeAdb, fakeTimer, {
        globalActionClient,
        frameContextClient,
        window: launcherWindow(),
      });

      // No explicit signal forwarded -- only the ambient request signal is
      // aborted. Because the fallback COMBINES the (absent) forwarded signal
      // with the ambient one, the ADB keyevent is still cancelled.
      await expect(
        runWithAbortSignal(controller.signal, () => dispatch(pressButton, "home")),
      ).rejects.toThrow(OPERATION_CANCELLED_MESSAGE);

      expect(fakeAdb.getExecutedArgv()).toEqual([]);
      expect(fakeAdb.getCommandCalls()).toEqual([]);
    });

    test("home verification spends the REMAINING deadline, not a fresh full getActive timeout", async () => {
      globalActionClient = {
        requestGlobalAction: async () => {
          throw new Error("global action unavailable");
        },
      };
      const window = launcherWindow();
      const pressButton = new PressButton(androidDevice, fakeAdb, fakeTimer, {
        globalActionClient,
        frameContextClient,
        window,
      });

      // Supply a 1234ms budget: the post-keyevent home verification must forward
      // the leftover budget into getActive rather than letting it fall back to
      // the 5s default (which would overrun a nearly-spent caller deadline).
      await dispatch(pressButton, "home", { timeoutMs: 1234 });

      const verifyOptions = window.getGetActiveOptions();
      expect(verifyOptions.length).toBeGreaterThan(0);
      const verifyTimeout = verifyOptions[verifyOptions.length - 1]?.timeoutMs;
      expect(typeof verifyTimeout).toBe("number");
      expect(verifyTimeout!).toBeGreaterThan(0);
      expect(verifyTimeout!).toBeLessThanOrEqual(1234);
    });

    test("does not start a verification read after the shared deadline expires", async () => {
      const window = launcherWindow();
      // verifyAndroidHomeForeground only needs these collaborators. Avoid the
      // production constructor here because it allocates a CtrlProxy port that
      // is unrelated to this pre-read deadline gate.
      const pressButton = new PressButton(androidDevice, fakeAdb, fakeTimer, {
        globalActionClient,
        frameContextClient,
        window,
      });

      await expect(
        pressButton.testHooks.verifyAndroidHomeForeground({ timeoutMs: 0 }),
      ).resolves.toBe(false);

      expect(window.getGetActiveCallCount()).toBe(0);
    });

    test("does not accept launcher evidence after the foreground read spends the budget", async () => {
      class BudgetSpendingWindow extends FakeWindow {
        override async getActive(): ReturnType<FakeWindow["getActive"]> {
          fakeTimer.advanceTime(1);
          return {
            appId: "com.android.launcher3",
            activityName: "Launcher",
            layoutSeqSum: 0,
          };
        }
      }
      const window = new BudgetSpendingWindow();
      const pressButton = new PressButton(androidDevice, fakeAdb, fakeTimer, {
        globalActionClient,
        frameContextClient,
        window,
      });

      await expect(
        pressButton.testHooks.verifyAndroidHomeForeground({ timeoutMs: 1 }),
      ).resolves.toBe(false);
      expect(fakeAdb.getCommandCalls()).toEqual([]);
    });

    test("forwards the signal into the CtrlProxy global-action wait", async () => {
      let capturedSignal: AbortSignal | undefined;
      globalActionClient = {
        requestGlobalAction: async (
          _action: string,
          _timeoutMs?: number,
          _perf?: unknown,
          options?: AndroidGlobalActionOptions,
        ) => {
          capturedSignal = options?.signal;
          // Report failure so the flow falls back to the ADB keyevent path.
          return { success: false, action: "home", totalTimeMs: 0, error: "not now" };
        },
      };
      const controller = new AbortController();
      const pressButton = new PressButton(androidDevice, fakeAdb, fakeTimer, {
        globalActionClient,
        frameContextClient,
        window: launcherWindow(),
      });

      await dispatch(pressButton, "home", { signal: controller.signal });

      expect(capturedSignal).toBe(controller.signal);
    });

    test("forwards the frame context into the CtrlProxy global-action request", async () => {
      const frameContexts: Array<string | undefined> = [];
      globalActionClient = {
        requestGlobalAction: async (
          _action: string,
          _timeoutMs?: number,
          _perf?: unknown,
          options?: AndroidGlobalActionOptions,
        ) => {
          frameContexts.push(options?.frameContext);
          return { success: true, action: "back", totalTimeMs: 0 };
        },
      };
      const pressButton = new PressButton(androidDevice, fakeAdb, fakeTimer, {
        globalActionClient,
        frameContextClient,
        window: launcherWindow(),
      });

      await dispatch(pressButton, "back", { frameContext: "frame-9" });

      expect(frameContexts).toEqual(["frame-9"]);
    });

    test("forwards the signal into the CtrlProxy frame-context validation wait", async () => {
      let capturedSignal: AbortSignal | undefined;
      globalActionClient = {
        requestGlobalAction: async () => ({ success: false, action: "back", totalTimeMs: 0 }),
      };
      frameContextClient = {
        validateFrameContext: async (
          _frameContext: string,
          _timeoutMs?: number,
          signal?: AbortSignal,
        ) => {
          capturedSignal = signal;
          return { success: true, totalTimeMs: 0 };
        },
      };
      const controller = new AbortController();
      const pressButton = new PressButton(androidDevice, fakeAdb, fakeTimer, {
        globalActionClient,
        frameContextClient,
      });

      const result = await dispatch(pressButton, "back", {
        timeoutMs: 500,
        frameContext: "frame-1",
        signal: controller.signal,
      });

      expect(result.success).toBe(true);
      expect(capturedSignal).toBe(controller.signal);
    });

    test("classifies an ambient-only abort during verification as cancellation, not a read failure", async () => {
      // The normal MCP route forwards no explicit signal; only the ambient
      // request signal aborts. verifyAndroidHomeForeground must combine the two
      // and rethrow the abort out of the retry loop instead of logging it as an
      // ordinary read failure and sleeping/retrying to a false `false` verdict.
      const window = new FakeWindow();
      window.setThrowOnAbortedSignal();
      window.configureActiveWindow({
        appId: "com.android.settings",
        activityName: "Settings",
        layoutSeqSum: 0,
      });
      const pressButton = new PressButton(androidDevice, fakeAdb, fakeTimer, {
        globalActionClient,
        frameContextClient,
        window,
      });
      const controller = new AbortController();
      controller.abort();

      await expect(
        runWithAbortSignal(controller.signal, () =>
          pressButton.testHooks.verifyAndroidHomeForeground({}),
        ),
      ).rejects.toThrow(OPERATION_CANCELLED_MESSAGE);
      // Exactly one read attempt: the abort broke the loop, no retry backoffs ran.
      expect(window.getGetActiveCallCount()).toBe(1);
    });
  });

  test("rejects a stale context instead of falling back from a failed global action to ADB", async () => {
    globalActionClient = {
      requestGlobalAction: async () => ({
        success: false,
        action: "back",
        totalTimeMs: 0,
        error: "global action unavailable",
      }),
    };
    frameContextClient = {
      validateFrameContext: async () => ({
        success: false,
        totalTimeMs: 0,
        error: "Stale frame context; observe a fresh frame before retrying",
      }),
    };

    const pressButton = new PressButton(androidDevice, fakeAdb, undefined, {
      globalActionClient,
      frameContextClient,
    });
    const result = await dispatch(pressButton, "back", { timeoutMs: 500, frameContext: "epoch:2" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Stale frame context");
    expect(fakeAdb.getExecutedCommands()).toEqual([]);
  });

  test("validates a context before dispatching an ADB-only hardware button", async () => {
    frameContextClient = {
      validateFrameContext: async () => ({
        success: false,
        totalTimeMs: 0,
        error: "Stale frame context; observe a fresh frame before retrying",
      }),
    };

    const pressButton = new PressButton(androidDevice, fakeAdb, undefined, {
      globalActionClient,
      frameContextClient,
    });
    const result = await dispatch(pressButton, "volume_up", {
      timeoutMs: 500,
      frameContext: "epoch:3",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Stale frame context");
    expect(fakeAdb.getExecutedCommands()).toEqual([]);
  });
});

// Validate the actual fake-backed branch results before and after finalization.
const pressForOutputSchema = PressButton.prototype.press;
let pressOutputSchemaSpy: ReturnType<typeof spyOnOutputSchema>;
beforeOutputSchema(() => {
  pressOutputSchemaSpy = spyOnOutputSchema(PressButton.prototype, "press").mockImplementation(
    async function (this: PressButton, ...args: Parameters<PressButton["press"]>) {
      const result = await pressForOutputSchema.apply(this, args);
      const payload = { message: "Result", ...result };
      expect(pressButtonResultSchema.parse(payload)).toBeDefined();
      const finalized = finalizeToolResponse(createStructuredToolResponse(payload), {
        name: "pressButton",
        outputSchema: pressButtonResultSchema,
        artifactWriter: new FakeArtifactWriter(),
      });
      expect(pressButtonResultSchema.parse(finalized.structuredContent)).toBeDefined();
      return result;
    },
  );
});
afterOutputSchema(() => pressOutputSchemaSpy.mockRestore());

// Dispatch tests drive the transport seam through testHooks and still validate the result schema.
async function dispatch(
  pressButton: PressButton,
  ...args: Parameters<PressButton["press"]>
): ReturnType<PressButton["press"]> {
  const result = await pressButton.testHooks.executeAndroidButtonPress(...args);
  expect(pressButtonResultSchema.parse({ message: "Result", ...result })).toBeDefined();
  return result;
}

describe("acceptAndroidHomeAlreadyOnLauncher (#15028)", () => {
  test.each([
    ["android", "home", false],
    ["android", "back", true],
    ["ios", "home", true],
  ] as const)(
    "preserves no-change failure for %s %s, press ok=%s",
    (platform, button, pressSucceeded) => {
      const result = { success: false, error: "No visual change observed" };
      acceptAndroidHomeAlreadyOnLauncher(result, { platform, button, pressSucceeded });
      expect(result).toEqual({ success: false, error: "No visual change observed" });
    },
  );

  test("preserves other errors and successful screen changes", () => {
    const context = { platform: "android", button: "home", pressSucceeded: true };
    const failed = { success: false, error: "Observation failed" };
    acceptAndroidHomeAlreadyOnLauncher(failed, context);
    expect(failed).toEqual({ success: false, error: "Observation failed" });
    const changed = { success: true };
    acceptAndroidHomeAlreadyOnLauncher(changed, context);
    expect(changed).toEqual({ success: true });
  });
});
