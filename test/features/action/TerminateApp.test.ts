import { expect, describe, test, beforeEach } from "bun:test";
import { TerminateApp } from "../../../src/features/action/TerminateApp";
import type { BootedDevice } from "../../../src/models";
import { FakeSimctl } from "../../fakes/FakeSimctl";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeDeviceAppTerminator } from "../../fakes/FakeDeviceAppTerminator";

describe("TerminateApp (iOS)", () => {
  // Simulator UDIDs are 8-4-4-4-12 UUIDs; isIosSimulatorUdid keys the simctl vs
  // devicectl transport off this shape (see UninstallApp/LaunchApp).
  const iosDevice: BootedDevice = {
    deviceId: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
    name: "iPhone 15",
    platform: "ios"
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

  test("returns not installed when bundle id is missing", async () => {
    fakeSimctl.setInstalledApps([{ bundleId: "com.example.other" }]);

    const terminateApp = new TerminateApp(iosDevice, null, fakeSimctl, fakeTimer);
    const result = await terminateApp.execute("com.example.app", { skipObservation: true });

    expect(result.success).toBe(true);
    expect(result.wasInstalled).toBe(false);
    expect(result.wasRunning).toBe(false);
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
    platform: "ios"
  };

  let fakeSimctl: FakeSimctl;
  let fakeTimer: FakeTimer;

  beforeEach(() => {
    fakeSimctl = new FakeSimctl();
    fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
  });

  test("terminates a running app via devicectl (not simctl)", async () => {
    const terminator = new FakeDeviceAppTerminator({ result: { wasInstalled: true, wasRunning: true } });

    const terminateApp = new TerminateApp(iosPhysicalDevice, null, fakeSimctl, fakeTimer, terminator);
    const result = await terminateApp.execute("com.example.app", { skipObservation: true });

    expect(result.success).toBe(true);
    expect(result.wasInstalled).toBe(true);
    expect(result.wasRunning).toBe(true);
    expect(result.wasForeground).toBe(false);
    expect(result.packageName).toBe("com.example.app");
    // Physical path must route through devicectl terminator, never simctl.
    expect(terminator.terminateCalls).toEqual([
      { deviceUdid: "00008110-001A2B3C4D5E6F70", bundleId: "com.example.app" }
    ]);
    expect(fakeSimctl.wasMethodCalled("terminateApp")).toBe(false);
  });

  test("reports wasRunning:false when the app is installed but not running", async () => {
    const terminator = new FakeDeviceAppTerminator({ result: { wasInstalled: true, wasRunning: false } });

    const terminateApp = new TerminateApp(iosPhysicalDevice, null, fakeSimctl, fakeTimer, terminator);
    const result = await terminateApp.execute("com.example.app", { skipObservation: true });

    expect(result.success).toBe(true);
    expect(result.wasInstalled).toBe(true);
    expect(result.wasRunning).toBe(false);
    expect(terminator.terminateCalls).toHaveLength(1);
  });

  test("reports wasInstalled:false when the app is not installed", async () => {
    const terminator = new FakeDeviceAppTerminator({ result: { wasInstalled: false, wasRunning: false } });

    const terminateApp = new TerminateApp(iosPhysicalDevice, null, fakeSimctl, fakeTimer, terminator);
    const result = await terminateApp.execute("com.example.app", { skipObservation: true });

    expect(result.success).toBe(true);
    expect(result.wasInstalled).toBe(false);
    expect(result.wasRunning).toBe(false);
    expect(terminator.terminateCalls).toHaveLength(1);
  });

  test("surfaces a clear error when devicectl termination is unsupported (iOS<=16 / non-macOS)", async () => {
    const terminator = new FakeDeviceAppTerminator();
    terminator.setError(new Error("Physical iOS device app termination requires macOS"));

    const terminateApp = new TerminateApp(iosPhysicalDevice, null, fakeSimctl, fakeTimer, terminator);
    const result = await terminateApp.execute("com.example.app", { skipObservation: true });

    expect(result.success).toBe(false);
    expect(result.error).toContain("macOS");
    // A failure must not crash and must not fall back to simctl.
    expect(fakeSimctl.wasMethodCalled("terminateApp")).toBe(false);
  });

  test("simulator path never invokes the devicectl terminator", async () => {
    const simDevice: BootedDevice = {
      deviceId: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
      name: "iPhone 15",
      platform: "ios"
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
    platform: "android"
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
    fakeAdb.setUsers([{ userId: 0, name: "Owner", running: true }]);
    fakeAdb.setCommandResult(
      "shell pm list packages --user 0 -f com.example.app | grep -c com.example.app",
      "1"
    );
    fakeAdb.setCommandResult(
      "shell am force-stop --user 0 com.example.app",
      ""
    );

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
    fakeAdb.setUsers([{ userId: 0, name: "Owner", running: true }]);
    fakeAdb.setCommandResult(
      "shell pm list packages --user 0 -f com.example.app | grep -c com.example.app",
      "0"
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

  test("treats grep -c failure as not installed instead of throwing", async () => {
    fakeAdb.setForegroundApp(null);
    fakeAdb.setUsers([{ userId: 0, name: "Owner", running: true }]);
    // Simulate grep -c exiting with code 1 when package is not found
    fakeAdb.setCommandError(
      "grep -c com.example.app",
      new Error("Command failed with exit code 1")
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
