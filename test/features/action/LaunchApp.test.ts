import { afterEach, beforeEach, describe, expect, test, spyOn } from "bun:test";
import { promises as fsp } from "fs";
import * as os from "os";
import * as nodePath from "path";
import { LaunchApp } from "../../../src/features/action/LaunchApp";
import { BootedDevice, ObserveResult } from "../../../src/models";
import { DefaultPerformanceTracker } from "../../../src/utils/PerformanceTracker";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAwaitIdle } from "../../fakes/FakeAwaitIdle";
import { FakeInstalledAppsProvider } from "../../fakes/FakeInstalledAppsProvider";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeTargetUserDetector } from "../../fakes/FakeTargetUserDetector";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeWindow } from "../../fakes/FakeWindow";
import { FakeIOSCtrlProxy } from "../../fakes/FakeIOSCtrlProxy";
import { IOSCtrlProxyClient } from "../../../src/features/observe/ios";
import { IOSCtrlProxyManager } from "../../../src/utils/IOSCtrlProxyManager";

describe("LaunchApp", () => {
  let device: BootedDevice;
  let fakeAdb: FakeAdbExecutor;
  let fakeAwaitIdle: FakeAwaitIdle;
  let fakeObserveScreen: FakeObserveScreen;
  let fakeTimer: FakeTimer;
  let fakeWindow: FakeWindow;
  let launchApp: LaunchApp;

  const packageName = "com.example.app";

  const createObserveResult = (appId?: string): ObserveResult => ({
    updatedAt: Date.now(),
    screenSize: { width: 1080, height: 1920 },
    systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
    viewHierarchy: appId ? { node: {}, packageName: appId } as any : { node: {} },
    activeWindow: appId ? { appId, activityName: "MainActivity", layoutSeqSum: 1 } : undefined
  });

  const configureInstalledApp = () => {
    fakeAdb.setCommandResponse("shell pm list packages --user 0", {
      stdout: `package:${packageName}\n`,
      stderr: ""
    });
    fakeAdb.setCommandResponse("shell pm list packages -s --user 0", { stdout: "", stderr: "" });
  };

  beforeEach(() => {
    device = { name: "test-device", platform: "android", deviceId: "device-123" };
    fakeAdb = new FakeAdbExecutor();
    fakeAwaitIdle = new FakeAwaitIdle();
    fakeObserveScreen = new FakeObserveScreen();
    fakeTimer = new FakeTimer();
    fakeWindow = new FakeWindow();

    fakeObserveScreen.setObserveResult(createObserveResult());
    fakeWindow.configureCachedActiveWindow(null);
    fakeWindow.configureActiveWindow({ appId: packageName, activityName: "MainActivity", layoutSeqSum: 1 });

    launchApp = new LaunchApp(device, fakeAdb as unknown as any, null, fakeTimer);
    (launchApp as any).awaitIdle = fakeAwaitIdle;
    (launchApp as any).observeScreen = fakeObserveScreen;
    (launchApp as any).window = fakeWindow;

    configureInstalledApp();
  });

  test("returns observation when app is already in foreground", async () => {
    fakeAdb.setForegroundApp({ packageName, userId: 0 });
    fakeAdb.setCommandResponse(`shell ps | grep ${packageName}`, { stdout: "1\n", stderr: "" });

    const result = await launchApp.execute(packageName, false, false);

    expect(result.success).toBe(true);
    expect(result.error).toBe("App is already in foreground");
    expect(result.observation).toBeDefined();
    expect(fakeObserveScreen.getExecuteCallCount()).toBeGreaterThan(0);
    expect(fakeAwaitIdle.wasMethodCalled("initializeUiStabilityTracking")).toBe(true);
  });

  test("waits for foreground before returning observation", async () => {
    fakeAdb.setForegroundApp(null);
    fakeAdb.setCommandResponse(`shell ps | grep ${packageName}`, { stdout: "0\n", stderr: "" });

    const resultPromise = launchApp.execute(packageName, false, false);

    for (let i = 0; i < 50 && fakeTimer.getPendingSleepCount() === 0; i += 1) {
      await Promise.resolve();
    }

    expect(fakeTimer.getPendingSleepCount()).toBeGreaterThan(0);

    fakeAdb.setForegroundApp({ packageName, userId: 0 });
    fakeTimer.advanceTime(500);

    const result = await resultPromise;

    expect(result.success).toBe(true);
    expect(result.observation).toBeDefined();
    expect(fakeTimer.getSleepCallCount()).toBeGreaterThan(0);
  });

  test("re-observes until the launch observation reports the launched Android app", async () => {
    fakeTimer.enableAutoAdvance();
    const previousPackageName = "com.example.previous";
    const observations = [
      createObserveResult(previousPackageName),
      createObserveResult(packageName)
    ];

    fakeAdb.setForegroundApp({ packageName, userId: 0 });
    fakeAdb.setCommandResponse(`shell ps | grep ${packageName}`, { stdout: "0\n", stderr: "" });
    fakeObserveScreen.setObserveResult(() => observations.shift() ?? createObserveResult(packageName));

    const result = await launchApp.execute(packageName, false, false);

    expect(result.success).toBe(true);
    expect(result.observation?.activeWindow?.appId).toBe(packageName);
    expect(result.observation?.viewHierarchy?.packageName).toBe(packageName);
    expect(fakeObserveScreen.getExecuteCallCount()).toBeGreaterThan(1);
  });

  test("treats Android notification permission dialogs as valid launch observations", async () => {
    fakeTimer.enableAutoAdvance();
    const permissionControllerPackageName = "com.google.android.permissioncontroller";

    fakeAdb.setForegroundApp({ packageName: permissionControllerPackageName, userId: 0 });
    fakeAdb.setCommandResponse(`shell ps | grep ${packageName}`, { stdout: "0\n", stderr: "" });
    fakeObserveScreen.setObserveResult({
      ...createObserveResult(permissionControllerPackageName),
      activeWindow: {
        appId: permissionControllerPackageName,
        activityName: "GrantPermissionsActivity",
        layoutSeqSum: 1,
        type: "notification_permission_dialog"
      },
      notificationPermissionDetected: true
    });

    const result = await launchApp.execute(packageName, false, false);

    expect(result.success).toBe(true);
    expect(result.observation?.notificationPermissionDetected).toBe(true);
    expect(result.observation?.activeWindow?.type).toBe("notification_permission_dialog");
    expect(result.observation?.activeWindow?.appId).toBe(permissionControllerPackageName);
    expect(fakeObserveScreen.getExecuteCallCount()).toBe(1);
  });

  test("fails without embedding a stale Android observation when the launched app never appears", async () => {
    fakeTimer.enableAutoAdvance();
    const previousPackageName = "com.example.previous";

    fakeAdb.setForegroundApp({ packageName, userId: 0 });
    fakeAdb.setCommandResponse(`shell ps | grep ${packageName}`, { stdout: "0\n", stderr: "" });
    fakeObserveScreen.setObserveResult(() => createObserveResult(previousPackageName));

    const result = await launchApp.execute(packageName, false, false);

    expect(result.success).toBe(false);
    expect(result.error).toContain(`Timed out waiting for launch observation to show ${packageName}`);
    expect(result.observation).toBeUndefined();
  });

  test("runs target user detection and install check in parallel", async () => {

    const targetUserDetector = new FakeTargetUserDetector(fakeTimer, {
      delayMs: 50,
      resolvedUserId: 10
    });
    const installedAppsProvider = new FakeInstalledAppsProvider(fakeTimer, {
      delayMs: 50,
      installedApps: []
    });

    const parallelLaunchApp = new LaunchApp(device, fakeAdb as unknown as any, null, fakeTimer, {
      targetUserDetector,
      installedAppsProvider
    });

    const resultPromise = parallelLaunchApp.execute(packageName, false, false);

    for (let i = 0; i < 50 && fakeTimer.getPendingSleepCount() < 2; i += 1) {
      await Promise.resolve();
    }

    expect(targetUserDetector.getCallCount()).toBe(1);
    expect(installedAppsProvider.getCallCount()).toBe(1);
    expect(fakeTimer.getPendingSleepCount()).toBe(2);

    fakeTimer.advanceTime(50);

    const result = await resultPromise;

    expect(targetUserDetector.getCompletedCount()).toBe(1);
    expect(installedAppsProvider.getCompletedCount()).toBe(1);
    expect(result.success).toBe(false);
    expect(result.error).toBe("App is not installed");
    expect(result.userId).toBe(10);
  });

  test("waits for both preflight tasks to settle when one fails", async () => {

    const targetUserDetector = new FakeTargetUserDetector(fakeTimer, {
      delayMs: 50,
      resolvedUserId: 10
    });
    const installedAppsProvider = new FakeInstalledAppsProvider(fakeTimer, {
      delayMs: 50,
      shouldThrow: true,
      error: new Error("check installed failed")
    });

    const parallelLaunchApp = new LaunchApp(device, fakeAdb as unknown as any, null, fakeTimer, {
      targetUserDetector,
      installedAppsProvider
    });

    const resultPromise = parallelLaunchApp.execute(packageName, false, false);

    for (let i = 0; i < 50 && fakeTimer.getPendingSleepCount() < 2; i += 1) {
      await Promise.resolve();
    }

    expect(fakeTimer.getPendingSleepCount()).toBe(2);

    fakeTimer.advanceTime(50);

    await expect(resultPromise).rejects.toThrow("check installed failed");
    expect(targetUserDetector.getCompletedCount()).toBe(1);
    expect(installedAppsProvider.getCompletedCount()).toBe(1);
  });

  test("records perf timing for both preflight tasks when one fails", async () => {

    const perfTracker = new DefaultPerformanceTracker(fakeTimer);
    const targetUserDetector = new FakeTargetUserDetector(fakeTimer, {
      delayMs: 50,
      resolvedUserId: 10
    });
    const installedAppsProvider = new FakeInstalledAppsProvider(fakeTimer, {
      delayMs: 50,
      shouldThrow: true,
      error: new Error("check installed failed")
    });

    const perfLaunchApp = new LaunchApp(device, fakeAdb as unknown as any, null, fakeTimer, {
      targetUserDetector,
      installedAppsProvider,
      performanceTrackerFactory: () => perfTracker
    });

    const resultPromise = perfLaunchApp.execute(packageName, false, false);

    for (let i = 0; i < 50 && fakeTimer.getPendingSleepCount() < 2; i += 1) {
      await Promise.resolve();
    }

    fakeTimer.advanceTime(50);

    await expect(resultPromise).rejects.toThrow("check installed failed");

    const timings = perfTracker.getTimings();
    expect(Array.isArray(timings)).toBe(true);

    const launchEntry = (timings as any[]).find(entry => entry.name === "launchApp");
    expect(launchEntry).toBeDefined();
    const childNames = (launchEntry.children as any[]).map(entry => entry.name);
    expect(childNames).toContain("detectTargetUser");
    expect(childNames).toContain("checkInstalled");
  });

  test("launches iOS system apps even when installed list is empty", async () => {
    fakeTimer.enableAutoAdvance();
    const iosDevice: BootedDevice = { name: "test-ios-device", platform: "ios", deviceId: "ios-123" };
    const systemBundleId = "com.apple.Preferences";
    const fakeIOSCtrlProxy = new FakeIOSCtrlProxy();
    const getInstanceSpy = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue(
      fakeIOSCtrlProxy as unknown as IOSCtrlProxyClient
    );

    const iosObserveResult: ObserveResult = {
      updatedAt: Date.now(),
      screenSize: { width: 1080, height: 1920 },
      systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
      viewHierarchy: { hierarchy: { node: {} }, packageName: systemBundleId } as any
    };

    const iosFakeObserveScreen = new FakeObserveScreen();
    iosFakeObserveScreen.setObserveResult(iosObserveResult);
    const iosFakeAwaitIdle = new FakeAwaitIdle();
    const iosFakeWindow = new FakeWindow();
    iosFakeWindow.configureCachedActiveWindow({ appId: systemBundleId, activityName: "Main", layoutSeqSum: 1 });

    const installedAppsProvider = new FakeInstalledAppsProvider(fakeTimer, {
      installedApps: []
    });

    const fakeSimctl = {
      launchApp: async () => ({ success: true, pid: 123 }),
      terminateApp: async () => {},
    };

    const iosLaunchApp = new LaunchApp(
      iosDevice,
      fakeAdb as unknown as any,
      fakeSimctl as any,
      fakeTimer,
      { installedAppsProvider }
    );
    (iosLaunchApp as any).awaitIdle = iosFakeAwaitIdle;
    (iosLaunchApp as any).observeScreen = iosFakeObserveScreen;
    (iosLaunchApp as any).window = iosFakeWindow;
    (iosLaunchApp as any).waitForIosHierarchyReady = async () => {};

    try {
      const result = await iosLaunchApp.execute(systemBundleId, false, false);
      expect(result.success).toBe(true);
      // Warm launch uses simctl directly — checkInstalled not called on success path
      expect(installedAppsProvider.getCallCount()).toBe(0);
    } finally {
      getInstanceSpy.mockRestore();
    }
  });

  describe("iOS setTargetBundleId timing", () => {
    const userBundleId = "com.example.myapp";
    const systemBundleId = "com.apple.Preferences";

    function createIOSTestHarness(opts: {
      bundleId: string;
      launchSuccess?: boolean;
    }) {
      const iosDevice: BootedDevice = { name: "test-ios", platform: "ios", deviceId: "ios-target" };
      const fakeCtrlProxy = new FakeIOSCtrlProxy();

      const ctrlProxySpy = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue(
        fakeCtrlProxy as unknown as IOSCtrlProxyClient
      );

      const targetBundleIdCalls: string[] = [];
      const managerSpy = spyOn(IOSCtrlProxyManager, "getInstance").mockReturnValue({
        setTargetBundleId: (id: string) => targetBundleIdCalls.push(id),
      } as unknown as IOSCtrlProxyManager);

      const iosObserveScreen = new FakeObserveScreen();
      iosObserveScreen.setObserveResult({
        updatedAt: Date.now(),
        screenSize: { width: 1080, height: 1920 },
        systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
        viewHierarchy: { hierarchy: { node: {} }, packageName: opts.bundleId } as any
      });

      const iosWindow = new FakeWindow();
      iosWindow.configureCachedActiveWindow({ appId: opts.bundleId, activityName: "Main", layoutSeqSum: 1 });

      const installedApps = new FakeInstalledAppsProvider(fakeTimer, {
        installedApps: [opts.bundleId]
      });

      const fakeSimctl = {
        launchApp: async () => opts.launchSuccess === false
          ? { success: false, error: "simctl launch failed" }
          : { success: true, pid: 123 },
        terminateApp: async () => {},
      };

      const iosLaunchApp = new LaunchApp(iosDevice, fakeAdb as unknown as any, fakeSimctl as any, fakeTimer, { installedAppsProvider: installedApps });
      (iosLaunchApp as any).awaitIdle = new FakeAwaitIdle();
      (iosLaunchApp as any).observeScreen = iosObserveScreen;
      (iosLaunchApp as any).window = iosWindow;
      (iosLaunchApp as any).waitForIosHierarchyReady = async () => {};

      return { iosLaunchApp, targetBundleIdCalls, cleanup: () => { ctrlProxySpy.mockRestore(); managerSpy.mockRestore(); } };
    }

    test("sets targetBundleId BEFORE simctl launch so CtrlProxy targets the app, not SpringBoard", async () => {
      fakeTimer.enableAutoAdvance();
      const iosDevice: BootedDevice = { name: "test-ios", platform: "ios", deviceId: "ios-order" };
      const callOrder: string[] = [];

      const ctrlProxySpy = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue(
        new FakeIOSCtrlProxy() as unknown as IOSCtrlProxyClient
      );
      const managerSpy = spyOn(IOSCtrlProxyManager, "getInstance").mockReturnValue({
        setTargetBundleId: (id: string) => callOrder.push(`setTargetBundleId:${id}`),
      } as unknown as IOSCtrlProxyManager);

      const fakeSimctl = {
        launchApp: async () => {
          callOrder.push(`simctlLaunch:${userBundleId}`);
          return { success: true, pid: 123 };
        },
        terminateApp: async () => {},
      };

      const iosObserveScreen = new FakeObserveScreen();
      iosObserveScreen.setObserveResult({
        updatedAt: Date.now(),
        screenSize: { width: 1080, height: 1920 },
        systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
        viewHierarchy: { hierarchy: { node: {} }, packageName: userBundleId } as any,
      });
      const iosWindow = new FakeWindow();
      iosWindow.configureCachedActiveWindow({ appId: userBundleId, activityName: "Main", layoutSeqSum: 1 });
      const installedApps = new FakeInstalledAppsProvider(fakeTimer, { installedApps: [userBundleId] });

      const iosLaunchApp = new LaunchApp(iosDevice, fakeAdb as unknown as any, fakeSimctl as any, fakeTimer, { installedAppsProvider: installedApps });
      (iosLaunchApp as any).awaitIdle = new FakeAwaitIdle();
      (iosLaunchApp as any).observeScreen = iosObserveScreen;
      (iosLaunchApp as any).window = iosWindow;
      (iosLaunchApp as any).waitForIosHierarchyReady = async () => {};

      try {
        await iosLaunchApp.execute(userBundleId, false, false);
        // setTargetBundleId must fire before launch so CtrlProxy receives the
        // bundle ID via SIMCTL_CHILD_CTRL_PROXY_IOS_BUNDLE_ID when it starts.
        expect(callOrder.indexOf(`setTargetBundleId:${userBundleId}`))
          .toBeLessThan(callOrder.indexOf(`simctlLaunch:${userBundleId}`));
      } finally {
        ctrlProxySpy.mockRestore();
        managerSpy.mockRestore();
      }
    });

    test("re-observes until the iOS launch observation hierarchy reports the launched bundle", async () => {
      fakeTimer.enableAutoAdvance();
      const iosDevice: BootedDevice = { name: "test-ios", platform: "ios", deviceId: "ios-observation" };
      const previousBundleId = "com.apple.Maps";
      const observations = [
        {
          updatedAt: Date.now(),
          screenSize: { width: 1080, height: 1920 },
          systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
          viewHierarchy: { hierarchy: { node: {} }, packageName: previousBundleId } as any,
        },
        {
          updatedAt: Date.now(),
          screenSize: { width: 1080, height: 1920 },
          systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
          viewHierarchy: { hierarchy: { node: {} }, packageName: userBundleId } as any,
        },
      ];

      const ctrlProxySpy = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue(
        new FakeIOSCtrlProxy() as unknown as IOSCtrlProxyClient
      );
      const managerSpy = spyOn(IOSCtrlProxyManager, "getInstance").mockReturnValue({
        setTargetBundleId: () => {},
      } as unknown as IOSCtrlProxyManager);
      const fakeSimctl = {
        launchApp: async () => ({ success: true, pid: 123 }),
        terminateApp: async () => {},
      };
      const iosObserveScreen = new FakeObserveScreen();
      iosObserveScreen.setObserveResult(() => observations.shift() ?? {
        updatedAt: Date.now(),
        screenSize: { width: 1080, height: 1920 },
        systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
        viewHierarchy: { hierarchy: { node: {} }, packageName: userBundleId } as any,
      });
      const iosWindow = new FakeWindow();
      iosWindow.configureCachedActiveWindow({ appId: userBundleId, activityName: "Main", layoutSeqSum: 1 });
      const installedApps = new FakeInstalledAppsProvider(fakeTimer, { installedApps: [userBundleId] });

      const iosLaunchApp = new LaunchApp(iosDevice, fakeAdb as unknown as any, fakeSimctl as any, fakeTimer, { installedAppsProvider: installedApps });
      (iosLaunchApp as any).awaitIdle = new FakeAwaitIdle();
      (iosLaunchApp as any).observeScreen = iosObserveScreen;
      (iosLaunchApp as any).window = iosWindow;
      (iosLaunchApp as any).waitForIosHierarchyReady = async () => {};

      try {
        const result = await iosLaunchApp.execute(userBundleId, false, false);
        expect(result.success).toBe(true);
        expect(result.observation?.viewHierarchy?.packageName).toBe(userBundleId);
        expect(iosObserveScreen.getExecuteCallCount()).toBeGreaterThan(1);
      } finally {
        ctrlProxySpy.mockRestore();
        managerSpy.mockRestore();
      }
    });

    test("sets targetBundleId after successful non-system app launch", async () => {
      fakeTimer.enableAutoAdvance();
      const { iosLaunchApp, targetBundleIdCalls, cleanup } = createIOSTestHarness({
        bundleId: userBundleId,
        launchSuccess: true,
      });

      try {
        const result = await iosLaunchApp.execute(userBundleId, false, false);
        expect(result.success).toBe(true);
        expect(targetBundleIdCalls).toEqual([userBundleId]);
      } finally {
        cleanup();
      }
    });

    test("still sets targetBundleId even when launch fails (must be set before CtrlProxy starts)", async () => {
      fakeTimer.enableAutoAdvance();
      const { iosLaunchApp, targetBundleIdCalls, cleanup } = createIOSTestHarness({
        bundleId: userBundleId,
        launchSuccess: false,
      });

      try {
        const result = await iosLaunchApp.execute(userBundleId, false, false);
        expect(result.success).toBe(false);
        // setTargetBundleId is called before requestLaunchApp (which triggers CtrlProxy setup),
        // so it fires regardless of whether the launch ultimately succeeds.
        expect(targetBundleIdCalls).toEqual([userBundleId]);
      } finally {
        cleanup();
      }
    });

    test("does not set targetBundleId for system app launch", async () => {
      fakeTimer.enableAutoAdvance();
      const { iosLaunchApp, targetBundleIdCalls, cleanup } = createIOSTestHarness({
        bundleId: systemBundleId,
        launchSuccess: true,
      });

      try {
        const result = await iosLaunchApp.execute(systemBundleId, false, false);
        expect(result.success).toBe(true);
        expect(targetBundleIdCalls).toEqual([]);
      } finally {
        cleanup();
      }
    });
  });

  describe("iOS clearAppData", () => {
    const userBundleId = "com.example.myapp";
    const systemBundleId = "com.apple.Preferences";
    const tempDirs: string[] = [];

    afterEach(async () => {
      for (const dir of tempDirs.splice(0)) {
        await fsp.rm(dir, { recursive: true, force: true });
      }
    });

    function createClearDataHarness(bundleId: string, opts: { containerPath?: string } = {}) {
      const iosDevice: BootedDevice = { name: "test-ios", platform: "ios", deviceId: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE" };
      const fakeCtrlProxy = new FakeIOSCtrlProxy();

      const ctrlProxySpy = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue(
        fakeCtrlProxy as unknown as IOSCtrlProxyClient
      );
      const managerSpy = spyOn(IOSCtrlProxyManager, "getInstance").mockReturnValue({
        setTargetBundleId: () => {},
      } as unknown as IOSCtrlProxyManager);

      // get_app_container returns this path (empty → clear fails as "not installed").
      const containerPath = opts.containerPath ?? "";
      const calls: string[] = [];
      const fakeSimctl = {
        launchApp: async (id: string) => { calls.push(`launch:${id}`); return { success: true, pid: 123 }; },
        terminateApp: async (id: string) => { calls.push(`terminate:${id}`); },
        executeCommand: async (command: string) => {
          calls.push(`exec:${command}`);
          const stdout = command.startsWith("get_app_container") ? containerPath : "";
          return { stdout, stderr: "", trim: () => stdout.trim(), toString: () => stdout, includes: (s: string) => stdout.includes(s) } as any;
        },
      };

      const iosObserveScreen = new FakeObserveScreen();
      iosObserveScreen.setObserveResult({
        updatedAt: Date.now(),
        screenSize: { width: 1080, height: 1920 },
        systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
        viewHierarchy: { hierarchy: { node: {} }, packageName: bundleId } as any,
      });
      const iosWindow = new FakeWindow();
      iosWindow.configureCachedActiveWindow({ appId: bundleId, activityName: "Main", layoutSeqSum: 1 });
      const installedApps = new FakeInstalledAppsProvider(fakeTimer, { installedApps: [bundleId] });

      const iosLaunchApp = new LaunchApp(iosDevice, fakeAdb as unknown as any, fakeSimctl as any, fakeTimer, { installedAppsProvider: installedApps });
      (iosLaunchApp as any).awaitIdle = new FakeAwaitIdle();
      (iosLaunchApp as any).observeScreen = iosObserveScreen;
      (iosLaunchApp as any).window = iosWindow;
      (iosLaunchApp as any).waitForIosHierarchyReady = async () => {};

      return { iosLaunchApp, fakeCtrlProxy, calls, cleanup: () => { ctrlProxySpy.mockRestore(); managerSpy.mockRestore(); } };
    }

    test("wipes the data container and re-wires CtrlProxy when clearAppData is true", async () => {
      fakeTimer.enableAutoAdvance();
      const containerPath = await fsp.mkdtemp(nodePath.join(os.tmpdir(), "automobile-launch-clear-"));
      tempDirs.push(containerPath);
      const { iosLaunchApp, fakeCtrlProxy, calls, cleanup } = createClearDataHarness(userBundleId, { containerPath });
      try {
        const result = await iosLaunchApp.execute(userBundleId, /* clearAppData */ true, /* coldBoot */ false);
        expect(result.success).toBe(true);
        // Data container resolved via get_app_container (the fast clear path)
        expect(calls.some(c => c.startsWith("exec:get_app_container") && c.includes(userBundleId))).toBe(true);
        // CtrlProxy cache dropped so the hierarchy re-snapshots the fresh launch
        expect(fakeCtrlProxy.clearCacheCallCount).toBeGreaterThan(0);
        // App is relaunched after the wipe
        expect(calls.some(c => c === `launch:${userBundleId}`)).toBe(true);
      } finally {
        cleanup();
      }
    });

    test("aborts the launch (no simctl launch) when the clear fails", async () => {
      fakeTimer.enableAutoAdvance();
      // No containerPath → get_app_container returns empty → clear fails.
      const { iosLaunchApp, calls, cleanup } = createClearDataHarness(userBundleId);
      try {
        const result = await iosLaunchApp.execute(userBundleId, /* clearAppData */ true, /* coldBoot */ false);
        expect(result.success).toBe(false);
        expect(result.error).toContain("Failed to clear app data");
        // Must NOT launch with stale data
        expect(calls.some(c => c === `launch:${userBundleId}`)).toBe(false);
      } finally {
        cleanup();
      }
    });

    test("does not wipe data for a system bundle even when clearAppData is true", async () => {
      fakeTimer.enableAutoAdvance();
      const { iosLaunchApp, calls, cleanup } = createClearDataHarness(systemBundleId);
      try {
        const result = await iosLaunchApp.execute(systemBundleId, /* clearAppData */ true, /* coldBoot */ false);
        expect(result.success).toBe(true);
        // No get_app_container resolution for system bundles
        expect(calls.some(c => c.startsWith("exec:get_app_container"))).toBe(false);
      } finally {
        cleanup();
      }
    });
  });
});
