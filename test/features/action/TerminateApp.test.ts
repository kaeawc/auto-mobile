import { expect, describe, test, beforeEach, afterEach } from "bun:test";
import { TerminateApp } from "../../../src/features/action/TerminateApp";
import type { BootedDevice, ObserveResult } from "../../../src/models";
import { FakeSimctl } from "../../fakes/FakeSimctl";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeDeviceAppTerminator } from "../../fakes/FakeDeviceAppTerminator";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeAwaitIdle } from "../../fakes/FakeAwaitIdle";
import { FakeWindow } from "../../fakes/FakeWindow";
import { setDebugPerfEnabled } from "../../../src/utils/PerformanceTracker";
import type { TimingData, TimingEntry } from "../../../src/utils/PerformanceTracker";

describe("TerminateApp (iOS)", () => {
  // Simulator UDIDs are 8-4-4-4-12 UUIDs; isIosSimulatorUdid keys the simctl vs
  // devicectl transport off this shape (see UninstallApp/LaunchApp).
  const iosDevice: BootedDevice = {
    deviceId: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
    name: "iPhone 15",
    platform: "ios",
  };

  let fakeSimctl: FakeSimctl;
  let fakeTimer: FakeTimer;

  beforeEach(() => {
    fakeSimctl = new FakeSimctl();
    fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
  });

  test("terminates installed app via simctl", async () => {
    fakeSimctl.setInstalledApps([{ bundleId: "com.example.app" }]);

    const terminateApp = new TerminateApp(iosDevice, null, fakeSimctl, fakeTimer);
    const result = await terminateApp.execute("com.example.app", { skipObservation: true });

    expect(result.success).toBe(true);
    expect(result.wasInstalled).toBe(true);
    expect(result.wasRunning).toBe(true);
    expect(result.wasForeground).toBe(false);
    expect(fakeSimctl.wasMethodCalled("terminateApp")).toBe(true);
  });

  test("marks app as not running when simctl reports no process", async () => {
    class NoProcessSimctl extends FakeSimctl {
      override async terminateApp(bundleId: string, deviceId?: string): Promise<void> {
        await super.terminateApp(bundleId, deviceId);
        throw new Error("found nothing to terminate");
      }
    }

    const noProcessSimctl = new NoProcessSimctl();
    noProcessSimctl.setInstalledApps([{ bundleId: "com.example.app" }]);

    const terminateApp = new TerminateApp(iosDevice, null, noProcessSimctl, fakeTimer);
    const result = await terminateApp.execute("com.example.app", { skipObservation: true });

    expect(result.success).toBe(true);
    expect(result.wasInstalled).toBe(true);
    expect(result.wasRunning).toBe(false);
  });

  test("marks app as not running when simctl reports a process-scoped 'not running' (shared matcher)", async () => {
    class NotRunningSimctl extends FakeSimctl {
      override async terminateApp(bundleId: string, deviceId?: string): Promise<void> {
        await super.terminateApp(bundleId, deviceId);
        throw new Error("The process is not running.");
      }
    }

    const notRunningSimctl = new NotRunningSimctl();
    notRunningSimctl.setInstalledApps([{ bundleId: "com.example.app" }]);

    const terminateApp = new TerminateApp(iosDevice, null, notRunningSimctl, fakeTimer);
    const result = await terminateApp.execute("com.example.app", { skipObservation: true });

    expect(result.success).toBe(true);
    expect(result.wasInstalled).toBe(true);
    expect(result.wasRunning).toBe(false);
  });

  test("still surfaces an unrelated simctl terminate failure (device-level 'not running' is not swallowed)", async () => {
    class DeviceDownSimctl extends FakeSimctl {
      override async terminateApp(bundleId: string, deviceId?: string): Promise<void> {
        await super.terminateApp(bundleId, deviceId);
        throw new Error("The device is not running.");
      }
    }

    const deviceDownSimctl = new DeviceDownSimctl();
    deviceDownSimctl.setInstalledApps([{ bundleId: "com.example.app" }]);

    const terminateApp = new TerminateApp(iosDevice, null, deviceDownSimctl, fakeTimer);
    const result = await terminateApp.execute("com.example.app", { skipObservation: true });

    // A device-level failure is a real error, not an already-terminated app.
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/device is not running/i);
    expect(result.wasRunning).toBe(true);
  });

  test("returns not installed when bundle id is missing", async () => {
    fakeSimctl.setInstalledApps([{ bundleId: "com.example.other" }]);

    const terminateApp = new TerminateApp(iosDevice, null, fakeSimctl, fakeTimer);
    const result = await terminateApp.execute("com.example.app", { skipObservation: true });

    expect(result.success).toBe(true);
    expect(result.wasInstalled).toBe(false);
    expect(result.wasRunning).toBe(false);
    expect(fakeSimctl.wasMethodCalled("terminateApp")).toBe(false);
  });

  test("reports a failure instead of a no-op when the installed-app listing fails", async () => {
    // A locked/disconnected device or an unavailable Xcode makes the listing
    // fail. That is not "the app is absent" — terminating must not silently
    // report success (issue #5621).
    fakeSimctl.setInstalledApps([{ bundleId: "com.example.app" }]);
    fakeSimctl.setListAppsError(new Error("Unable to boot device in current state"));

    const terminateApp = new TerminateApp(iosDevice, null, fakeSimctl, fakeTimer);
    const result = await terminateApp.execute("com.example.app", { skipObservation: true });

    expect(result.success).toBe(false);
    expect(result.error).toContain("com.example.app");
    expect(result.wasInstalled).toBeUndefined();
    expect(result.wasRunning).toBeUndefined();
    expect(fakeSimctl.wasMethodCalled("terminateApp")).toBe(false);
  });

  test("detects install when bundleIdentifier is provided", async () => {
    fakeSimctl.setInstalledApps([{ bundleIdentifier: "com.example.app" }]);

    const terminateApp = new TerminateApp(iosDevice, null, fakeSimctl, fakeTimer);
    const result = await terminateApp.execute("com.example.app", { skipObservation: true });

    expect(result.success).toBe(true);
    expect(result.wasInstalled).toBe(true);
    expect(fakeSimctl.wasMethodCalled("terminateApp")).toBe(true);
  });
});

