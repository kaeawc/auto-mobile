import { expect, describe, test, beforeEach } from "bun:test";
import { InstallApp, type DeviceAppInstaller } from "../../../src/features/action/InstallApp";
import { createPerformanceTracker, type TimingEntry } from "../../../src/utils/PerformanceTracker";
import type { BootedDevice, ExecResult } from "../../../src/models";
import { AdbClientFactory } from "../../../src/utils/android-cmdline-tools/AdbClientFactory";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeHostCommandExecutor } from "../../fakes/FakeHostCommandExecutor";
import { FakeAndroidBuildToolsLocator } from "../../fakes/FakeAndroidBuildToolsLocator";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeSimctl } from "../../fakes/FakeSimctl";

const createExecResult = (stdout: string, stderr: string = ""): ExecResult => ({
  stdout,
  stderr,
  toString: () => stdout,
  trim: () => stdout.trim(),
  includes: (searchString: string) => stdout.includes(searchString)
});

class FakeDeviceAppInstaller implements DeviceAppInstaller {
  public calls: Array<{ deviceUdid: string; artifactPath: string }> = [];
  public shouldThrow: Error | null = null;

  async installApp(deviceUdid: string, artifactPath: string): Promise<void> {
    this.calls.push({ deviceUdid, artifactPath });
    if (this.shouldThrow) {
      throw this.shouldThrow;
    }
  }
}

