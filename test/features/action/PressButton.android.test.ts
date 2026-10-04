import {
  beforeEach as beforeOutputSchema,
  afterEach as afterOutputSchema,
  spyOn as spyOnOutputSchema,
} from "bun:test";
import { pressButtonResultSchema } from "../../../src/server/toolOutputSchemas";
import { finalizeToolResponse } from "../../../src/server/finalizeToolResponse";
import { createStructuredToolResponse } from "../../../src/utils/toolUtils";
import { FakeArtifactWriter } from "../../fakes/FakeArtifactWriter";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { PressButton } from "../../../src/features/action/PressButton";
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
  let getInstanceSpy: ReturnType<typeof spyOn> | null = null;

  beforeEach(() => {
    fakeAdb = new FakeAdbExecutor();
    fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    clearResolvedHomePackageCache();
  });

  afterEach(() => {
    getInstanceSpy?.mockRestore();
    getInstanceSpy = null;
    setDeviceIncarnationResolver(undefined);
    clearResolvedHomePackageCache();
  });

  const press = async (button: string, window?: WindowInterface) => {
    const pressButton = new PressButton(androidDevice, fakeAdb, fakeTimer);
    if (window) {
      (pressButton as any).window = window;
    }
    const result = await (
      pressButton as unknown as {
        executeAndroidButtonPress(button: string): ReturnType<PressButton["press"]>;
      }
    ).executeAndroidButtonPress(button);
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

  // Navigation buttons fall back to an ADB keyevent when the a11y global action
  // is unavailable. This pins the keycode each navigation button maps to — e.g.
  // "back" must be 4 (KEYCODE_BACK), never 3 (KEYCODE_HOME).
  test.each<[string, number]>([
    ["back", 4],
    ["recent", 187],
  ])("falls back to keyevent %i for navigation button %s", async (button, keyCode) => {
    getInstanceSpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue({
      requestGlobalAction: async () => {
        throw new Error("global action unavailable");
      },
    } as unknown as AndroidCtrlProxyClient);

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
          getInstanceSpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue({
            requestGlobalAction: async (
              ...args: Parameters<AndroidCtrlProxyClient["requestGlobalAction"]>
            ) => {
              args[5]?.();
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
          } as unknown as AndroidCtrlProxyClient);
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
          getInstanceSpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue({
            requestGlobalAction: async (
              ...args: Parameters<AndroidCtrlProxyClient["requestGlobalAction"]>
            ) => {
              const acknowledged = reason === "device refused" || reason === "unsupported";
              if (acknowledged) {
                args[5]?.();
              }
              return {
                success: false,
                action: button,
                totalTimeMs: 0,
                error: reason,
                acknowledged,
              };
            },
          } as unknown as AndroidCtrlProxyClient);
          expect(await press(button)).toEqual({ success: true, button, keyCode });
          expect(fakeAdb.getExecutedCommands()).toEqual([`shell input keyevent ${keyCode}`]);
        },
      );
      test(`${button} acknowledged success does not use ADB`, async () => {
        getInstanceSpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue({
          requestGlobalAction: async (
            ...args: Parameters<AndroidCtrlProxyClient["requestGlobalAction"]>
          ) => {
            args[5]?.();
            return { success: true, action: button, totalTimeMs: 1, acknowledged: true };
          },
        } as unknown as AndroidCtrlProxyClient);
        expect(await press(button)).toEqual({ success: true, button, keyCode });
        expect(fakeAdb.getExecutedCommands()).toEqual([]);
      });
    }
    test("home still falls back after a dispatched timeout and verifies the launcher", async () => {
      getInstanceSpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue({
        requestGlobalAction: async (
          ...args: Parameters<AndroidCtrlProxyClient["requestGlobalAction"]>
        ) => {
          args[5]?.();
          return {
            success: false,
            action: "home",
            totalTimeMs: 3000,
            error: "timeout",
            acknowledged: false,
          };
        },
      } as unknown as AndroidCtrlProxyClient);
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
    test("falls back to keyevent 3 and succeeds once the launcher is confirmed foreground", async () => {
      getInstanceSpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue({
        requestGlobalAction: async () => {
          throw new Error("global action unavailable");
        },
      } as unknown as AndroidCtrlProxyClient);

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
      getInstanceSpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue({
        requestGlobalAction: async () => ({ success: true }),
      } as unknown as AndroidCtrlProxyClient);
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
      getInstanceSpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue({
        requestGlobalAction: async () => ({ success: true }),
      } as unknown as AndroidCtrlProxyClient);
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
      const pressButton = Object.create(PressButton.prototype) as PressButton;
      (pressButton as any).timer = fakeTimer;
      (pressButton as any).adb = fakeAdb;
      (pressButton as any).device = androidDevice;
      (pressButton as any).window = window;
      return pressButton;
    };

    test("evicts the cached HOME package when verification fails", async () => {
      // An epoch token is registered, so the entry would otherwise survive the
      // full TTL -- only the failure eviction can make the next call re-resolve.
      setDeviceIncarnationResolver(() => 1);
      fakeAdb.setCommandResponse("resolve-activity", {
        stdout: "com.launcher.a/.Main",
        stderr: "",
      });

      await expect(
        (verifier(sequencedWindow(["com.other.app"])) as any).verifyAndroidHomeForeground({
          retryDelaysMs: [],
        }),
      ).resolves.toBe(false);

      fakeAdb.setCommandResponse("resolve-activity", {
        stdout: "com.launcher.b/.Main",
        stderr: "",
      });
      expect(
        await resolveConfiguredHomePackage(fakeAdb, androidDevice.deviceId, fakeTimer, "1"),
      ).toBe("com.launcher.b");
    });

    test("keeps the cached HOME package when verification succeeds", async () => {
      setDeviceIncarnationResolver(() => 1);
      fakeAdb.setCommandResponse("resolve-activity", {
        stdout: "com.launcher.a/.Main",
        stderr: "",
      });

      await expect(
        (verifier(sequencedWindow(["com.launcher.a"])) as any).verifyAndroidHomeForeground({
          retryDelaysMs: [],
        }),
      ).resolves.toBe(true);

      fakeAdb.setCommandResponse("resolve-activity", {
        stdout: "com.launcher.b/.Main",
        stderr: "",
      });
      expect(
        await resolveConfiguredHomePackage(fakeAdb, androidDevice.deviceId, fakeTimer, "1"),
      ).toBe("com.launcher.a");
    });
  });

  describe("AbortSignal propagation (issue #6289)", () => {
    test("forwards the signal into the ADB keyevent fallback and home verification", async () => {
      getInstanceSpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue({
        requestGlobalAction: async () => {
          throw new Error("global action unavailable");
        },
      } as unknown as AndroidCtrlProxyClient);
      const window = launcherWindow();
      const controller = new AbortController();

      const pressButton = new PressButton(androidDevice, fakeAdb, fakeTimer);
      (pressButton as any).window = window;
      const result = await (pressButton as any).executeAndroidButtonPress(
        "home",
        undefined,
        undefined,
        controller.signal,
      );

      expect(result.success).toBe(true);
      const keyeventCall = fakeAdb.getCommandCalls().find((c) => c.command.includes("keyevent 3"));
      expect(keyeventCall?.signal).toBeDefined();
      // The verification read (getActive) also received the forwarded signal.
      expect(window.getLastGetActiveSignal()).toBeDefined();
    });

    test("combined signal: an ambient request abort cancels the ADB keyevent fallback", async () => {
      getInstanceSpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue({
        requestGlobalAction: async () => {
          throw new Error("global action unavailable");
        },
      } as unknown as AndroidCtrlProxyClient);
      fakeAdb.setThrowOnAbortedSignal();
      const controller = new AbortController();
      controller.abort();

      const pressButton = new PressButton(androidDevice, fakeAdb, fakeTimer);
      (pressButton as any).window = launcherWindow();

      // No explicit signal forwarded -- only the ambient request signal is
      // aborted. Because the fallback COMBINES the (absent) forwarded signal
      // with the ambient one, the ADB keyevent is still cancelled.
      await expect(
        runWithAbortSignal(controller.signal, () =>
          (pressButton as any).executeAndroidButtonPress("home"),
        ),
      ).rejects.toThrow(OPERATION_CANCELLED_MESSAGE);

      const keyeventCall = fakeAdb.getCommandCalls().find((c) => c.command.includes("keyevent 3"));
      expect(keyeventCall?.signal?.aborted).toBe(true);
    });

    test("home verification spends the REMAINING deadline, not a fresh full getActive timeout", async () => {
      getInstanceSpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue({
        requestGlobalAction: async () => {
          throw new Error("global action unavailable");
        },
      } as unknown as AndroidCtrlProxyClient);
      const window = launcherWindow();
      const pressButton = new PressButton(androidDevice, fakeAdb, fakeTimer);
      (pressButton as any).window = window;

      // Supply a 1234ms budget: the post-keyevent home verification must forward
      // the leftover budget into getActive rather than letting it fall back to
      // the 5s default (which would overrun a nearly-spent caller deadline).
      await (pressButton as any).executeAndroidButtonPress("home", 1234);

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
      const pressButton = Object.create(PressButton.prototype) as PressButton;
      (pressButton as any).timer = fakeTimer;
      (pressButton as any).adb = fakeAdb;
      (pressButton as any).device = androidDevice;
      (pressButton as any).window = window;

      await expect(
        (pressButton as any).verifyAndroidHomeForeground({ timeoutMs: 0 }),
      ).resolves.toBe(false);

      expect(window.getGetActiveCallCount()).toBe(0);
    });

    test("does not accept launcher evidence after the foreground read spends the budget", async () => {
      const window = {
        async getActive() {
          fakeTimer.advanceTime(1);
          return {
            appId: "com.android.launcher3",
            activityName: "Launcher",
            layoutSeqSum: 0,
          };
        },
      };
      const pressButton = Object.create(PressButton.prototype) as PressButton;
      (pressButton as any).timer = fakeTimer;
      (pressButton as any).adb = fakeAdb;
      (pressButton as any).device = androidDevice;
      (pressButton as any).window = window;

      await expect(
        (pressButton as any).verifyAndroidHomeForeground({ timeoutMs: 1 }),
      ).resolves.toBe(false);
      expect(fakeAdb.getCommandCalls()).toEqual([]);
    });

    test("forwards the signal into the CtrlProxy global-action wait", async () => {
      let capturedSignal: AbortSignal | undefined;
      getInstanceSpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue({
        requestGlobalAction: async (
          _action: string,
          _timeoutMs?: number,
          _perf?: unknown,
          _frameContext?: string,
          signal?: AbortSignal,
        ) => {
          capturedSignal = signal;
          // Report failure so the flow falls back to the ADB keyevent path.
          return { success: false, action: "home", totalTimeMs: 0, error: "not now" };
        },
      } as unknown as AndroidCtrlProxyClient);
      const controller = new AbortController();
      const pressButton = new PressButton(androidDevice, fakeAdb, fakeTimer);
      (pressButton as any).window = launcherWindow();

      await (pressButton as any).executeAndroidButtonPress(
        "home",
        undefined,
        undefined,
        controller.signal,
      );

      expect(capturedSignal).toBe(controller.signal);
    });

    test("forwards the signal into the CtrlProxy frame-context validation wait", async () => {
      let capturedSignal: AbortSignal | undefined;
      getInstanceSpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue({
        requestGlobalAction: async () => ({ success: false, action: "back", totalTimeMs: 0 }),
        validateFrameContext: async (
          _frameContext: string,
          _timeoutMs?: number,
          signal?: AbortSignal,
        ) => {
          capturedSignal = signal;
          return { success: true, totalTimeMs: 0 };
        },
      } as unknown as AndroidCtrlProxyClient);
      const controller = new AbortController();
      const pressButton = new PressButton(androidDevice, fakeAdb, fakeTimer);

      const result = await (pressButton as any).executeAndroidButtonPress(
        "back",
        500,
        "frame-1",
        controller.signal,
      );

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
      const pressButton = new PressButton(androidDevice, fakeAdb, fakeTimer);
      (pressButton as any).window = window;
      const controller = new AbortController();
      controller.abort();

      await expect(
        runWithAbortSignal(controller.signal, () =>
          (pressButton as any).verifyAndroidHomeForeground({}),
        ),
      ).rejects.toThrow(OPERATION_CANCELLED_MESSAGE);
      // Exactly one read attempt: the abort broke the loop, no retry backoffs ran.
      expect(window.getGetActiveCallCount()).toBe(1);
    });
  });

  test("rejects a stale context instead of falling back from a failed global action to ADB", async () => {
    getInstanceSpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue({
      requestGlobalAction: async () => ({ success: false, error: "global action unavailable" }),
      validateFrameContext: async () => ({
        success: false,
        error: "Stale frame context; observe a fresh frame before retrying",
      }),
    } as unknown as AndroidCtrlProxyClient);

    const pressButton = new PressButton(androidDevice, fakeAdb);
    const result = await (pressButton as any).executeAndroidButtonPress("back", 500, "epoch:2");

    expect(result.success).toBe(false);
    expect(result.error).toContain("Stale frame context");
    expect(fakeAdb.getExecutedCommands()).toEqual([]);
  });

  test("validates a context before dispatching an ADB-only hardware button", async () => {
    getInstanceSpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue({
      validateFrameContext: async () => ({
        success: false,
        error: "Stale frame context; observe a fresh frame before retrying",
      }),
    } as unknown as AndroidCtrlProxyClient);

    const pressButton = new PressButton(androidDevice, fakeAdb);
    const result = await (pressButton as any).executeAndroidButtonPress(
      "volume_up",
      500,
      "epoch:3",
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("Stale frame context");
    expect(fakeAdb.getExecutedCommands()).toEqual([]);
  });
});

// Validate the actual fake-backed branch results before and after finalization.
const executeForOutputSchema = PressButton.prototype.execute;
let executeOutputSchemaSpy: ReturnType<typeof spyOnOutputSchema>;
beforeOutputSchema(() => {
  executeOutputSchemaSpy = spyOnOutputSchema(PressButton.prototype, "execute").mockImplementation(
    async function (this: PressButton, ...args: Parameters<PressButton["execute"]>) {
      const result = await executeForOutputSchema.apply(this, args);
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
afterOutputSchema(() => executeOutputSchemaSpy.mockRestore());

// Existing dispatch tests intentionally exercise the private transport seam.
const dispatchPrototype = PressButton.prototype as unknown as {
  executeAndroidButtonPress: PressButton["press"];
};
const dispatchForOutputSchema = dispatchPrototype.executeAndroidButtonPress;
let dispatchOutputSchemaSpy: ReturnType<typeof spyOnOutputSchema>;
beforeOutputSchema(() => {
  dispatchOutputSchemaSpy = spyOnOutputSchema(
    dispatchPrototype,
    "executeAndroidButtonPress",
  ).mockImplementation(async function (
    this: PressButton,
    ...args: Parameters<PressButton["press"]>
  ) {
    const result = await dispatchForOutputSchema.apply(this, args);
    expect(pressButtonResultSchema.parse({ message: "Result", ...result })).toBeDefined();
    return result;
  });
});
afterOutputSchema(() => dispatchOutputSchemaSpy.mockRestore());