describe("TerminateApp (iOS physical device)", () => {
  // Physical-device UDID (00008XXX form) — isIosSimulatorUdid returns false.
  const iosPhysicalDevice: BootedDevice = {
    deviceId: "00008110-001A2B3C4D5E6F70",
    name: "iPhone 15 Pro (physical)",
    platform: "ios",
  };

  let fakeSimctl: FakeSimctl;
  let fakeTimer: FakeTimer;

  beforeEach(() => {
    fakeSimctl = new FakeSimctl();
    fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
  });

  test("terminates a running app via devicectl (not simctl)", async () => {
    const terminator = new FakeDeviceAppTerminator({
      result: { wasInstalled: true, wasRunning: true },
    });

    const terminateApp = new TerminateApp(
      iosPhysicalDevice,
      null,
      fakeSimctl,
      fakeTimer,
      terminator,
    );
    const result = await terminateApp.execute("com.example.app", { skipObservation: true });

    expect(result.success).toBe(true);
    expect(result.wasInstalled).toBe(true);
    expect(result.wasRunning).toBe(true);
    expect(result.wasForeground).toBe(false);
    expect(result.packageName).toBe("com.example.app");
    // Physical path must route through devicectl terminator, never simctl.
    expect(terminator.terminateCalls).toEqual([
      { deviceUdid: "00008110-001A2B3C4D5E6F70", bundleId: "com.example.app" },
    ]);
    expect(fakeSimctl.wasMethodCalled("terminateApp")).toBe(false);
  });

  test("reports wasRunning:false when the app is installed but not running", async () => {
    const terminator = new FakeDeviceAppTerminator({
      result: { wasInstalled: true, wasRunning: false },
    });

    const terminateApp = new TerminateApp(
      iosPhysicalDevice,
      null,
      fakeSimctl,
      fakeTimer,
      terminator,
    );
    const result = await terminateApp.execute("com.example.app", { skipObservation: true });

    expect(result.success).toBe(true);
    expect(result.wasInstalled).toBe(true);
    expect(result.wasRunning).toBe(false);
    expect(terminator.terminateCalls).toHaveLength(1);
  });

  test("reports wasInstalled:false when the app is not installed", async () => {
    const terminator = new FakeDeviceAppTerminator({
      result: { wasInstalled: false, wasRunning: false },
    });

    const terminateApp = new TerminateApp(
      iosPhysicalDevice,
      null,
      fakeSimctl,
      fakeTimer,
      terminator,
    );
    const result = await terminateApp.execute("com.example.app", { skipObservation: true });

    expect(result.success).toBe(true);
    expect(result.wasInstalled).toBe(false);
    expect(result.wasRunning).toBe(false);
    expect(terminator.terminateCalls).toHaveLength(1);
  });

  test("surfaces a clear error when devicectl termination is unsupported (iOS<=16 / non-macOS)", async () => {
    const terminator = new FakeDeviceAppTerminator();
    terminator.setError(new Error("Physical iOS device app termination requires macOS"));

    const terminateApp = new TerminateApp(
      iosPhysicalDevice,
      null,
      fakeSimctl,
      fakeTimer,
      terminator,
    );
    const result = await terminateApp.execute("com.example.app", { skipObservation: true });

    expect(result.success).toBe(false);
    expect(result.error).toContain("macOS");
    // Install/running state is unknown on failure — must be omitted, not a
    // fabricated `false` that a caller could misread as "not installed".
    expect(result.wasInstalled).toBeUndefined();
    expect(result.wasRunning).toBeUndefined();
    // A failure must not crash and must not fall back to simctl.
    expect(fakeSimctl.wasMethodCalled("terminateApp")).toBe(false);
  });

  test("simulator path never invokes the devicectl terminator", async () => {
    const simDevice: BootedDevice = {
      deviceId: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
      name: "iPhone 15",
      platform: "ios",
    };
    const terminator = new FakeDeviceAppTerminator();
    fakeSimctl.setInstalledApps([{ bundleId: "com.example.app" }]);

    const terminateApp = new TerminateApp(simDevice, null, fakeSimctl, fakeTimer, terminator);
    const result = await terminateApp.execute("com.example.app", { skipObservation: true });

    expect(result.success).toBe(true);
    expect(result.wasRunning).toBe(true);
    expect(fakeSimctl.wasMethodCalled("terminateApp")).toBe(true);
    expect(terminator.terminateCalls).toHaveLength(0);
  });
});

