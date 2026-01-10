import { expect, describe, test, beforeEach } from "bun:test";
import { InstallApp } from "../../../src/features/action/InstallApp";
import { createPerformanceTracker, type TimingEntry } from "../../../src/utils/PerformanceTracker";
import type { BootedDevice, ExecResult } from "../../../src/models";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeHostCommandExecutor } from "../../fakes/FakeHostCommandExecutor";
import { FakeAndroidBuildToolsLocator } from "../../fakes/FakeAndroidBuildToolsLocator";
import { FakeTimer } from "../../fakes/FakeTimer";

const createExecResult = (stdout: string, stderr: string = ""): ExecResult => ({
  stdout,
  stderr,
  toString: () => stdout,
  trim: () => stdout.trim(),
  includes: (searchString: string) => stdout.includes(searchString)
});

describe("InstallApp", () => {
  const device: BootedDevice = {
    deviceId: "emulator-5554",
    name: "Test Device",
    platform: "android"
  };

  let fakeAdb: FakeAdbExecutor;
  let fakeHost: FakeHostCommandExecutor;
  let fakeLocator: FakeAndroidBuildToolsLocator;
  let fakeTimer: FakeTimer;

  beforeEach(() => {
    fakeAdb = new FakeAdbExecutor();
    fakeHost = new FakeHostCommandExecutor();
    fakeLocator = new FakeAndroidBuildToolsLocator();
    fakeTimer = new FakeTimer();
    fakeTimer.setManualMode();
  });

  test("installs using aapt2 and targets work profile user", async () => {
    const apkPath = "/tmp/app-debug.apk";
    const perf = createPerformanceTracker(true, fakeTimer);

    fakeLocator.setTool({ tool: "aapt2", path: "/sdk/build-tools/35.0.0/aapt2" });
    fakeHost.setCommandResponse("aapt2", createExecResult("package: name='com.example.app' versionCode='1'"));

    fakeAdb.setUsers([
      { userId: 0, name: "Owner", flags: 13, running: true },
      { userId: 10, name: "Work", flags: 30, running: true }
    ]);
    fakeAdb.setCommandResponse("shell pm list packages --user 10 -f com.example.app", createExecResult("0"));
    fakeAdb.setCommandResponse(`install --user 10 -r "${apkPath}"`, createExecResult("Success"));

    const installApp = new InstallApp(
      device,
      fakeAdb,
      fakeHost,
      fakeLocator,
      () => perf
    );

    const result = await installApp.execute(apkPath);

    expect(result.success).toBe(true);
    expect(result.upgrade).toBe(false);
    expect(result.userId).toBe(10);
    expect(fakeHost.wasCommandExecuted("aapt2")).toBe(true);
    expect(fakeAdb.wasCommandExecuted("install --user 10 -r")).toBe(true);

    const timings = perf.getTimings() as TimingEntry[];
    const installEntry = timings[0];
    expect(installEntry.name).toBe("installApp");
    const childNames = (installEntry.children as TimingEntry[]).map(entry => entry.name);
    expect(childNames).toEqual([
      "extractPackageName",
      "detectTargetUser",
      "checkInstalled",
      "adbInstall"
    ]);
  });

  test("throws when no aapt tool is available", async () => {
    const apkPath = "/tmp/app-debug.apk";
    const perf = createPerformanceTracker(true, fakeTimer);

    fakeLocator.setTool(null);

    const installApp = new InstallApp(
      device,
      fakeAdb,
      fakeHost,
      fakeLocator,
      () => perf
    );

    await expect(installApp.execute(apkPath)).rejects.toThrow("aapt2 or aapt");
  });
});
