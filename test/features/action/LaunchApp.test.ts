import {
  beforeEach as beforeOutputSchema,
  afterEach as afterOutputSchema,
  spyOn as spyOnOutputSchema,
} from "bun:test";
import { launchAppResultSchema } from "../../../src/server/toolOutputSchemas";
import { finalizeToolResponse } from "../../../src/server/finalizeToolResponse";
import { createStructuredToolResponse } from "../../../src/utils/toolUtils";
import { FakeArtifactWriter } from "../../fakes/FakeArtifactWriter";
import { afterEach, beforeEach, describe, expect, test, spyOn } from "bun:test";
import { promises as fsp, readFileSync } from "fs";
import * as os from "os";
import * as nodePath from "path";
import { LaunchApp } from "../../../src/features/action/LaunchApp";
import { buildLaunchAppResponse } from "../../../src/server/appTools";
import {
  ActionableError,
  BackStackInfo,
  BootedDevice,
  ExecResult,
  ObserveResult,
  ViewHierarchyResult,
} from "../../../src/models";
import {
  DefaultPerformanceTracker,
  setDebugPerfEnabled,
} from "../../../src/utils/PerformanceTracker";
import { runWithPerfTracker, trackAmbient } from "../../../src/utils/PerfContext";
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
import { IOSCtrlProxyManager } from "../../../src/ctrlProxy/IOSCtrlProxyManager";
import { DeviceLostError } from "../../../src/server/deviceLossOutcome";
import { PortManager } from "../../../src/utils/PortManager";
import { logger } from "../../../src/utils/logger";
import { FakeDeviceWindowCacheInvalidator } from "../../fakes/FakeDeviceWindowCacheInvalidator";
import { FakeObserveCacheStore } from "../../fakes/FakeObserveCacheStore";