describe("InstallApp", () => {
  const device: BootedDevice = {
    deviceId: "emulator-5554",
    name: "Test Device",
    platform: "android"
  };
  const iosSimulatorDevice: BootedDevice = {
    deviceId: "A1B2C3D4-E5F6-7890-ABCD-EF1234567890",
    name: "iPhone 15",
    platform: "ios"
  };
  const iosPhysicalDevice: BootedDevice = {
    deviceId: "00008101-001A2B3C4D5E6F78",
    name: "Jason's iPhone",
    platform: "ios"
  };

  let fakeAdb: FakeAdbExecutor;
  let fakeAdbFactory: AdbClientFactory;
  let fakeHost: FakeHostCommandExecutor;
  let fakeLocator: FakeAndroidBuildToolsLocator;
  let fakeTimer: FakeTimer;

  beforeEach(() => {
    fakeAdb = new FakeAdbExecutor();
    fakeAdbFactory = { create: () => fakeAdb };
    fakeHost = new FakeHostCommandExecutor();
    fakeLocator = new FakeAndroidBuildToolsLocator();
    fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
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
      fakeAdbFactory,
      fakeHost,
      fakeLocator,
      () => perf
    );

    const result = await installApp.execute(apkPath);

    expect(result.success).toBe(true);
    expect(result.upgrade).toBe(false);
    expect(result.userId).toBe(10);
    expect(result.packageName).toBe("com.example.app");
    expect(result.warning).toBeUndefined();
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

  test("falls back to package diffing when aapt is unavailable", async () => {
    class SequencedFakeAdbExecutor extends FakeAdbExecutor {
      private listPackagesResponses: ExecResult[] = [];

      setListPackagesResponses(responses: ExecResult[]): void {
        this.listPackagesResponses = [...responses];
      }

      override async executeCommand(
        command: string,
        timeoutMs?: number,
        maxBuffer?: number,
        noRetry?: boolean,
        signal?: AbortSignal
      ): Promise<ExecResult> {
        if (command.includes("shell pm list packages --user 0")) {
          const response = this.listPackagesResponses.shift();
          if (response) {
            await super.executeCommand(command, timeoutMs, maxBuffer, noRetry, signal);
            return response;
          }
        }
        return super.executeCommand(command, timeoutMs, maxBuffer, noRetry, signal);
      }
    }

    const apkPath = "/tmp/app-debug.apk";
    const perf = createPerformanceTracker(true, fakeTimer);
    const sequencedAdb = new SequencedFakeAdbExecutor();

    fakeLocator.setTool(null);
    sequencedAdb.setListPackagesResponses([
      createExecResult("package:com.example.before\n"),
      createExecResult("package:com.example.before\npackage:com.example.new\n")
    ]);
    sequencedAdb.setCommandResponse(`install --user 0 -r \"${apkPath}\"`, createExecResult("Success"));

    const installApp = new InstallApp(
      device,
      { create: () => sequencedAdb },
      fakeHost,
      fakeLocator,
      () => perf
    );

    const result = await installApp.execute(apkPath);

    expect(result.success).toBe(true);
    expect(result.upgrade).toBe(false);
    expect(result.userId).toBe(0);
    expect(result.packageName).toBe("com.example.new");
    expect(result.warning).toContain("aapt2");
    expect(fakeHost.wasCommandExecuted("aapt2")).toBe(false);
    expect(sequencedAdb.wasCommandExecuted("shell pm list packages --user 0")).toBe(true);
    expect(sequencedAdb.wasCommandExecuted("install --user 0 -r")).toBe(true);
  });

  test("returns a warning when aapt is unavailable and install fails", async () => {
    const apkPath = "/tmp/app-debug.apk";
    const perf = createPerformanceTracker(true, fakeTimer);

    fakeLocator.setTool(null);

    const installApp = new InstallApp(
      device,
      fakeAdbFactory,
      fakeHost,
      fakeLocator,
      () => perf
    );

    const result = await installApp.execute(apkPath);

    expect(result.success).toBe(false);
    expect(result.warning).toContain("aapt2");
  });

  test("installs iOS .app on simulator via simctl and detects new bundle id", async () => {
    class SequencedFakeSimctl extends FakeSimctl {
      private listResponses: any[][] = [];

      setListResponses(responses: any[][]): void {
        this.listResponses = [...responses];
      }

      override async listApps(deviceId?: string): Promise<any[]> {
        const response = this.listResponses.shift();
        if (response) {
          return response;
        }
        return super.listApps(deviceId);
      }
    }

    const appPath = "/tmp/MyApp.app";
    const perf = createPerformanceTracker(true, fakeTimer);
    const sequencedSimctl = new SequencedFakeSimctl();
    sequencedSimctl.setListResponses([
      [{ bundleId: "com.example.old" }],
      [{ bundleId: "com.example.old" }, { bundleId: "com.example.new" }]
    ]);

    const installApp = new InstallApp(
      iosSimulatorDevice,
      fakeAdbFactory,
      null,
      null,
      () => perf,
      sequencedSimctl
    );

    const result = await installApp.execute(appPath);

    expect(result.success).toBe(true);
    expect(result.packageName).toBe("com.example.new");
    expect(result.upgrade).toBe(false);
    expect(sequencedSimctl.wasMethodCalled("installApp")).toBe(true);
  });

  test("installs iOS .ipa on physical device via devicectl", async () => {
    const ipaPath = "/tmp/MyApp.ipa";
    const perf = createPerformanceTracker(true, fakeTimer);
    const fakeInstaller = new FakeDeviceAppInstaller();

    const installApp = new InstallApp(
      iosPhysicalDevice,
      fakeAdbFactory,
      null,
      null,
      () => perf,
      undefined,
      fakeInstaller
    );

    const result = await installApp.execute(ipaPath);

    expect(result.success).toBe(true);
    expect(result.userId).toBe(0);
    expect(fakeInstaller.calls).toHaveLength(1);
    expect(fakeInstaller.calls[0].deviceUdid).toBe(iosPhysicalDevice.deviceId);
    expect(fakeInstaller.calls[0].artifactPath).toBe(ipaPath);
  });

  test("rejects .ipa on iOS simulator with clear error", async () => {
    const ipaPath = "/tmp/MyApp.ipa";
    const perf = createPerformanceTracker(true, fakeTimer);

    const installApp = new InstallApp(
      iosSimulatorDevice,
      fakeAdbFactory,
      null,
      null,
      () => perf
    );

    await expect(installApp.execute(ipaPath)).rejects.toThrow(
      "iOS simulators do not support .ipa files. Use a .app bundle built for the simulator instead."
    );
  });

  test("rejects .app on iOS physical device with clear error", async () => {
    const appPath = "/tmp/MyApp.app";
    const perf = createPerformanceTracker(true, fakeTimer);

    const installApp = new InstallApp(
      iosPhysicalDevice,
      fakeAdbFactory,
      null,
      null,
      () => perf
    );

    await expect(installApp.execute(appPath)).rejects.toThrow(
      "iOS physical devices do not support .app bundles. Use a signed .ipa file instead."
    );
  });

  test("rejects .apk on iOS device with clear error", async () => {
    const apkPath = "/tmp/app-debug.apk";
    const perf = createPerformanceTracker(true, fakeTimer);

    const installApp = new InstallApp(
      iosSimulatorDevice,
      fakeAdbFactory,
      null,
      null,
      () => perf
    );

    await expect(installApp.execute(apkPath)).rejects.toThrow(
      'iOS devices only support .app bundles (simulator) and .ipa files (physical device), but got ".apk" file.'
    );
  });

  test("rejects .app on Android device with clear error", async () => {
    const appPath = "/tmp/MyApp.app";
    const perf = createPerformanceTracker(true, fakeTimer);

    const installApp = new InstallApp(
      device,
      fakeAdbFactory,
      fakeHost,
      fakeLocator,
      () => perf
    );

    await expect(installApp.execute(appPath)).rejects.toThrow(
      'Android devices only support .apk files, but got ".app" file. Use an .apk file for Android installation.'
    );
  });

  test("rejects .ipa on Android device with clear error", async () => {
    const ipaPath = "/tmp/MyApp.ipa";
    const perf = createPerformanceTracker(true, fakeTimer);

    const installApp = new InstallApp(
      device,
      fakeAdbFactory,
      fakeHost,
      fakeLocator,
      () => perf
    );

    await expect(installApp.execute(ipaPath)).rejects.toThrow(
      'Android devices only support .apk files, but got ".ipa" file. Use an .apk file for Android installation.'
    );
  });

  test("resolves relative artifact path to absolute", async () => {
    const perf = createPerformanceTracker(true, fakeTimer);

    fakeLocator.setTool({ tool: "aapt2", path: "/sdk/build-tools/35.0.0/aapt2" });
    fakeHost.setCommandResponse("aapt2", createExecResult("package: name='com.example.app' versionCode='1'"));
    fakeAdb.setCommandResponse("shell pm list packages --user 0 -f com.example.app", createExecResult("0"));

    const cwd = process.cwd();
    const expectedAbsolute = `${cwd}/relative/path/app.apk`;
    fakeAdb.setCommandResponse(`install --user 0 -r "${expectedAbsolute}"`, createExecResult("Success"));

    const installApp = new InstallApp(device, fakeAdbFactory, fakeHost, fakeLocator, () => perf);
    const result = await installApp.execute("relative/path/app.apk");

    expect(result.success).toBe(true);
    expect(fakeAdb.wasCommandExecuted(`install --user 0 -r "${expectedAbsolute}"`)).toBe(true);
  });

  test("detects iOS simulator upgrade when bundle already installed", async () => {
    class SequencedFakeSimctl extends FakeSimctl {
      private listResponses: any[][] = [];
      setListResponses(responses: any[][]): void { this.listResponses = [...responses]; }
      override async listApps(deviceId?: string): Promise<any[]> {
        return this.listResponses.shift() ?? super.listApps(deviceId);
      }
    }

    const appPath = "/tmp/MyApp.app";
    const perf = createPerformanceTracker(true, fakeTimer);
    const sequencedSimctl = new SequencedFakeSimctl();
    sequencedSimctl.setListResponses([
      [{ bundleId: "com.example.app", bundlePath: "/tmp/MyApp.app" }],
      [{ bundleId: "com.example.app", bundlePath: "/tmp/MyApp.app" }]
    ]);

    const installApp = new InstallApp(iosSimulatorDevice, fakeAdbFactory, null, null, () => perf, sequencedSimctl);
    const result = await installApp.execute(appPath);

    expect(result.success).toBe(true);
    expect(result.upgrade).toBe(true);
    expect(result.packageName).toBe("com.example.app");
    expect(result.warning).toBeUndefined();
  });

  test("detects iOS simulator bundle ID via path match", async () => {
    class SequencedFakeSimctl extends FakeSimctl {
      private listResponses: any[][] = [];
      setListResponses(responses: any[][]): void { this.listResponses = [...responses]; }
      override async listApps(deviceId?: string): Promise<any[]> {
        return this.listResponses.shift() ?? super.listApps(deviceId);
      }
    }

    const appPath = "/tmp/MyApp.app";
    const perf = createPerformanceTracker(true, fakeTimer);
    const sequencedSimctl = new SequencedFakeSimctl();
    sequencedSimctl.setListResponses([
      [],
      [{ bundleId: "com.example.pathmatched", bundlePath: "/tmp/MyApp.app" }]
    ]);

    const installApp = new InstallApp(iosSimulatorDevice, fakeAdbFactory, null, null, () => perf, sequencedSimctl);
    const result = await installApp.execute(appPath);

    expect(result.success).toBe(true);
    expect(result.packageName).toBe("com.example.pathmatched");
    expect(result.upgrade).toBe(false);
  });

  test("warns when multiple new bundle IDs detected on iOS simulator", async () => {
    class SequencedFakeSimctl extends FakeSimctl {
      private listResponses: any[][] = [];
      setListResponses(responses: any[][]): void { this.listResponses = [...responses]; }
      override async listApps(deviceId?: string): Promise<any[]> {
        return this.listResponses.shift() ?? super.listApps(deviceId);
      }
    }

    const appPath = "/tmp/MyApp.app";
    const perf = createPerformanceTracker(true, fakeTimer);
    const sequencedSimctl = new SequencedFakeSimctl();
    sequencedSimctl.setListResponses([
      [],
      [{ bundleId: "com.example.a" }, { bundleId: "com.example.b" }]
    ]);

    const installApp = new InstallApp(iosSimulatorDevice, fakeAdbFactory, null, null, () => perf, sequencedSimctl);
    const result = await installApp.execute(appPath);

    expect(result.success).toBe(true);
    expect(result.packageName).toBeUndefined();
    expect(result.warning).toContain("multiple new bundle IDs");
  });

  test("warns when no bundle ID can be determined on iOS simulator", async () => {
    class SequencedFakeSimctl extends FakeSimctl {
      private listResponses: any[][] = [];
      setListResponses(responses: any[][]): void { this.listResponses = [...responses]; }
      override async listApps(deviceId?: string): Promise<any[]> {
        return this.listResponses.shift() ?? super.listApps(deviceId);
      }
    }

    const appPath = "/tmp/MyApp.app";
    const perf = createPerformanceTracker(true, fakeTimer);
    const sequencedSimctl = new SequencedFakeSimctl();
    sequencedSimctl.setListResponses([
      [{ bundleId: "com.example.existing" }],
      [{ bundleId: "com.example.existing" }]
    ]);

    const installApp = new InstallApp(iosSimulatorDevice, fakeAdbFactory, null, null, () => perf, sequencedSimctl);
    const result = await installApp.execute(appPath);

    expect(result.success).toBe(true);
    expect(result.packageName).toBeUndefined();
    expect(result.warning).toContain("bundle ID could not be determined");
  });

  test("propagates devicectl failure for iOS physical device install", async () => {
    const ipaPath = "/tmp/MyApp.ipa";
    const perf = createPerformanceTracker(true, fakeTimer);
    const fakeInstaller = new FakeDeviceAppInstaller();
    fakeInstaller.shouldThrow = new Error("devicectl: device not paired");

    const installApp = new InstallApp(iosPhysicalDevice, fakeAdbFactory, null, null, () => perf, undefined, fakeInstaller);

    await expect(installApp.execute(ipaPath)).rejects.toThrow("devicectl: device not paired");
  });

  test("respects abort signal for iOS simulator install", async () => {
    const appPath = "/tmp/MyApp.app";
    const perf = createPerformanceTracker(true, fakeTimer);
    const controller = new AbortController();
    controller.abort();

    const installApp = new InstallApp(iosSimulatorDevice, fakeAdbFactory, null, null, () => perf);

    await expect(installApp.execute(appPath, undefined, controller.signal)).rejects.toThrow("Operation cancelled");
  });

  test("respects abort signal for iOS physical device install", async () => {
    const ipaPath = "/tmp/MyApp.ipa";
    const perf = createPerformanceTracker(true, fakeTimer);
    const fakeInstaller = new FakeDeviceAppInstaller();
    const controller = new AbortController();
    controller.abort();

    const installApp = new InstallApp(iosPhysicalDevice, fakeAdbFactory, null, null, () => perf, undefined, fakeInstaller);

    await expect(installApp.execute(ipaPath, undefined, controller.signal)).rejects.toThrow("Operation cancelled");
  });

  test("detects Android upgrade when package already installed", async () => {
    const apkPath = "/tmp/app-debug.apk";
    const perf = createPerformanceTracker(true, fakeTimer);

    fakeLocator.setTool({ tool: "aapt2", path: "/sdk/build-tools/35.0.0/aapt2" });
    fakeHost.setCommandResponse("aapt2", createExecResult("package: name='com.example.app' versionCode='2'"));
    fakeAdb.setCommandResponse("shell pm list packages --user 0 -f com.example.app", createExecResult("1"));
    fakeAdb.setCommandResponse(`install --user 0 -r "${apkPath}"`, createExecResult("Success"));

    const installApp = new InstallApp(device, fakeAdbFactory, fakeHost, fakeLocator, () => perf);
    const result = await installApp.execute(apkPath);

    expect(result.success).toBe(true);
    expect(result.upgrade).toBe(true);
    expect(result.packageName).toBe("com.example.app");
  });

  test("handles case-insensitive extensions", async () => {
    const perf = createPerformanceTracker(true, fakeTimer);

    fakeLocator.setTool({ tool: "aapt2", path: "/sdk/build-tools/35.0.0/aapt2" });
    fakeHost.setCommandResponse("aapt2", createExecResult("package: name='com.example.app' versionCode='1'"));
    fakeAdb.setCommandResponse("shell pm list packages --user 0 -f com.example.app", createExecResult("0"));
    fakeAdb.setCommandResponse('install --user 0 -r "/tmp/app.APK"', createExecResult("Success"));

    const installApp = new InstallApp(device, fakeAdbFactory, fakeHost, fakeLocator, () => perf);
    const result = await installApp.execute("/tmp/app.APK");

    expect(result.success).toBe(true);
  });

  test("rejects unknown extension on iOS", async () => {
    const perf = createPerformanceTracker(true, fakeTimer);
    const installApp = new InstallApp(iosSimulatorDevice, fakeAdbFactory, null, null, () => perf);

    await expect(installApp.execute("/tmp/MyApp.zip")).rejects.toThrow(
      'iOS devices only support .app bundles (simulator) and .ipa files (physical device), but got ".zip" file.'
    );
  });

  test("rejects unknown extension on Android", async () => {
    const perf = createPerformanceTracker(true, fakeTimer);
    const installApp = new InstallApp(device, fakeAdbFactory, fakeHost, fakeLocator, () => perf);

    await expect(installApp.execute("/tmp/MyApp.zip")).rejects.toThrow(
      'Android devices only support .apk files, but got ".zip" file.'
    );
  });

  test("rejects file with no extension on iOS", async () => {
    const perf = createPerformanceTracker(true, fakeTimer);
    const installApp = new InstallApp(iosSimulatorDevice, fakeAdbFactory, null, null, () => perf);

    await expect(installApp.execute("/tmp/MyApp")).rejects.toThrow(
      'iOS devices only support .app bundles (simulator) and .ipa files (physical device), but got "" file.'
    );
  });

  test("rejects file with no extension on Android", async () => {
    const perf = createPerformanceTracker(true, fakeTimer);
    const installApp = new InstallApp(device, fakeAdbFactory, fakeHost, fakeLocator, () => perf);

    await expect(installApp.execute("/tmp/MyApp")).rejects.toThrow(
      'Android devices only support .apk files, but got "" file.'
    );
  });

  test("iOS physical device install returns warning about bundle ID detection", async () => {
    const ipaPath = "/tmp/MyApp.ipa";
    const perf = createPerformanceTracker(true, fakeTimer);
    const fakeInstaller = new FakeDeviceAppInstaller();

    const installApp = new InstallApp(iosPhysicalDevice, fakeAdbFactory, null, null, () => perf, undefined, fakeInstaller);
    const result = await installApp.execute(ipaPath);

    expect(result.warning).toContain("Bundle ID detection is not available");
    expect(result.upgrade).toBe(false);
  });
});
