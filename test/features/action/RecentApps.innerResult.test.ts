import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { RecentApps } from "../../../src/features/action/RecentApps";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import type { BootedDevice, ObserveResult, ViewHierarchyResult } from "../../../src/models";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeWindow } from "../../fakes/FakeWindow";
import { FakeAwaitIdle } from "../../fakes/FakeAwaitIdle";
import { FakeTimer } from "../../fakes/FakeTimer";
import capturedRecents from "../../fixtures/android-launcher/launcher-recents-emulator-5600.json";
import capturedHome from "../../fixtures/android-launcher/launcher-home-emulator-5600.json";
import capturedAppHierarchy from "../../fixtures/android-focus/playground-text-field-pre-tap.json";

const device: BootedDevice = {
  name: "test-device",
  platform: "android",
  deviceId: "test-recent-apps",
};

const screenSize = { width: 1080, height: 2400 };
const systemInsets = { top: 63, bottom: 63, left: 0, right: 0 };

function observation(viewHierarchy: ViewHierarchyResult, timer: FakeTimer): ObserveResult {
  return { timestamp: timer.now(), screenSize, systemInsets, viewHierarchy };
}

/** Real captured Playground hierarchy: includes android:id/content and a navigation bar view. */
function capturedObservation(timer: FakeTimer): ObserveResult {
  return { ...capturedAppHierarchy, timestamp: timer.now(), screenSize, systemInsets };
}

/**
 * Minimal typed app hierarchy for #9979: the app tags a container with the bare id `content`
 * (e.g. Compose testTagsAsResourceId) holding a clickable control whose id merely contains a
 * navigation-ish word. Only the resource ids matter here; this is not a device dump.
 */
function appHierarchyWithControl(containerId: string, controlId: string): ViewHierarchyResult {
  return {
    hierarchy: {
      node: {
        $: { class: "android.widget.FrameLayout", "resource-id": containerId },
        node: [
          {
            $: {
              "resource-id": controlId,
              class: "android.view.View",
              bounds: { left: 720, top: 1810, right: 1080, bottom: 1910 },
              clickable: "true",
            },
          },
        ],
      },
    },
  };
}

