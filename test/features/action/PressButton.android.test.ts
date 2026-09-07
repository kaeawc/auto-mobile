import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { PressButton } from "../../../src/features/action/PressButton";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeWindow } from "../../fakes/FakeWindow";
import { FakeTimer } from "../../fakes/FakeTimer";
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
  });

  afterEach(() => {
    getInstanceSpy?.mockRestore();
    getInstanceSpy = null;
  });

  const press = (button: string, window?: WindowInterface) => {
    const pressButton = new PressButton(androidDevice, fakeAdb, fakeTimer);
    if (window) {
      (pressButton as any).window = window;
    }
    return (pressButton as any).executeAndroidButtonPress(button) as Promise<{
      success: boolean;
      button: string;
      keyCode: number;
      error?: string;
    }>;
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