describe("LaunchApp", () => {
  let device: BootedDevice;
  let fakeAdb: FakeAdbExecutor;
  let fakeAwaitIdle: FakeAwaitIdle;
  let fakeObserveScreen: FakeObserveScreen;
  let fakeTimer: FakeTimer;
  let fakeWindow: FakeWindow;
  let launchApp: LaunchApp;

  const packageName = "com.example.app";

  const createObserveResult = (appId?: string, backStack?: BackStackInfo): ObserveResult => ({
    updatedAt: Date.now(),
    screenSize: { width: 1080, height: 1920 },
    systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
    viewHierarchy: appId ? ({ node: {}, packageName: appId } as any) : { node: {} },
    activeWindow: appId ? { appId, activityName: "MainActivity", layoutSeqSum: 1 } : undefined,
    backStack,
  });

  const configureInstalledApp = () => {
    fakeAdb.setCommandResponse("shell pm list packages --user 0", {
      stdout: `package:${packageName}\n`,
      stderr: "",
    });
    fakeAdb.setCommandResponse("shell pm list packages -s --user 0", { stdout: "", stderr: "" });
  };

  const configureSuccessfulClearAppData = () => {
    launchApp = new LaunchApp(device, fakeAdb, null, fakeTimer, {
      createAndroidClearAppData: () => ({
        execute: async () => ({ success: true, packageName }),
      }),
    });
    launchApp.awaitIdle = fakeAwaitIdle;
    launchApp.observeScreen = fakeObserveScreen;
    launchApp.window = fakeWindow;
  };

  const hasStartedAppLaunch = () =>
    fakeAdb
      .getExecutedCommands()
      .some(
        (command) =>
          command.includes("shell am start --user 0") ||
          command.includes(`shell monkey -p '${packageName}'`),
      );

  beforeEach(() => {
    PortManager.reset();
    PortManager.setPortAvailabilityCheckerForTesting({ isPortAvailable: () => true });
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

  afterEach(() => {
    setDebugPerfEnabled(false);
    PortManager.reset();
    PortManager.setPortAvailabilityCheckerForTesting(null);
  });

  test("foreground launch retires the pre-launch hierarchy before post-action observation", async () => {
    fakeTimer.enableAutoAdvance();
    fakeAdb.setForegroundApp({ packageName: "com.example.other", userId: 0 });
    fakeAdb.setCommandResponse("shell am start --user 0", {
      stdout: "Starting: Intent",
      stderr: "",
    });
    const invalidator = new FakeDeviceWindowCacheInvalidator();
    launchApp.windowCacheInvalidator = invalidator;
    fakeObserveScreen.setObserveResult(() => {
      expect(invalidator.calls).toEqual([device]);
      return {
        ...createObserveResult(),
        activeWindow: { appId: packageName, activityName: "MainActivity", layoutSeqSum: 1 },
      };
    });
    const result = await launchApp.execute(packageName, false, false);
    expect(result.success).toBe(true);
    expect(invalidator.calls).toEqual([device]);
  });

  test("install-aware targeting launches a personal-only app with a running work profile", async () => {
    fakeTimer.enableAutoAdvance();
    fakeAdb.setForegroundApp({ packageName: "com.example.other", userId: 0 });
    fakeAdb.setUsers([
      { userId: 0, name: "Owner", flags: 0x13, running: true },
      { userId: 10, name: "Work", flags: 0x30, running: true },
    ]);
    fakeAdb.setCommandResponse("shell pm list packages --user 10", {
      stdout: "package:com.example.other",
      stderr: "",
    });
    fakeAdb.setCommandResponse("shell am start --user 0", {
      stdout: "Starting: Intent",
      stderr: "",
    });
    fakeObserveScreen.setObserveResult({
      ...createObserveResult(),
      activeWindow: { appId: packageName, activityName: "MainActivity", layoutSeqSum: 1 },
    });
    const detectorSpy = spyOn(launchApp["targetUserDetector"], "detectTargetUserId");
    const result = await launchApp.execute(packageName, false, false);
    expect(result).toMatchObject({ success: true, userId: 0 });
    expect(
      fakeAdb.wasCommandExecuted(
        `shell am start --user 0 -a android.intent.action.MAIN -c android.intent.category.LAUNCHER '${packageName}'`,
      ),
    ).toBe(true);
    expect(fakeAdb.wasCommandExecuted("shell am start --user 10")).toBe(false);
    expect(detectorSpy).toHaveBeenCalledTimes(1);
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

    // #6868: "make this app foreground" is a goal, not a transition. An app that
    // is already there is the goal satisfied — a success carrying
    // `alreadyForeground: true` plus the observation, never an error a client has
    // to string-match to decide whether to continue.
    expect(result.success).toBe(true);
    expect(result.alreadyForeground).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.observation).toBeDefined();
    expect(fakeObserveScreen.getExecuteCallCount()).toBeGreaterThan(0);
    expect(
      fakeObserveScreen
        .getExecuteOptions()
        .every((options) => options.signal === controller.signal),
    ).toBe(true);
    expect(fakeAwaitIdle.wasMethodCalled("initializeUiStabilityTracking")).toBe(true);
  });

  test("rejects Android launch arguments before invoking device commands", async () => {
    await expect(
      launchApp.execute(packageName, false, false, undefined, undefined, undefined, undefined, [
        "--flag",
      ]),
    ).rejects.toThrow("launchArguments are supported on iOS only");
    expect(fakeAdb.getExecutedCommands()).toHaveLength(0);
  });

  test("checks Android running state through the shared process-state command", async () => {
    fakeAdb.setForegroundApp({ packageName, userId: 0 });
    fakeAdb.setCommandResponse("shell dumpsys activity processes", {
      stdout: "123:com.example.app/u0a123\n",
      stderr: "",
    });

    await launchApp.execute(packageName, false, false);

    expect(fakeAdb.getCommandCalls()).toContainEqual(
      expect.objectContaining({
        command: "shell dumpsys activity processes",
        timeoutMs: 5_000,
        noRetry: true,
      }),
    );
  });

  test("keeps nested launch command spans on an outer ambient tracker", async () => {
    setDebugPerfEnabled(true);
    fakeAdb.setForegroundApp({ packageName, userId: 0 });
    fakeAdb.setCommandResponse("shell dumpsys activity processes", {
      stdout: "123:com.example.app/u0a123\n",
      stderr: "",
    });
    const outer = new DefaultPerformanceTracker(fakeTimer);
    const nestedLaunch = new LaunchApp(device, fakeAdb as unknown as any, null, fakeTimer, {
      targetUserDetector: {
        detectTargetUserId: () => trackAmbient("adb shell cmd user", async () => 0),
      },
      installedAppsProvider: {
        listInstalledApps: async () => ({ apps: [packageName], successful: true }),
      },
      performanceTrackerFactory: () => new DefaultPerformanceTracker(fakeTimer),
    });
    (nestedLaunch as any).awaitIdle = fakeAwaitIdle;
    (nestedLaunch as any).observeScreen = fakeObserveScreen;
    (nestedLaunch as any).window = fakeWindow;

    await runWithPerfTracker(outer, () => nestedLaunch.execute(packageName, false, false));

    expect(outer.getTimings()).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "adb shell cmd user" })]),
    );
  });

  test("gives Android launch exclusive priority over background performance sampling", async () => {
    const events: string[] = [];
    const prioritizedLaunch = new LaunchApp(device, fakeAdb as unknown as any, null, fakeTimer, {
      performanceSamplingCoordinator: {
        async withDeviceSamplingPaused(deviceId, operation) {
          events.push(`pause:${deviceId}`);
          try {
            return await operation();
          } finally {
            events.push(`resume:${deviceId}`);
          }
        },
      },
    });
    (prioritizedLaunch as any).awaitIdle = fakeAwaitIdle;
    (prioritizedLaunch as any).observeScreen = fakeObserveScreen;
    (prioritizedLaunch as any).window = fakeWindow;
    fakeAdb.setForegroundApp({ packageName, userId: 0 });
    fakeAdb.setCommandResponse("shell dumpsys activity processes", {
      stdout: "123:com.example.app/u0a123\n",
      stderr: "",
    });

    await expect(prioritizedLaunch.execute(packageName, false, false)).resolves.toMatchObject({
      success: true,
    });

    expect(events).toEqual(["pause:device-123", "resume:device-123"]);
  });

  function routeProcessChecksThroughClient(exec: () => Promise<ExecResult>) {
    const calls: Parameters<typeof fakeAdb.executeCommand>[] = [];
    const originalExecute = fakeAdb.executeCommand.bind(fakeAdb);
    const spy = spyOn(fakeAdb, "executeCommand").mockImplementation(async (...args) => {
      if (args[0] === "shell dumpsys activity processes") {
        calls.push(args);
        return exec();
      }
      return originalExecute(...args);
    });
    return { calls, spy };
  }

  function processResult(): ExecResult {
    const stdout = "123:com.example.app/u0a123\n";
    return {
      stdout,
      stderr: "",
      toString: () => stdout,
      trim: () => stdout.trim(),
      includes: (search) => stdout.includes(search),
    };
  }

  test("retries a transient Android offline process check", async () => {
    const controller = new AbortController();
    fakeTimer.enableAutoAdvance();
    fakeAdb.setForegroundApp({ packageName, userId: 0 });
    fakeObserveScreen.setObserveResult(createObserveResult(packageName));
    let dispatches = 0;
    const { calls, spy } = routeProcessChecksThroughClient(async () => {
      dispatches += 1;
      if (dispatches === 1) {
        throw new Error("adb: device offline");
      }
      return processResult();
    });

    try {
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
      expect(result.alreadyForeground).toBe(true);
      expect(calls).toEqual([
        ["shell dumpsys activity processes", 5_000, undefined, true, controller.signal],
        ["shell dumpsys activity processes", 5_000, undefined, true, controller.signal],
      ]);
      expect(dispatches).toBe(2);
      expect(fakeTimer.now()).toBe(200);
    } finally {
      spy.mockRestore();
    }
  });

  test("fails fast on a deterministic process-check failure", async () => {
    let dispatches = 0;
    const { calls, spy } = routeProcessChecksThroughClient(async () => {
      dispatches += 1;
      throw new Error("unknown command");
    });

    try {
      await expect(launchApp.execute(packageName, false, false)).rejects.toThrow("unknown command");
      expect(calls).toHaveLength(1);
      expect(dispatches).toBe(1);
      expect(fakeTimer.getPendingTimeoutCount()).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  test("bounds Android offline process recovery", async () => {
    fakeTimer.enableAutoAdvance();
    let dispatches = 0;
    const { calls, spy } = routeProcessChecksThroughClient(async () => {
      dispatches += 1;
      throw new Error("adb: device offline");
    });

    try {
      await expect(launchApp.execute(packageName, false, false)).rejects.toThrow("device offline");
      expect(calls).toHaveLength(2);
      expect(dispatches).toBe(2);
      expect(fakeTimer.now()).toBe(200);
      expect(fakeTimer.getPendingTimeoutCount()).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  test("cancels and cleans up while waiting to retry an offline process check", async () => {
    const controller = new AbortController();
    const deviceLoss = new DeviceLostError(device.deviceId, "device-disconnected:retry-delay");
    let dispatches = 0;
    const { calls, spy } = routeProcessChecksThroughClient(async () => {
      dispatches += 1;
      throw new Error("adb: device offline");
    });

    try {
      const resultPromise = launchApp.execute(
        packageName,
        false,
        false,
        undefined,
        undefined,
        undefined,
        controller.signal,
      );
      for (let i = 0; i < 50 && fakeTimer.getPendingTimeoutCount() === 0; i += 1) {
        await Promise.resolve();
      }
      expect(fakeTimer.getPendingTimeouts()).toEqual([200]);
      controller.abort(deviceLoss);

      await expect(resultPromise).rejects.toBe(deviceLoss);
      expect(calls).toHaveLength(1);
      expect(dispatches).toBe(1);
      expect(fakeTimer.getPendingTimeoutCount()).toBe(0);
      expect(fakeTimer.now()).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  test("prefers an abort reason that arrives with the ADB rejection", async () => {
    const controller = new AbortController();
    const deviceLoss = new DeviceLostError(device.deviceId, "device-disconnected:adb-race");
    const { calls, spy } = routeProcessChecksThroughClient(async () => {
      controller.abort(deviceLoss);
      throw new Error("adb: device offline");
    });

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
      expect(calls).toHaveLength(1);
      expect(fakeTimer.getPendingTimeoutCount()).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  // The already-foreground branch reads the foreground app and THEN observes, so
  // another app (or a system surface) can take over in between. Reconcile that
  // observation through the same validation path a real launch uses instead of
  // asserting `alreadyForeground: true` over a capture of a different app.
  test("re-observes before claiming already-foreground when the first observation shows another app", async () => {
    fakeTimer.enableAutoAdvance();
    fakeAdb.setForegroundApp({ packageName, userId: 0 });
    fakeAdb.setCommandResponse("shell dumpsys activity processes", {
      stdout: "123:com.example.app/u0a123\n",
      stderr: "",
    });
    fakeObserveScreen.setObserveResult((index) =>
      createObserveResult(index === 0 ? "com.example.other" : packageName),
    );

    const result = await launchApp.execute(packageName, false, false);

    expect(result.success).toBe(true);
    expect(result.alreadyForeground).toBe(true);
    expect(result.observation?.activeWindow?.appId).toBe(packageName);
    expect(fakeObserveScreen.getExecuteCallCount()).toBeGreaterThan(1);
  });

  test("does not report already-foreground over an observation that never shows the app", async () => {
    fakeTimer.enableAutoAdvance();
    const otherPackageName = "com.example.other";
    fakeAdb.setForegroundApp({ packageName, userId: 0 });
    fakeAdb.setCommandResponse("shell dumpsys activity processes", {
      stdout: "123:com.example.app/u0a123\n",
      stderr: "",
    });
    fakeObserveScreen.setObserveResult(() => createObserveResult(otherPackageName));

    const result = await launchApp.execute(packageName, false, false);

    expect(result.success).toBe(false);
    expect(result.error).toContain(
      `Timed out waiting for launch observation to show ${packageName}`,
    );
    expect(result.observation).toBeUndefined();
    expect(result.observationOmitted?.reason).toBe("stale_launch_observation");
  });

  test("accepts a helper-package activity in a task rooted at the launched app", async () => {
    fakeTimer.enableAutoAdvance();
    const settingsPackageName = "com.android.settings";
    const helperPackageName = "com.google.android.settings.intelligence";
    const helperObservation = createObserveResult(helperPackageName, {
      depth: 1,
      activities: [],
      currentTaskId: 8,
      tasks: [
        {
          id: 8,
          userId: 0,
          packageName: settingsPackageName,
          rootActivity: `${settingsPackageName}/.Settings`,
          topActivity: `${helperPackageName}/.modules.search.SearchActivity`,
        },
      ],
    });

    fakeAdb.setForegroundApp({ packageName: settingsPackageName, userId: 0 });
    fakeAdb.setCommandResponse("shell pm list packages --user 0", {
      stdout: `package:${settingsPackageName}\n`,
      stderr: "",
    });
    fakeAdb.setCommandResponse("shell dumpsys activity processes", { stdout: "0\n", stderr: "" });
    fakeObserveScreen.setObserveResult(helperObservation);

    const result = await launchApp.execute(settingsPackageName, false, false);

    expect(result.success).toBe(true);
    expect(result.foregroundActivityPackage).toBe(helperPackageName);
    expect(result.verifiedBy).toBe("task-root");
    expect(result.observation).toBeDefined();
    expect(result.observation?.backStack).toEqual(helperObservation.backStack);
  });

  test("rejects a matching task root from another Android user", async () => {
    const helperPackage = "com.example.helper";
    const observation = createObserveResult(helperPackage, {
      depth: 1,
      activities: [],
      currentTaskId: 8,
      tasks: [{ id: 8, userId: 10, packageName, rootActivity: `${packageName}/.MainActivity` }],
    });
    const result = await (launchApp as any).ensureLaunchObservationMatchesPackage(
      { success: true, packageName, observation },
      packageName,
      0,
      1,
      undefined,
      false,
      0,
    );

    expect(result.success).toBe(false);
    expect(result.verifiedBy).toBeUndefined();
    expect(result.observation).toBeUndefined();
  });

  test("settles a matching task root when the task user id is unknown", async () => {
    const helperPackage = "com.example.helper";
    const observation = createObserveResult(helperPackage, {
      depth: 1,
      activities: [],
      currentTaskId: 8,
      tasks: [{ id: 8, packageName, rootActivity: `${packageName}/.MainActivity` }],
    });
    const result = await (launchApp as any).ensureLaunchObservationMatchesPackage(
      { success: true, packageName, observation },
      packageName,
      0,
      1,
      undefined,
      false,
      0,
    );

    expect(result.success).toBe(true);
    expect(result.verifiedBy).toBe("task-root");
    expect(result.observation?.backStack).toEqual(observation.backStack);
  });

  test("does not verify another user's task during an Android launch", async () => {
    fakeTimer.enableAutoAdvance();
    const helperPackage = "com.example.helper";
    fakeAdb.setForegroundApp({ packageName, userId: 0 });
    fakeObserveScreen.setObserveResult(
      createObserveResult(helperPackage, {
        depth: 1,
        activities: [],
        currentTaskId: 8,
        tasks: [{ id: 8, userId: 10, packageName, rootActivity: `${packageName}/.MainActivity` }],
      }),
    );

    const result = await launchApp.execute(packageName, false, false, undefined, 0);

    expect(result.success).toBe(false);
    expect(result.verifiedBy).toBeUndefined();
    expect(result.observation).toBeUndefined();
  });

  test("rejects another user's companion task provenance", async () => {
    const helperPackage = "com.example.helper";
    const observation = createObserveResult(helperPackage, {
      depth: 0,
      activities: [],
      currentTaskId: 8,
      tasks: [{ id: 8, userId: 10, packageName: helperPackage, launchedFromPackage: packageName }],
    });

    const result = await (launchApp as any).ensureLaunchObservationMatchesPackage(
      { success: true, packageName, observation },
      packageName,
      0,
      1,
      undefined,
      false,
      0,
    );

    expect(result.success).toBe(false);
    expect(result.verifiedBy).toBeUndefined();
  });

  test("does not give a failed launch task-root leniency", async () => {
    const helperPackage = "com.example.helper";
    const observation = createObserveResult(helperPackage, {
      depth: 1,
      activities: [],
      currentTaskId: 8,
      tasks: [{ id: 8, userId: 0, packageName, rootActivity: `${packageName}/.MainActivity` }],
    });

    const result = await (launchApp as any).ensureLaunchObservationMatchesPackage(
      { success: false, packageName, observation },
      packageName,
      1000,
      100,
      undefined,
      false,
      0,
    );

    expect(result.verifiedBy).toBeUndefined();
    expect(result.observation).toBeUndefined();
    expect(fakeTimer.getSleepHistory()).toEqual([]);
  });

  test("settles an existing task-root observation without another poll", async () => {
    const helperPackage = "com.example.helper";
    const observation = createObserveResult(helperPackage, {
      depth: 1,
      activities: [],
      currentTaskId: 8,
      tasks: [{ id: 8, userId: 0, packageName, rootActivity: `${packageName}/.MainActivity` }],
    });
    fakeTimer.enableAutoAdvance();
    fakeObserveScreen.setObserveResult(observation);

    const result = await (launchApp as any).ensureLaunchObservationMatchesPackage(
      { success: true, packageName, observation },
      packageName,
      1000,
      100,
      undefined,
      false,
      0,
    );

    expect(result.verifiedBy).toBe("task-root");
    expect(fakeTimer.getSleepHistory()).toEqual([]);
    expect(fakeObserveScreen.getCallCount("execute")).toBe(0);
  });

  test("polls and omits a non-settleable initial observation", async () => {
    const observation = createObserveResult("com.example.other");
    fakeTimer.enableAutoAdvance();
    fakeObserveScreen.setObserveResult(observation);

    const result = await (launchApp as any).ensureLaunchObservationMatchesPackage(
      { success: true, packageName, observation },
      packageName,
      1,
      1,
      undefined,
      false,
      0,
    );

    expect(fakeTimer.getSleepHistory()).toEqual([1]);
    expect(fakeObserveScreen.getCallCount("execute")).toBe(1);
    expect(result.success).toBe(false);
    expect(result.observationOmitted?.reason).toBe("stale_launch_observation");
  });

  test("accepts a companion task launched by the app", async () => {
    fakeTimer.enableAutoAdvance();
    const settingsPackageName = "com.android.settings";
    const companionPackageName = "com.google.android.settings.intelligence";
    const companionObservation = createObserveResult(companionPackageName, {
      depth: 0,
      activities: [],
      currentTaskId: 44,
      tasks: [
        {
          id: 44,
          userId: 0,
          packageName: companionPackageName,
          rootActivity: `${companionPackageName}/.modules.search.SearchActivity`,
          topActivity: `${companionPackageName}/.modules.search.SearchActivity`,
          launchedFromPackage: settingsPackageName,
        },
      ],
    });

    fakeAdb.setForegroundApp({ packageName: companionPackageName, userId: 0 });
    fakeAdb.setCommandResponse("android.intent.category.LAUNCHER", {
      stdout: "Starting: Intent",
      stderr: "",
    });
    fakeAdb.setCommandResponse("shell pm list packages --user 0", {
      stdout: `package:${settingsPackageName}\n`,
      stderr: "",
    });
    fakeAdb.setCommandResponse("shell dumpsys activity processes", { stdout: "0\n", stderr: "" });
    fakeObserveScreen.setObserveResult(companionObservation);

    const result = await launchApp.execute(settingsPackageName, false, false);

    expect(result.success).toBe(true);
    expect(result.verifiedBy).toBe("task-provenance");
    expect(result.foregroundActivityPackage).toBe(companionPackageName);
    expect(result.observation?.backStack).toEqual(companionObservation.backStack);
  });

  test("rejects a companion task launched by another package", async () => {
    fakeTimer.enableAutoAdvance();
    const settingsPackageName = "com.android.settings";
    const companionPackageName = "com.google.android.settings.intelligence";
    const companionObservation = createObserveResult(companionPackageName, {
      depth: 0,
      activities: [],
      currentTaskId: 44,
      tasks: [
        {
          id: 44,
          packageName: companionPackageName,
          rootActivity: `${companionPackageName}/.modules.search.SearchActivity`,
          launchedFromPackage: "com.google.android.apps.nexuslauncher",
        },
      ],
    });

    fakeAdb.setForegroundApp({ packageName: settingsPackageName, userId: 0 });
    fakeAdb.setCommandResponse("shell pm list packages --user 0", {
      stdout: `package:${settingsPackageName}\n`,
      stderr: "",
    });
    fakeAdb.setCommandResponse("shell dumpsys activity processes", { stdout: "0\n", stderr: "" });
    fakeObserveScreen.setObserveResult(companionObservation);

    const result = await launchApp.execute(settingsPackageName, false, false);

    expect(result.success).toBe(false);
    expect(result.verifiedBy).toBeUndefined();
    expect(result.foregroundActivityPackage).toBeUndefined();
  });

  test("does not accept a SystemUI overlay over a companion task launched by the app", async () => {
    fakeTimer.enableAutoAdvance();
    const settingsPackageName = "com.android.settings";
    const companionPackageName = "com.google.android.settings.intelligence";
    const overlayObservation = {
      ...createObserveResult(companionPackageName, {
        depth: 0,
        activities: [],
        currentTaskId: 44,
        tasks: [
          {
            id: 44,
            packageName: companionPackageName,
            rootActivity: `${companionPackageName}/.modules.search.SearchActivity`,
            launchedFromPackage: settingsPackageName,
          },
        ],
      }),
      activeWindow: {
        appId: "com.android.systemui",
        activityName: "NotificationShade",
        layoutSeqSum: 1,
        systemOverlay: true,
      },
    };

    fakeAdb.setForegroundApp({ packageName: settingsPackageName, userId: 0 });
    fakeAdb.setCommandResponse("shell pm list packages --user 0", {
      stdout: `package:${settingsPackageName}\n`,
      stderr: "",
    });
    fakeAdb.setCommandResponse("shell dumpsys activity processes", { stdout: "0\n", stderr: "" });
    fakeObserveScreen.setObserveResult(() => overlayObservation);

    const result = await launchApp.execute(settingsPackageName, false, false);

    expect(result.success).toBe(false);
    expect(result.verifiedBy).toBeUndefined();
    expect(result.foregroundActivityPackage).toBeUndefined();
  });

  test("does not accept a SystemUI overlay over a task rooted at the launched app", async () => {
    fakeTimer.enableAutoAdvance();
    const settingsPackageName = "com.android.settings";
    const helperPackageName = "com.google.android.settings.intelligence";
    const overlayObservation = {
      ...createObserveResult(helperPackageName, {
        depth: 1,
        activities: [],
        currentTaskId: 8,
        tasks: [
          {
            id: 8,
            packageName: settingsPackageName,
            rootActivity: `${settingsPackageName}/.Settings`,
            topActivity: `${helperPackageName}/.modules.search.SearchActivity`,
          },
        ],
      }),
      activeWindow: {
        appId: "com.android.systemui",
        activityName: "NotificationShade",
        layoutSeqSum: 1,
        systemOverlay: true,
      },
    };

    fakeAdb.setForegroundApp({ packageName: settingsPackageName, userId: 0 });
    fakeAdb.setCommandResponse("shell pm list packages --user 0", {
      stdout: `package:${settingsPackageName}\n`,
      stderr: "",
    });
    fakeAdb.setCommandResponse("shell dumpsys activity processes", { stdout: "0\n", stderr: "" });
    fakeObserveScreen.setObserveResult(() => overlayObservation);

    const result = await launchApp.execute(settingsPackageName, false, false);

    expect(result.success).toBe(false);
    expect(result.error).toContain(
      `Timed out waiting for launch observation to show ${settingsPackageName}`,
    );
    expect(result.verifiedBy).toBeUndefined();
    expect(result.foregroundActivityPackage).toBeUndefined();
    expect(fakeObserveScreen.getExecuteCallCount()).toBeGreaterThan(1);
  });

  test("collapses a notification shade covering the launched Android app", async () => {
    fakeTimer.enableAutoAdvance();
    const controller = new AbortController();
    const gfxMetrics = { p50Ms: 17 };
    const perfTiming = [{ phase: "launch", durationMs: 42 }];
    const notificationShadeObservation = {
      ...createObserveResult(),
      gfxMetrics,
      perfTiming,
      activeWindow: {
        appId: "com.android.systemui",
        activityName: "NotificationShade",
        layoutSeqSum: 1,
        systemOverlay: true,
      },
    };
    const observations = [notificationShadeObservation, createObserveResult(packageName)];

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
    expect(result.observation?.gfxMetrics).toEqual(gfxMetrics);
    expect(result.observation?.perfTiming).toEqual(perfTiming);
    expect(
      fakeAdb.getExecutedCommands().filter((command) => command === "shell cmd statusbar collapse"),
    ).toHaveLength(1);
    expect(
      fakeAdb.getCommandCalls().find((call) => call.command === "shell cmd statusbar collapse")
        ?.signal,
    ).toBe(controller.signal);
  });

  test("collapses a notification shade that appears during Android launch observation", async () => {
    fakeTimer.enableAutoAdvance();
    const notificationShadeObservation = {
      ...createObserveResult(),
      activeWindow: {
        appId: "com.android.systemui",
        activityName: "NotificationShade",
        layoutSeqSum: 1,
        systemOverlay: true,
      },
    };
    let observationCount = 0;

    fakeAdb.setForegroundApp({ packageName, userId: 0 });
    fakeAdb.setCommandResponse("shell dumpsys activity processes", { stdout: "0\n", stderr: "" });
    fakeObserveScreen.setObserveResult(() => {
      observationCount += 1;
      if (observationCount === 1) {
        return createObserveResult("com.example.previous");
      }
      return fakeAdb.getExecutedCommands().includes("shell cmd statusbar collapse")
        ? createObserveResult(packageName)
        : notificationShadeObservation;
    });

    const result = await launchApp.execute(packageName, false, false);

    expect(result.success).toBe(true);
    expect(result.observation?.activeWindow?.appId).toBe(packageName);
    expect(observationCount).toBeGreaterThan(2);
    expect(fakeAdb.getExecutedCommands()).toContain("shell cmd statusbar collapse");
  });

  test("rate limits shade collapse attempts through the Android launch timeout", async () => {
    fakeTimer.enableAutoAdvance();
    const notificationShadeObservation = {
      ...createObserveResult(),
      activeWindow: {
        appId: "com.android.systemui",
        activityName: "NotificationShade",
        layoutSeqSum: 1,
        systemOverlay: true,
      },
    };

    fakeAdb.setForegroundApp({ packageName, userId: 0 });
    fakeAdb.setCommandResponse("shell dumpsys activity processes", { stdout: "0\n", stderr: "" });
    fakeObserveScreen.setObserveResult(() => notificationShadeObservation);

    const result = await launchApp.execute(packageName, false, true);
    const collapseCount = fakeAdb
      .getExecutedCommands()
      .filter((command) => command === "shell cmd statusbar collapse").length;

    expect(result.success).toBe(false);
    expect(result.error).toContain("notification shade");
    expect(fakeTimer.now()).toBeGreaterThanOrEqual(15_000);
    expect(collapseCount).toBeGreaterThan(1);
    expect(collapseCount).toBeLessThan(20);
  });

  test("reports a notification shade blocker after cold boot launch verification times out", async () => {
    fakeTimer.enableAutoAdvance();
    const notificationShadeObservation = {
      ...createObserveResult(),
      activeWindow: {
        appId: "com.android.systemui",
        activityName: "NotificationShade",
        layoutSeqSum: 1,
        systemOverlay: true,
      },
    };

    fakeAdb.setForegroundApp({ packageName, userId: 0 });
    fakeAdb.setCommandResponse("shell dumpsys activity processes", { stdout: "0\n", stderr: "" });
    fakeObserveScreen.setObserveResult(() => notificationShadeObservation);

    const result = await launchApp.execute(packageName, false, true);

    expect(result.success).toBe(false);
    expect(result.error).toContain("notification shade");
    expect(result.error).not.toContain("coldBoot: true");
  });

  test("reports a locked device instead of blaming the notification shade", async () => {
    fakeTimer.enableAutoAdvance();
    const keyguardObservation = {
      ...createObserveResult(),
      activeWindow: {
        appId: "com.android.systemui",
        activityName: "Keyguard",
        layoutSeqSum: 1,
        systemOverlay: true,
      },
      deviceLock: { locked: true, keyguardShowing: true, secure: true },
    };

    fakeAdb.setForegroundApp({ packageName, userId: 0 });
    fakeAdb.setCommandResponse("shell dumpsys activity processes", { stdout: "0\n", stderr: "" });
    fakeObserveScreen.setObserveResult(() => keyguardObservation);

    const result = await launchApp.execute(packageName, false, true);

    expect(result.success).toBe(false);
    expect(result.error).toContain("device is locked");
    expect(result.error).toContain("wakeAndUnlock");
    expect(result.error).not.toContain("notification shade");
  });

  test("reports the actual foreground blocker after cold boot launch verification times out", async () => {
    fakeTimer.enableAutoAdvance();
    const otherPackageName = "com.example.other";

    fakeAdb.setForegroundApp({ packageName, userId: 0 });
    fakeAdb.setCommandResponse("shell dumpsys activity processes", { stdout: "0\n", stderr: "" });
    fakeObserveScreen.setObserveResult(() => createObserveResult(otherPackageName));

    const result = await launchApp.execute(packageName, false, true);

    expect(result.success).toBe(false);
    expect(result.error).toContain(otherPackageName);
    expect(result.error).toContain(packageName);
    expect(result.error).not.toContain("notification shade");
    expect(result.error).not.toContain("coldBoot: true");
  });

  test("waits for a fresh observation before accepting a rooted helper task", async () => {
    fakeTimer.enableAutoAdvance();
    const settingsPackageName = "com.android.settings";
    const helperPackageName = "com.google.android.settings.intelligence";
    const backStack: BackStackInfo = {
      depth: 1,
      activities: [],
      currentTaskId: 8,
      tasks: [
        {
          id: 8,
          userId: 0,
          packageName: settingsPackageName,
          rootActivity: `${settingsPackageName}/.Settings`,
          topActivity: `${helperPackageName}/.modules.search.SearchActivity`,
        },
      ],
    };
    const unverifiedObservation = {
      ...createObserveResult(helperPackageName, backStack),
      freshness: {
        isFresh: false,
        verified: false,
        warning: "Accessibility service is reconnecting after a transient ADB reset",
      },
    };

    fakeAdb.setForegroundApp({ packageName: settingsPackageName, userId: 0 });
    fakeAdb.setCommandResponse("shell pm list packages --user 0", {
      stdout: `package:${settingsPackageName}\n`,
      stderr: "",
    });
    fakeAdb.setCommandResponse("shell dumpsys activity processes", { stdout: "0\n", stderr: "" });
    fakeObserveScreen.setObserveResult(() =>
      fakeTimer.now() < 10_500
        ? unverifiedObservation
        : createObserveResult(helperPackageName, backStack),
    );

    const result = await launchApp.execute(settingsPackageName, false, false);

    expect(result.success).toBe(true);
    expect(result.verifiedBy).toBe("task-root");
    expect(result.foregroundActivityPackage).toBe(helperPackageName);
    expect(result.observation?.freshness?.verified).not.toBe(false);
    expect(fakeTimer.now()).toBeGreaterThanOrEqual(10_500);
  });

  test("rejects a foreground task rooted at a different package with recovery guidance", async () => {
    fakeTimer.enableAutoAdvance();
    const otherPackageName = "com.example.other";
    const otherTaskObservation = createObserveResult(otherPackageName, {
      depth: 1,
      activities: [],
      currentTaskId: 9,
      tasks: [
        {
          id: 9,
          packageName: otherPackageName,
          rootActivity: `${otherPackageName}/.MainActivity`,
        },
      ],
    });

    fakeAdb.setForegroundApp({ packageName, userId: 0 });
    fakeAdb.setCommandResponse("shell dumpsys activity processes", {
      stdout: "123:com.example.app/u0a123\n",
      stderr: "",
    });
    fakeObserveScreen.setObserveResult(otherTaskObservation);

    const result = await launchApp.execute(packageName, false, false);

    expect(result.success).toBe(false);
    expect(result.error).toContain(otherPackageName);
    expect(result.error).toContain("coldBoot: true");
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
    expect(result.alreadyForeground).toBe(true);
    expect(result.error).toBeUndefined();
    expect(fakeAdb.wasCommandExecuted("shell dumpsys activity processes")).toBe(true);
  });

  test("keeps sampling paused until cancelled Android preflight work settles", async () => {
    const controller = new AbortController();
    const deviceLoss = new DeviceLostError(
      device.deviceId,
      `device-disconnected:${device.deviceId}`,
    );
    const installedApps = Promise.withResolvers<{ apps: string[]; successful: boolean }>();
    const events: string[] = [];
    const receivedSignals: AbortSignal[] = [];
    const cancellableLaunch = new LaunchApp(device, fakeAdb as unknown as any, null, fakeTimer, {
      targetUserDetector: {
        async detectTargetUserId(_packageName, _userId, signal) {
          if (signal) {
            receivedSignals.push(signal);
          }
          controller.abort(deviceLoss);
          return 0;
        },
      },
      installedAppsProvider: {
        async listInstalledApps(signal) {
          if (signal) {
            receivedSignals.push(signal);
          }
          return await installedApps.promise;
        },
      },
      performanceSamplingCoordinator: {
        async withDeviceSamplingPaused(_deviceId, operation) {
          events.push("paused");
          try {
            return await operation();
          } finally {
            events.push("resumed");
          }
        },
      },
    });
    (cancellableLaunch as any).awaitIdle = fakeAwaitIdle;
    (cancellableLaunch as any).observeScreen = fakeObserveScreen;
    (cancellableLaunch as any).window = fakeWindow;

    const result = cancellableLaunch.execute(
      packageName,
      false,
      false,
      undefined,
      undefined,
      undefined,
      controller.signal,
    );
    for (let attempt = 0; attempt < 10 && receivedSignals.length < 2; attempt++) {
      await Promise.resolve();
    }

    expect(receivedSignals).toEqual([controller.signal, controller.signal]);
    expect(events).toEqual(["paused"]);

    installedApps.resolve({ apps: [], successful: true });
    await expect(result).rejects.toBe(deviceLoss);
    expect(events).toEqual(["paused", "resumed"]);
    expect(hasStartedAppLaunch()).toBe(false);
  });

  test("bounds sampling pause when cancelled Android preflight ignores abort", async () => {
    const controller = new AbortController();
    const deviceLoss = new DeviceLostError(
      device.deviceId,
      `device-disconnected:${device.deviceId}`,
    );
    const events: string[] = [];
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
      performanceSamplingCoordinator: {
        async withDeviceSamplingPaused(_deviceId, operation) {
          events.push("paused");
          try {
            return await operation();
          } finally {
            events.push("resumed");
          }
        },
      },
    });

    const result = cancellableLaunch.execute(
      packageName,
      false,
      false,
      undefined,
      undefined,
      undefined,
      controller.signal,
    );
    for (let attempt = 0; attempt < 20 && fakeTimer.getPendingTimeoutCount() === 0; attempt++) {
      await Promise.resolve();
    }

    expect(fakeTimer.getPendingTimeouts()).toEqual([1_000]);
    expect(events).toEqual(["paused"]);

    fakeTimer.advanceTime(1_000);
    await expect(result).rejects.toBe(deviceLoss);
    expect(events).toEqual(["paused", "resumed"]);
    expect(fakeTimer.getPendingTimeoutCount()).toBe(0);
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
      expect(fakeAdb.wasCommandExecuted(`shell monkey -p '${packageName}'`)).toBe(false);
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
    fakeAdb.setCommandError(`shell monkey -p '${packageName}'`, new Error("monkey unavailable"));
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

  test("discovery queries first, skips package look-alikes and stops after the first literal result", async () => {
    fakeTimer.enableAutoAdvance();
    const controller = new AbortController();
    const perf = new DefaultPerformanceTracker(fakeTimer);
    const trackSpy = spyOn(perf, "track");
    const executeSpy = spyOn(fakeAdb, "executeCommand");
    const discoveryLaunch = new LaunchApp(device, fakeAdb, null, fakeTimer, {
      performanceTrackerFactory: () => perf,
    });
    discoveryLaunch.awaitIdle = fakeAwaitIdle;
    discoveryLaunch.observeScreen = fakeObserveScreen;
    discoveryLaunch.window = fakeWindow;
    const getInstanceSpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockImplementation(() => {
      throw new Error("CtrlProxy unavailable in this fake-only test");
    });
    fakeAdb.setCommandResponse(
      `shell am start --user 0 -a android.intent.action.MAIN -c android.intent.category.LAUNCHER '${packageName}'`,
      { stdout: "Error: no launcher activity", stderr: "" },
    );
    fakeAdb.setCommandResponse(`shell monkey -p '${packageName}'`, {
      stdout: "No activities found to run, monkey aborted",
      stderr: "",
    });
    const firstCommand = `shell cmd package query-activities --brief --user 0 -a android.intent.action.MAIN -c android.intent.category.LAUNCHER | grep '${packageName}'`;
    // Minimal input-shape probes, not claimed device captures.
    fakeAdb.setCommandResponse(firstCommand, {
      stdout: `comXexampleXapp/.Main ${packageName}/.Discovered`,
      stderr: "",
    });

    try {
      const result = await discoveryLaunch.execute(
        packageName,
        false,
        false,
        undefined,
        undefined,
        undefined,
        controller.signal,
      );
      expect(result).toMatchObject({ success: true, activityName: ".Discovered" });
      expect(
        fakeAdb
          .getExecutedCommands()
          .filter((command) => command.includes("pm dump") || command.includes("query-activities")),
      ).toEqual([firstCommand]);
      expect(executeSpy).toHaveBeenCalledWith(
        firstCommand,
        undefined,
        undefined,
        undefined,
        controller.signal,
      );
      const discoveryLabels = trackSpy.mock.calls
        .map(([label]) => label)
        .filter((label) => label.startsWith("activity") || label === "a11yLaunchIntent");
      expect(discoveryLabels).toEqual(["activityApproach_1"]);
    } finally {
      getInstanceSpy.mockRestore();
      executeSpy.mockRestore();
      trackSpy.mockRestore();
    }
  });

  test("warns with the underlying iOS hierarchy sync error and continues", async () => {
    const client = {
      async getLatestHierarchy() {
        return null;
      },
      async requestHierarchySync() {
        throw new Error("hierarchy socket closed");
      },
    };
    const getInstanceSpy = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue(
      client as unknown as IOSCtrlProxyClient,
    );
    const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
    const iosLaunchApp = new LaunchApp({ ...device, platform: "ios" }, fakeAdb, null, fakeTimer);
    try {
      await (
        iosLaunchApp as unknown as {
          waitForIosHierarchyReady(timeoutMs: number): Promise<void>;
        }
      ).waitForIosHierarchyReady(5000);
      expect(warnSpy).toHaveBeenCalledWith(
        "[LaunchApp] iOS hierarchy sync failed: hierarchy socket closed",
      );
    } finally {
      warnSpy.mockRestore();
      getInstanceSpy.mockRestore();
    }
  });

  test("resolves iOS hierarchy readiness via sync and unsubscribes the losing push", async () => {
    const iosDevice: BootedDevice = {
      name: "test-ios-device",
      platform: "ios",
      deviceId: "11111111-1111-1111-1111-111111111111",
    };
    let unsubscribeCount = 0;
    const client = {
      async getLatestHierarchy() {
        return null;
      },
      onPushUpdate() {
        return () => {
          unsubscribeCount++;
        };
      },
      async requestHierarchySync() {
        return { hierarchy: { packageName } };
      },
    };
    const getInstanceSpy = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue(
      client as unknown as IOSCtrlProxyClient,
    );
    const info = spyOn(logger, "info");
    const iosLaunchApp = new LaunchApp(iosDevice, fakeAdb, null, fakeTimer);
    try {
      await (
        iosLaunchApp as unknown as {
          waitForIosHierarchyReady(timeoutMs: number, expectedPackageName: string): Promise<void>;
        }
      ).waitForIosHierarchyReady(5_000, packageName);
      expect(info).toHaveBeenCalledWith(expect.stringContaining("iOS hierarchy ready via sync"));
      expect(unsubscribeCount).toBe(1);
      expect(fakeTimer.getPendingTimeoutCount()).toBe(0);
    } finally {
      info.mockRestore();
      getInstanceSpy.mockRestore();
    }
  });

  test.each(["device loss", "default abort"])(
    "aborts and unsubscribes during an iOS hierarchy race (%s)",
    async (reason) => {
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
      const iosLaunchApp = new LaunchApp(iosDevice, fakeAdb, null, fakeTimer);

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
        controller.abort(reason === "device loss" ? deviceLoss : undefined);

        await expect(wait).rejects.toBe(controller.signal.reason);
        expect(unsubscribeCount).toBe(1);
        expect(fakeTimer.getPendingTimeoutCount()).toBe(0);
      } finally {
        getInstanceSpy.mockRestore();
      }
    },
  );

  test("keeps waiting for an iOS push when the first sync still reports the previous app", async () => {
    const iosDevice: BootedDevice = {
      name: "test-ios-device",
      platform: "ios",
      deviceId: "11111111-1111-1111-1111-111111111111",
    };
    let pushUpdate: ((hierarchy: { packageName?: string }) => void) | undefined;
    let unsubscribeCount = 0;
    const client = {
      async getLatestHierarchy() {
        return null;
      },
      onPushUpdate(callback: (hierarchy: { packageName?: string }) => void) {
        pushUpdate = callback;
        return () => {
          unsubscribeCount += 1;
        };
      },
      async requestHierarchySync() {
        return { hierarchy: { packageName: "com.apple.springboard" } };
      },
    };
    const getInstanceSpy = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue(
      client as unknown as IOSCtrlProxyClient,
    );
    const iosLaunchApp = new LaunchApp(iosDevice, fakeAdb, null, fakeTimer);
    const info = spyOn(logger, "info");

    try {
      let settled = false;
      const wait = (
        iosLaunchApp as unknown as {
          waitForIosHierarchyReady(timeoutMs: number, expectedPackageName: string): Promise<void>;
        }
      ).waitForIosHierarchyReady(60_000, packageName);
      void wait.then(() => {
        settled = true;
      });
      await Promise.resolve();
      await Promise.resolve();

      expect(settled).toBe(false);
      expect(fakeTimer.getPendingTimeoutCount()).toBe(1);

      pushUpdate?.({ packageName });
      await wait;
      expect(info).toHaveBeenCalledWith(expect.stringContaining("iOS hierarchy ready via push"));

      expect(unsubscribeCount).toBe(1);
      expect(fakeTimer.getPendingTimeoutCount()).toBe(0);
    } finally {
      info.mockRestore();
      getInstanceSpy.mockRestore();
    }
  });

  test("launches an Android app whose launcher activity is not MainActivity with the package resolver", async () => {
    fakeTimer.enableAutoAdvance();
    const settingsPackageName = "com.android.settings";
    const resolverCommand = `shell am start --user 0 -a android.intent.action.MAIN -c android.intent.category.LAUNCHER '${settingsPackageName}'`;

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
    expect(fakeAdb.wasCommandExecuted(`shell monkey -p '${settingsPackageName}'`)).toBe(false);
  });

  const performFallbackLaunch = (launchPackage = packageName, userId = 0) =>
    (
      launchApp as unknown as {
        performLaunch(
          packageName: string,
          activityName: undefined,
          userId: number,
          perf: DefaultPerformanceTracker,
          signal?: AbortSignal,
        ): Promise<{ success: boolean; activityName?: string }>;
      }
    ).performLaunch(launchPackage, undefined, userId, new DefaultPerformanceTracker(fakeTimer));

  test("warns with the intent launch exception before continuing to monkey", async () => {
    fakeAdb.setCommandError(
      "shell am start --user 0 -a android.intent.action.MAIN",
      new Error("intent dispatch failed"),
    );
    const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const result = await performFallbackLaunch();
      expect(result).toMatchObject({ success: true, activityName: "monkey_launch" });
      expect(warnSpy).toHaveBeenCalledWith(
        "[LaunchApp] Intent launch failed: intent dispatch failed, falling back to monkey",
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("warns with the monkey launch exception before continuing to activity discovery", async () => {
    fakeAdb.setCommandResponse("shell am start --user 0 -a android.intent.action.MAIN", {
      stdout: "Error: no launcher activity",
      stderr: "",
    });
    fakeAdb.setCommandError("shell monkey", new Error("monkey dispatch failed"));
    const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const result = await performFallbackLaunch();
      expect(result.success).toBe(true);
      expect(warnSpy).toHaveBeenCalledWith(
        "[LaunchApp] Monkey launch failed: monkey dispatch failed, falling back to activity discovery",
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  describe("ADB launcher fallback contract", () => {
    let ctrlProxySpy: ReturnType<typeof spyOn<typeof AndroidCtrlProxyClient, "getInstance">>;
    const playgroundPackage = "dev.jasonpearson.automobile.playground";
    const playground = readFileSync(
      new URL(
        "../../fixtures/android-launcher/dumpsys-package-playground-launcher.txt",
        import.meta.url,
      ),
      "utf8",
    );
    const egg = readFileSync(
      new URL(
        "../../fixtures/android-launcher/dumpsys-package-egg-no-launcher.txt",
        import.meta.url,
      ),
      "utf8",
    );

    beforeEach(() => {
      ctrlProxySpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockImplementation(() => {
        throw new Error("CtrlProxy unavailable in this fake-only test");
      });
      fakeAdb.setCommandResponse("shell am start", {
        stdout: "Error: no launcher activity",
        stderr: "",
      });
    });

    afterEach(() => ctrlProxySpy.mockRestore());

    test("monkey argv selects LAUNCHER without an unsupported user option", async () => {
      const result = await performFallbackLaunch();
      expect(result.activityName).toBe("monkey_launch");
      expect(
        fakeAdb.getExecutedCommands().filter((command) => command.startsWith("shell monkey")),
      ).toEqual([`shell monkey -p '${packageName}' -c android.intent.category.LAUNCHER 1`]);
    });

    test("monkey is skipped for a nonzero user and discovery still runs", async () => {
      const resultPromise = performFallbackLaunch(packageName, 10);
      await expect(resultPromise).rejects.toBeInstanceOf(ActionableError);
      expect(
        fakeAdb.getExecutedCommands().some((command) => command.startsWith("shell monkey")),
      ).toBe(false);
      expect(
        fakeAdb.getExecutedCommands().some((command) => command.includes("query-activities")),
      ).toBe(true);
    });

    test("first discovery probe has MAIN LAUNCHER and the target user before pm dump", async () => {
      fakeAdb.setCommandError("shell monkey", new Error("monkey unavailable in fake"));
      await expect(performFallbackLaunch(packageName, 10)).rejects.toBeInstanceOf(ActionableError);
      const probes = fakeAdb
        .getExecutedCommands()
        .filter(
          (command) =>
            command.includes("query-activities") ||
            command.includes("pm dump") ||
            command.includes("pm list packages -f"),
        );
      expect(probes[0]).toBe(
        `shell cmd package query-activities --brief --user 10 -a android.intent.action.MAIN -c android.intent.category.LAUNCHER | grep '${packageName}'`,
      );
      expect(probes).toHaveLength(2);
    });

    test("pm dump is a full un-grepped last resort", async () => {
      fakeAdb.setCommandError("shell monkey", new Error("monkey unavailable in fake"));
      await expect(performFallbackLaunch()).rejects.toBeInstanceOf(ActionableError);
      expect(
        fakeAdb.getExecutedCommands().filter((command) => command.includes("pm dump")),
      ).toEqual([`shell pm dump '${packageName}'`]);
    });

    test("real playground dump launches its relative launcher component", async () => {
      fakeAdb.setCommandError("shell monkey", new Error("monkey unavailable in fake"));
      fakeAdb.setCommandResponse(`shell pm dump '${playgroundPackage}'`, {
        stdout: playground,
        stderr: "",
      });
      const result = await performFallbackLaunch(playgroundPackage);
      expect(result.activityName).toBe(".MainActivity");
      expect(
        fakeAdb
          .getExecutedCommands()
          .filter((command) => command.includes("query-activities") || command.includes("pm dump")),
      ).toEqual([
        `shell cmd package query-activities --brief --user 0 -a android.intent.action.MAIN -c android.intent.category.LAUNCHER | grep '${playgroundPackage}'`,
        `shell pm dump '${playgroundPackage}'`,
      ]);
      expect(fakeAdb.getExecutedCommands()).toContain(
        `shell am start --user 0 -n '${playgroundPackage}/.MainActivity'`,
      );
    });

    test("real egg dump reaches the typed final launcher failure", async () => {
      fakeAdb.setCommandError("shell monkey", new Error("monkey unavailable in fake"));
      fakeAdb.setCommandResponse("shell pm dump 'com.android.egg'", { stdout: egg, stderr: "" });
      const resultPromise = performFallbackLaunch("com.android.egg");
      await expect(resultPromise).rejects.toBeInstanceOf(ActionableError);
      await expect(resultPromise).rejects.toThrow(
        "No launcher activity found and launcher intent failed",
      );
      expect(fakeAdb.getExecutedCommands()).toContain(
        "shell am start --user 0 -n 'com.android.egg/com.android.egg.MainLauncherActivity'",
      );
    });
  });

  const failLauncherResolver = () =>
    fakeAdb.setCommandResponse(
      "shell am start --user 0 -a android.intent.action.MAIN -c android.intent.category.LAUNCHER",
      {
        stdout: "Error: no launcher activity",
        stderr: "",
      },
    );

  test("monkey accepted and verified launches without trying later fallbacks", async () => {
    fakeTimer.enableAutoAdvance();
    failLauncherResolver();
    fakeAdb.setForegroundApp({ packageName, userId: 0 });
    fakeObserveScreen.setObserveResult(createObserveResult(packageName));

    const result = await launchApp.execute(packageName, false, false);

    expect(result).toMatchObject({ success: true, activityName: "monkey_launch" });
    expect(fakeAdb.wasCommandExecuted(`shell monkey -p '${packageName}'`)).toBe(true);
    expect(fakeAdb.wasCommandExecuted(`-n '${packageName}/`)).toBe(false);
    expect(
      fakeAdb
        .getExecutedCommands()
        .filter(
          (command) =>
            command.startsWith("shell am start") &&
            command.includes("android.intent.category.LAUNCHER"),
        ),
    ).toHaveLength(1);
    expect(fakeTimer.getSleepCallCount()).toBe(0);
  });

  test("accepted monkey stops fallbacks and uses the caller warning on unverified foreground", async () => {
    fakeTimer.enableAutoAdvance();
    failLauncherResolver();
    fakeAdb.setCommandResponse(`shell monkey -p '${packageName}'`, {
      stdout: "Events injected: 1",
      stderr: "",
    });
    fakeAdb.setForegroundApp({ packageName: "com.example.covering", userId: 0 });
    fakeObserveScreen.setObserveResult(createObserveResult(packageName));
    const warnSpy = spyOn(logger, "warn");

    try {
      const result = await launchApp.execute(packageName, false, false);

      expect(result).toMatchObject({ success: true, activityName: "monkey_launch" });
      expect(fakeAdb.wasCommandExecuted(`shell monkey -p '${packageName}'`)).toBe(true);
      expect(fakeAdb.wasCommandExecuted(`-n '${packageName}/`)).toBe(false);
      expect(
        fakeAdb
          .getExecutedCommands()
          .filter(
            (command) =>
              command.startsWith("shell am start") &&
              command.includes("android.intent.category.LAUNCHER"),
          ),
      ).toHaveLength(1);
      expect(warnSpy).toHaveBeenCalledWith(
        `[LaunchApp] ${packageName} did not become the foreground app before observation; continuing to validate launch observation`,
      );
      expect(fakeTimer.now()).toBe(5000);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("monkey failure marker advances to guessed activities without waiting", async () => {
    failLauncherResolver();
    fakeAdb.setCommandResponse(`shell monkey -p '${packageName}'`, {
      stdout: "** No activities found to run, monkey aborted.",
      stderr: "",
    });
    const result = await performFallbackLaunch();

    expect(result).toMatchObject({ success: true, activityName: `${packageName}.MainActivity` });
    expect(fakeAdb.wasCommandExecuted(`-n '${packageName}/${packageName}.MainActivity'`)).toBe(
      true,
    );
    expect(fakeAdb.wasCommandExecuted(`-n '${packageName}/${packageName}.ui.MainActivity'`)).toBe(
      false,
    );
    expect(fakeTimer.getSleepCallCount()).toBe(0);
  });

  test("bare monkey failure marker advances to guessed activities without waiting", async () => {
    failLauncherResolver();
    fakeAdb.setCommandResponse(`shell monkey -p '${packageName}'`, {
      stdout: "No activities found to run, monkey aborted",
      stderr: "",
    });
    const result = await performFallbackLaunch();

    expect(result).toMatchObject({ success: true, activityName: `${packageName}.MainActivity` });
    expect(fakeAdb.wasCommandExecuted(`-n '${packageName}/${packageName}.MainActivity'`)).toBe(
      true,
    );
    expect(fakeTimer.getSleepCallCount()).toBe(0);
  });

  test("capitalized monkey failure marker advances to guessed activities without waiting", async () => {
    failLauncherResolver();
    fakeAdb.setCommandResponse(`shell monkey -p '${packageName}'`, {
      stdout: "** Monkey aborted due to error.",
      stderr: "",
    });
    const result = await performFallbackLaunch();

    expect(result).toMatchObject({ success: true, activityName: `${packageName}.MainActivity` });
    expect(fakeAdb.wasCommandExecuted(`-n '${packageName}/${packageName}.MainActivity'`)).toBe(
      true,
    );
    expect(fakeTimer.getSleepCallCount()).toBe(0);
  });

  test("pattern failure marker advances to a later accepted pattern with one caller wait", async () => {
    fakeTimer.enableAutoAdvance();
    failLauncherResolver();
    fakeAdb.setCommandResponse(`shell monkey -p '${packageName}'`, {
      stdout: "No activities found to run, monkey aborted",
      stderr: "",
    });
    fakeAdb.setCommandResponse(`-n '${packageName}/${packageName}.MainActivity'`, {
      stdout: "Error type 3\nActivity class does not exist.",
      stderr: "",
    });
    fakeAdb.setForegroundApp({ packageName: "com.example.covering", userId: 0 });
    fakeObserveScreen.setObserveResult(createObserveResult(packageName));

    const result = await launchApp.execute(packageName, false, false);

    expect(result).toMatchObject({ success: true, activityName: `${packageName}.ui.MainActivity` });
    expect(fakeAdb.wasCommandExecuted(`-n '${packageName}/${packageName}.MainActivity'`)).toBe(
      true,
    );
    expect(fakeAdb.wasCommandExecuted(`-n '${packageName}/${packageName}.ui.MainActivity'`)).toBe(
      true,
    );
    expect(fakeAdb.wasCommandExecuted(`-n '${packageName}/${packageName}.main.MainActivity'`)).toBe(
      false,
    );
    expect(fakeTimer.now()).toBe(5000);
  });

  test("throws when every fallback reports a failure marker", async () => {
    fakeAdb.setCommandResponseSequence(
      "shell am start --user 0 -a android.intent.action.MAIN -c android.intent.category.LAUNCHER",
      [
        { stdout: "Error: no launcher activity", stderr: "" },
        { stdout: "Error: Activity not started, unable to resolve Intent", stderr: "" },
      ],
    );
    fakeAdb.setCommandResponse(`shell monkey -p '${packageName}'`, {
      stdout: "No activities found to run, monkey aborted",
      stderr: "",
    });
    fakeAdb.setCommandResponse("shell am start --user 0 -n", {
      stdout: "Error type 3\nActivity class does not exist.",
      stderr: "",
    });

    await expect(performFallbackLaunch()).rejects.toBeInstanceOf(ActionableError);
    expect(
      fakeAdb.wasCommandExecuted(`-n '${packageName}/${packageName}.MainLauncherActivity'`),
    ).toBe(true);
    expect(
      fakeAdb
        .getExecutedCommands()
        .filter(
          (command) =>
            command.startsWith("shell am start") &&
            command.includes("android.intent.category.LAUNCHER"),
        ),
    ).toHaveLength(2);
    expect(fakeTimer.getSleepCallCount()).toBe(0);
  });

  test.each([
    "Starting: Intent { act=android.intent.action.MAIN pkg=com.example.errorreporter }",
    "Warning: Activity not started, its current task has been brought to the front",
  ])(
    "accepted final launcher intent output %s uses the caller wait and observation",
    async (output) => {
      fakeTimer.enableAutoAdvance();
      fakeAdb.setCommandResponseSequence(
        "shell am start --user 0 -a android.intent.action.MAIN -c android.intent.category.LAUNCHER",
        [
          { stdout: "Error: no launcher activity", stderr: "" },
          { stdout: output, stderr: "" },
        ],
      );
      fakeAdb.setCommandResponse(`shell monkey -p '${packageName}'`, {
        stdout: "No activities found to run, monkey aborted",
        stderr: "",
      });
      fakeAdb.setCommandResponse("shell am start --user 0 -n", {
        stdout: "Error type 3\nActivity class does not exist.",
        stderr: "",
      });
      fakeAdb.setForegroundApp({ packageName: "com.example.covering", userId: 0 });
      fakeObserveScreen.setObserveResult(createObserveResult(packageName));

      const result = await launchApp.execute(packageName, false, false);

      expect(result.success).toBe(true);
      expect(
        fakeAdb
          .getExecutedCommands()
          .filter(
            (command) =>
              command.startsWith("shell am start") &&
              command.includes("android.intent.category.LAUNCHER"),
          ),
      ).toHaveLength(2);
      expect(fakeTimer.now()).toBe(5000);
    },
  );

  test("aborts during the caller foreground wait after monkey is accepted", async () => {
    failLauncherResolver();
    fakeAdb.setForegroundApp({ packageName: "com.example.covering", userId: 0 });
    const controller = new AbortController();
    const cancellation = new Error("launch cancelled");
    const resultPromise = launchApp.execute(
      packageName,
      false,
      false,
      undefined,
      undefined,
      undefined,
      controller.signal,
    );

    for (let i = 0; i < 100 && fakeTimer.getPendingSleepCount() === 0; i += 1) {
      await Promise.resolve();
    }
    expect(fakeAdb.wasCommandExecuted(`shell monkey -p '${packageName}'`)).toBe(true);
    expect(fakeTimer.getPendingSleepCount()).toBe(1);
    controller.abort(cancellation);
    fakeTimer.advanceTime(200);

    await expect(resultPromise).rejects.toBe(cancellation);
    expect(fakeAdb.wasCommandExecuted(`-n '${packageName}/`)).toBe(false);
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
    expect(
      fakeAdb.wasCommandExecuted(
        `shell monkey -p '${packageName}' -c android.intent.category.LAUNCHER 1`,
      ),
    ).toBe(true);
  });

  test("waits for two matching fresh Android frames after clearing app data", async () => {
    configureSuccessfulClearAppData();
    fakeTimer.enableAutoAdvance();
    fakeAdb.setForegroundApp({ packageName, userId: 0 });
    fakeAdb.setCommandResponse("shell dumpsys activity processes", { stdout: "0\n", stderr: "" });
    const frame = (marker: string): ObserveResult => ({
      ...createObserveResult(packageName),
      viewHierarchy: {
        packageName,
        hierarchy: { node: { marker } },
      } as unknown as ViewHierarchyResult,
    });
    fakeObserveScreen.setObserveSequence([
      frame("launch"),
      frame("loading"),
      frame("onboarding"),
      frame("onboarding"),
    ]);

    const result = await launchApp.execute(packageName, true, false);

    expect(result.success).toBe(true);
    expect(result.observation?.viewHierarchy).toEqual(frame("onboarding").viewHierarchy);
    expect(fakeObserveScreen.getExecuteCallCount()).toBe(4);
    expect(fakeTimer.getCurrentTime()).toBeLessThanOrEqual(2_500);
  });

  test("bounds a cold launch with a perpetually changing hierarchy", async () => {
    configureSuccessfulClearAppData();
    fakeTimer.enableAutoAdvance();
    fakeAdb.setForegroundApp({ packageName, userId: 0 });
    fakeAdb.setCommandResponse("shell dumpsys activity processes", { stdout: "0\n", stderr: "" });
    fakeObserveScreen.setObserveResult((index) => ({
      ...createObserveResult(packageName),
      viewHierarchy: {
        packageName,
        hierarchy: { node: { marker: index } },
      } as unknown as ViewHierarchyResult,
    }));

    const result = await launchApp.execute(packageName, true, false);

    expect(result.success).toBe(true);
    expect(fakeTimer.getCurrentTime()).toBe(2_500);
    expect(fakeObserveScreen.getExecuteCallCount()).toBeGreaterThan(2);
  });

  test("does not wait for stable frames on a launch without clearAppData", async () => {
    fakeTimer.enableAutoAdvance();
    fakeAdb.setForegroundApp({ packageName, userId: 0 });
    fakeAdb.setCommandResponse("shell dumpsys activity processes", { stdout: "0\n", stderr: "" });
    fakeObserveScreen.setObserveResult(createObserveResult(packageName));

    const result = await launchApp.execute(packageName, false, false);

    expect(result.success).toBe(true);
    expect(fakeObserveScreen.getExecuteCallCount()).toBe(1);
    expect(fakeTimer.getCurrentTime()).toBe(0);
  });

  test("does not launch Android when clearing app data fails for a running app", async () => {
    fakeTimer.enableAutoAdvance();
    fakeAdb.setForegroundApp({ packageName, userId: 0 });
    fakeAdb.setCommandResponse("shell dumpsys activity processes", {
      stdout: "123:com.example.app/u0a123\n",
      stderr: "",
    });
    const launchWithFailedClear = new LaunchApp(device, fakeAdb, null, fakeTimer, {
      createAndroidClearAppData: () => ({
        execute: async () => ({
          success: false,
          packageName,
          error: "Failed to clear application data: Failed",
        }),
      }),
    });

    const result = await launchWithFailedClear.execute(packageName, true, false);

    expect(result).toMatchObject({
      success: false,
      packageName,
      userId: 0,
      error: "Failed to clear app data: Failed to clear application data: Failed",
    });
    expect(fakeAdb.wasCommandExecuted(`shell monkey -p '${packageName}'`)).toBe(false);
  });

  test("does not launch Android when clearing app data fails for a stopped app", async () => {
    fakeTimer.enableAutoAdvance();
    fakeAdb.setForegroundApp({ packageName, userId: 0 });
    fakeAdb.setCommandResponse("shell dumpsys activity processes", { stdout: "0\n", stderr: "" });
    const launchWithFailedClear = new LaunchApp(device, fakeAdb, null, fakeTimer, {
      createAndroidClearAppData: () => ({
        execute: async () => ({
          success: false,
          packageName,
          error: "Failed to clear application data: Failed",
        }),
      }),
    });

    const result = await launchWithFailedClear.execute(packageName, true, false);

    expect(result).toMatchObject({
      success: false,
      packageName,
      userId: 0,
      error: "Failed to clear app data: Failed to clear application data: Failed",
    });
    expect(fakeAdb.wasCommandExecuted(`shell monkey -p '${packageName}'`)).toBe(false);
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
    expect(
      fakeAdb.wasCommandExecuted(
        `shell monkey -p '${packageName}' -c android.intent.category.LAUNCHER 1`,
      ),
    ).toBe(true);
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
    expect(
      fakeAdb.wasCommandExecuted(
        `shell monkey -p '${packageName}' -c android.intent.category.LAUNCHER 1`,
      ),
    ).toBe(true);
  });

  test("does not launch Android when the injected cold boot fails", async () => {
    fakeTimer.enableAutoAdvance();
    fakeAdb.setCommandResponse("shell dumpsys activity processes", {
      stdout: "123:com.example.app/u0a123\n",
      stderr: "",
    });
    const action = new LaunchApp(device, fakeAdb as unknown as any, null, fakeTimer, {
      createAndroidColdBoot: () => ({ execute: async () => ({ success: false, error: "x" }) }),
    });
    (action as any).awaitIdle = fakeAwaitIdle;
    (action as any).observeScreen = fakeObserveScreen;
    (action as any).window = fakeWindow;

    const result = await action.execute(packageName, false, true);

    expect(result.success).toBe(false);
    expect(result.error).toContain("Cold boot could not stop");
    expect(
      fakeAdb
        .getExecutedCommands()
        .some((command) => command.includes("am start") || command.includes("monkey")),
    ).toBe(false);
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
    expect(result.foregroundActivityPackage).toBeUndefined();
    expect(result.verifiedBy).toBeUndefined();
    expect(fakeObserveScreen.getExecuteCallCount()).toBeGreaterThan(1);
    expect(
      fakeObserveScreen
        .getExecuteOptions()
        .every((options) => options.signal === controller.signal),
    ).toBe(true);
    expect(fakeObserveScreen.getExecuteOptions().at(-1)?.skipPerformanceAudit).toBe(true);
  });

  test("captures only the final launch observation after package reconciliation", async () => {
    fakeTimer.enableAutoAdvance();
    const previousPackageName = "com.example.previous";
    const observations = [
      createObserveResult(previousPackageName),
      createObserveResult(packageName),
    ];
    const originalPolicy = process.env.AUTOMOBILE_ACTION_OBSERVATION_SKIP_SCREENSHOT;
    process.env.AUTOMOBILE_ACTION_OBSERVATION_SKIP_SCREENSHOT = "false";

    try {
      fakeAdb.setForegroundApp({ packageName, userId: 0 });
      fakeAdb.setCommandResponse("shell dumpsys activity processes", { stdout: "0\n", stderr: "" });
      fakeObserveScreen.setObserveResult(
        () => observations.shift() ?? createObserveResult(packageName),
      );

      const result = await launchApp.execute(packageName, false, false);

      expect(result.observation?.activeWindow?.appId).toBe(packageName);
      expect(fakeObserveScreen.getExecuteOptions().every((options) => options.skipScreenshot)).toBe(
        true,
      );
      expect(
        fakeObserveScreen.getExecuteOptions().every((options) => options.skipAccessibilityAudit),
      ).toBe(true);
      expect(fakeObserveScreen.getCaptureScreenshotCallCount()).toBe(1);
      expect(fakeObserveScreen.getCapturedScreenshotObservations()).toEqual([result.observation]);
    } finally {
      if (originalPolicy === undefined) {
        delete process.env.AUTOMOBILE_ACTION_OBSERVATION_SKIP_SCREENSHOT;
      } else {
        process.env.AUTOMOBILE_ACTION_OBSERVATION_SKIP_SCREENSHOT = originalPolicy;
      }
    }
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

  test("waits through the Android CtrlProxy reconnect cooldown", async () => {
    fakeTimer.enableAutoAdvance();
    const unverifiedObservation = {
      ...createObserveResult(packageName),
      freshness: {
        isFresh: false,
        verified: false,
        warning: "Accessibility service is reconnecting after a transient ADB reset",
      },
    };

    fakeAdb.setForegroundApp({ packageName, userId: 0 });
    fakeAdb.setCommandResponse("shell dumpsys activity processes", { stdout: "0\n", stderr: "" });
    fakeObserveScreen.setObserveResult(() =>
      fakeTimer.now() < 10_500 ? unverifiedObservation : createObserveResult(packageName),
    );

    const result = await launchApp.execute(packageName, false, false);

    expect(result.success).toBe(true);
    expect(result.observation?.freshness?.verified).not.toBe(false);
    expect(fakeTimer.now()).toBeGreaterThanOrEqual(10_500);
  });

  // Issue #6220 follow-up (P1 review finding on #6239): a launch observation
  // that reports NO foreground window at all (neither `activeWindow.appId` nor
  // `viewHierarchy.packageName` name an app — the shape ObserveScreen's own
  // freshness now marks `verified: false` for) must NOT be treated the same as
  // "observed a different/stale app": that path rejects and deletes the
  // observation, but the launch genuinely happened and the response builder
  // needs the observation preserved to report a structured `verified: false` +
  // `verifyFailureReason` instead of a thrown/silent failure.
  test("preserves a no-foreground-window launch observation instead of rejecting it as stale", async () => {
    fakeTimer.enableAutoAdvance();
    const noWindowObservation = {
      ...createObserveResult(undefined),
      freshness: {
        isFresh: false,
        verified: false,
        warning: "Observed hierarchy reports no foreground application window",
      },
    };

    fakeAdb.setForegroundApp({ packageName, userId: 0 });
    fakeAdb.setCommandResponse("shell dumpsys activity processes", { stdout: "0\n", stderr: "" });
    fakeObserveScreen.setObserveResult(noWindowObservation);

    const result = await launchApp.execute(packageName, false, false);

    expect(result.success).toBe(true);
    expect(result.observation).toBeDefined();
    expect(result.observation?.freshness?.verified).toBe(false);
    expect(result.observation?.activeWindow?.appId).toBeFalsy();
    expect(result.observationOmitted).toBeUndefined();
  });

  // P1 review finding on #6239: a status-bar-ONLY final capture must be
  // classified as "no foreground window" even when it still carries STALE
  // `packageName`/`foregroundActivity`/`activeWindow.appId` metadata left over
  // from a previously-resumed app. The package-count check alone would see
  // those stale package names and misroute this to the wrong-app reject path
  // (success:false, observation stripped, buildLaunchAppResponse throws)
  // instead of the intended structured `verified:false` +
  // `verifyFailureReason: "no_foreground_window"`. Reusing
  // `resolveMissingForegroundWindow` (the SAME machine-readable verdict the
  // observe freshness gate uses) catches this via geometry, independent of
  // whatever stale identity survives on the wire.
  test("preserves a status-bar-only launch observation with stale identity metadata as no-window, not wrong-app", async () => {
    fakeTimer.enableAutoAdvance();
    const staleAppPackageName = "com.example.previous";
    const statusBarOnlyObservation: ObserveResult = {
      updatedAt: Date.now(),
      screenSize: { width: 1080, height: 1920 },
      systemInsets: { top: 63, bottom: 0, left: 0, right: 0 },
      viewHierarchy: {
        packageName: staleAppPackageName,
        foregroundActivity: `${staleAppPackageName}/.MainActivity`,
        hierarchy: {
          node: {
            bounds: { left: 0, top: 0, right: 1080, bottom: 63 },
            node: [{ text: "12:34", bounds: { left: 21, top: 0, right: 107, bottom: 63 } }],
          },
        },
      } as any,
      // Stale identity that survived on the wire even though the tree itself
      // has collapsed to status-bar-only content.
      activeWindow: { appId: staleAppPackageName, activityName: "MainActivity", layoutSeqSum: 1 },
    };

    fakeAdb.setForegroundApp({ packageName, userId: 0 });
    fakeAdb.setCommandResponse("shell dumpsys activity processes", { stdout: "0\n", stderr: "" });
    fakeObserveScreen.setObserveResult(statusBarOnlyObservation);

    const result = await launchApp.execute(packageName, false, false);

    // Preserved as a no-window outcome, NOT flipped to a wrong-app rejection.
    expect(result.success).toBe(true);
    expect(result.observation).toBeDefined();
    expect(result.observationOmitted).toBeUndefined();

    const payload = buildLaunchAppResponse(packageName, result);
    expect(payload.verified).toBe(false);
    expect(payload.verifyFailureReason).toBe("no_foreground_window");
  });

  // P2 review finding on #6239: a hierarchy naming a DIFFERENT app only via
  // `viewHierarchy.foregroundActivity` (no `activeWindow.appId`, no
  // `viewHierarchy.packageName`) must be a detected wrong-app mismatch, not
  // an empty-package vacuous accept — the omission previously let a genuine
  // wrong-app landing through as if no app were observed at all.
  test("detects a wrong-app landing named only by foregroundActivity, instead of an empty-package accept", async () => {
    fakeTimer.enableAutoAdvance();
    const wrongAppPackageName = "com.example.other";
    const wrongAppObservation: ObserveResult = {
      ...createObserveResult(undefined),
      viewHierarchy: {
        node: {},
        foregroundActivity: `${wrongAppPackageName}/.MainActivity`,
      } as any,
    };

    fakeAdb.setForegroundApp({ packageName, userId: 0 });
    fakeAdb.setCommandResponse("shell dumpsys activity processes", { stdout: "0\n", stderr: "" });
    fakeObserveScreen.setObserveResult(wrongAppObservation);

    const result = await launchApp.execute(packageName, false, false);

    expect(result.success).toBe(false);
    expect(result.error).toContain(
      `Timed out waiting for launch observation to show ${packageName}`,
    );
    expect(result.error).toContain(wrongAppPackageName);
    expect(result.observation).toBeUndefined();
    expect(result.observationOmitted).toBeDefined();
  });

  // P1 review finding on #6239: `foregroundActivity` must be a FALLBACK
  // identity signal, never a competing one. The reconciled/settled primary
  // signals (`activeWindow.appId`, `viewHierarchy.packageName`) already agree
  // on the just-launched app B, but the raw `foregroundActivity` wire field
  // can lag a same-observation A->B transition and still name the PREVIOUS
  // app A. Contributing A alongside a settled B must not fail the match and
  // turn a successful launch into a failure.
  test("succeeds when primary signals agree on the launched app despite a lagging foregroundActivity", async () => {
    fakeTimer.enableAutoAdvance();
    const previousPackageName = "com.example.previous";
    const laggedObservation: ObserveResult = {
      ...createObserveResult(packageName),
      viewHierarchy: {
        ...createObserveResult(packageName).viewHierarchy,
        // Raw accessibility signal still names the PREVIOUS app A, even
        // though activeWindow/viewHierarchy.packageName already settled on B.
        foregroundActivity: `${previousPackageName}/.MainActivity`,
      } as any,
    };

    fakeAdb.setForegroundApp({ packageName, userId: 0 });
    fakeAdb.setCommandResponse("shell dumpsys activity processes", { stdout: "0\n", stderr: "" });
    fakeObserveScreen.setObserveResult(laggedObservation);

    const result = await launchApp.execute(packageName, false, false);

    expect(result.success).toBe(true);
    expect(result.observation?.activeWindow?.appId).toBe(packageName);
    expect(result.observationOmitted).toBeUndefined();
    // No retry needed: the primary signals alone decided the match.
    expect(fakeObserveScreen.getExecuteCallCount()).toBe(1);
  });

  // Counterpart to the wrong-app case above: when only `foregroundActivity`
  // names an app (no primary signals at all) and it names the RIGHT app, the
  // launch must succeed via that fallback rather than being rejected.
  test("succeeds via foregroundActivity fallback when it names the launched app and no primary signal is present", async () => {
    fakeTimer.enableAutoAdvance();
    const rightAppObservation: ObserveResult = {
      ...createObserveResult(undefined),
      viewHierarchy: {
        node: {},
        foregroundActivity: `${packageName}/.MainActivity`,
      } as any,
    };

    fakeAdb.setForegroundApp({ packageName, userId: 0 });
    fakeAdb.setCommandResponse("shell dumpsys activity processes", { stdout: "0\n", stderr: "" });
    fakeObserveScreen.setObserveResult(rightAppObservation);

    const result = await launchApp.execute(packageName, false, false);

    expect(result.success).toBe(true);
    expect(result.observationOmitted).toBeUndefined();
    expect(fakeObserveScreen.getExecuteCallCount()).toBe(1);
  });

  test("treats Android notification permission dialogs as valid launch observations", async () => {
    fakeTimer.enableAutoAdvance();
    const permissionControllerPackageName = "com.google.android.permissioncontroller";

    fakeAdb.setForegroundApp({ packageName: permissionControllerPackageName, userId: 0 });
    fakeAdb.setCommandResponse("android.intent.category.LAUNCHER", {
      stdout: "Starting: Intent",
      stderr: "",
    });
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
    expect(invalidated).toEqual([device, device]);
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

  test("reports an Android listing failure instead of claiming the app is absent", async () => {
    fakeTimer.enableAutoAdvance();
    const installedAppsProvider = new FakeInstalledAppsProvider(fakeTimer, {
      successful: false,
      error: new Error("adb package listing failed"),
    });
    const action = new LaunchApp(device, fakeAdb, null, fakeTimer, {
      installedAppsProvider,
    });

    await expect(action.execute(packageName, false, false)).rejects.toThrow(
      "Could not determine whether com.example.app is installed: adb package listing failed",
    );
    expect(hasStartedAppLaunch()).toBe(false);
  });

  test("rejects an incomplete Android listing even when it contains the app", async () => {
    fakeTimer.enableAutoAdvance();
    const action = new LaunchApp(device, fakeAdb, null, fakeTimer, {
      installedAppsProvider: {
        listInstalledApps: async () => ({ apps: [packageName], successful: false }),
      },
    });

    await expect(action.execute(packageName, false, false)).rejects.toThrow(
      "Could not determine whether com.example.app is installed: installed-app listing did not complete successfully",
    );
    expect(hasStartedAppLaunch()).toBe(false);
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

    function createIOSTestHarness(opts: {
      bundleId: string;
      launchSuccess?: boolean;
      listingSuccessful?: boolean;
      installedApps?: string[];
    }) {
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
        installedApps: opts.installedApps ?? [opts.bundleId],
        successful: opts.listingSuccessful,
      });

      const calls: string[] = [];
      const listInstalledApps = installedApps.listInstalledApps.bind(installedApps);
      spyOn(installedApps, "listInstalledApps").mockImplementation(async () => {
        calls.push("listapps");
        return listInstalledApps();
      });
      const fakeSimctl = {
        launchApp: async (
          id: string,
          options?: { foregroundIfRunning?: boolean; launchArguments?: string[] },
          deviceId?: string,
        ) => {
          calls.push(`launch:${deviceId}:${id}:${JSON.stringify(options)}`);
          return opts.launchSuccess === false
            ? { success: false, error: "simctl launch failed" }
            : { success: true, pid: 123 };
        },
        terminateApp: async (id: string, deviceId?: string) => {
          calls.push(`terminate:${deviceId}:${id}`);
        },
      };

      const iosLaunchApp = new LaunchApp(
        iosDevice,
        fakeAdb as unknown as any,
        fakeSimctl as any,
        fakeTimer,
        {
          installedAppsProvider: installedApps,
          clearAppDataFactory: () => {
            calls.push("clearFactory");
            return {
              execute: async (id) => {
                calls.push(`clear:${id}`);
                return { success: true, packageName: id };
              },
            };
          },
        },
      );
      (iosLaunchApp as any).awaitIdle = new FakeAwaitIdle();
      (iosLaunchApp as any).observeScreen = iosObserveScreen;
      (iosLaunchApp as any).window = iosWindow;
      (iosLaunchApp as any).waitForIosHierarchyReady = async () => {};

      return {
        iosLaunchApp,
        fakeCtrlProxy,
        installedApps,
        calls,
        targetBundleIdCalls,
        cleanup: () => {
          ctrlProxySpy.mockRestore();
          managerSpy.mockRestore();
        },
      };
    }

    const launchPaths = [
      { name: "warm", clear: false, cold: false, args: undefined },
      { name: "coldBoot", clear: false, cold: true, args: undefined },
      { name: "launchArguments", clear: false, cold: false, args: ["-x"] },
      { name: "clearAppData", clear: true, cold: false, args: undefined },
    ];
    const simulatorId = "22222222-2222-2222-2222-222222222222";

    test.each(launchPaths.slice(1))(
      "rejects a missing simulator app before $name work",
      async (path) => {
        fakeTimer.enableAutoAdvance();
        const harness = createIOSTestHarness({
          bundleId: userBundleId,
          launchSuccess: false,
          installedApps: [systemBundleId],
        });
        try {
          const warmResult = await harness.iosLaunchApp.execute(userBundleId, false, false);
          expect(warmResult).toMatchObject({
            success: false,
            packageName: userBundleId,
            error: "App is not installed",
          });
          harness.calls.length = 0;
          harness.targetBundleIdCalls.length = 0;
          const result = await harness.iosLaunchApp.execute(
            userBundleId,
            path.clear,
            path.cold,
            undefined,
            undefined,
            undefined,
            undefined,
            path.args,
          );
          expect(result).toEqual(warmResult);
          expect(harness.calls).toEqual(["listapps"]);
          expect(harness.installedApps.getCallCount()).toBe(2);
          expect(harness.targetBundleIdCalls).toEqual([]);
          expect(harness.fakeCtrlProxy.getLaunchAppHistory()).toEqual([]);
          expect(harness.fakeCtrlProxy.clearCacheCallCount).toBe(0);
        } finally {
          harness.cleanup();
        }
      },
    );

    test.each(launchPaths)("preserves installed simulator app calls on $name", async (path) => {
      fakeTimer.enableAutoAdvance();
      const harness = createIOSTestHarness({ bundleId: userBundleId });
      try {
        const result = await harness.iosLaunchApp.execute(
          userBundleId,
          path.clear,
          path.cold,
          undefined,
          undefined,
          undefined,
          undefined,
          path.args,
        );
        expect(result.success).toBe(true);
        const cold = path.name !== "warm";
        expect(harness.calls).toEqual([
          ...(cold ? ["listapps", `terminate:${simulatorId}:${userBundleId}`] : []),
          ...(path.clear ? ["clearFactory", `clear:${userBundleId}`] : []),
          `launch:${simulatorId}:${userBundleId}:${JSON.stringify({
            ...(cold ? { foregroundIfRunning: false } : {}),
            launchArguments: path.args,
          })}`,
        ]);
        expect(harness.installedApps.getCallCount()).toBe(cold ? 1 : 0);
        expect(harness.fakeCtrlProxy.getLaunchAppHistory()).toEqual([userBundleId]);
        expect(harness.targetBundleIdCalls).toEqual([userBundleId]);
      } finally {
        harness.cleanup();
      }
    });

    for (const installedApps of [[], ["com.example.other"], ["com.apple.Fitness"]]) {
      test.each(launchPaths.slice(1))(
        `proceeds after an implausible cold listing ${JSON.stringify(installedApps)} on $name`,
        async (path) => {
          fakeTimer.enableAutoAdvance();
          const harness = createIOSTestHarness({ bundleId: userBundleId, installedApps });
          try {
            const result = await harness.iosLaunchApp.execute(
              userBundleId,
              path.clear,
              path.cold,
              undefined,
              undefined,
              undefined,
              undefined,
              path.args,
            );
            expect(result.success).toBe(true);
            expect(result.error).not.toBe("App is not installed");
            expect(harness.calls).toEqual([
              "listapps",
              `terminate:${simulatorId}:${userBundleId}`,
              ...(path.clear ? ["clearFactory", `clear:${userBundleId}`] : []),
              `launch:${simulatorId}:${userBundleId}:${JSON.stringify({
                foregroundIfRunning: false,
                launchArguments: path.args,
              })}`,
            ]);
            expect(harness.installedApps.getCallCount()).toBe(1);
          } finally {
            harness.cleanup();
          }
        },
      );
    }

    test("skips the cold installed check for simulator system bundles", async () => {
      fakeTimer.enableAutoAdvance();
      const harness = createIOSTestHarness({ bundleId: systemBundleId, installedApps: [] });
      try {
        const result = await harness.iosLaunchApp.execute(systemBundleId, false, true);
        expect(result.success).toBe(true);
        expect(harness.calls).toEqual([
          `terminate:${simulatorId}:${systemBundleId}`,
          `launch:${simulatorId}:${systemBundleId}:{"foregroundIfRunning":false}`,
        ]);
        expect(harness.installedApps.getCallCount()).toBe(0);
        expect(harness.targetBundleIdCalls).toEqual([]);
      } finally {
        harness.cleanup();
      }
    });

    test.each([true, false])(
      "proceeds after an unsuccessful cold listing (launch success: %s)",
      async (launchSuccess) => {
        fakeTimer.enableAutoAdvance();
        const harness = createIOSTestHarness({
          bundleId: userBundleId,
          installedApps: [],
          listingSuccessful: false,
          launchSuccess,
        });
        try {
          const result = await harness.iosLaunchApp.execute(userBundleId, false, true);
          expect(result.success).toBe(launchSuccess);
          if (!launchSuccess) {
            expect(result.error).toBe("simctl launch failed");
          }
          expect(harness.calls).toEqual([
            "listapps",
            `terminate:${simulatorId}:${userBundleId}`,
            `launch:${simulatorId}:${userBundleId}:{"foregroundIfRunning":false}`,
          ]);
          expect(harness.installedApps.getCallCount()).toBe(1);
        } finally {
          harness.cleanup();
        }
      },
    );

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

    test("retargets a resident CtrlProxy runner after simctl foregrounds the app", async () => {
      fakeTimer.enableAutoAdvance();
      const { iosLaunchApp, fakeCtrlProxy, cleanup } = createIOSTestHarness({
        bundleId: userBundleId,
        launchSuccess: true,
      });

      try {
        const result = await iosLaunchApp.execute(userBundleId, false, false);

        expect(result.success).toBe(true);
        expect(fakeCtrlProxy.getLaunchAppHistory()).toEqual([userBundleId]);
      } finally {
        cleanup();
      }
    });

    test("preserves the simctl launch error when the fallback app listing fails", async () => {
      fakeTimer.enableAutoAdvance();
      const { iosLaunchApp, installedApps, cleanup } = createIOSTestHarness({
        bundleId: userBundleId,
        launchSuccess: false,
        listingSuccessful: false,
      });

      try {
        const result = await iosLaunchApp.execute(userBundleId, false, false);
        expect(result).toMatchObject({
          success: false,
          packageName: userBundleId,
          error: "simctl launch failed",
        });
        expect(installedApps.getCallCount()).toBe(1);
      } finally {
        cleanup();
      }
    });

    test("warm launch still confirms a missing iOS simulator app after a successful empty listing", async () => {
      fakeTimer.enableAutoAdvance();
      const { iosLaunchApp, installedApps, cleanup } = createIOSTestHarness({
        bundleId: userBundleId,
        launchSuccess: false,
        installedApps: [],
      });

      try {
        const result = await iosLaunchApp.execute(userBundleId, false, false);
        expect(result).toMatchObject({
          success: false,
          packageName: userBundleId,
          error: "App is not installed",
        });
        expect(installedApps.getCallCount()).toBe(1);
      } finally {
        cleanup();
      }
    });

    test("cancels the resident CtrlProxy retarget request", async () => {
      fakeTimer.enableAutoAdvance();
      const controller = new AbortController();
      const cancellation = new Error("launch request cancelled");
      const { iosLaunchApp, fakeCtrlProxy, cleanup } = createIOSTestHarness({
        bundleId: userBundleId,
        launchSuccess: true,
      });
      let receivedSignal: AbortSignal | undefined;
      let hierarchyWaits = 0;
      fakeCtrlProxy.requestLaunchApp = async (_bundleId, _timeoutMs, _perf, _coldBoot, signal) => {
        receivedSignal = signal;
        return await new Promise((resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      };
      (iosLaunchApp as any).waitForIosHierarchyReady = async () => {
        hierarchyWaits += 1;
      };

      try {
        const result = iosLaunchApp.execute(
          userBundleId,
          false,
          false,
          undefined,
          undefined,
          undefined,
          controller.signal,
        );
        for (let attempt = 0; attempt < 20 && !receivedSignal; attempt++) {
          await Promise.resolve();
        }
        expect(receivedSignal).toBeDefined();
        expect(receivedSignal).not.toBe(controller.signal);
        expect(receivedSignal?.aborted).toBe(false);

        controller.abort(cancellation);

        await expect(result).rejects.toBe(cancellation);
        expect(receivedSignal?.aborted).toBe(true);
        expect(receivedSignal?.reason).toBe(cancellation);
        expect(hierarchyWaits).toBe(0);
      } finally {
        cleanup();
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
        invalidateCache: () => {},
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
      terminateError?: Error;
      cacheInvalidator?: FakeDeviceWindowCacheInvalidator;
      useDefaultClearAppData?: boolean;
      installedApps?: string[];
      listingSuccessful?: boolean;
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
      const terminateCalls: Array<{ bundleId: string; deviceId: string | undefined }> = [];
      const simctlLaunchArguments: Array<string[] | undefined> = [];
      const fakeSimctl = {
        executeCommandArgs: async () => {
          simctlCalls.push("get_app_container");
          return {
            stdout: "",
            stderr: "",
            toString: () => "",
            trim: () => "",
            includes: () => false,
          };
        },
        launchApp: async (id: string, options?: { launchArguments?: string[] }) => {
          simctlCalls.push(`launch:${id}`);
          simctlLaunchArguments.push(options?.launchArguments);
          return { success: true, pid: 999 };
        },
        terminateApp: async (id: string, deviceId?: string) => {
          simctlCalls.push(`terminate:${id}`);
          terminateCalls.push({ bundleId: id, deviceId });
          if (opts.terminateError) {
            throw opts.terminateError;
          }
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
        installedApps: opts.installedApps ?? [userBundleId],
        successful: opts.listingSuccessful,
      });
      const performanceTracker = new DefaultPerformanceTracker(fakeTimer);

      const iosLaunchApp = new LaunchApp(
        iosDevice,
        fakeAdb as unknown as any,
        fakeSimctl as any,
        fakeTimer,
        {
          installedAppsProvider: installedApps,
          cacheInvalidator: opts.cacheInvalidator,
          deviceAppLauncher,
          clearAppDataFactory: opts.useDefaultClearAppData ? undefined : clearAppDataFactory,
          performanceTrackerFactory: () => performanceTracker,
        },
      );
      (iosLaunchApp as any).awaitIdle = new FakeAwaitIdle();
      (iosLaunchApp as any).observeScreen = iosObserveScreen;
      (iosLaunchApp as any).window = iosWindow;
      (iosLaunchApp as any).waitForIosHierarchyReady = async () => {};

      return {
        iosLaunchApp,
        installedApps,
        fakeCtrlProxy,
        deviceAppLauncher,
        simctlCalls,
        terminateCalls,
        simctlLaunchArguments,
        clearCalls,
        performanceTracker,
        cleanup: () => {
          ctrlProxySpy.mockRestore();
          managerSpy.mockRestore();
        },
      };
    }

    test.each([true, false])(
      "malformed IDs keep physical launch guards (success=%s)",
      async (success) => {
        fakeTimer.enableAutoAdvance();
        const h = createDeviceHarness({
          deviceId: "unrecognized-device",
          launchResult: success
            ? { success: true, pid: 123 }
            : { success: false, error: "device unavailable" },
        });
        const listing = spyOn(h.installedApps, "listInstalledApps");
        const retarget = spyOn(h.fakeCtrlProxy, "requestLaunchApp");
        try {
          const result = await h.iosLaunchApp.execute(userBundleId);
          expect(result.success).toBe(success);
          expect(h.deviceAppLauncher.launchCalls).toHaveLength(1);
          expect(h.simctlCalls).toEqual([]);
          expect(listing).not.toHaveBeenCalled();
          expect(retarget).not.toHaveBeenCalled();
        } finally {
          listing.mockRestore();
          retarget.mockRestore();
          h.cleanup();
        }
      },
    );

    test.each([
      {
        name: "trustworthy missing",
        apps: ["com.apple.Preferences"],
        successful: true,
        missing: true,
      },
      {
        name: "trustworthy installed",
        apps: ["com.apple.Preferences", userBundleId],
        successful: true,
        missing: false,
      },
      { name: "empty", apps: [], successful: true, missing: false },
      { name: "partial", apps: ["com.example.other"], successful: true, missing: false },
      { name: "failed", apps: ["com.apple.Preferences"], successful: false, missing: false },
    ])("physical cold pre-check handles $name listing", async (listing) => {
      fakeTimer.enableAutoAdvance();
      const h = createDeviceHarness({
        deviceId: physicalUdid,
        installedApps: listing.apps,
        listingSuccessful: listing.successful,
      });
      try {
        const result = await h.iosLaunchApp.execute(userBundleId, true, true);
        expect(h.installedApps.getCallCount()).toBe(1);
        expect(h.simctlCalls).toEqual([]);
        expect(h.terminateCalls).toEqual([]);
        if (listing.missing) {
          expect(result).toMatchObject({ success: false, error: "App is not installed" });
          expect(h.deviceAppLauncher.launchCalls).toEqual([]);
          expect(h.clearCalls).toEqual([]);
          expect(h.fakeCtrlProxy.clearCacheCallCount).toBe(0);
        } else {
          expect(result.success).toBe(true);
          expect(h.clearCalls).toHaveLength(1);
          expect(h.deviceAppLauncher.launchCalls).toEqual([
            {
              deviceUdid: physicalUdid,
              bundleId: userBundleId,
              terminateExisting: true,
            },
          ]);
        }
      } finally {
        h.cleanup();
      }
    });

    test("unknown device IDs skip the cold installed check", async () => {
      fakeTimer.enableAutoAdvance();
      const h = createDeviceHarness({
        deviceId: "unrecognized-device",
        installedApps: ["com.apple.Preferences"],
      });
      try {
        const result = await h.iosLaunchApp.execute(userBundleId, false, true);
        expect(result.success).toBe(true);
        expect(h.installedApps.getCallCount()).toBe(0);
        expect(h.deviceAppLauncher.launchCalls).toHaveLength(1);
        expect(h.simctlCalls).toEqual([]);
      } finally {
        h.cleanup();
      }
    });

    test("launch arguments force a fresh simulator process and reach simctl", async () => {
      fakeTimer.enableAutoAdvance();
      const { iosLaunchApp, simctlCalls, simctlLaunchArguments, cleanup } = createDeviceHarness({
        deviceId: simulatorUdid,
      });
      try {
        await iosLaunchApp.execute(
          userBundleId,
          false,
          false,
          undefined,
          undefined,
          undefined,
          undefined,
          ["--allow-storage-mutations"],
        );
        expect(simctlCalls).toEqual([`terminate:${userBundleId}`, `launch:${userBundleId}`]);
        expect(simctlLaunchArguments).toEqual([["--allow-storage-mutations"]]);
      } finally {
        cleanup();
      }
    });

    test("launch arguments reach devicectl on a physical iOS device", async () => {
      fakeTimer.enableAutoAdvance();
      const { iosLaunchApp, deviceAppLauncher, cleanup } = createDeviceHarness({
        deviceId: physicalUdid,
      });
      try {
        await iosLaunchApp.execute(
          userBundleId,
          false,
          false,
          undefined,
          undefined,
          undefined,
          undefined,
          ["--allow-storage-mutations"],
        );
        expect(deviceAppLauncher.launchCalls[0]?.launchArguments).toEqual([
          "--allow-storage-mutations",
        ]);
      } finally {
        cleanup();
      }
    });

    test.each([false, true])(
      "simulator cold boot invalidates after termination (throws=%s)",
      async (throws) => {
        fakeTimer.enableAutoAdvance();
        const invalidator = new FakeDeviceWindowCacheInvalidator((_device, preserveAppIdentity) => {
          expect(h.simctlCalls).toEqual(
            preserveAppIdentity
              ? [`terminate:${userBundleId}`, `launch:${userBundleId}`]
              : [`terminate:${userBundleId}`],
          );
        });
        const h = createDeviceHarness({
          deviceId: simulatorUdid,
          terminateError: throws ? new Error("not running") : undefined,
          cacheInvalidator: invalidator,
        });
        try {
          expect((await h.iosLaunchApp.execute(userBundleId, false, true)).success).toBe(true);
          expect(invalidator.calls).toHaveLength(2);
          expect(invalidator.calls[0]).toMatchObject({ deviceId: simulatorUdid, platform: "ios" });
        } finally {
          h.cleanup();
        }
      },
    );

    test("default iOS data-clear factory receives the launch invalidator", async () => {
      fakeTimer.enableAutoAdvance();
      const invalidator = new FakeDeviceWindowCacheInvalidator();
      const h = createDeviceHarness({
        deviceId: simulatorUdid,
        cacheInvalidator: invalidator,
        useDefaultClearAppData: true,
      });
      try {
        const result = await h.iosLaunchApp.execute(userBundleId, true, true);
        expect(result.success).toBe(false);
        expect(result.error).toContain("data container");
        expect(h.simctlCalls).toEqual([
          `terminate:${userBundleId}`,
          `terminate:${userBundleId}`,
          "get_app_container",
        ]);
        expect(invalidator.calls).toHaveLength(3);
        expect(invalidator.calls[0]).toBe(invalidator.calls[1]);
        expect(invalidator.calls[1]?.deviceId).toBe(simulatorUdid);
      } finally {
        h.cleanup();
      }
    });

    test("simulator cold boot rejects a pre-restart put, while a no-op invalidator caches it", async () => {
      fakeTimer.enableAutoAdvance();
      for (const fence of [true, false]) {
        const store = new FakeObserveCacheStore(fakeTimer);
        const generation = store.currentGeneration(simulatorUdid);
        const stale = { ...createObserveResult(userBundleId), updatedAt: fakeTimer.now() };
        const invalidator = new FakeDeviceWindowCacheInvalidator((device) => {
          if (fence) {
            store.clear(device.deviceId);
          }
        });
        const h = createDeviceHarness({ deviceId: simulatorUdid, cacheInvalidator: invalidator });
        try {
          expect((await h.iosLaunchApp.execute(userBundleId, false, true)).success).toBe(true);
          await store.put(simulatorUdid, stale, generation);
          expect(store.getRecentInMemoryForDevice(simulatorUdid)).toEqual(
            fence ? undefined : stale,
          );
          expect(await store.getMostRecent(simulatorUdid)).toEqual(fence ? undefined : stale);
        } finally {
          h.cleanup();
        }
      }
    });

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
      const { iosLaunchApp, deviceAppLauncher, simctlCalls, performanceTracker, cleanup } =
        createDeviceHarness({
          deviceId: physicalUdid,
        });
      try {
        await iosLaunchApp.execute(userBundleId, false, true);
        // Exactly one devicectl round-trip: the launch (with --terminate-existing).
        // No separate pre-terminate call, and simctl is never touched on a device.
        expect(deviceAppLauncher.launchCalls).toHaveLength(1);
        expect(deviceAppLauncher.launchCalls[0].terminateExisting).toBe(true);
        expect(simctlCalls).toEqual([]);
        expect(JSON.stringify(performanceTracker.getTimings())).not.toContain(
          '"name":"terminateApp"',
        );
      } finally {
        cleanup();
      }
    });

    test("cold boot on a simulator terminates once on the selected device", async () => {
      fakeTimer.enableAutoAdvance();
      const { iosLaunchApp, terminateCalls, cleanup } = createDeviceHarness({
        deviceId: simulatorUdid,
      });
      try {
        const result = await iosLaunchApp.execute(userBundleId, false, true);
        expect(result.success).toBe(true);
        expect(terminateCalls).toEqual([{ bundleId: userBundleId, deviceId: simulatorUdid }]);
      } finally {
        cleanup();
      }
    });

    test("simulator cold-start termination errors are swallowed and launch proceeds", async () => {
      fakeTimer.enableAutoAdvance();
      const { iosLaunchApp, simctlCalls, cleanup } = createDeviceHarness({
        deviceId: simulatorUdid,
        terminateError: new Error("not running"),
      });
      try {
        const result = await iosLaunchApp.execute(userBundleId, false, true);
        expect(result.success).toBe(true);
        expect(simctlCalls).toEqual([`terminate:${userBundleId}`, `launch:${userBundleId}`]);
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
        installedApps,
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
      const { iosLaunchApp, fakeCtrlProxy, installedApps, calls, cleanup } = createClearDataHarness(
        userBundleId,
        {
          containerPath,
        },
      );
      try {
        const result = await iosLaunchApp.execute(
          userBundleId,
          /* clearAppData */ true,
          /* coldBoot */ false,
        );
        expect(result.success).toBe(true);
        expect(installedApps.getCallCount()).toBe(1);
        expect(calls).toEqual([
          `terminate:${userBundleId}`,
          `terminate:${userBundleId}`,
          `exec:get_app_container AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE ${userBundleId} data`,
          `launch:${userBundleId}`,
        ]);
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

// Validate the actual fake-backed branch results before and after finalization.
const executeForOutputSchema = LaunchApp.prototype.execute;
let executeOutputSchemaSpy: ReturnType<typeof spyOnOutputSchema>;
beforeOutputSchema(() => {
  executeOutputSchemaSpy = spyOnOutputSchema(LaunchApp.prototype, "execute").mockImplementation(
    async function (this: LaunchApp, ...args: Parameters<LaunchApp["execute"]>) {
      const result = await executeForOutputSchema.apply(this, args);
      const payload = { message: "Result", ...result };
      expect(launchAppResultSchema.parse(payload)).toBeDefined();
      const finalized = finalizeToolResponse(createStructuredToolResponse(payload), {
        name: "launchApp",
        outputSchema: launchAppResultSchema,
        artifactWriter: new FakeArtifactWriter(),
      });
      expect(launchAppResultSchema.parse(finalized.structuredContent)).toBeDefined();
      return result;
    },
  );
});
afterOutputSchema(() => executeOutputSchemaSpy.mockRestore());
