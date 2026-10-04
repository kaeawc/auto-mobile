import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { RecentApps } from "../../../src/features/action/RecentApps";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import type { BootedDevice, ObserveResult, ViewHierarchyResult } from "../../../src/models";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeWindow } from "../../fakes/FakeWindow";
import { FakeAwaitIdle } from "../../fakes/FakeAwaitIdle";
import { FakeTimer } from "../../fakes/FakeTimer";

type NavigationMethod = "gesture" | "legacy" | "hardware";
const device: BootedDevice = {
  name: "test-device",
  platform: "android",
  deviceId: "test-recent-apps",
};

function createHierarchy(method: NavigationMethod): ViewHierarchyResult {
  return {
    hierarchy: {
      node: {
        $: { class: "android.widget.FrameLayout", "resource-id": "@android:id/content" },
        node:
          method === "hardware"
            ? []
            : [
                {
                  $: {
                    "resource-id":
                      method === "gesture"
                        ? "com.android.systemui:id/home_handle"
                        : "com.android.systemui:id/recent_apps",
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

function createObservation(method: NavigationMethod, timer: FakeTimer): ObserveResult {
  return {
    timestamp: timer.now(),
    screenSize: { width: 1080, height: 1920 },
    systemInsets: { top: 48, bottom: 120, left: 0, right: 0 },
    viewHierarchy: createHierarchy(method),
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
    observe.setObserveResult(() => createObservation("gesture", timer));
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

  // These three regressions must fail on the original callback's constant success result.
  test("preserves gesture inner failure and observation", async () => {
    recentApps["executeGestureNavigation"] = async () => ({
      success: false,
      method: "gesture",
      error: "Gesture failed",
    });
    const result = await recentApps.execute();
    expect(result.success).toBe(false);
    expect(result.method).toBe("gesture");
    expect(result.error).toBe("Gesture failed");
    expect(result.observation).toBeDefined();
  });

  test("preserves legacy inner failure and observation", async () => {
    observe.setObserveResult(() => createObservation("legacy", timer));
    recentApps["executeLegacyNavigation"] = async () => ({
      success: false,
      method: "legacy",
      error: "Legacy failed",
    });
    const result = await recentApps.execute();
    expect(result.success).toBe(false);
    expect(result.method).toBe("legacy");
    expect(result.error).toBe("Legacy failed");
    expect(result.observation).toBeDefined();
  });

  test("preserves hardware inner failure and observation", async () => {
    observe.setObserveResult(() => createObservation("hardware", timer));
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

  test.each([
    ["gesture", "shell input swipe"],
    ["legacy", "shell input tap"],
    ["hardware", "shell input keyevent 187"],
  ] as const)("preserves %s success and issues its command", async (method, command) => {
    observe.setObserveResult(() => createObservation(method, timer));
    const result = await recentApps.execute();
    expect(result.success).toBe(true);
    expect(result.method).toBe(method);
    expect(result.observation).toBeDefined();
    expect(adb.getExecutedCommands().some((executed) => executed.includes(command))).toBe(true);
  });

  test("undelivered hardware global action falls back to ADB successfully", async () => {
    observe.setObserveResult(() => createObservation("hardware", timer));
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
    observe.setObserveResult(() => createObservation("hardware", timer));
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
    expect(adb.getExecutedCommands()).toEqual([]);
  });

  test("abort during gesture command rejects", async () => {
    const controller = new AbortController();
    adb.abortAfterCommand("shell input swipe", controller);
    await expect(recentApps.execute(undefined, controller.signal)).rejects.toThrow(
      "Operation cancelled",
    );
    expect(adb.getExecutedCommands().some((command) => command.includes("shell input swipe"))).toBe(
      true,
    );
  });

  test("thrown inner error rejects", async () => {
    recentApps["executeGestureNavigation"] = async () => {
      throw new Error("Inner gesture error");
    };
    await expect(recentApps.execute()).rejects.toThrow("Inner gesture error");
  });
});
