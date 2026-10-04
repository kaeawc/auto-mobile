import { SimCtlClient } from "../../../src/utils/ios-cmdline-tools/SimCtlClient";
import { DeviceAppManager } from "../../../src/utils/ios-cmdline-tools/DeviceAppManager";
import {
  beforeEach as beforeOutputSchema,
  afterEach as afterOutputSchema,
  spyOn as spyOnOutputSchema,
} from "bun:test";
import { terminateAppResultSchema } from "../../../src/server/toolOutputSchemas";
import { finalizeToolResponse } from "../../../src/server/finalizeToolResponse";
import { createStructuredToolResponse } from "../../../src/utils/toolUtils";
import { FakeArtifactWriter } from "../../fakes/FakeArtifactWriter";
import { expect, describe, test, beforeEach, afterEach, spyOn } from "bun:test";
import {
  DefaultDeviceWindowCacheInvalidator,
  TerminateApp,
} from "../../../src/features/action/TerminateApp";
import type { BootedDevice, ObserveResult } from "../../../src/models";
import { FakeSimctl } from "../../fakes/FakeSimctl";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import type { AdbClient } from "../../../src/utils/android-cmdline-tools/AdbClient";
import { FakeDeviceAppTerminator } from "../../fakes/FakeDeviceAppTerminator";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeAwaitIdle } from "../../fakes/FakeAwaitIdle";
import { FakeWindow } from "../../fakes/FakeWindow";
import { setDebugPerfEnabled } from "../../../src/utils/PerformanceTracker";
import type { TimingData, TimingEntry } from "../../../src/utils/PerformanceTracker";
import { ActionableError } from "../../../src/models/ActionableError";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { runWithAbortSignal } from "../../../src/utils/AbortContext";
import { OPERATION_CANCELLED_MESSAGE } from "../../../src/utils/constants";
import { IOSCtrlProxyClient } from "../../../src/features/observe/ios";