describe("TerminateApp (Android)", () => {
  const androidDevice: BootedDevice = {
    deviceId: "emulator-5554",
    name: "Pixel 7",
    platform: "android",
  };

  let fakeAdb: FakeAdbClient;
  let fakeTimer: FakeTimer;

  beforeEach(() => {
    fakeAdb = new FakeAdbClient();
    fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
  });

  test("terminates installed foreground app", async () => {
    fakeAdb.setForegroundApp({ packageName: "com.example.app", userId: 0 });
    fakeAdb.setUsers([{ userId: 0, name: "Owner", flags: 0x4000, running: true }]);
    fakeAdb.setCommandResult(
      "shell pm list packages --user 0 -f com.example.app | grep -c com.example.app",
      "1",
    );
    fakeAdb.setCommandResult(
      'shell dumpsys activity processes | grep -E "com.example.app/u0a"',
      "3220:com.example.app/u0a123",
    );
    fakeAdb.setCommandResult("shell am force-stop --user 0 com.example.app", "");

    const terminateApp = new TerminateApp(androidDevice, fakeAdb as any, null, fakeTimer);
    const result = await terminateApp.execute("com.example.app", { skipObservation: true });

    expect(result.success).toBe(true);
    expect(result.wasInstalled).toBe(true);
    expect(result.wasRunning).toBe(true);
    expect(result.wasForeground).toBe(true);
    expect(result.userId).toBe(0);
    expect(fakeAdb.wasCommandExecuted("force-stop")).toBe(true);
  });

  test("returns not installed when package is missing", async () => {
    fakeAdb.setForegroundApp(null);
    fakeAdb.setUsers([{ userId: 0, name: "Owner", flags: 0x4000, running: true }]);
    fakeAdb.setCommandResult(
      "shell pm list packages --user 0 -f com.example.app | grep -c com.example.app",
      "0",
    );

    const terminateApp = new TerminateApp(androidDevice, fakeAdb as any, null, fakeTimer);
    const result = await terminateApp.execute("com.example.app", { skipObservation: true });

    expect(result.success).toBe(true);
    expect(result.wasInstalled).toBe(false);
    expect(result.wasRunning).toBe(false);
    expect(result.wasForeground).toBe(false);
    expect(result.userId).toBe(0);
    expect(fakeAdb.wasCommandExecuted("force-stop")).toBe(false);
  });

  test("fails instead of reporting a stopped app when the user-scoped process check fails", async () => {
    fakeAdb.setForegroundApp(null);
    fakeAdb.setUsers([{ userId: 0, name: "Owner", flags: 0x4000, running: true }]);
    fakeAdb.setCommandResult(
      "shell pm list packages --user 0 -f com.example.app | grep -c com.example.app",
      "1",
    );
    fakeAdb.setCommandError(
      'shell dumpsys activity processes | grep -E "com.example.app/u0a"',
      new Error("dumpsys unavailable"),
    );

    const terminateApp = new TerminateApp(androidDevice, fakeAdb as any, null, fakeTimer);

    await expect(
      terminateApp.execute("com.example.app", { skipObservation: true }),
    ).rejects.toThrow("Could not determine whether com.example.app is running for Android user 0");
    expect(fakeAdb.wasCommandExecuted("force-stop")).toBe(false);
  });

  test("treats grep -c failure as not installed instead of throwing", async () => {
    fakeAdb.setForegroundApp(null);
    fakeAdb.setUsers([{ userId: 0, name: "Owner", flags: 0x4000, running: true }]);
    // Simulate the install-probe shell command throwing (grep -c exits 1 when the
    // package is absent). The error key MUST be the exact command string — the
    // fake matches errors by exact command, so a substring key never fires and
    // the catch-and-degrade path stays untested (issue #4169 item 5).
    fakeAdb.setCommandError(
      "shell pm list packages --user 0 -f com.example.app | grep -c com.example.app",
      new Error("Command failed with exit code 1"),
    );

    const terminateApp = new TerminateApp(androidDevice, fakeAdb as any, null, fakeTimer);
    const result = await terminateApp.execute("com.example.app", { skipObservation: true });

    expect(result.success).toBe(true);
    expect(result.wasInstalled).toBe(false);
    expect(result.wasRunning).toBe(false);
    expect(result.wasForeground).toBe(false);
    expect(result.userId).toBe(0);
    expect(fakeAdb.wasCommandExecuted("force-stop")).toBe(false);
  });
});

