import { expect, describe, test, beforeEach, afterEach, spyOn } from "bun:test";
import { HomeScreen } from "../../../src/features/action/HomeScreen";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { BootedDevice, ObserveResult } from "../../../src/models";
import { IOSCtrlProxyClient } from "../../../src/features/observe/ios";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeWindow } from "../../fakes/FakeWindow";
import { FakeAwaitIdle } from "../../fakes/FakeAwaitIdle";
import { FakeIOSCtrlProxy } from "../../fakes/FakeIOSCtrlProxy";
import { FakeTimer } from "../../fakes/FakeTimer";
import type { ActiveWindowInfo } from "../../../src/models/ActiveWindowInfo";
import type { Window as WindowInterface } from "../../../src/features/observe/interfaces/Window";

// Helper function to create mock ObserveResult
// Each call creates a unique viewHierarchy object so change detection works
let hierarchyCounter = 0;
const createObserveResult = (): ObserveResult => ({
  timestamp: Date.now(),
  screenSize: { width: 1080, height: 1920 },
  systemInsets: { top: 48, bottom: 120, left: 0, right: 0 },
  viewHierarchy: { node: {}, id: hierarchyCounter++ },
});

// Minimal Window stub that returns a scripted sequence of foreground apps,
// one entry per `getActive` call (last entry repeats once exhausted). Lets
// tests exercise "the global action's post-dispatch check sees the old app,
// the post-ADB-fallback check sees the launcher" without a shared FakeWindow
// method for sequencing.
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

