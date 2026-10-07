import { expect, describe, test, beforeEach, afterEach, spyOn } from "bun:test";
import { RecentApps } from "../../../src/features/action/RecentApps";
import { BootedDevice, ObserveResult } from "../../../src/models";

const testDevice: BootedDevice = {
  name: "test-device",
  platform: "android",
  deviceId: "emulator-5554",
};
import { IOSCtrlProxyClient } from "../../../src/features/observe/ios";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeWindow } from "../../fakes/FakeWindow";
import { FakeAwaitIdle } from "../../fakes/FakeAwaitIdle";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeIOSCtrlProxy } from "../../fakes/FakeIOSCtrlProxy";
import capturedRecents from "../../fixtures/android-launcher/launcher-recents-emulator-5600.json";
import capturedAppHierarchy from "../../fixtures/android-focus/playground-text-field-pre-tap.json";

describe("RecentApps", () => {
  let recentApps: RecentApps;
  let fakeAdb: FakeAdbExecutor;
  let fakeObserveScreen: FakeObserveScreen;
  let fakeWindow: FakeWindow;
  let fakeAwaitIdle: FakeAwaitIdle;
  let fakeTimer: FakeTimer;

  beforeEach(() => {
    // Create fakes for testing
    fakeAdb = new FakeAdbExecutor();
    fakeObserveScreen = new FakeObserveScreen();
    fakeObserveScreen.enableAutoVaryHierarchy();
    fakeWindow = new FakeWindow();
    fakeAwaitIdle = new FakeAwaitIdle();
    fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();

    // Configure default responses
    fakeWindow.configureCachedActiveWindow(null);
    fakeWindow.configureActiveWindow({
      appId: "com.test.app",
      activityName: "MainActivity",
      layoutSeqSum: 123,
    });

    // Set up default factory function for observe results to create new objects each time
    // This is needed because BaseVisualChange compares object identity to detect changes
    fakeObserveScreen.setObserveResult(() => {
      // Create new object to simulate actual change detection
      return fakeAdb.getExecutedCommands().includes("shell input keyevent 187")
        ? { ...capturedRecents, timestamp: fakeTimer.now() }
        : createObserveResult(createAppHierarchy());
    });

    // Inject the fakes into the feature
    recentApps = new RecentApps(testDevice, fakeAdb, fakeTimer);
    (recentApps as any).observeScreen = fakeObserveScreen;
    (recentApps as any).window = fakeWindow;
    (recentApps as any).awaitIdle = fakeAwaitIdle;
  });

  // Helper function to create mock ObserveResult
  const createObserveResult = (viewHierarchy?: any): ObserveResult => ({
    timestamp: Date.now(),
    screenSize: { width: 1080, height: 1920 },
    systemInsets: { top: 48, bottom: 120, left: 0, right: 0 },
    viewHierarchy: viewHierarchy || { node: {} },
  });

  // Minimal app hierarchy; navigation must never target its controls (see #9979)
  const createAppHierarchy = () => ({
    hierarchy: {
      node: {
        $: {
          class: "android.widget.FrameLayout",
          "resource-id": "android:id/content",
        },
      },
    },
  });

  describe("execute", () => {
    test("should open recents via the key event on a real captured app hierarchy", async () => {
      fakeObserveScreen.setObserveResult(() => ({
        ...(fakeAdb.getExecutedCommands().includes("shell input keyevent 187")
          ? capturedRecents
          : capturedAppHierarchy),
        timestamp: Date.now(),
        screenSize: { width: 1080, height: 2400 },
        systemInsets: { top: 63, bottom: 63, left: 0, right: 0 },
      }));
      fakeAdb.setCommandResponse("shell input keyevent 187", { stdout: "", stderr: "" });

      const result = await recentApps.execute();

      expect(result.success).toBe(true);
      expect(result.method).toBe("hardware");
      expect(result.observation).toBeDefined();
      expect(fakeAdb.getExecutedCommands().filter((cmd) => cmd.includes("input keyevent"))).toEqual(
        ["shell input keyevent 187"],
      );
    });

    test("should work with progress callback", async () => {
      fakeObserveScreen.setObserveResult(() =>
        fakeAdb.getExecutedCommands().includes("shell input keyevent 187")
          ? { ...capturedRecents, timestamp: fakeTimer.now() }
          : createObserveResult(createAppHierarchy()),
      );
      fakeAdb.setDefaultResponse({ stdout: "", stderr: "" });

      let callbackCalled = false;
      const progressCallback = () => {
        callbackCalled = true;
      };
      const result = await recentApps.execute(progressCallback);

      expect(result.success).toBe(true);
      expect(callbackCalled).toBe(true);
    });

    test("should still press recents when the view hierarchy is unavailable", async () => {
      fakeObserveScreen.setObserveResult(() => {
        const result = createObserveResult();
        (result.viewHierarchy as any) = null;
        return result;
      });
      fakeAdb.setDefaultResponse({ stdout: "", stderr: "" });

      const result = await recentApps.execute();

      expect(result.success).toBe(false);
      expect(result.method).toBe("hardware");
    });
  });

  describe("error handling", () => {
    test("should handle hardware navigation ADB command failure", async () => {
      const mockCachedObservation = createObserveResult(createAppHierarchy());
      fakeObserveScreen.setObserveResult(mockCachedObservation);
      fakeAdb.setCommandError("shell input keyevent 187", new Error("hardware command failed"));

      await expect(recentApps.execute()).rejects.toThrow("hardware command failed");
    });
  });

  describe("iOS platform", () => {
    let iosRecentApps: RecentApps;
    let fakeIOSCtrlProxy: FakeIOSCtrlProxy;
    let getInstanceSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
      const iosDevice: BootedDevice = {
        name: "iPhone 15",
        platform: "ios",
        deviceId: "ios-device",
      };
      iosRecentApps = new RecentApps(iosDevice, fakeAdb, fakeTimer);
      (iosRecentApps as any).observeScreen = fakeObserveScreen;
      (iosRecentApps as any).window = fakeWindow;
      (iosRecentApps as any).awaitIdle = fakeAwaitIdle;

      fakeIOSCtrlProxy = new FakeIOSCtrlProxy();
      getInstanceSpy = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue(
        fakeIOSCtrlProxy as any,
      );
    });

    afterEach(() => {
      getInstanceSpy.mockRestore();
    });

    test("should use CtrlProxy requestRecentApps on iOS", async () => {
      const result = await iosRecentApps.execute();
      expect(result.success).toBe(true);
      expect(result.method).toBe("ios_swipe");
      expect(fakeIOSCtrlProxy.getRecentAppsRequestCount()).toBe(1);
    });

    test("should return observation on iOS", async () => {
      const result = await iosRecentApps.execute();
      expect(result.success).toBe(true);
      expect(result.observation).toBeDefined();
    });

    test("should throw when CtrlProxy recentApps fails on iOS", async () => {
      fakeIOSCtrlProxy.setFailureMode("recentApps", new Error("Connection lost"));

      await expect(iosRecentApps.execute()).rejects.toThrow("Connection lost");
    });

    test("should return explicit failure when CtrlProxy cannot verify App Switcher on iOS", async () => {
      fakeIOSCtrlProxy.setRecentAppsResult({
        success: false,
        totalTimeMs: 100,
        error: "iOS App Switcher did not appear after recent apps invocation",
      });

      const result = await iosRecentApps.execute();

      expect(result.success).toBe(false);
      expect(result.method).toBe("ios_swipe");
      expect(result.error).toBe("iOS App Switcher did not appear after recent apps invocation");
      expect(result.observation).toBeDefined();
    });
  });
});
