import { readFileSync } from "node:fs";
import { expect, describe, test, beforeEach, afterEach, spyOn } from "bun:test";
import { HomeScreen } from "../../../src/features/action/HomeScreen";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { BootedDevice, ObserveResult, ViewHierarchyResult } from "../../../src/models";
import { IOSCtrlProxyClient } from "../../../src/features/observe/ios";
import type { CtrlProxyHierarchy } from "../../../src/features/observe/ios/types";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeWindow } from "../../fakes/FakeWindow";
import { FakeAwaitIdle } from "../../fakes/FakeAwaitIdle";
import { FakeIOSCtrlProxy } from "../../fakes/FakeIOSCtrlProxy";
import { FakeTimer } from "../../fakes/FakeTimer";
import type { ActiveWindowInfo } from "../../../src/models/ActiveWindowInfo";
import type { Window as WindowInterface } from "../../../src/features/observe/interfaces/Window";
import { runWithAbortSignal } from "../../../src/utils/AbortContext";
import { OPERATION_CANCELLED_MESSAGE } from "../../../src/utils/constants";
import { clearResolvedHomePackageCache } from "../../../src/features/observe/androidLauncherPackages";

// Helper function to create mock ObserveResult
// Each call creates a unique viewHierarchy object so change detection works
let hierarchyCounter = 0;
const createObserveResult = (): ObserveResult => ({
  timestamp: Date.now(),
  screenSize: { width: 1080, height: 1920 },
  systemInsets: { top: 48, bottom: 120, left: 0, right: 0 },
  viewHierarchy: { node: {}, id: hierarchyCounter++ },
});

// Read/parse each byte-exact capture at most once.
const launcherCaptures = new Map<string, ViewHierarchyResult>();
function launcherObservation(surface: string, deviceId: number): ObserveResult {
  const name = `launcher-${surface}-emulator-${deviceId}.json`;
  let viewHierarchy = launcherCaptures.get(name);
  if (!viewHierarchy) {
    const capture: { viewHierarchy: ViewHierarchyResult } = JSON.parse(
      readFileSync(new URL(`../../fixtures/android-launcher/${name}`, import.meta.url), "utf8"),
    );
    viewHierarchy = capture.viewHierarchy;
    launcherCaptures.set(name, viewHierarchy);
  }
  return { ...createObserveResult(), viewHierarchy };
}

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