/**
 * Observed-interaction coverage for the DEFAULT production path (issue #3037).
 * Every other suite passes `{ skipObservation: true }`, so the path that runs
 * the terminate logic *inside* `observedInteraction` had zero coverage — and it
 * is where the perf-tree ownership bug lived: the terminate helpers used to call
 * `perf.end()` mid-observation, popping the "terminateApp" block early so the
 * subsequent `finalObserve` (and `uiStability`) entries reparented to the root.
 * These tests assert both the result AND a well-formed perf tree with no
 * reparented entries. All I/O is faked (observeScreen / awaitIdle / window), so
 * no real device is touched and each test stays well under the 100ms budget.
 */
describe("TerminateApp (observed interaction, perf-tree ownership)", () => {
  const iosSimDevice: BootedDevice = {
    deviceId: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
    name: "iPhone 15",
    platform: "ios",
  };
  const iosPhysicalDevice: BootedDevice = {
    deviceId: "00008110-001A2B3C4D5E6F70",
    name: "iPhone 15 Pro (physical)",
    platform: "ios",
  };
  const androidDevice: BootedDevice = {
    deviceId: "emulator-5554",
    name: "Pixel 7",
    platform: "android",
  };

  // Names that `observedInteraction`/`takeObservation` add AFTER the block runs.
  // If any of these appears at the top level of the tree, the "terminateApp"
  // block was popped early and they reparented — the exact bug this fixes.
  const POST_BLOCK_ENTRY_NAMES = ["finalObserve", "uiStability"];

  const createObserveResult = (): ObserveResult => ({
    updatedAt: Date.now(),
    screenSize: { width: 1170, height: 2532 },
    systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
    viewHierarchy: {
      hierarchy: { node: [] },
      packageName: "com.example.app",
      updatedAt: Date.now(),
    },
  });

  const topLevelNames = (timings: TimingData): string[] =>
    Array.isArray(timings) ? timings.map((e) => e.name) : Object.keys(timings);

  const findEntry = (timings: TimingData, name: string): TimingEntry | undefined => {
    const list = Array.isArray(timings) ? timings : Object.values(timings);
    return list.find((e) => e.name === name);
  };

  // Recursively collect every entry name anywhere in the tree.
  const allNames = (timings: TimingData): string[] => {
    const list = Array.isArray(timings) ? timings : Object.values(timings);
    return list.flatMap((e) => [e.name, ...(e.children ? allNames(e.children) : [])]);
  };

  /**
   * Assert the perf tree is well-formed: a single top-level "terminateApp"
   * block that OWNS the post-observation entries, with none of them leaked to
   * the root. Returns the observation's perfTiming for further assertions.
   */
  const assertWellFormedPerfTree = (result: any): TimingData => {
    const timings: TimingData | undefined = result?.observation?.perfTiming;
    expect(timings).toBeDefined();
    const roots = topLevelNames(timings!);
    // The owner block must be the single root, not a sibling of observe entries.
    expect(roots).toEqual(["terminateApp"]);
    // No post-block entry may sit at the root (that is the reparenting symptom).
    for (const leaked of POST_BLOCK_ENTRY_NAMES) {
      expect(roots).not.toContain(leaked);
    }
    // finalObserve must be present and nested UNDER terminateApp.
    const terminate = findEntry(timings!, "terminateApp");
    expect(terminate?.children).toBeDefined();
    expect(allNames(terminate!.children!)).toContain("finalObserve");
    return timings!;
  };

  let fakeSimctl: FakeSimctl;
  let fakeAdb: FakeAdbClient;
  let fakeTimer: FakeTimer;
  let fakeObserveScreen: FakeObserveScreen;
  let fakeAwaitIdle: FakeAwaitIdle;
  let fakeWindow: FakeWindow;

  const wireDeps = (terminateApp: TerminateApp): void => {
    (terminateApp as any).observeScreen = fakeObserveScreen;
    (terminateApp as any).awaitIdle = fakeAwaitIdle;
    (terminateApp as any).window = fakeWindow;
  };

  beforeEach(() => {
    setDebugPerfEnabled(true); // exercise DefaultPerformanceTracker (NoOp hides the tree)
    fakeSimctl = new FakeSimctl();
    fakeAdb = new FakeAdbClient();
    fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    fakeObserveScreen = new FakeObserveScreen();
    fakeObserveScreen.setObserveResult(() => createObserveResult());
    fakeAwaitIdle = new FakeAwaitIdle();
    fakeWindow = new FakeWindow();
    fakeWindow.configureCachedActiveWindow(null);
  });

  afterEach(() => {
    setDebugPerfEnabled(false);
  });

  test("iOS simulator: terminates via simctl and produces a well-formed perf tree", async () => {
    fakeSimctl.setInstalledApps([{ bundleId: "com.example.app" }]);

    const terminateApp = new TerminateApp(iosSimDevice, null, fakeSimctl, fakeTimer);
    wireDeps(terminateApp);
    const result = await terminateApp.execute("com.example.app");

    expect(result.success).toBe(true);
    expect(result.wasInstalled).toBe(true);
    expect(result.wasRunning).toBe(true);
    expect(fakeSimctl.wasMethodCalled("terminateApp")).toBe(true);
    assertWellFormedPerfTree(result);
  });

  test("iOS simulator (not installed): still nests the perf tree correctly", async () => {
    fakeSimctl.setInstalledApps([{ bundleId: "com.example.other" }]);

    const terminateApp = new TerminateApp(iosSimDevice, null, fakeSimctl, fakeTimer);
    wireDeps(terminateApp);
    const result = await terminateApp.execute("com.example.app");

    expect(result.success).toBe(true);
    expect(result.wasInstalled).toBe(false);
    expect(fakeSimctl.wasMethodCalled("terminateApp")).toBe(false);
    // Even the early-return (not-installed) branch must not pop the block early.
    assertWellFormedPerfTree(result);
  });

  test("iOS physical: terminates via devicectl and produces a well-formed perf tree", async () => {
    const terminator = new FakeDeviceAppTerminator({
      result: { wasInstalled: true, wasRunning: true },
    });

    const terminateApp = new TerminateApp(
      iosPhysicalDevice,
      null,
      fakeSimctl,
      fakeTimer,
      terminator,
    );
    wireDeps(terminateApp);
    const result = await terminateApp.execute("com.example.app");

    expect(result.success).toBe(true);
    expect(result.wasInstalled).toBe(true);
    expect(result.wasRunning).toBe(true);
    expect(terminator.terminateCalls).toEqual([
      { deviceUdid: "00008110-001A2B3C4D5E6F70", bundleId: "com.example.app" },
    ]);
    expect(fakeSimctl.wasMethodCalled("terminateApp")).toBe(false);
    assertWellFormedPerfTree(result);
  });

  test("iOS physical (failure): surfaces a typed error without corrupting the perf tree", async () => {
    const terminator = new FakeDeviceAppTerminator();
    terminator.setError(new Error("Physical iOS device app termination requires macOS"));

    const terminateApp = new TerminateApp(
      iosPhysicalDevice,
      null,
      fakeSimctl,
      fakeTimer,
      terminator,
    );
    wireDeps(terminateApp);
    const result = await terminateApp.execute("com.example.app");

    expect(result.success).toBe(false);
    expect(result.error).toContain("macOS");
    // A caught failure must still leave the block open for the owner to close.
    assertWellFormedPerfTree(result);
  });

  test("Android: force-stops and produces a well-formed perf tree", async () => {
    fakeAdb.setForegroundApp({ packageName: "com.example.app", userId: 0 });
    fakeAdb.setUsers([{ userId: 0, name: "Owner", flags: 0x4000, running: true }]);
    fakeAdb.setCommandResult(
      "shell pm list packages --user 0 -f com.example.app | grep -c com.example.app",
      "1",
    );
    fakeAdb.setCommandResult(
      'shell dumpsys activity processes | grep -E "com.example.app/u0a"',
      "3220:com.example.app/u0a123",
    );
    fakeAdb.setCommandResult("shell am force-stop --user 0 com.example.app", "");

    const terminateApp = new TerminateApp(androidDevice, fakeAdb as any, null, fakeTimer);
    wireDeps(terminateApp);
    // skipUiStability keeps the Android gfxinfo path out of the test; the perf
    // ownership under observedInteraction is what we are covering here.
    const result = await terminateApp.execute("com.example.app", { skipUiStability: true });

    expect(result.success).toBe(true);
    expect(result.wasRunning).toBe(true);
    expect(fakeAdb.wasCommandExecuted("force-stop")).toBe(true);
    assertWellFormedPerfTree(result);
  });
});