describe("TerminateApp (Android install listing)", () => {
  const device: BootedDevice = { deviceId: "emulator-9426", name: "Pixel", platform: "android" };
  let adb: FakeAdbClient;
  let app: TerminateApp;
  let ctrlProxySpy: ReturnType<typeof spyOn<typeof AndroidCtrlProxyClient, "getInstance">>;

  beforeEach(() => {
    adb = new FakeAdbClient();
    adb.setUsers([{ userId: 0, name: "Owner", flags: 0x4000, running: true }]);
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    app = new TerminateApp(device, adb as unknown as AdbClient, { timer });
    ctrlProxySpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockImplementation(() => {
      throw new Error("CtrlProxy unavailable");
    });
  });

  afterEach(() => ctrlProxySpy.mockRestore());

  test("rejects a failed listing with the adb reason and no force-stop", async () => {
    const offline = new Error("device offline");
    adb.setCommandError("shell pm list packages --user 0", offline);
    const outcome = app.execute("com.example.app", { skipObservation: true });
    await expect(outcome).rejects.toBeInstanceOf(ActionableError);
    await expect(outcome).rejects.toThrow("device offline");
    await expect(outcome).rejects.toMatchObject({ cause: offline });
    expect(adb.wasCommandExecuted("force-stop")).toBe(false);
  });

  test("preserves the exact not-installed result after a successful listing", async () => {
    adb.setCommandResult("shell pm list packages --user 0", "package:com.example.other");
    expect(await app.execute("com.example.app", { skipObservation: true })).toEqual({
      success: true,
      packageName: "com.example.app",
      wasInstalled: false,
      wasRunning: false,
      wasForeground: false,
      userId: 0,
    });
    expect(adb.wasCommandExecuted("force-stop")).toBe(false);
  });

  test("force-stops an installed running package", async () => {
    adb.setCommandResult("shell pm list packages --user 0", "package:com.example.app");
    adb.setCommandResult("shell dumpsys activity processes", "3220:com.example.app/u0a123");
    const result = await app.execute("com.example.app", { skipObservation: true });
    expect(result).toMatchObject({ success: true, wasInstalled: true, wasRunning: true });
    expect(adb.wasCommandExecuted("shell am force-stop --user 0 'com.example.app'")).toBe(true);
  });

  test("propagates an aborted request as cancellation", async () => {
    const signal = AbortSignal.abort();
    await expect(
      runWithAbortSignal(signal, () => app.execute("com.example.app", { skipObservation: true })),
    ).rejects.toThrow(OPERATION_CANCELLED_MESSAGE);
    expect(adb.wasCommandExecuted("force-stop")).toBe(false);
  });

  test("cancellation during CtrlProxy lookup prevents the shell fallback", async () => {
    const controller = new AbortController();
    ctrlProxySpy.mockImplementation(() => {
      controller.abort();
      throw new Error("CtrlProxy lookup interrupted");
    });
    await expect(
      app.execute("com.example.app", { skipObservation: true }, controller.signal),
    ).rejects.toThrow(OPERATION_CANCELLED_MESSAGE);
    expect(adb.wasCommandExecuted("shell pm list packages")).toBe(false);
    expect(adb.wasCommandExecuted("force-stop")).toBe(false);
  });

  test("passes the signal to the shell listing and preserves cancellation during it", async () => {
    const controller = new AbortController();
    const executeCommand = adb.executeCommand.bind(adb);
    const commandSpy = spyOn(adb, "executeCommand").mockImplementation(async (...args) => {
      const result = await executeCommand(...args);
      if (args[0] === "shell pm list packages --user 0") {
        expect(args[4]).toBe(controller.signal);
        controller.abort();
        throw new Error("listing interrupted");
      }
      return result;
    });
    try {
      await expect(
        app.execute("com.example.app", { skipObservation: true }, controller.signal),
      ).rejects.toThrow(OPERATION_CANCELLED_MESSAGE);
      expect(adb.wasCommandExecuted("force-stop")).toBe(false);
    } finally {
      commandSpy.mockRestore();
    }
  });

  test.each([new DOMException("Aborted", "AbortError"), new Error(OPERATION_CANCELLED_MESSAGE)])(
    "propagates shell cancellation without wrapping it: %s",
    async (cancelled) => {
      adb.setCommandError("shell pm list packages --user 0", cancelled);
      await expect(app.execute("com.example.app", { skipObservation: true })).rejects.toBe(
        cancelled,
      );
      expect(adb.wasCommandExecuted("force-stop")).toBe(false);
    },
  );
});

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

  test("preserves default dependency implementations with omitted options", () => {
    const app = new TerminateApp(iosDevice, new FakeAdbClient() as unknown as AdbClient);
    expect(app["cacheInvalidator"]).toBeInstanceOf(DefaultDeviceWindowCacheInvalidator);
    expect(app["deviceTerminator"]).toBeInstanceOf(DeviceAppManager);
    expect(app["simctl"]).toBeInstanceOf(SimCtlClient);
  });

  test("clears an existing iOS CtrlProxy hierarchy cache", () => {
    const clearCache = spyOn({ clearCache: () => {} }, "clearCache");
    const existingClientSpy = spyOn(IOSCtrlProxyClient, "getExistingInstance").mockReturnValue({
      clearCache,
    } as unknown as IOSCtrlProxyClient);

    try {
      new DefaultDeviceWindowCacheInvalidator().invalidate(iosDevice);
      expect(clearCache).toHaveBeenCalledTimes(1);
    } finally {
      existingClientSpy.mockRestore();
    }
  });

  test("terminates installed app via simctl", async () => {
    fakeSimctl.setInstalledApps([{ bundleId: "com.example.app" }]);

    const terminator = new FakeDeviceAppTerminator();
    const terminateApp = new TerminateApp(iosDevice, null, {
      simctl: fakeSimctl,
      timer: fakeTimer,
      deviceTerminator: terminator,
    });
    const result = await terminateApp.execute("com.example.app", { skipObservation: true });

    expect(fakeSimctl.getMethodCalls("terminateApp")).toEqual([
      { bundleId: "com.example.app", deviceId: iosDevice.deviceId },
    ]);
    expect(terminator.terminateCalls).toEqual([]);
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

    const terminateApp = new TerminateApp(iosDevice, null, {
      simctl: noProcessSimctl,
      timer: fakeTimer,
    });
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

    const terminateApp = new TerminateApp(iosDevice, null, {
      simctl: notRunningSimctl,
      timer: fakeTimer,
    });
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

    const terminateApp = new TerminateApp(iosDevice, null, {
      simctl: deviceDownSimctl,
      timer: fakeTimer,
    });
    const result = await terminateApp.execute("com.example.app", { skipObservation: true });

    // A device-level failure is a real error, not an already-terminated app.
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/device is not running/i);
    expect(result.wasRunning).toBe(true);
  });

  test("returns not installed when bundle id is missing", async () => {
    fakeSimctl.setInstalledApps([{ bundleId: "com.example.other" }]);

    const terminateApp = new TerminateApp(iosDevice, null, {
      simctl: fakeSimctl,
      timer: fakeTimer,
    });
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

    const terminateApp = new TerminateApp(iosDevice, null, {
      simctl: fakeSimctl,
      timer: fakeTimer,
    });
    const result = await terminateApp.execute("com.example.app", { skipObservation: true });

    expect(result.success).toBe(false);
    expect(result.error).toContain("com.example.app");
    expect(result.wasInstalled).toBeUndefined();
    expect(result.wasRunning).toBeUndefined();
    expect(fakeSimctl.wasMethodCalled("terminateApp")).toBe(false);
  });

  test("detects install when bundleIdentifier is provided", async () => {
    fakeSimctl.setInstalledApps([{ bundleIdentifier: "com.example.app" }]);

    const terminateApp = new TerminateApp(iosDevice, null, {
      simctl: fakeSimctl,
      timer: fakeTimer,
    });
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

    const terminateApp = new TerminateApp(iosPhysicalDevice, null, {
      simctl: fakeSimctl,
      timer: fakeTimer,
      deviceTerminator: terminator,
    });
    const result = await terminateApp.execute("com.example.app", { skipObservation: true });

    expect(result.success).toBe(true);
    expect(result.wasInstalled).toBe(true);
    expect(result.wasRunning).toBe(true);
    expect(result.wasForeground).toBe(false);
    expect(result.packageName).toBe("com.example.app");
    expect(fakeSimctl.wasMethodCalled("listApps")).toBe(false);
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

    const terminateApp = new TerminateApp(iosPhysicalDevice, null, {
      simctl: fakeSimctl,
      timer: fakeTimer,
      deviceTerminator: terminator,
    });
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

    const terminateApp = new TerminateApp(iosPhysicalDevice, null, {
      simctl: fakeSimctl,
      timer: fakeTimer,
      deviceTerminator: terminator,
    });
    const result = await terminateApp.execute("com.example.app", { skipObservation: true });

    expect(result.success).toBe(true);
    expect(result.wasInstalled).toBe(false);
    expect(result.wasRunning).toBe(false);
    expect(terminator.terminateCalls).toHaveLength(1);
  });

  test("surfaces a clear error when devicectl termination is unsupported (iOS<=16 / non-macOS)", async () => {
    const terminator = new FakeDeviceAppTerminator();
    terminator.setError(new Error("Physical iOS device app termination requires macOS"));

    const terminateApp = new TerminateApp(iosPhysicalDevice, null, {
      simctl: fakeSimctl,
      timer: fakeTimer,
      deviceTerminator: terminator,
    });
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

    const terminateApp = new TerminateApp(simDevice, null, {
      simctl: fakeSimctl,
      timer: fakeTimer,
      deviceTerminator: terminator,
    });
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
      "shell pm list packages --user 0",
      "package:com.example.app\npackage:com.android.settings",
    );
    fakeAdb.setCommandResult("shell dumpsys activity processes", "3220:com.example.app/u0a123");
    fakeAdb.setCommandResult("shell am force-stop --user 0 'com.example.app'", "");

    const terminateApp = new TerminateApp(androidDevice, fakeAdb as any, { timer: fakeTimer });
    const result = await terminateApp.execute("com.example.app", { skipObservation: true });

    expect(result.success).toBe(true);
    expect(result.wasInstalled).toBe(true);
    expect(result.wasRunning).toBe(true);
    expect(result.wasForeground).toBe(true);
    expect(result.userId).toBe(0);
    expect(fakeAdb.wasCommandExecuted("force-stop")).toBe(true);
  });

  test("checks Android running state through the shared process-state command", async () => {
    fakeAdb.setUsers([{ userId: 0, name: "Owner", flags: 0x4000, running: true }]);
    fakeAdb.setCommandResult("shell pm list packages --user 0", "package:com.example.app");
    fakeAdb.setCommandResult("shell dumpsys activity processes", "no processes");

    await new TerminateApp(androidDevice, fakeAdb as unknown as AdbClient, {
      timer: fakeTimer,
    }).execute("com.example.app", { skipObservation: true });

    expect(fakeAdb.getCommandCalls()).toContainEqual(
      expect.objectContaining({
        command: "shell dumpsys activity processes",
        timeoutMs: 5_000,
        noRetry: true,
      }),
    );
  });

  test("terminates an installed app running under a numeric system UID", async () => {
    fakeAdb.setForegroundApp({ packageName: "com.android.settings", userId: 0 });
    fakeAdb.setUsers([{ userId: 0, name: "Owner", flags: 0x4000, running: true }]);
    fakeAdb.setCommandResult(
      "shell pm list packages --user 0",
      "package:com.example.app\npackage:com.android.settings",
    );
    fakeAdb.setCommandResult(
      "shell dumpsys activity processes",
      "*APP* UID 1000 ProcessRecord{3dc154f 30779:com.android.settings/1000}",
    );
    fakeAdb.setCommandResult("shell am force-stop --user 0 'com.android.settings'", "");

    const terminateApp = new TerminateApp(androidDevice, fakeAdb as any, { timer: fakeTimer });
    const result = await terminateApp.execute("com.android.settings", { skipObservation: true });

    expect(result.wasRunning).toBe(true);
    expect(result.wasForeground).toBe(true);
    expect(fakeAdb.wasCommandExecuted("shell am force-stop --user 0 'com.android.settings'")).toBe(
      true,
    );
  });

  test("invalidates the cached window record after a successful force-stop (issue #5867)", async () => {
    fakeAdb.setForegroundApp({ packageName: "com.example.app", userId: 0 });
    fakeAdb.setUsers([{ userId: 0, name: "Owner", flags: 0x4000, running: true }]);
    fakeAdb.setCommandResult(
      "shell pm list packages --user 0",
      "package:com.example.app\npackage:com.android.settings",
    );
    fakeAdb.setCommandResult("shell dumpsys activity processes", "3220:com.example.app/u0a123");
    fakeAdb.setCommandResult("shell am force-stop --user 0 'com.example.app'", "");

    const invalidated: BootedDevice[] = [];
    const cacheInvalidator = {
      invalidate: (device: BootedDevice) => {
        invalidated.push(device);
      },
    };

    const terminateApp = new TerminateApp(androidDevice, fakeAdb as any, {
      timer: fakeTimer,
      cacheInvalidator: cacheInvalidator,
    });
    const result = await terminateApp.execute("com.example.app", { skipObservation: true });

    expect(result.success).toBe(true);
    expect(fakeAdb.wasCommandExecuted("force-stop")).toBe(true);
    expect(invalidated).toHaveLength(1);
    expect(invalidated[0].deviceId).toBe("emulator-5554");
  });

  test("invalidates the cache when an installed app's process is already gone (issue #5867)", async () => {
    // The dead-process state is exactly what terminate-then-observe recovers
    // from, so the already-stopped path must invalidate the stale window record
    // too — not only the force-stop path.
    fakeAdb.setForegroundApp(null);
    fakeAdb.setUsers([{ userId: 0, name: "Owner", flags: 0x4000, running: true }]);
    fakeAdb.setCommandResult(
      "shell pm list packages --user 0",
      "package:com.example.app\npackage:com.android.settings",
    );
    fakeAdb.setCommandResult("shell dumpsys activity processes", "3271:com.example.other/u0a123");

    const invalidated: BootedDevice[] = [];
    const cacheInvalidator = {
      invalidate: (device: BootedDevice) => {
        invalidated.push(device);
      },
    };

    const terminateApp = new TerminateApp(androidDevice, fakeAdb as any, {
      timer: fakeTimer,
      cacheInvalidator: cacheInvalidator,
    });
    const result = await terminateApp.execute("com.example.app", { skipObservation: true });

    expect(result.wasRunning).toBe(false);
    expect(fakeAdb.wasCommandExecuted("force-stop")).toBe(false);
    expect(invalidated).toHaveLength(1);
    expect(invalidated[0].deviceId).toBe("emulator-5554");
  });

  test("does not invalidate the cache when the package is not installed (issue #5867)", async () => {
    fakeAdb.setForegroundApp(null);
    fakeAdb.setUsers([{ userId: 0, name: "Owner", flags: 0x4000, running: true }]);
    fakeAdb.setCommandResult("shell pm list packages --user 0", "");

    const invalidated: BootedDevice[] = [];
    const cacheInvalidator = {
      invalidate: (device: BootedDevice) => {
        invalidated.push(device);
      },
    };

    const terminateApp = new TerminateApp(androidDevice, fakeAdb as any, {
      timer: fakeTimer,
      cacheInvalidator: cacheInvalidator,
    });
    const result = await terminateApp.execute("com.example.app", { skipObservation: true });

    expect(result.wasInstalled).toBe(false);
    expect(invalidated).toHaveLength(0);
  });

  test("returns not installed when only a prefix-superset package exists", async () => {
    fakeAdb.setForegroundApp(null);
    fakeAdb.setUsers([{ userId: 0, name: "Owner", flags: 0x4000, running: true }]);
    fakeAdb.setCommandResult("shell pm list packages --user 0", "package:com.example.app2");

    const terminateApp = new TerminateApp(androidDevice, fakeAdb as any, { timer: fakeTimer });
    const result = await terminateApp.execute("com.example.app", { skipObservation: true });

    expect(result.success).toBe(true);
    expect(result.wasInstalled).toBe(false);
    expect(result.wasRunning).toBe(false);
    expect(result.wasForeground).toBe(false);
    expect(result.userId).toBe(0);
    expect(fakeAdb.wasCommandExecuted("force-stop")).toBe(false);
  });

  test("returns already stopped when the process filter has no match", async () => {
    fakeAdb.setForegroundApp(null);
    fakeAdb.setUsers([{ userId: 0, name: "Owner", flags: 0x4000, running: true }]);
    fakeAdb.setCommandResult(
      "shell pm list packages --user 0",
      "package:com.example.app\npackage:com.android.settings",
    );
    // grep exits 1 when there are no matching processes. This is the expected
    // signal that the installed app is already stopped, not an ADB failure.
    fakeAdb.setCommandError(
      'shell dumpsys activity processes | grep -E "com.example.app/u0a"',
      new Error("Command failed with exit code 1"),
    );
    fakeAdb.setCommandResult("shell dumpsys activity processes", "3271:com.example.other/u0a123");

    const terminateApp = new TerminateApp(androidDevice, fakeAdb as any, { timer: fakeTimer });
    const result = await terminateApp.execute("com.example.app", { skipObservation: true });

    expect(result).toEqual({
      success: true,
      packageName: "com.example.app",
      wasInstalled: true,
      wasRunning: false,
      wasForeground: false,
      userId: 0,
    });
    expect(fakeAdb.wasCommandExecuted("force-stop")).toBe(false);
  });

  test("fails instead of reporting a stopped app when the user-scoped process check fails", async () => {
    fakeAdb.setForegroundApp(null);
    fakeAdb.setUsers([{ userId: 0, name: "Owner", flags: 0x4000, running: true }]);
    fakeAdb.setCommandResult(
      "shell pm list packages --user 0",
      "package:com.example.app\npackage:com.android.settings",
    );
    fakeAdb.setCommandError("shell dumpsys activity processes", new Error("dumpsys unavailable"));

    const terminateApp = new TerminateApp(androidDevice, fakeAdb as any, { timer: fakeTimer });

    await expect(
      terminateApp.execute("com.example.app", { skipObservation: true }),
    ).rejects.toThrow("Could not determine whether com.example.app is running for Android user 0");
    expect(fakeAdb.wasCommandExecuted("force-stop")).toBe(false);
  });

  test("surfaces package-list query failure", async () => {
    fakeAdb.setForegroundApp(null);
    fakeAdb.setUsers([{ userId: 0, name: "Owner", flags: 0x4000, running: true }]);
    fakeAdb.setCommandError(
      "shell pm list packages --user 0",
      new Error("Command failed with exit code 1"),
    );

    const terminateApp = new TerminateApp(androidDevice, fakeAdb as any, { timer: fakeTimer });
    await expect(
      terminateApp.execute("com.example.app", { skipObservation: true }),
    ).rejects.toThrow("Command failed with exit code 1");
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

    const terminateApp = new TerminateApp(iosSimDevice, null, {
      simctl: fakeSimctl,
      timer: fakeTimer,
    });
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

    const terminateApp = new TerminateApp(iosSimDevice, null, {
      simctl: fakeSimctl,
      timer: fakeTimer,
    });
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

    const terminateApp = new TerminateApp(iosPhysicalDevice, null, {
      simctl: fakeSimctl,
      timer: fakeTimer,
      deviceTerminator: terminator,
    });
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

    const terminateApp = new TerminateApp(iosPhysicalDevice, null, {
      simctl: fakeSimctl,
      timer: fakeTimer,
      deviceTerminator: terminator,
    });
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
      "shell pm list packages --user 0",
      "package:com.example.app\npackage:com.android.settings",
    );
    fakeAdb.setCommandResult("shell dumpsys activity processes", "3220:com.example.app/u0a123");
    fakeAdb.setCommandResult("shell am force-stop --user 0 'com.example.app'", "");

    const terminateApp = new TerminateApp(androidDevice, fakeAdb as any, { timer: fakeTimer });
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

// Validate the actual fake-backed branch results before and after finalization.
const executeForOutputSchema = TerminateApp.prototype.execute;
let executeOutputSchemaSpy: ReturnType<typeof spyOnOutputSchema>;
beforeOutputSchema(() => {
  executeOutputSchemaSpy = spyOnOutputSchema(TerminateApp.prototype, "execute").mockImplementation(
    async function (this: TerminateApp, ...args: Parameters<TerminateApp["execute"]>) {
      const result = await executeForOutputSchema.apply(this, args);
      const payload = { message: "Result", ...result };
      expect(terminateAppResultSchema.parse(payload)).toBeDefined();
      const finalized = finalizeToolResponse(createStructuredToolResponse(payload), {
        name: "terminateApp",
        outputSchema: terminateAppResultSchema,
        artifactWriter: new FakeArtifactWriter(),
      });
      expect(terminateAppResultSchema.parse(finalized.structuredContent)).toBeDefined();
      return result;
    },
  );
});
afterOutputSchema(() => executeOutputSchemaSpy.mockRestore());