function iosHierarchy(packageName: string): CtrlProxyHierarchy {
  return { packageName, updatedAt: 1, hierarchy: { className: "XCUIApplication" } };
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
    clearResolvedHomePackageCache("test-device");
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
    AndroidCtrlProxyClient.resetInstances();
    clearResolvedHomePackageCache("test-device");
  });

  function createIosHomeScreen(options?: {
    simulator?: boolean;
    simctl?: {
      executeCommandArgs: (
        args: string[],
        timeoutMs?: number,
      ) => Promise<{ stdout: string; stderr: string }>;
    };
  }): { action: HomeScreen; client: FakeIOSCtrlProxy } {
    const iosDevice: BootedDevice = {
      name: "iPhone 15",
      platform: "ios",
      deviceId: options?.simulator ? "A1B2C3D4-E5F6-7890-ABCD-EF1234567890" : "ios-device",
    };
    const action = new HomeScreen(iosDevice, fakeAdb, fakeTimer, options?.simctl);
    (action as any).observeScreen = fakeObserveScreen;
    (action as any).window = fakeWindow;
    (action as any).awaitIdle = fakeAwaitIdle;

    const client = new FakeIOSCtrlProxy(fakeTimer);
    getInstanceSpy = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue(client as any);
    return { action, client };
  }

  describe("execute", () => {
    test.each(["android", "ios"] as const)(
      "succeeds when already on the %s home screen with an unchanged hierarchy",
      async (platform) => {
        const observation = createObserveResult();
        if (platform === "android") {
          observation.viewHierarchy = launcherObservation("home", 5600).viewHierarchy;
          const launcherPackage = observation.viewHierarchy.packageName;
          fakeWindow.configureActiveWindow({
            appId: launcherPackage,
            activityName: "NexusLauncherActivity",
            layoutSeqSum: 123,
          });
          fakeAdb.setCommandResponse(
            "shell cmd package resolve-activity --brief -c android.intent.category.HOME -a android.intent.action.MAIN",
            { stdout: `${launcherPackage}/.NexusLauncherActivity`, stderr: "" },
          );
        } else {
          observation.viewHierarchy.hierarchy = { node: { $: { class: "Home" } } };
          observation.viewHierarchy.packageName = "com.apple.springboard";
        }
        fakeObserveScreen.setObserveResult(observation);
        let action = homeScreen;
        if (platform === "ios") {
          const ios = createIosHomeScreen();
          ios.client.setHierarchyData(iosHierarchy("com.apple.springboard"));
          action = ios.action;
        }

        const result = await action.execute();
        expect(result.success).toBe(true);
        expect(result).toHaveProperty("message", "Already on the home screen");
        expect(result.error).toBeUndefined();
        if (platform === "android") {
          expect(
            fakeAdb.getExecutedCommands().filter((command) => command.includes("resolve-activity")),
          ).toHaveLength(1);
        }
      },
    );

    test("an unchanged hierarchy still fails when the previous foreground was not home", async () => {
      const observation = createObserveResult();
      observation.viewHierarchy.hierarchy = { node: { $: { class: "Settings" } } };
      observation.viewHierarchy.packageName = "com.android.settings";
      fakeObserveScreen.setObserveResult(observation);

      const result = await homeScreen.execute();
      expect(result.success).toBe(false);
      expect(result.error).toBe("No visual change observed");
      expect(result).not.toHaveProperty("message");
    });

    describe("Android launcher surfaces", () => {
      const launcherPackage = "com.google.android.apps.nexuslauncher";

      beforeEach(() => {
        fakeWindow.configureActiveWindow({
          appId: launcherPackage,
          activityName: "NexusLauncherActivity",
          layoutSeqSum: 123,
        });
        fakeAdb.setCommandResponse(
          "shell cmd package resolve-activity --brief -c android.intent.category.HOME -a android.intent.action.MAIN",
          { stdout: `${launcherPackage}/.NexusLauncherActivity`, stderr: "" },
        );
      });

      test.each([
        { surface: "allapps", deviceId: 5600 },
        { surface: "allapps", deviceId: 5602 },
        { surface: "widgets", deviceId: 5600 },
        { surface: "recents", deviceId: 5600 },
        { surface: "recents", deviceId: 5602 },
      ])(
        "presses Home from $surface on emulator-$deviceId without an already-home message",
        async ({ surface, deviceId }) => {
          fakeObserveScreen.setObserveSequence([
            launcherObservation(surface, deviceId),
            launcherObservation("home", deviceId),
          ]);

          const result = await homeScreen.execute();

          expect(result.success).toBe(true);
          expect(result).not.toHaveProperty("message");
          expect(result.error).toBeUndefined();
          expect(fakeAdb.getExecutedCommands()).toContain("shell input keyevent 3");
        },
      );

      test.each([
        { surface: "allapps", deviceId: 5600 },
        { surface: "allapps", deviceId: 5602 },
        { surface: "widgets", deviceId: 5600 },
        { surface: "recents", deviceId: 5600 },
        { surface: "recents", deviceId: 5602 },
      ])(
        "an unchanged $surface on emulator-$deviceId fails the expected visual change",
        async ({ surface, deviceId }) => {
          fakeObserveScreen.setObserveResult(launcherObservation(surface, deviceId));

          const result = await homeScreen.execute();

          expect(result.success).toBe(false);
          expect(result.error).toBe("No visual change observed");
          expect(result).not.toHaveProperty("message");
          expect(fakeAdb.getExecutedCommands()).toContain("shell input keyevent 3");
        },
      );

      test.each([false, true])(
        "presses Home from a hidden workspace without overlay markers (hierarchy changes: %s)",
        async (hierarchyChanges) => {
          const observation = createObserveResult();
          observation.viewHierarchy = {
            packageName: launcherPackage,
            hierarchy: {
              node: {
                $: {
                  "resource-id": `${launcherPackage}:id/workspace`,
                  "visible-to-user": false,
                },
              },
            },
          };
          if (hierarchyChanges) {
            fakeObserveScreen.setObserveSequence([observation, launcherObservation("home", 5600)]);
          } else {
            fakeObserveScreen.setObserveResult(observation);
          }

          const result = await homeScreen.execute();

          expect(result.success).toBe(hierarchyChanges);
          expect(result.error).toBe(hierarchyChanges ? undefined : "No visual change observed");
          expect(result).not.toHaveProperty("message");
          expect(fakeAdb.getExecutedCommands()).toContain("shell input keyevent 3");
        },
      );

      test.each([5600, 5602])(
        "an unchanged home workspace on emulator-%s still reports already-home",
        async (deviceId) => {
          fakeObserveScreen.setObserveResult(launcherObservation("home", deviceId));

          const result = await homeScreen.execute();

          expect(result.success).toBe(true);
          expect(result.message).toBe("Already on the home screen");
          expect(result.error).toBeUndefined();
        },
      );
    });

    test("reuses the verified configured launcher for a custom Android home package", async () => {
      const observation = createObserveResult();
      observation.viewHierarchy = {
        packageName: "com.example.home",
        hierarchy: { node: { $: { class: "Home" } } },
      };
      fakeObserveScreen.setObserveResult(observation);
      fakeWindow.configureActiveWindow({
        appId: "com.example.home",
        activityName: "Home",
        layoutSeqSum: 123,
      });
      const resolveCommand =
        "shell cmd package resolve-activity --brief -c android.intent.category.HOME -a android.intent.action.MAIN";
      fakeAdb.setCommandResponse(resolveCommand, {
        stdout: "com.example.home/.Home",
        stderr: "",
      });

      const result = await homeScreen.execute();
      expect(result.success).toBe(true);
      expect(result.message).toBe("Already on the home screen");
      expect(fakeAdb.getExecutedCommands().filter((command) => command === resolveCommand)).toEqual(
        [resolveCommand],
      );
    });

    test("an iOS SpringBoard fallback does not establish that Home was already foreground", async () => {
      const observation = createObserveResult();
      observation.viewHierarchy = {
        packageName: "com.apple.springboard",
        fallbackToSpringboard: true,
        hierarchy: { node: { $: { class: "Home" } } },
      };
      fakeObserveScreen.setObserveResult(observation);
      const { action, client } = createIosHomeScreen();
      client.setHierarchyData(iosHierarchy("com.apple.springboard"));

      const result = await action.execute();
      expect(result.success).toBe(false);
      expect(result.error).toBe("No visual change observed");
      expect(result.message).toBeUndefined();
    });

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
      const { action, client } = createIosHomeScreen();
      client.setHierarchyData(iosHierarchy("com.apple.springboard"));

      const result = await action.execute();
      expect(result.success).toBe(true);
      expect(client.getPressHomeRequestCount()).toBe(1);
      expect(client.getHierarchyRequestCount()).toBe(1);
      expect(fakeTimer.getSleepHistory()).toEqual([]);
    });

    test("reports the foreground app and blocking alert after bounded iOS retries", async () => {
      const { action, client } = createIosHomeScreen();
      client.setHierarchyData(iosHierarchy("com.apple.Maps"));
      spyOn(client, "convertToViewHierarchyResult").mockReturnValue({
        packageName: "com.apple.Maps",
        hierarchy: {
          node: {
            $: { class: "XCUIApplication" },
            node: [
              {
                $: { class: "XCUIElementTypeAlert", text: "Allow Maps to use your location?" },
              },
            ],
          },
        },
      });

      await expect(action.execute()).rejects.toThrow(
        /com\.apple\.Maps.*XCUIElementTypeAlert.*Allow Maps to use your location\?/,
      );
      expect(client.getHierarchyRequestCount()).toBe(4);
      expect(fakeTimer.getSleepHistory()).toEqual([300, 600, 900]);
    });

    test("reports the foreground app when iOS Home is blocked without an alert", async () => {
      const { action, client } = createIosHomeScreen();
      client.setHierarchyData(iosHierarchy("com.apple.Maps"));

      await expect(action.execute()).rejects.toThrow(
        "Home press did not background com.apple.Maps; the home screen did not become foreground",
      );
      expect(client.getHierarchyRequestCount()).toBe(4);
    });

    test("waits for SpringBoard when the first iOS hierarchy still shows the app", async () => {
      const { action, client } = createIosHomeScreen();
      const hierarchies = [
        iosHierarchy("com.apple.Maps"),
        iosHierarchy("com.apple.Maps"),
        iosHierarchy("com.apple.springboard"),
      ];
      let readCount = 0;
      spyOn(client, "requestHierarchySync").mockImplementation(async () => ({
        hierarchy: hierarchies[Math.min(readCount++, hierarchies.length - 1)],
      }));

      const result = await action.execute();
      expect(result.success).toBe(true);
      expect(readCount).toBe(3);
      expect(fakeTimer.getSleepHistory()).toEqual([300, 600]);
    });

    test("simulator launches SpringBoard without requesting runner Home", async () => {
      const calls: string[][] = [];
      const { action, client } = createIosHomeScreen({
        simulator: true,
        simctl: {
          executeCommandArgs: async (args) => {
            calls.push(args);
            return { stdout: "", stderr: "" };
          },
        },
      });
      client.setHierarchyData(iosHierarchy("com.apple.springboard"));
      const pressSpy = spyOn(client, "requestPressHome");

      const result = await action.execute();
      expect(result.success).toBe(true);
      expect(pressSpy).not.toHaveBeenCalled();
      expect(calls).toEqual([
        ["launch", "A1B2C3D4-E5F6-7890-ABCD-EF1234567890", "com.apple.springboard"],
      ]);
      expect(client.getHierarchyRequestCount()).toBe(1);
    });

    test("simulator launch failure reports the failed launch", async () => {
      const { action, client } = createIosHomeScreen({
        simulator: true,
        simctl: {
          executeCommandArgs: async () => {
            throw new Error("simctl launch rejected SpringBoard");
          },
        },
      });
      await expect(action.execute()).rejects.toThrow(/simctl launch rejected SpringBoard/);
      expect(client.getPressHomeRequestCount()).toBe(0);
    });

    test("simulator waits for a slow SpringBoard switch using fake time", async () => {
      const { action, client } = createIosHomeScreen({
        simulator: true,
        simctl: { executeCommandArgs: async () => ({ stdout: "", stderr: "" }) },
      });
      const readSpy = spyOn(client, "requestHierarchySync").mockImplementation(async () => ({
        hierarchy: iosHierarchy(
          fakeTimer.now() >= 3000 ? "com.apple.springboard" : "com.apple.Maps",
        ),
      }));

      await action.executeIosHomeNavigation();
      expect(fakeTimer.now()).toBeGreaterThanOrEqual(3000);
      expect(fakeTimer.now()).toBeLessThan(5000);
      expect(readSpy.mock.calls.length).toBeGreaterThan(4);
      expect(client.getPressHomeRequestCount()).toBe(0);
    });

    test("simulator allows a slow hierarchy read within the 5s deadline", async () => {
      const { action, client } = createIosHomeScreen({
        simulator: true,
        simctl: { executeCommandArgs: async () => ({ stdout: "", stderr: "" }) },
      });
      const readSpy = spyOn(client, "requestHierarchySync").mockImplementation(async () => {
        await fakeTimer.sleep(1200);
        return { hierarchy: iosHierarchy("com.apple.springboard") };
      });

      await action.executeIosHomeNavigation();
      expect(readSpy.mock.calls[0]?.[3]).toBe(1500);
      expect(fakeTimer.now()).toBe(1200);
    });

    test("simctl launch reports the remaining foreground app after the bounded wait", async () => {
      const { action, client } = createIosHomeScreen({
        simulator: true,
        simctl: { executeCommandArgs: async () => ({ stdout: "", stderr: "" }) },
      });
      client.setHierarchyData(iosHierarchy("com.apple.Maps"));

      await expect(action.executeIosHomeNavigation()).rejects.toThrow(
        /simctl launched SpringBoard.*com\.apple\.Maps/,
      );
      expect(fakeTimer.now()).toBe(5000);
      expect(client.getPressHomeRequestCount()).toBe(0);
    });

    test("unknown foreground failure does not claim an app was backgrounded", async () => {
      const { action, client } = createIosHomeScreen({
        simulator: true,
        simctl: { executeCommandArgs: async () => ({ stdout: "", stderr: "" }) },
      });
      client.setHierarchyData(null);

      await expect(action.executeIosHomeNavigation()).rejects.toThrow(
        "Home press did not bring SpringBoard to the foreground",
      );
      expect(fakeTimer.now()).toBe(5000);
    });

    test("simulator foreground polling respects a shorter caller budget", async () => {
      const { action, client } = createIosHomeScreen({
        simulator: true,
        simctl: { executeCommandArgs: async () => ({ stdout: "", stderr: "" }) },
      });
      client.setHierarchyData(iosHierarchy("com.apple.Maps"));
      const readSpy = spyOn(client, "requestHierarchySync");

      await expect(action.executeIosHomeNavigation(undefined, undefined, 500)).rejects.toThrow(
        /SpringBoard.*com\.apple\.Maps/,
      );
      expect(fakeTimer.now()).toBe(500);
      expect(readSpy.mock.calls.every((call) => (call[3] ?? 0) <= 500)).toBe(true);
    });

    test("unknown initial foreground succeeds once SpringBoard appears", async () => {
      const { action, client } = createIosHomeScreen({
        simulator: true,
        simctl: { executeCommandArgs: async () => ({ stdout: "", stderr: "" }) },
      });
      let readCount = 0;
      spyOn(client, "requestHierarchySync").mockImplementation(async () => ({
        hierarchy: readCount++ === 0 ? undefined : iosHierarchy("com.apple.springboard"),
      }));

      await action.executeIosHomeNavigation();
      expect(readCount).toBe(2);
      expect(fakeTimer.getSleepHistory()).toEqual([100]);
    });

    test("physical iOS keeps runner Home and never invokes simctl", async () => {
      const calls: string[][] = [];
      const { action, client } = createIosHomeScreen({
        simctl: {
          executeCommandArgs: async (args) => {
            calls.push(args);
            return { stdout: "", stderr: "" };
          },
        },
      });
      client.setHierarchyData(iosHierarchy("com.apple.springboard"));

      await action.executeIosHomeNavigation();
      expect(client.getPressHomeRequestCount()).toBe(1);
      expect(calls).toEqual([]);
    });

    test("physical iOS failure never invokes simctl", async () => {
      let launches = 0;
      const { action, client } = createIosHomeScreen({
        simctl: {
          executeCommandArgs: async () => {
            launches++;
            return { stdout: "", stderr: "" };
          },
        },
      });
      client.setFailureMode("pressHome", new Error("hardware home failed"));

      await expect(action.execute()).rejects.toThrow("hardware home failed");
      expect(launches).toBe(0);
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

  // Deadline-bounding + AbortSignal propagation for the ADB KEYCODE_HOME
  // fallback (issue #6289).
  describe("ADB KEYCODE_HOME fallback deadline + abort (issue #6289)", () => {
    test("bounds the KEYCODE_HOME keyevent with a deadline and threads a signal", async () => {
      // Global action unavailable, so the ADB keyevent fallback runs; the
      // default fakeWindow reports the launcher, so verification passes.
      getInstanceSpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue({
        requestGlobalAction: async () => {
          throw new Error("global action unavailable");
        },
      } as unknown as AndroidCtrlProxyClient);

      await (homeScreen as any).executeAndroidHome();

      const keyeventCall = fakeAdb.getCommandCalls().find((c) => c.command.includes("keyevent 3"));
      expect(keyeventCall).toBeDefined();
      // Deadline-bounded and single-shot. With no ambient/forwarded signal in
      // scope the combined signal is undefined (nothing to cancel on); the
      // combined-signal test below covers the cancellation wiring.
      expect(keyeventCall?.timeoutMs).toBe(3000);
      expect(keyeventCall?.noRetry).toBe(true);
    });

    test("an ambient request abort cancels the KEYCODE_HOME fallback (combined signal)", async () => {
      // The forwarded private signal is combined with the ambient request
      // signal, so a cancelled MCP request still aborts the fallback read.
      getInstanceSpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue({
        requestGlobalAction: async () => {
          throw new Error("global action unavailable");
        },
      } as unknown as AndroidCtrlProxyClient);
      fakeAdb.setThrowOnAbortedSignal();
      const controller = new AbortController();
      controller.abort();

      await expect(
        runWithAbortSignal(controller.signal, () => (homeScreen as any).executeAndroidHome()),
      ).rejects.toThrow(OPERATION_CANCELLED_MESSAGE);

      const keyeventCall = fakeAdb.getCommandCalls().find((c) => c.command.includes("keyevent 3"));
      expect(keyeventCall?.signal?.aborted).toBe(true);
    });
  });
});
