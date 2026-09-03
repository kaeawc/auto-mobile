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
import { FakeDeviceAppLauncher } from "../../fakes/FakeDeviceAppLauncher";
import { IOSCtrlProxyClient } from "../../../src/features/observe/ios";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { IOSCtrlProxyManager } from "../../../src/utils/IOSCtrlProxyManager";
import { DeviceLostError } from "../../../src/server/deviceLossOutcome";

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
    viewHierarchy: appId ? ({ node: {}, packageName: appId } as any) : { node: {} },
    activeWindow: appId ? { appId, activityName: "MainActivity", layoutSeqSum: 1 } : undefined,
  });

  const configureInstalledApp = () => {
    fakeAdb.setCommandResponse("shell pm list packages --user 0", {
      stdout: `package:${packageName}\n`,
      stderr: "",
    });
    fakeAdb.setCommandResponse("shell pm list packages -s --user 0", { stdout: "", stderr: "" });
  };

  const hasStartedAppLaunch = () =>
    fakeAdb
      .getExecutedCommands()
      .some(
        (command) =>
          command.includes("shell am start --user 0") ||
          command.includes(`shell monkey -p ${packageName}`),
      );

  beforeEach(() => {
    device = { name: "test-device", platform: "android", deviceId: "device-123" };
    fakeAdb = new FakeAdbExecutor();
    fakeAwaitIdle = new FakeAwaitIdle();
    fakeObserveScreen = new FakeObserveScreen();
    fakeTimer = new FakeTimer();
    fakeWindow = new FakeWindow();

    fakeObserveScreen.setObserveResult(createObserveResult());
    fakeWindow.configureCachedActiveWindow(null);
    fakeWindow.configureActiveWindow({
      appId: packageName,
      activityName: "MainActivity",
      layoutSeqSum: 1,
    });

    launchApp = new LaunchApp(device, fakeAdb as unknown as any, null, fakeTimer);
    (launchApp as any).awaitIdle = fakeAwaitIdle;
    (launchApp as any).observeScreen = fakeObserveScreen;
    (launchApp as any).window = fakeWindow;

    configureInstalledApp();
  });

  test("returns observation when app is already in foreground", async () => {
    const controller = new AbortController();
    fakeAdb.setForegroundApp({ packageName, userId: 0 });
    fakeAdb.setCommandResponse("shell dumpsys activity processes", {
      stdout: "123:com.example.app/u0a123\n",
      stderr: "",
    });

    const result = await launchApp.execute(
      packageName,
      false,
      false,
      undefined,
      undefined,
      undefined,
      controller.signal,
    );

    expect(result.success).toBe(true);
    expect(result.error).toBe("App is already in foreground");
    expect(result.observation).toBeDefined();
    expect(fakeObserveScreen.getExecuteCallCount()).toBeGreaterThan(0);
    expect(
      fakeObserveScreen
        .getExecuteOptions()
        .every((options) => options.signal === controller.signal),
    ).toBe(true);
    expect(fakeAwaitIdle.wasMethodCalled("initializeUiStabilityTracking")).toBe(true);
  });

  test("recognizes a running app whose process uses a numeric system UID", async () => {
    const controller = new AbortController();
    const settingsPackageName = "com.android.settings";
    fakeAdb.setCommandResponse("shell pm list packages --user 0", {
      stdout: `package:${settingsPackageName}\n`,
      stderr: "",
    });
    fakeAdb.setCommandResponse("shell pm list packages -s --user 0", { stdout: "", stderr: "" });
    fakeAdb.setCommandResponse("shell dumpsys activity processes", {
      stdout: "*APP* UID 1000 ProcessRecord{3dc154f 30779:com.android.settings/1000}",
      stderr: "",
    });
    fakeAdb.setForegroundApp({ packageName: settingsPackageName, userId: 0 });

    const result = await launchApp.execute(
      settingsPackageName,
      false,
      false,
      undefined,
      undefined,
      undefined,
      controller.signal,
    );

    expect(result.success).toBe(true);
    expect(result.error).toBe("App is already in foreground");
    expect(fakeAdb.wasCommandExecuted("shell dumpsys activity processes")).toBe(true);
  });

  test("stops launch when device loss cancels the operation during preflight", async () => {
    const controller = new AbortController();
    const deviceLoss = new DeviceLostError(
      device.deviceId,
      `device-disconnected:${device.deviceId}`,
    );
    const cancellableLaunch = new LaunchApp(device, fakeAdb as unknown as any, null, fakeTimer, {
      targetUserDetector: {
        async detectTargetUserId() {
          controller.abort(deviceLoss);
          return 0;
        },
      },
      installedAppsProvider: {
        async listInstalledApps() {
          return await new Promise<never>(() => {});
        },
      },
    });
    (cancellableLaunch as any).awaitIdle = fakeAwaitIdle;
    (cancellableLaunch as any).observeScreen = fakeObserveScreen;
    (cancellableLaunch as any).window = fakeWindow;

    await expect(
      cancellableLaunch.execute(
        packageName,
        false,
        false,
        undefined,
        undefined,
        undefined,
        controller.signal,
      ),
    ).rejects.toBe(deviceLoss);
    expect(hasStartedAppLaunch()).toBe(false);
  });

  test("does not clear Android app data after device loss during the running check", async () => {
    const controller = new AbortController();
    const deviceLoss = new DeviceLostError(
      device.deviceId,
      `device-disconnected:${device.deviceId}`,
    );
    let clearCalls = 0;
    const cancellableLaunch = new LaunchApp(device, fakeAdb as unknown as any, null, fakeTimer, {
      createAndroidClearAppData: () => ({
        async execute() {
          clearCalls += 1;
          return { success: true, packageName };
        },
      }),
    });
    (cancellableLaunch as any).awaitIdle = fakeAwaitIdle;
    (cancellableLaunch as any).observeScreen = fakeObserveScreen;
    (cancellableLaunch as any).window = fakeWindow;
    const originalExecuteCommand = fakeAdb.executeCommand.bind(fakeAdb);
    const executeSpy = spyOn(fakeAdb, "executeCommand").mockImplementation(
      async (command, timeoutMs, maxBuffer, noRetry, signal) => {
        const result = await originalExecuteCommand(command, timeoutMs, maxBuffer, noRetry, signal);
        if (command.startsWith("shell dumpsys activity processes")) {
          controller.abort(deviceLoss);
        }
        return result;
      },
    );

    try {
      await expect(
        cancellableLaunch.execute(
          packageName,
          /* clearAppData */ true,
          /* coldBoot */ false,
          undefined,
          undefined,
          undefined,
          controller.signal,
        ),
      ).rejects.toBe(deviceLoss);
      expect(clearCalls).toBe(0);
      expect(hasStartedAppLaunch()).toBe(false);
    } finally {
      executeSpy.mockRestore();
    }
  });

  test("does not run fallback launch commands after device loss during intent launch", async () => {
    const controller = new AbortController();
    const deviceLoss = new DeviceLostError(
      device.deviceId,
      `device-disconnected:${device.deviceId}`,
    );
    const originalExecuteCommand = fakeAdb.executeCommand.bind(fakeAdb);
    const executeSpy = spyOn(fakeAdb, "executeCommand").mockImplementation(
      async (command, timeoutMs, maxBuffer, noRetry, signal) => {
        if (
          command.includes("android.intent.action.MAIN") &&
          command.includes("android.intent.category.LAUNCHER")
        ) {
          controller.abort(deviceLoss);
          throw new Error("ADB transport disconnected");
        }
        return await originalExecuteCommand(command, timeoutMs, maxBuffer, noRetry, signal);
      },
    );

    try {
      await expect(
        launchApp.execute(
          packageName,
          false,
          false,
          undefined,
          undefined,
          undefined,
          controller.signal,
        ),
      ).rejects.toBe(deviceLoss);
      expect(fakeAdb.wasCommandExecuted(`shell monkey -p ${packageName}`)).toBe(false);
    } finally {
      executeSpy.mockRestore();
    }
  });

  test("does not run ADB activity probes after device loss during launcher discovery", async () => {
    const controller = new AbortController();
    const deviceLoss = new DeviceLostError(
      device.deviceId,
      `device-disconnected:${device.deviceId}`,
    );
    fakeAdb.setCommandResponse("android.intent.category.LAUNCHER", {
      stdout: "Error: launcher intent unavailable",
      stderr: "",
    });
    fakeAdb.setCommandError(`shell monkey -p ${packageName}`, new Error("monkey unavailable"));
    const getInstanceSpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue({
      async requestLaunchIntent() {
        controller.abort(deviceLoss);
        throw new Error("CtrlProxy disconnected");
      },
    } as unknown as AndroidCtrlProxyClient);

    try {
      await expect(
        launchApp.execute(
          packageName,
          false,
          false,
          undefined,
          undefined,
          undefined,
          controller.signal,
        ),
      ).rejects.toBe(deviceLoss);
      expect(
        fakeAdb
          .getExecutedCommands()
          .some(
            (command) => command.includes("shell pm dump") || command.includes("query-activities"),
          ),
      ).toBe(false);
    } finally {
      getInstanceSpy.mockRestore();
    }
  });

  test("aborts and unsubscribes while waiting for an iOS hierarchy race", async () => {
    const iosDevice: BootedDevice = {
      name: "test-ios-device",
      platform: "ios",
      deviceId: "11111111-1111-1111-1111-111111111111",
    };
    const controller = new AbortController();
    const deviceLoss = new DeviceLostError(
      iosDevice.deviceId,
      `device-disconnected:${iosDevice.deviceId}`,
    );
    let unsubscribeCount = 0;
    const client = {
      async getLatestHierarchy() {
        return null;
      },
      onPushUpdate() {
        return () => {
          unsubscribeCount += 1;
        };
      },
      async requestHierarchySync() {
        return await new Promise<never>(() => {});
      },
    };
    const getInstanceSpy = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue(
      client as unknown as IOSCtrlProxyClient,
    );
    const iosLaunchApp = new LaunchApp(iosDevice, fakeAdb as unknown as any, null, fakeTimer);

    try {
      const wait = (
        iosLaunchApp as unknown as {
          waitForIosHierarchyReady(
            timeoutMs: number,
            expectedPackageName: string,
            signal: AbortSignal,
          ): Promise<void>;
        }
      ).waitForIosHierarchyReady(5_000, packageName, controller.signal);
      await Promise.resolve();
      controller.abort(deviceLoss);

      await expect(wait).rejects.toBe(deviceLoss);
      expect(unsubscribeCount).toBe(1);
      expect(fakeTimer.getPendingTimeoutCount()).toBe(0);
    } finally {
      getInstanceSpy.mockRestore();
    }
  });

  test("launches an Android app whose launcher activity is not MainActivity with the package resolver", async () => {
    fakeTimer.enableAutoAdvance();
    const settingsPackageName = "com.android.settings";
    const resolverCommand = `shell am start --user 0 -a android.intent.action.MAIN -c android.intent.category.LAUNCHER ${settingsPackageName}`;

    fakeAdb.setCommandResponse("shell pm list packages --user 0", {
      stdout: `package:${settingsPackageName}\n`,
      stderr: "",
    });
    fakeAdb.setCommandResponse(resolverCommand, {
      stdout: "Starting: Intent { act=android.intent.action.MAIN }",
      stderr: "",
    });
    fakeAdb.setCommandResponse("shell dumpsys activity processes", {
      stdout: "",
      stderr: "",
    });
    fakeAdb.setForegroundApp({ packageName: settingsPackageName, userId: 0 });
    fakeObserveScreen.setObserveResult(createObserveResult(settingsPackageName));

    const result = await launchApp.execute(settingsPackageName, false, false);

    expect(result.success).toBe(true);
    expect(result.observation?.activeWindow?.appId).toBe(settingsPackageName);
    expect(
      fakeAdb
        .getExecutedCommands()
        .filter(
          (command) =>
            command.includes("shell am start") &&
            command.includes("android.intent.category.LAUNCHER"),
        ),
    ).toEqual([resolverCommand]);
    expect(fakeAdb.wasCommandExecuted(`shell monkey -p ${settingsPackageName}`)).toBe(false);
  });

  test("clears Android app data through the injected action before relaunch", async () => {
    fakeTimer.enableAutoAdvance();
    fakeAdb.setForegroundApp({ packageName, userId: 0 });
    fakeAdb.setCommandResponse("shell dumpsys activity processes", {
      stdout: "123:com.example.app/u0a123\n",
      stderr: "",
    });

    const clearCalls: Array<{
      device: BootedDevice;
      packageName: string;
      userId: number | undefined;
    }> = [];
    const coldBootCalls: Array<{ packageName: string; options: unknown }> = [];
    const lifecycleLaunchApp = new LaunchApp(device, fakeAdb as unknown as any, null, fakeTimer, {
      createAndroidClearAppData: (clearDevice) => ({
        execute: async (clearPackageName: string, userId?: number) => {
          expect(hasStartedAppLaunch()).toBe(false);
          clearCalls.push({ device: clearDevice, packageName: clearPackageName, userId });
          return { success: true, packageName: clearPackageName, userId };
        },
      }),
      createAndroidColdBoot: () => ({
        execute: async (coldBootPackageName: string, options?: unknown) => {
          expect(hasStartedAppLaunch()).toBe(false);
          coldBootCalls.push({ packageName: coldBootPackageName, options });
          return {
            success: true,
            packageName: coldBootPackageName,
            wasInstalled: true,
            wasRunning: true,
            wasForeground: false,
            userId: 0,
          };
        },
      }),
    });
    (lifecycleLaunchApp as any).awaitIdle = fakeAwaitIdle;
    (lifecycleLaunchApp as any).observeScreen = fakeObserveScreen;
    (lifecycleLaunchApp as any).window = fakeWindow;

    const result = await lifecycleLaunchApp.execute(packageName, true, false);

    expect(result.success).toBe(true);
    expect(clearCalls).toEqual([{ device, packageName, userId: 0 }]);
    expect(coldBootCalls).toEqual([]);
    expect(fakeAdb.wasCommandExecuted(`shell monkey -p ${packageName} --user 0 1`)).toBe(true);
  });

  test("clears Android app data through the injected action before relaunch when not running", async () => {
    fakeTimer.enableAutoAdvance();
    fakeAdb.setForegroundApp({ packageName, userId: 0 });
    fakeAdb.setCommandResponse("shell dumpsys activity processes", { stdout: "0\n", stderr: "" });

    const clearCalls: Array<{
      device: BootedDevice;
      packageName: string;
      userId: number | undefined;
    }> = [];
    const lifecycleLaunchApp = new LaunchApp(device, fakeAdb as unknown as any, null, fakeTimer, {
      createAndroidClearAppData: (clearDevice) => ({
        execute: async (clearPackageName: string, userId?: number) => {
          expect(hasStartedAppLaunch()).toBe(false);
          clearCalls.push({ device: clearDevice, packageName: clearPackageName, userId });
          return { success: true, packageName: clearPackageName, userId };
        },
      }),
    });
    (lifecycleLaunchApp as any).awaitIdle = fakeAwaitIdle;
    (lifecycleLaunchApp as any).observeScreen = fakeObserveScreen;
    (lifecycleLaunchApp as any).window = fakeWindow;

    const result = await lifecycleLaunchApp.execute(packageName, true, false);

    expect(result.success).toBe(true);
    expect(clearCalls).toEqual([{ device, packageName, userId: 0 }]);
    expect(fakeAdb.wasCommandExecuted(`shell monkey -p ${packageName} --user 0 1`)).toBe(true);
  });

  test("cold boots Android through the injected action before relaunch", async () => {
    fakeTimer.enableAutoAdvance();
    fakeAdb.setForegroundApp({ packageName, userId: 0 });
    fakeAdb.setCommandResponse("shell dumpsys activity processes", {
      stdout: "123:com.example.app/u0a123\n",
      stderr: "",
    });

    const clearCalls: string[] = [];
    const coldBootCalls: Array<{ device: BootedDevice; packageName: string; options: unknown }> =
      [];
    const lifecycleLaunchApp = new LaunchApp(device, fakeAdb as unknown as any, null, fakeTimer, {
      createAndroidClearAppData: () => ({
        execute: async (clearPackageName: string) => {
          clearCalls.push(clearPackageName);
          return { success: true, packageName: clearPackageName };
        },
      }),
      createAndroidColdBoot: (coldBootDevice) => ({
        execute: async (coldBootPackageName: string, options?: unknown) => {
          expect(hasStartedAppLaunch()).toBe(false);
          coldBootCalls.push({ device: coldBootDevice, packageName: coldBootPackageName, options });
          return {
            success: true,
            packageName: coldBootPackageName,
            wasInstalled: true,
            wasRunning: true,
            wasForeground: false,
            userId: 0,
          };
        },
      }),
    });
    (lifecycleLaunchApp as any).awaitIdle = fakeAwaitIdle;
    (lifecycleLaunchApp as any).observeScreen = fakeObserveScreen;
    (lifecycleLaunchApp as any).window = fakeWindow;

    const result = await lifecycleLaunchApp.execute(packageName, false, true);

    expect(result.success).toBe(true);
    expect(clearCalls).toEqual([]);
    expect(coldBootCalls).toEqual([
      {
        device,
        packageName,
        options: { skipObservation: true, userId: 0 },
      },
    ]);
    expect(fakeAdb.wasCommandExecuted(`shell monkey -p ${packageName} --user 0 1`)).toBe(true);
  });

  test("waits for foreground before returning observation", async () => {
    fakeAdb.setForegroundApp(null);
    fakeAdb.setCommandResponse("shell dumpsys activity processes", { stdout: "0\n", stderr: "" });

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
    const controller = new AbortController();
    const previousPackageName = "com.example.previous";
    const observations = [
      createObserveResult(previousPackageName),
      createObserveResult(packageName),
    ];

    fakeAdb.setForegroundApp({ packageName, userId: 0 });
    fakeAdb.setCommandResponse("shell dumpsys activity processes", { stdout: "0\n", stderr: "" });
    fakeObserveScreen.setObserveResult(
      () => observations.shift() ?? createObserveResult(packageName),
    );

    const result = await launchApp.execute(
      packageName,
      false,
      false,
      undefined,
      undefined,
      undefined,
      controller.signal,
    );

    expect(result.success).toBe(true);
    expect(result.observation?.activeWindow?.appId).toBe(packageName);
    expect(result.observation?.viewHierarchy?.packageName).toBe(packageName);
    expect(fakeObserveScreen.getExecuteCallCount()).toBeGreaterThan(1);
    expect(
      fakeObserveScreen
        .getExecuteOptions()
        .every((options) => options.signal === controller.signal),
    ).toBe(true);
  });

  test("re-observes when a matching launch observation is marked unverified", async () => {
    fakeTimer.enableAutoAdvance();
    const unverifiedObservation = {
      ...createObserveResult(packageName),
      freshness: {
        isFresh: false,
        verified: false,
        warning: "Observed hierarchy contains only Android status-bar content",
      },
    };

    fakeAdb.setForegroundApp({ packageName, userId: 0 });
    fakeAdb.setCommandResponse("shell dumpsys activity processes", { stdout: "0\n", stderr: "" });
    fakeObserveScreen.setObserveResult(unverifiedObservation);

    const result = await launchApp.execute(packageName, false, false);

    expect(result.success).toBe(false);
    expect(result.observation).toBeUndefined();
    expect(fakeObserveScreen.getExecuteCallCount()).toBeGreaterThan(1);
  });

  test("treats Android notification permission dialogs as valid launch observations", async () => {
    fakeTimer.enableAutoAdvance();
    const permissionControllerPackageName = "com.google.android.permissioncontroller";

    fakeAdb.setForegroundApp({ packageName: permissionControllerPackageName, userId: 0 });
    fakeAdb.setCommandResponse("shell dumpsys activity processes", { stdout: "0\n", stderr: "" });
    fakeObserveScreen.setObserveResult({
      ...createObserveResult(permissionControllerPackageName),
      activeWindow: {
        appId: permissionControllerPackageName,
        activityName: "GrantPermissionsActivity",
        layoutSeqSum: 1,
        type: "notification_permission_dialog",
      },
      notificationPermissionDetected: true,
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
    const invalidated: BootedDevice[] = [];
    const staleLaunchApp = new LaunchApp(device, fakeAdb as any, null, fakeTimer, {
      cacheInvalidator: {
        invalidate: (invalidatedDevice) => {
          invalidated.push(invalidatedDevice);
        },
      },
    });
    (staleLaunchApp as any).awaitIdle = fakeAwaitIdle;
    (staleLaunchApp as any).observeScreen = fakeObserveScreen;
    (staleLaunchApp as any).window = fakeWindow;

    fakeAdb.setForegroundApp({ packageName, userId: 0 });
    fakeAdb.setCommandResponse("shell dumpsys activity processes", { stdout: "0\n", stderr: "" });
    fakeObserveScreen.setObserveResult(() => createObserveResult(previousPackageName));

    const result = await staleLaunchApp.execute(packageName, false, false);

    expect(result.success).toBe(false);
    expect(result.error).toContain(
      `Timed out waiting for launch observation to show ${packageName}`,
    );
    expect(result.observation).toBeUndefined();
    expect(invalidated).toEqual([device]);
  });

  // Deterministic launch payload shape (issue #5872 AC2): when the observation is
  // dropped because it is stale, the response must EXPLAIN which shape it is rather
  // than silently omitting the observation with nothing distinguishing it.
  test("explains the omitted observation with observationOmitted when the launch is stale", async () => {
    fakeTimer.enableAutoAdvance();
    const previousPackageName = "com.example.previous";

    fakeAdb.setForegroundApp({ packageName, userId: 0 });
    fakeAdb.setCommandResponse("shell dumpsys activity processes", { stdout: "0\n", stderr: "" });
    fakeObserveScreen.setObserveResult(() => createObserveResult(previousPackageName));

    const result = await launchApp.execute(packageName, false, false);

    expect(result.observation).toBeUndefined();
    expect(result.observationOmitted).toBeDefined();
    expect(result.observationOmitted!.reason).toBe("stale_launch_observation");
    expect(result.observationOmitted!.expectedPackage).toBe(packageName);
    expect(result.observationOmitted!.reportedPackages).toContain(previousPackageName);
  });

  test("runs target user detection and install check in parallel", async () => {
    const targetUserDetector = new FakeTargetUserDetector(fakeTimer, {
      delayMs: 50,
      resolvedUserId: 10,
    });
    const installedAppsProvider = new FakeInstalledAppsProvider(fakeTimer, {
      delayMs: 50,
      installedApps: [],
    });

    const parallelLaunchApp = new LaunchApp(device, fakeAdb as unknown as any, null, fakeTimer, {
      targetUserDetector,
      installedAppsProvider,
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
      resolvedUserId: 10,
    });
    const installedAppsProvider = new FakeInstalledAppsProvider(fakeTimer, {
      delayMs: 50,
      shouldThrow: true,
      error: new Error("check installed failed"),
    });

    const parallelLaunchApp = new LaunchApp(device, fakeAdb as unknown as any, null, fakeTimer, {
      targetUserDetector,
      installedAppsProvider,
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
      resolvedUserId: 10,
    });
    const installedAppsProvider = new FakeInstalledAppsProvider(fakeTimer, {
      delayMs: 50,
      shouldThrow: true,
      error: new Error("check installed failed"),
    });

    const perfLaunchApp = new LaunchApp(device, fakeAdb as unknown as any, null, fakeTimer, {
      targetUserDetector,
      installedAppsProvider,
      performanceTrackerFactory: () => perfTracker,
    });

    const resultPromise = perfLaunchApp.execute(packageName, false, false);

    for (let i = 0; i < 50 && fakeTimer.getPendingSleepCount() < 2; i += 1) {
      await Promise.resolve();
    }

    fakeTimer.advanceTime(50);

    await expect(resultPromise).rejects.toThrow("check installed failed");

    const timings = perfTracker.getTimings();
    expect(Array.isArray(timings)).toBe(true);

    const launchEntry = (timings as any[]).find((entry) => entry.name === "launchApp");
    expect(launchEntry).toBeDefined();
    const childNames = (launchEntry.children as any[]).map((entry) => entry.name);
    expect(childNames).toContain("detectTargetUser");
    expect(childNames).toContain("checkInstalled");
  });

  test("launches iOS system apps even when installed list is empty", async () => {
    fakeTimer.enableAutoAdvance();
    const iosDevice: BootedDevice = {
      name: "test-ios-device",
      platform: "ios",
      deviceId: "11111111-1111-1111-1111-111111111111",
    };
    const systemBundleId = "com.apple.Preferences";
    const fakeIOSCtrlProxy = new FakeIOSCtrlProxy();
    const getInstanceSpy = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue(
      fakeIOSCtrlProxy as unknown as IOSCtrlProxyClient,
    );

    const iosObserveResult: ObserveResult = {
      updatedAt: Date.now(),
      screenSize: { width: 1080, height: 1920 },
      systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
      viewHierarchy: { hierarchy: { node: {} }, packageName: systemBundleId } as any,
    };

    const iosFakeObserveScreen = new FakeObserveScreen();
    iosFakeObserveScreen.setObserveResult(iosObserveResult);
    const iosFakeAwaitIdle = new FakeAwaitIdle();
    const iosFakeWindow = new FakeWindow();
    iosFakeWindow.configureCachedActiveWindow({
      appId: systemBundleId,
      activityName: "Main",
      layoutSeqSum: 1,
    });

    const installedAppsProvider = new FakeInstalledAppsProvider(fakeTimer, {
      installedApps: [],
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
      { installedAppsProvider },
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

    function createIOSTestHarness(opts: { bundleId: string; launchSuccess?: boolean }) {
      const iosDevice: BootedDevice = {
        name: "test-ios",
        platform: "ios",
        deviceId: "22222222-2222-2222-2222-222222222222",
      };
      const fakeCtrlProxy = new FakeIOSCtrlProxy();

      const ctrlProxySpy = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue(
        fakeCtrlProxy as unknown as IOSCtrlProxyClient,
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
        viewHierarchy: { hierarchy: { node: {} }, packageName: opts.bundleId } as any,
      });

      const iosWindow = new FakeWindow();
      iosWindow.configureCachedActiveWindow({
        appId: opts.bundleId,
        activityName: "Main",
        layoutSeqSum: 1,
      });

      const installedApps = new FakeInstalledAppsProvider(fakeTimer, {
        installedApps: [opts.bundleId],
      });

      const fakeSimctl = {
        launchApp: async () =>
          opts.launchSuccess === false
            ? { success: false, error: "simctl launch failed" }
            : { success: true, pid: 123 },
        terminateApp: async () => {},
      };

      const iosLaunchApp = new LaunchApp(
        iosDevice,
        fakeAdb as unknown as any,
        fakeSimctl as any,
        fakeTimer,
        { installedAppsProvider: installedApps },
      );
      (iosLaunchApp as any).awaitIdle = new FakeAwaitIdle();
      (iosLaunchApp as any).observeScreen = iosObserveScreen;
      (iosLaunchApp as any).window = iosWindow;
      (iosLaunchApp as any).waitForIosHierarchyReady = async () => {};

      return {
        iosLaunchApp,
        targetBundleIdCalls,
        cleanup: () => {
          ctrlProxySpy.mockRestore();
          managerSpy.mockRestore();
        },
      };
    }

    test("sets targetBundleId BEFORE simctl launch so CtrlProxy targets the app, not SpringBoard", async () => {
      fakeTimer.enableAutoAdvance();
      const iosDevice: BootedDevice = {
        name: "test-ios",
        platform: "ios",
        deviceId: "33333333-3333-3333-3333-333333333333",
      };
      const callOrder: string[] = [];

      const ctrlProxySpy = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue(
        new FakeIOSCtrlProxy() as unknown as IOSCtrlProxyClient,
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
      iosWindow.configureCachedActiveWindow({
        appId: userBundleId,
        activityName: "Main",
        layoutSeqSum: 1,
      });
      const installedApps = new FakeInstalledAppsProvider(fakeTimer, {
        installedApps: [userBundleId],
      });

      const iosLaunchApp = new LaunchApp(
        iosDevice,
        fakeAdb as unknown as any,
        fakeSimctl as any,
        fakeTimer,
        { installedAppsProvider: installedApps },
      );
      (iosLaunchApp as any).awaitIdle = new FakeAwaitIdle();
      (iosLaunchApp as any).observeScreen = iosObserveScreen;
      (iosLaunchApp as any).window = iosWindow;
      (iosLaunchApp as any).waitForIosHierarchyReady = async () => {};

      try {
        await iosLaunchApp.execute(userBundleId, false, false);
        // setTargetBundleId must fire before launch so CtrlProxy receives the
        // bundle ID via SIMCTL_CHILD_CTRL_PROXY_IOS_BUNDLE_ID when it starts.
        expect(callOrder.indexOf(`setTargetBundleId:${userBundleId}`)).toBeLessThan(
          callOrder.indexOf(`simctlLaunch:${userBundleId}`),
        );
      } finally {
        ctrlProxySpy.mockRestore();
        managerSpy.mockRestore();
      }
    });

    test("preserves a simulator SDK identity when a warm launch only foregrounds", async () => {
      fakeTimer.enableAutoAdvance();
      const { iosLaunchApp, cleanup } = createIOSTestHarness({
        bundleId: userBundleId,
        launchSuccess: true,
      });
      const clearedBundleIds: string[] = [];
      const existingClientSpy = spyOn(IOSCtrlProxyClient, "getExistingInstance").mockReturnValue({
        clearSdkScreenIdentity: (bundleId: string) => clearedBundleIds.push(bundleId),
      } as unknown as IOSCtrlProxyClient);

      try {
        const result = await iosLaunchApp.execute(userBundleId, false, false);

        expect(result.success).toBe(true);
        expect(clearedBundleIds).toEqual([]);
      } finally {
        existingClientSpy.mockRestore();
        cleanup();
      }
    });

    test("re-observes until the iOS launch observation hierarchy reports the launched bundle", async () => {
      fakeTimer.enableAutoAdvance();
      const iosDevice: BootedDevice = {
        name: "test-ios",
        platform: "ios",
        deviceId: "44444444-4444-4444-4444-444444444444",
      };
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
        new FakeIOSCtrlProxy() as unknown as IOSCtrlProxyClient,
      );
      const managerSpy = spyOn(IOSCtrlProxyManager, "getInstance").mockReturnValue({
        setTargetBundleId: () => {},
      } as unknown as IOSCtrlProxyManager);
      const fakeSimctl = {
        launchApp: async () => ({ success: true, pid: 123 }),
        terminateApp: async () => {},
      };
      const iosObserveScreen = new FakeObserveScreen();
      iosObserveScreen.setObserveResult(
        () =>
          observations.shift() ?? {
            updatedAt: Date.now(),
            screenSize: { width: 1080, height: 1920 },
            systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
            viewHierarchy: { hierarchy: { node: {} }, packageName: userBundleId } as any,
          },
      );
      const iosWindow = new FakeWindow();
      iosWindow.configureCachedActiveWindow({
        appId: userBundleId,
        activityName: "Main",
        layoutSeqSum: 1,
      });
      const installedApps = new FakeInstalledAppsProvider(fakeTimer, {
        installedApps: [userBundleId],
      });

      const iosLaunchApp = new LaunchApp(
        iosDevice,
        fakeAdb as unknown as any,
        fakeSimctl as any,
        fakeTimer,
        { installedAppsProvider: installedApps },
      );
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

  describe("iOS physical device (devicectl)", () => {
    const userBundleId = "com.example.myapp";
    // Physical-device UDID form (00008XXX-…), NOT the simulator 8-4-4-4-12 UUID.
    const physicalUdid = "00008120-000A123456789012";
    const simulatorUdid = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE";

    function createDeviceHarness(opts: {
      deviceId: string;
      launchResult?: { success: boolean; pid?: number; error?: string };
      clearResult?: { success: boolean; packageName: string; error?: string };
    }) {
      const iosDevice: BootedDevice = {
        name: "test-ios",
        platform: "ios",
        deviceId: opts.deviceId,
      };
      const fakeCtrlProxy = new FakeIOSCtrlProxy();
      const ctrlProxySpy = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue(
        fakeCtrlProxy as unknown as IOSCtrlProxyClient,
      );
      const managerSpy = spyOn(IOSCtrlProxyManager, "getInstance").mockReturnValue({
        setTargetBundleId: () => {},
      } as unknown as IOSCtrlProxyManager);

      const simctlCalls: string[] = [];
      const fakeSimctl = {
        launchApp: async (id: string) => {
          simctlCalls.push(`launch:${id}`);
          return { success: true, pid: 999 };
        },
        terminateApp: async (id: string) => {
          simctlCalls.push(`terminate:${id}`);
        },
      };

      const deviceAppLauncher = new FakeDeviceAppLauncher(
        opts.launchResult ? { launchResult: opts.launchResult } : {},
      );
      const clearCalls: Array<{ bundleId: string; device: BootedDevice; simctl: unknown }> = [];
      const clearAppDataFactory = (clearDevice: BootedDevice, clearSimctl: unknown) => ({
        execute: async (id: string) => {
          clearCalls.push({ bundleId: id, device: clearDevice, simctl: clearSimctl });
          return opts.clearResult ?? { success: true, packageName: id };
        },
      });

      const iosObserveScreen = new FakeObserveScreen();
      iosObserveScreen.setObserveResult({
        updatedAt: Date.now(),
        screenSize: { width: 1080, height: 1920 },
        systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
        viewHierarchy: { hierarchy: { node: {} }, packageName: userBundleId } as any,
      });
      const iosWindow = new FakeWindow();
      iosWindow.configureCachedActiveWindow({
        appId: userBundleId,
        activityName: "Main",
        layoutSeqSum: 1,
      });
      const installedApps = new FakeInstalledAppsProvider(fakeTimer, {
        installedApps: [userBundleId],
      });

      const iosLaunchApp = new LaunchApp(
        iosDevice,
        fakeAdb as unknown as any,
        fakeSimctl as any,
        fakeTimer,
        {
          installedAppsProvider: installedApps,
          deviceAppLauncher,
          clearAppDataFactory,
        },
      );
      (iosLaunchApp as any).awaitIdle = new FakeAwaitIdle();
      (iosLaunchApp as any).observeScreen = iosObserveScreen;
      (iosLaunchApp as any).window = iosWindow;
      (iosLaunchApp as any).waitForIosHierarchyReady = async () => {};

      return {
        iosLaunchApp,
        deviceAppLauncher,
        simctlCalls,
        clearCalls,
        cleanup: () => {
          ctrlProxySpy.mockRestore();
          managerSpy.mockRestore();
        },
      };
    }

    test("cold boot on a physical device launches via devicectl (not simctl) and propagates the PID", async () => {
      fakeTimer.enableAutoAdvance();
      const { iosLaunchApp, deviceAppLauncher, simctlCalls, cleanup } = createDeviceHarness({
        deviceId: physicalUdid,
        launchResult: { success: true, pid: 4321 },
      });
      try {
        const result = await iosLaunchApp.execute(
          userBundleId,
          /* clearAppData */ false,
          /* coldBoot */ true,
        );
        expect(result.success).toBe(true);
        expect(result.pid).toBe(4321);
        // Routed through devicectl with cold-boot relaunch semantics.
        expect(deviceAppLauncher.launchCalls).toHaveLength(1);
        expect(deviceAppLauncher.launchCalls[0]).toMatchObject({
          deviceUdid: physicalUdid,
          bundleId: userBundleId,
          terminateExisting: true,
        });
        // simctl must never be used for a physical device.
        expect(simctlCalls).toEqual([]);
      } finally {
        cleanup();
      }
    });

    test("cold boot on a device issues no separate terminate — --terminate-existing carries cold-boot semantics", async () => {
      fakeTimer.enableAutoAdvance();
      const { iosLaunchApp, deviceAppLauncher, simctlCalls, cleanup } = createDeviceHarness({
        deviceId: physicalUdid,
      });
      try {
        await iosLaunchApp.execute(userBundleId, false, true);
        // Exactly one devicectl round-trip: the launch (with --terminate-existing).
        // No separate pre-terminate call, and simctl is never touched on a device.
        expect(deviceAppLauncher.launchCalls).toHaveLength(1);
        expect(deviceAppLauncher.launchCalls[0].terminateExisting).toBe(true);
        expect(simctlCalls).toEqual([]);
      } finally {
        cleanup();
      }
    });

    test("warm launch on a physical device relaunches via devicectl --terminate-existing", async () => {
      fakeTimer.enableAutoAdvance();
      const { iosLaunchApp, deviceAppLauncher, simctlCalls, cleanup } = createDeviceHarness({
        deviceId: physicalUdid,
      });
      try {
        const result = await iosLaunchApp.execute(
          userBundleId,
          /* clearAppData */ false,
          /* coldBoot */ false,
        );
        expect(result.success).toBe(true);
        expect(deviceAppLauncher.launchCalls).toHaveLength(1);
        expect(deviceAppLauncher.launchCalls[0].terminateExisting).toBe(true);
        expect(simctlCalls).toEqual([]);
      } finally {
        cleanup();
      }
    });

    test("a devicectl launch failure propagates as { success: false } with the error", async () => {
      fakeTimer.enableAutoAdvance();
      const { iosLaunchApp, cleanup } = createDeviceHarness({
        deviceId: physicalUdid,
        launchResult: { success: false, error: "Application not found on device" },
      });
      try {
        const result = await iosLaunchApp.execute(userBundleId, false, true);
        expect(result.success).toBe(false);
        expect(result.error).toContain("Application not found on device");
      } finally {
        cleanup();
      }
    });

    test("clearAppData on a physical device clears via injected transport before devicectl relaunch", async () => {
      fakeTimer.enableAutoAdvance();
      const { iosLaunchApp, deviceAppLauncher, simctlCalls, clearCalls, cleanup } =
        createDeviceHarness({ deviceId: physicalUdid });
      try {
        const result = await iosLaunchApp.execute(
          userBundleId,
          /* clearAppData */ true,
          /* coldBoot */ false,
        );
        expect(result.success).toBe(true);
        expect(clearCalls).toHaveLength(1);
        expect(clearCalls[0]).toMatchObject({
          bundleId: userBundleId,
          device: { deviceId: physicalUdid, platform: "ios" },
        });
        expect(clearCalls[0].simctl).toBe((iosLaunchApp as any).simctl);
        expect(deviceAppLauncher.launchCalls).toEqual([
          {
            deviceUdid: physicalUdid,
            bundleId: userBundleId,
            terminateExisting: true,
          },
        ]);
        expect(simctlCalls).toEqual([]);
      } finally {
        cleanup();
      }
    });

    test("clearAppData failure on a physical device aborts without devicectl relaunch", async () => {
      fakeTimer.enableAutoAdvance();
      const { iosLaunchApp, deviceAppLauncher, simctlCalls, clearCalls, cleanup } =
        createDeviceHarness({
          deviceId: physicalUdid,
          clearResult: { success: false, packageName: userBundleId, error: "reinstall failed" },
        });
      try {
        const result = await iosLaunchApp.execute(
          userBundleId,
          /* clearAppData */ true,
          /* coldBoot */ false,
        );
        expect(result.success).toBe(false);
        expect(result.error).toContain("Failed to clear app data: reinstall failed");
        expect(clearCalls).toHaveLength(1);
        expect(clearCalls[0]).toMatchObject({
          bundleId: userBundleId,
          device: { deviceId: physicalUdid, platform: "ios" },
        });
        expect(clearCalls[0].simctl).toBe((iosLaunchApp as any).simctl);
        expect(deviceAppLauncher.launchCalls).toHaveLength(0);
        expect(simctlCalls).toEqual([]);
      } finally {
        cleanup();
      }
    });

    test("a simulator UDID still routes through simctl, never devicectl (regression)", async () => {
      fakeTimer.enableAutoAdvance();
      const { iosLaunchApp, deviceAppLauncher, simctlCalls, cleanup } = createDeviceHarness({
        deviceId: simulatorUdid,
      });
      try {
        const result = await iosLaunchApp.execute(userBundleId, false, true);
        expect(result.success).toBe(true);
        // Simulator path untouched: simctl used, devicectl launcher never called.
        expect(simctlCalls.some((c) => c === `launch:${userBundleId}`)).toBe(true);
        expect(deviceAppLauncher.launchCalls).toHaveLength(0);
      } finally {
        cleanup();
      }
    });

    test("stops an iOS clear-data launch when device loss occurs during termination", async () => {
      fakeTimer.enableAutoAdvance();
      const controller = new AbortController();
      const deviceLoss = new DeviceLostError(simulatorUdid, `device-disconnected:${simulatorUdid}`);
      const { iosLaunchApp, deviceAppLauncher, simctlCalls, clearCalls, cleanup } =
        createDeviceHarness({ deviceId: simulatorUdid });
      const simctl = (
        iosLaunchApp as unknown as {
          simctl: { terminateApp(bundleId: string): Promise<void> };
        }
      ).simctl;
      simctl.terminateApp = async (bundleId: string) => {
        simctlCalls.push(`terminate:${bundleId}`);
        controller.abort(deviceLoss);
      };

      try {
        await expect(
          iosLaunchApp.execute(
            userBundleId,
            /* clearAppData */ true,
            /* coldBoot */ false,
            undefined,
            undefined,
            undefined,
            controller.signal,
          ),
        ).rejects.toBe(deviceLoss);
        expect(clearCalls).toHaveLength(0);
        expect(deviceAppLauncher.launchCalls).toHaveLength(0);
        expect(simctlCalls).toEqual([`terminate:${userBundleId}`]);
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
      const iosDevice: BootedDevice = {
        name: "test-ios",
        platform: "ios",
        deviceId: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
      };
      const fakeCtrlProxy = new FakeIOSCtrlProxy();

      const ctrlProxySpy = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue(
        fakeCtrlProxy as unknown as IOSCtrlProxyClient,
      );
      const managerSpy = spyOn(IOSCtrlProxyManager, "getInstance").mockReturnValue({
        setTargetBundleId: () => {},
      } as unknown as IOSCtrlProxyManager);

      // get_app_container returns this path (empty → clear fails as "not installed").
      const containerPath = opts.containerPath ?? "";
      const calls: string[] = [];
      const fakeSimctl = {
        launchApp: async (id: string) => {
          calls.push(`launch:${id}`);
          return { success: true, pid: 123 };
        },
        terminateApp: async (id: string) => {
          calls.push(`terminate:${id}`);
        },
        executeCommand: async (command: string) => {
          calls.push(`exec:${command}`);
          const stdout = command.startsWith("get_app_container") ? containerPath : "";
          return {
            stdout,
            stderr: "",
            trim: () => stdout.trim(),
            toString: () => stdout,
            includes: (s: string) => stdout.includes(s),
          } as any;
        },
        executeCommandArgs: async (args: string[]) => {
          calls.push(`exec:${args.join(" ")}`);
          const stdout = args[0] === "get_app_container" ? containerPath : "";
          return {
            stdout,
            stderr: "",
            trim: () => stdout.trim(),
            toString: () => stdout,
            includes: (s: string) => stdout.includes(s),
          } as any;
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
      iosWindow.configureCachedActiveWindow({
        appId: bundleId,
        activityName: "Main",
        layoutSeqSum: 1,
      });
      const installedApps = new FakeInstalledAppsProvider(fakeTimer, { installedApps: [bundleId] });

      const iosLaunchApp = new LaunchApp(
        iosDevice,
        fakeAdb as unknown as any,
        fakeSimctl as any,
        fakeTimer,
        { installedAppsProvider: installedApps },
      );
      (iosLaunchApp as any).awaitIdle = new FakeAwaitIdle();
      (iosLaunchApp as any).observeScreen = iosObserveScreen;
      (iosLaunchApp as any).window = iosWindow;
      (iosLaunchApp as any).waitForIosHierarchyReady = async () => {};

      return {
        iosLaunchApp,
        fakeCtrlProxy,
        calls,
        cleanup: () => {
          ctrlProxySpy.mockRestore();
          managerSpy.mockRestore();
        },
      };
    }

    test("wipes the data container and re-wires CtrlProxy when clearAppData is true", async () => {
      fakeTimer.enableAutoAdvance();
      const containerPath = await fsp.mkdtemp(
        nodePath.join(os.tmpdir(), "automobile-launch-clear-"),
      );
      tempDirs.push(containerPath);
      const { iosLaunchApp, fakeCtrlProxy, calls, cleanup } = createClearDataHarness(userBundleId, {
        containerPath,
      });
      try {
        const result = await iosLaunchApp.execute(
          userBundleId,
          /* clearAppData */ true,
          /* coldBoot */ false,
        );
        expect(result.success).toBe(true);
        // Data container resolved via get_app_container (the fast clear path)
        expect(
          calls.some((c) => c.startsWith("exec:get_app_container") && c.includes(userBundleId)),
        ).toBe(true);
        // CtrlProxy cache dropped so the hierarchy re-snapshots the fresh launch
        expect(fakeCtrlProxy.clearCacheCallCount).toBeGreaterThan(0);
        // App is relaunched after the wipe
        expect(calls.some((c) => c === `launch:${userBundleId}`)).toBe(true);
      } finally {
        cleanup();
      }
    });

    test("aborts the launch (no simctl launch) when the clear fails", async () => {
      fakeTimer.enableAutoAdvance();
      // No containerPath → get_app_container returns empty → clear fails.
      const { iosLaunchApp, calls, cleanup } = createClearDataHarness(userBundleId);
      try {
        const result = await iosLaunchApp.execute(
          userBundleId,
          /* clearAppData */ true,
          /* coldBoot */ false,
        );
        expect(result.success).toBe(false);
        expect(result.error).toContain("Failed to clear app data");
        // Must NOT launch with stale data
        expect(calls.some((c) => c === `launch:${userBundleId}`)).toBe(false);
      } finally {
        cleanup();
      }
    });

    test("does not wipe data for a system bundle even when clearAppData is true", async () => {
      fakeTimer.enableAutoAdvance();
      const { iosLaunchApp, calls, cleanup } = createClearDataHarness(systemBundleId);
      try {
        const result = await iosLaunchApp.execute(
          systemBundleId,
          /* clearAppData */ true,
          /* coldBoot */ false,
        );
        expect(result.success).toBe(true);
        // No get_app_container resolution for system bundles
        expect(calls.some((c) => c.startsWith("exec:get_app_container"))).toBe(false);
      } finally {
        cleanup();
      }
    });
  });
});