describe("RecentApps inner result", () => {
  let recentApps: RecentApps;
  let adb: FakeAdbExecutor;
  let observe: FakeObserveScreen;
  let timer: FakeTimer;
  let instanceSpy: ReturnType<typeof spyOn> | undefined;
  let globalActionSpy: ReturnType<typeof spyOn> | undefined;

  beforeEach(() => {
    adb = new FakeAdbExecutor();
    timer = new FakeTimer();
    timer.enableAutoAdvance();
    observe = new FakeObserveScreen();
    observe.enableAutoVaryHierarchy();
    observe.setObserveResult(() =>
      globalActionSpy?.mock.calls.length ? recentsObservation() : capturedObservation(timer),
    );
    const window = new FakeWindow();
    window.configureCachedActiveWindow(null);
    window.configureActiveWindow({
      appId: "com.test.app",
      activityName: "MainActivity",
      layoutSeqSum: 123,
    });
    recentApps = new RecentApps(device, adb, timer);
    recentApps.observeScreen = observe;
    recentApps.window = window;
    recentApps.awaitIdle = new FakeAwaitIdle();
    const client = AndroidCtrlProxyClient.createForTesting(
      device,
      adb,
      () => {
        throw new Error("Unexpected socket connection");
      },
      timer,
    );
    globalActionSpy = spyOn(client, "requestGlobalAction").mockResolvedValue({
      success: false,
      error: "Global action failed",
    });
    instanceSpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(client);
  });

  afterEach(() => {
    instanceSpy?.mockRestore();
    globalActionSpy?.mockRestore();
  });

  const recentsObservation = (): ObserveResult => ({
    ...capturedRecents,
    timestamp: timer.now(),
    screenSize,
    systemInsets,
  });

  test("already-open overview never dispatches another recent action", async () => {
    observe.setObserveResult(() => recentsObservation());
    const result = await recentApps.execute();
    expect(result.success).toBe(true);
    expect(globalActionSpy).not.toHaveBeenCalled();
    expect(adb.getExecutedCommands().filter((cmd) => cmd.includes("input keyevent"))).toEqual([]);
  });

  test("two consecutive calls open overview with only one navigation dispatch", async () => {
    expect((await recentApps.execute()).success).toBe(true);
    expect((await recentApps.execute()).success).toBe(true);
    expect(globalActionSpy).toHaveBeenCalledTimes(1);
    expect(adb.getExecutedCommands().filter((cmd) => cmd.includes("input keyevent"))).toEqual([
      "shell input keyevent 187",
    ]);
  });

  test("unverified overview cannot suppress navigation or claim success", async () => {
    observe.setObserveResult(() => ({
      ...recentsObservation(),
      freshness: { isFresh: false, verified: false },
    }));
    const result = await recentApps.execute();
    expect(result.success).toBe(false);
    expect(globalActionSpy).toHaveBeenCalledTimes(1);
  });

  test("hardware delivery without overview reports an honest failure", async () => {
    observe.setObserveResult(() => capturedObservation(timer));
    const result = await recentApps.execute();
    expect(result.success).toBe(false);
    expect(result.error).toContain("overview");
    expect(adb.getExecutedCommands()).toContain("shell input keyevent 187");
  });

  test("launcher Home still dispatches recents and verifies the resulting overview", async () => {
    observe.setObserveResult(() =>
      adb.getExecutedCommands().includes("shell input keyevent 187")
        ? recentsObservation()
        : { ...capturedHome, timestamp: timer.now(), screenSize, systemInsets },
    );
    const result = await recentApps.execute();
    expect(result.success).toBe(true);
    expect(globalActionSpy).toHaveBeenCalledTimes(1);
    expect(adb.getExecutedCommands()).toContain("shell input keyevent 187");
  });

  // This regression must fail on the original callback's constant success result.
  test("preserves hardware inner failure and observation", async () => {
    recentApps["executeHardwareNavigation"] = async () => ({
      success: false,
      method: "hardware",
      error: "Hardware failed",
    });
    const result = await recentApps.execute();
    expect(result.success).toBe(false);
    expect(result.method).toBe("hardware");
    expect(result.error).toBe("Hardware failed");
    expect(result.observation).toBeDefined();
  });

  test("real captured app hierarchy opens Recents with the key event, never a tap or swipe", async () => {
    const result = await recentApps.execute();
    expect(result.success).toBe(true);
    expect(result.method).toBe("hardware");
    expect(result.observation).toBeDefined();
    expect(adb.getExecutedCommands().filter((cmd) => cmd.includes("input keyevent"))).toEqual([
      "shell input keyevent 187",
    ]);
  });

  // #9979: app elements whose ids contain navigation-ish words must never be tapped or swiped,
  // whether the container matches `content` exactly or as the framework id.
  test.each([
    ["content", "recent_searches"],
    ["content", "overview_tab"],
    ["content", "recents_button"],
    ["content", "bottom_nav_bar"],
    ["content", "filter_pill"],
    ["content", "home_handle"],
    ["android:id/content", "com.android.systemui:id/recent_apps"],
    ["@android:id/content", "com.android.systemui:id/home_handle"],
  ])("app container %s with control %s is not acted on", async (containerId, controlId) => {
    observe.setObserveResult(() =>
      globalActionSpy?.mock.calls.length
        ? recentsObservation()
        : observation(appHierarchyWithControl(containerId, controlId), timer),
    );
    const result = await recentApps.execute();
    expect(result.success).toBe(true);
    expect(result.method).toBe("hardware");
    const commands = adb.getExecutedCommands().filter((cmd) => cmd.includes("input "));
    expect(commands).toEqual(["shell input keyevent 187"]);
    expect(commands.some((command) => /input (tap|swipe)/.test(command))).toBe(false);
  });

  test("an unavailable view hierarchy allows the press but cannot verify overview", async () => {
    observe.setObserveResult(() => ({
      timestamp: timer.now(),
      screenSize,
      systemInsets,
    }));
    const result = await recentApps.execute();
    expect(result.success).toBe(false);
    expect(result.method).toBe("hardware");
    expect(adb.getExecutedCommands().filter((cmd) => cmd.includes("input keyevent"))).toEqual([
      "shell input keyevent 187",
    ]);
  });

  test("delivered global action succeeds without the key event", async () => {
    globalActionSpy!.mockResolvedValue({
      success: true,
      action: "recent",
      totalTimeMs: 10,
      acknowledged: true,
    });
    const result = await recentApps.execute();
    expect(result.success).toBe(true);
    expect(result.method).toBe("hardware");
    expect(adb.getExecutedCommands().filter((cmd) => cmd.includes("input "))).toEqual([]);
  });

  test("undelivered hardware global action falls back to ADB successfully", async () => {
    const result = await recentApps.execute();
    expect(globalActionSpy).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    expect(result.method).toBe("hardware");
    expect(adb.getExecutedCommands()).toContain("shell input keyevent 187");
  });

  test.each([
    "timeout",
    "socket closed",
    "thrown after send",
    "WebSocket not connected",
    "send failed",
    "device refused",
    "unsupported",
    "success",
  ])("hardware global action delivery: %s", async (reason) => {
    const undelivered = reason === "WebSocket not connected" || reason === "send failed";
    const acknowledged =
      reason === "device refused" || reason === "unsupported" || reason === "success";
    globalActionSpy!.mockImplementation(
      async (...args: Parameters<AndroidCtrlProxyClient["requestGlobalAction"]>) => {
        if (!undelivered) {
          args[5]?.();
        }
        if (reason === "thrown after send") {
          throw new Error(reason);
        }
        return {
          success: reason === "success",
          action: "recent",
          totalTimeMs: 3000,
          error: reason,
          acknowledged,
        };
      },
    );
    const result = await recentApps.execute();
    const indeterminate = !undelivered && !acknowledged;
    expect(result.success).toBe(!indeterminate);
    expect(result.method).toBe("hardware");
    expect(result.observation).toBeDefined();
    if (indeterminate) {
      expect(result.error).toContain("may have been applied");
      expect(result.error).toContain("Observe before retrying");
    }
    expect(
      adb.getExecutedCommands().filter((command) => command.includes("input keyevent")),
    ).toEqual(indeterminate || reason === "success" ? [] : ["shell input keyevent 187"]);
  });

  test("pre-aborted execute rejects without ADB commands", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(recentApps.execute(undefined, controller.signal)).rejects.toThrow(
      "Operation cancelled",
    );
    expect(adb.getExecutedCommands().filter((cmd) => cmd.includes("input "))).toEqual([]);
  });

  test("abort during the key event command rejects", async () => {
    const controller = new AbortController();
    adb.abortAfterCommand("shell input keyevent 187", controller);
    await expect(recentApps.execute(undefined, controller.signal)).rejects.toThrow(
      "Operation cancelled",
    );
    expect(adb.getExecutedCommands()).toContain("shell input keyevent 187");
  });

  test("thrown inner error rejects", async () => {
    recentApps["executeHardwareNavigation"] = async () => {
      throw new Error("Inner hardware error");
    };
    await expect(recentApps.execute()).rejects.toThrow("Inner hardware error");
  });
});