describe("HomeScreen", () => {
  let homeScreen: HomeScreen;
  let mockDevice: BootedDevice;
  let fakeAdb: FakeAdbExecutor;
  let fakeObserveScreen: FakeObserveScreen;
  let fakeWindow: FakeWindow;
  let fakeAwaitIdle: FakeAwaitIdle;
  let fakeTimer: FakeTimer;
  let getInstanceSpy: ReturnType<typeof spyOn> | null = null;

  beforeEach(() => {
    // Create fakes for testing
    fakeAdb = new FakeAdbExecutor();
    fakeObserveScreen = new FakeObserveScreen();
    fakeWindow = new FakeWindow();
    fakeAwaitIdle = new FakeAwaitIdle();
    fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();

    // Set up default fake responses. The default foreground app is a known
    // launcher package so home-press verification (issue #6147) passes for
    // tests that aren't specifically exercising the verification failure
    // path below.
    fakeWindow.configureCachedActiveWindow(null);
    fakeWindow.configureActiveWindow({
      appId: "com.android.launcher3",
      activityName: "Launcher",
      layoutSeqSum: 123,
    });

    // Set up default observe screen responses with valid viewHierarchy
    // We need to set different results to simulate screen change
    fakeObserveScreen.setObserveResult(() => createObserveResult());

    mockDevice = {
      name: "Test Device",
      platform: "android",
      deviceId: "test-device",
    };
    homeScreen = new HomeScreen(mockDevice, fakeAdb, fakeTimer);

    // Replace the internal managers with our fakes
    (homeScreen as any).observeScreen = fakeObserveScreen;
    (homeScreen as any).window = fakeWindow;
    (homeScreen as any).awaitIdle = fakeAwaitIdle;
  });

  afterEach(() => {
    getInstanceSpy?.mockRestore();
    getInstanceSpy = null;
  });

  describe("execute", () => {
    test("should execute hardware navigation using keyevent 3", async () => {
      fakeAdb.setCommandResponse("shell input keyevent 3", { stdout: "", stderr: "" });

      const result = await homeScreen.execute();
      expect(result.success).toBe(true);
      expect(result.navigationMethod).toBe("hardware");
      expect(result.observation).toBeDefined();

      // Verify hardware home button keyevent was executed
      const executedCommands = fakeAdb.getExecutedCommands();
      expect(executedCommands.some((cmd) => cmd.includes("shell input keyevent 3"))).toBe(true);
    });

    test("should work with progress callback", async () => {
      fakeAdb.setCommandResponse("shell input keyevent 3", { stdout: "", stderr: "" });

      let callbackCalled = false;
      const progressCallback = async () => {
        callbackCalled = true;
      };
      const result = await homeScreen.execute(progressCallback);

      expect(result.success).toBe(true);
      expect(result.navigationMethod).toBe("hardware");
      expect(callbackCalled).toBe(true);
    });

    test("should include observation in result", async () => {
      fakeAdb.setCommandResponse("shell input keyevent 3", { stdout: "", stderr: "" });

      const result = await homeScreen.execute();

      expect(result.success).toBe(true);
      expect(result.observation).toBeDefined();
      expect(result.observation?.screenSize).toBeDefined();
    });

    test("should use CtrlProxy iOS press home on iOS", async () => {
      const iosDevice: BootedDevice = {
        name: "iPhone 15",
        platform: "ios",
        deviceId: "ios-device",
      };
      const iosHomeScreen = new HomeScreen(iosDevice, fakeAdb);
      (iosHomeScreen as any).observeScreen = fakeObserveScreen;
      (iosHomeScreen as any).window = fakeWindow;
      (iosHomeScreen as any).awaitIdle = fakeAwaitIdle;

      const fakeIOSCtrlProxy = new FakeIOSCtrlProxy();
      const getInstanceSpy = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue(
        fakeIOSCtrlProxy as any,
      );

      try {
        const result = await iosHomeScreen.execute();
        expect(result.success).toBe(true);
        expect(fakeIOSCtrlProxy.getPressHomeRequestCount()).toBe(1);
      } finally {
        getInstanceSpy.mockRestore();
      }
    });
  });

  describe("error handling", () => {
    test("should propagate errors when hardware navigation fails", async () => {
      fakeAdb.setCommandError("shell input keyevent 3", new Error("hardware home failed"));

      await expect(homeScreen.execute()).rejects.toThrow("hardware home failed");
    });
  });

  describe("multiple devices", () => {
    test("should work with different device IDs", async () => {
      const otherDevice: BootedDevice = {
        name: "Device 2",
        platform: "android",
        deviceId: "device-2",
      };
      const homeScreen2 = new HomeScreen(otherDevice, fakeAdb);

      // Set up fakes for the second HomeScreen instance
      const fakeWindow2 = new FakeWindow();
      const fakeObserveScreen2 = new FakeObserveScreen();
      const fakeAwaitIdle2 = new FakeAwaitIdle();

      fakeWindow2.configureCachedActiveWindow(null);
      fakeWindow2.configureActiveWindow({
        appId: "com.android.launcher3",
        activityName: "Launcher",
        layoutSeqSum: 123,
      });
      fakeObserveScreen2.setObserveResult(() => createObserveResult());

      (homeScreen2 as any).observeScreen = fakeObserveScreen2;
      (homeScreen2 as any).window = fakeWindow2;
      (homeScreen2 as any).awaitIdle = fakeAwaitIdle2;

      fakeAdb.setCommandResponse("shell input keyevent 3", { stdout: "", stderr: "" });

      const result1 = await homeScreen.execute();
      const result2 = await homeScreen2.execute();

      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);
      expect(result1.navigationMethod).toBe("hardware");
      expect(result2.navigationMethod).toBe("hardware");
    });
  });

  // Regression coverage for issue #6147: on Android API 28 the accessibility
  // global action for "home" can report success while the foreground app
  // never becomes the launcher. Home must verify the actual foreground app
  // instead of trusting a dispatch method's self-reported result.
  describe("home-press verification (issue #6147)", () => {
    test("reports success when the accessibility global action actually backgrounds the app", async () => {
      getInstanceSpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue({
        requestGlobalAction: async () => ({ success: true }),
      } as unknown as AndroidCtrlProxyClient);
      // Default fakeWindow already reports "com.android.launcher3" foreground.

      const result = await homeScreen.execute();

      expect(result.success).toBe(true);
      // No ADB keyevent fallback is needed -- the only ADB traffic is the
      // configured-HOME-launcher resolution that verification now performs
      // (issue #6147 review, P1).
      expect(fakeAdb.getExecutedCommands().filter((cmd) => cmd.includes("keyevent"))).toEqual([]);
    });

    test("falls back to the ADB keyevent when the global action is inert (API 28) but the foreground never changes", async () => {
      // Simulates the API 28 repro from issue #6147: the global action
      // reports success, but the foreground package stays the app under
      // test on every check, including after the ADB fallback -- so this
      // must surface a failure rather than false success.
      getInstanceSpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue({
        requestGlobalAction: async () => ({ success: true }),
      } as unknown as AndroidCtrlProxyClient);
      (homeScreen as any).window = sequencedWindow(["com.android.settings"]);
      fakeAdb.setCommandResponse("shell input keyevent 3", { stdout: "", stderr: "" });

      await expect(homeScreen.execute()).rejects.toThrow(/did not background the foreground app/);

      // The inert global action must not be trusted -- the ADB fallback has
      // to have actually been attempted before giving up.
      expect(fakeAdb.getExecutedCommands()).toContain("shell input keyevent 3");
    });

    test("recovers via the ADB keyevent fallback when the global action is inert but the fallback reaches the launcher", async () => {
      getInstanceSpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue({
        requestGlobalAction: async () => ({ success: true }),
      } as unknown as AndroidCtrlProxyClient);
      // The post-global-action verification retries internally (initial
      // attempt + 2 backoff retries) before giving up, so it must see the
      // app unchanged on all 3 of those checks; only the post-ADB-keyevent
      // verification's first check sees the launcher.
      (homeScreen as any).window = sequencedWindow([
        "com.android.settings",
        "com.android.settings",
        "com.android.settings",
        "com.android.launcher3",
      ]);
      fakeAdb.setCommandResponse("shell input keyevent 3", { stdout: "", stderr: "" });

      const result = await homeScreen.execute();

      expect(result.success).toBe(true);
      expect(fakeAdb.getExecutedCommands()).toContain("shell input keyevent 3");
    });

    test("throws instead of reporting false success when the ADB keyevent fallback also fails to reach the launcher", async () => {
      getInstanceSpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue({
        requestGlobalAction: async () => ({ success: false, error: "global action unavailable" }),
      } as unknown as AndroidCtrlProxyClient);
      (homeScreen as any).window = sequencedWindow(["com.android.settings"]);
      fakeAdb.setCommandResponse("shell input keyevent 3", { stdout: "", stderr: "" });

      await expect(homeScreen.execute()).rejects.toThrow(/did not background the foreground app/);
    });
  });
});
