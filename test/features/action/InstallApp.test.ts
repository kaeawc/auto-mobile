import { expect, describe, test, beforeEach, afterEach } from "bun:test";
import { InstallApp, type DeviceAppInstaller } from "../../../src/features/action/InstallApp";
import { createPerformanceTracker, type TimingEntry } from "../../../src/utils/PerformanceTracker";
import type { BootedDevice, ExecResult } from "../../../src/models";
import { AdbClientFactory } from "../../../src/utils/android-cmdline-tools/AdbClientFactory";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeHostCommandExecutor } from "../../fakes/FakeHostCommandExecutor";
import { FakeAndroidBuildToolsLocator } from "../../fakes/FakeAndroidBuildToolsLocator";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeSimctl } from "../../fakes/FakeSimctl";
import { FakeInstalledAppsRepository } from "../../fakes/FakeInstalledAppsRepository";
import path from "path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { DAEMON_LAUNCH_CWD_ENV } from "../../../src/utils/workingDirectory";
import type { PlistReader } from "../../../src/utils/ios-cmdline-tools/PlistClient";

const createExecResult = (stdout: string, stderr: string = ""): ExecResult => ({
  stdout,
  stderr,
  toString: () => stdout,
  trim: () => stdout.trim(),
  includes: (searchString: string) => stdout.includes(searchString)
});

class SequencedFakeSimctl extends FakeSimctl {
  private listResponses: any[][] = [];

  setListResponses(responses: any[][]): void {
    this.listResponses = [...responses];
  }

  override async listApps(deviceId?: string): Promise<any[]> {
    return this.listResponses.shift() ?? super.listApps(deviceId);
  }
}

class DowngradeFakeSimctl extends SequencedFakeSimctl {
  public installError: Error | null = null;
  private installCalls = 0;

  override async installApp(appPath: string, deviceId?: string): Promise<void> {
    this.installCalls++;
    if (this.installCalls === 1 && this.installError) {
      throw this.installError;
    }
    return super.installApp(appPath, deviceId);
  }
}

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

function fakePlist(bundleId: string): PlistReader {
  return {
    readJsonFile: async () => ({}),
    readJsonBytes: async () => ({}),
    readXmlFile: async () => "",
    readXmlBytes: async () => "",
    extractRawFile: async () => bundleId,
  };
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
  const tempDirs: string[] = [];
  const originalLaunchCwd = process.env[DAEMON_LAUNCH_CWD_ENV];

  beforeEach(() => {
    fakeAdb = new FakeAdbExecutor();
    fakeAdbFactory = { create: () => fakeAdb };
    fakeHost = new FakeHostCommandExecutor();
    fakeLocator = new FakeAndroidBuildToolsLocator();
    fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
  });

  afterEach(() => {
    if (originalLaunchCwd === undefined) {
      delete process.env[DAEMON_LAUNCH_CWD_ENV];
    } else {
      process.env[DAEMON_LAUNCH_CWD_ENV] = originalLaunchCwd;
    }
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  test("installs using aapt2 and targets work profile user", async () => {
    const apkPath = "/tmp/app-debug.apk";
    const perf = createPerformanceTracker(true, fakeTimer);

    fakeLocator.setTool({ tool: "aapt2", path: "/sdk/build-tools/35.0.0/aapt2" });
    fakeHost.setCommandResponse("aapt2", createExecResult("package: name='com.example.app' versionCode='1'"));

    fakeAdb.setUsers([
      { userId: 0, name: "Owner", flags: 0x13, running: true },
      { userId: 10, name: "Work", flags: 0x30, running: true }
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

    // Nesting invariant (issue #4169 item 15): the whole install is owned by a
    // single "installApp" root and every phase is nested under it. Asserting the
    // exact child NAMES makes a pure rename of a perf block break CI with no
    // behavior change; asserting the ownership SHAPE still catches the real
    // regression — a premature perf.end() that reparents phases to the top level.
    const timings = perf.getTimings() as TimingEntry[];
    expect(timings).toHaveLength(1);
    const installEntry = timings[0];
    expect(installEntry.name).toBe("installApp");
    expect((installEntry.children as TimingEntry[]).length).toBeGreaterThan(0);
  });

  test("marks the Android installed-apps cache stale after a successful install", async () => {
    const apkPath = "/tmp/app-debug.apk";
    const repo = new FakeInstalledAppsRepository();
    await repo.upsertInstalledApp(device.deviceId, 0, "com.example.previous", false, 1_000);

    fakeLocator.setTool({ tool: "aapt2", path: "/sdk/build-tools/35.0.0/aapt2" });
    fakeHost.setCommandResponse("aapt2", createExecResult("package: name='com.example.app' versionCode='1'"));
    fakeAdb.setUsers([{ userId: 0, name: "Owner", flags: 0x13, running: true }]);
    fakeAdb.setCommandResponse("shell pm list packages --user 0 -f com.example.app", createExecResult("0"));
    fakeAdb.setCommandResponse(`install --user 0 -r "${apkPath}"`, createExecResult("Success"));

    const installApp = new InstallApp(
      device,
      fakeAdbFactory,
      fakeHost,
      fakeLocator,
      () => createPerformanceTracker(true, fakeTimer),
      null,
      null,
      undefined,
      repo
    );

    await installApp.execute(apkPath);

    expect(await repo.getLatestVerification(device.deviceId)).toBe(0);
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
    const repo = new FakeInstalledAppsRepository();
    await repo.upsertInstalledApp(device.deviceId, 0, "com.example.previous", false, 1_000);

    fakeLocator.setTool(null);

    const installApp = new InstallApp(
      device,
      fakeAdbFactory,
      fakeHost,
      fakeLocator,
      () => perf,
      null,
      null,
      undefined,
      repo
    );

    const result = await installApp.execute(apkPath);

    expect(result.success).toBe(false);
    expect(result.warning).toContain("aapt2");
    expect(await repo.getLatestVerification(device.deviceId)).toBe(1_000);
  });

  test("invalidates the cache before package discovery after a successful install", async () => {
    class PackageDiscoveryFailureAdb extends FakeAdbExecutor {
      private listPackagesCalls = 0;

      override async executeCommand(
        command: string,
        timeoutMs?: number,
        maxBuffer?: number,
        noRetry?: boolean,
        signal?: AbortSignal
      ): Promise<ExecResult> {
        if (command === "shell pm list packages --user 0") {
          this.listPackagesCalls++;
          if (this.listPackagesCalls === 2) {
            throw new Error("ADB disconnected after install");
          }
        }
        return super.executeCommand(command, timeoutMs, maxBuffer, noRetry, signal);
      }
    }

    const apkPath = "/tmp/app-debug.apk";
    const repo = new FakeInstalledAppsRepository();
    const adb = new PackageDiscoveryFailureAdb();
    await repo.upsertInstalledApp(device.deviceId, 0, "com.example.previous", false, 1_000);
    fakeLocator.setTool(null);
    adb.setCommandResponse("shell pm list packages --user 0", createExecResult("package:com.example.previous\n"));
    adb.setCommandResponse(`install --user 0 -r "${apkPath}"`, createExecResult("Success"));

    const installApp = new InstallApp(
      device,
      { create: () => adb },
      fakeHost,
      fakeLocator,
      () => createPerformanceTracker(true, fakeTimer),
      null,
      null,
      undefined,
      repo
    );

    await expect(installApp.execute(apkPath)).rejects.toThrow("ADB disconnected after install");

    expect(await repo.getLatestVerification(device.deviceId)).toBe(0);
  });

  test("installs iOS .app on simulator via simctl and detects new bundle id", async () => {
    const appPath = "/tmp/MyApp.app";
    const perf = createPerformanceTracker(true, fakeTimer);
    const sequencedSimctl = new SequencedFakeSimctl();
    sequencedSimctl.setListResponses([
      [{ bundleId: "com.example.old" }],
      [{ bundleId: "com.example.old" }, { bundleId: "com.example.new" }]
    ]);
    fakeHost.setCommandResponse("plutil", createExecResult("com.example.unused\n"));
    const repo = new FakeInstalledAppsRepository();
    await repo.upsertInstalledApp(iosSimulatorDevice.deviceId, 0, "com.example.old", false, 1_000);

    const installApp = new InstallApp(
      iosSimulatorDevice,
      fakeAdbFactory,
      fakeHost,
      null,
      () => perf,
      sequencedSimctl,
      null,
      undefined,
      repo
    );

    const result = await installApp.execute(appPath);

    expect(result.success).toBe(true);
    expect(result.packageName).toBe("com.example.new");
    expect(result.upgrade).toBe(false);
    expect(sequencedSimctl.wasMethodCalled("installApp")).toBe(true);
    expect(fakeHost.wasCommandExecuted("plutil")).toBe(false);
    expect(await repo.getLatestVerification(iosSimulatorDevice.deviceId)).toBe(0);
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

  // Issue #4169 item 7: artifact-extension routing as one specification table,
  // including the boundary rows that were previously unspecified — a double
  // extension (".apk.zip" → ".zip"), a trailing dot ("/tmp/MyApp." → "." per
  // path.extname), a dotfile ("/tmp/.apk" → "" — no extension), and a bare name
  // (no extension → ""). Rejections throw BEFORE any device I/O, so no host /
  // locator / simctl fakes are needed.
  describe("artifact extension routing rejects the wrong artifact", () => {
    // Android accepts only .apk; the thrown message echoes the extracted ext.
    const androidRejections: Array<[string, string]> = [
      [".app bundle", "/tmp/MyApp.app"],
      [".ipa file", "/tmp/MyApp.ipa"],
      [".zip file", "/tmp/MyApp.zip"],
      ["double extension keeps only the last segment", "/tmp/MyApp.apk.zip"],
      ["trailing dot", "/tmp/MyApp."],
      ["dotfile with no real extension", "/tmp/.apk"],
      ["no extension", "/tmp/MyApp"]
    ];
    const androidExpectedExt: Record<string, string> = {
      "/tmp/MyApp.app": ".app",
      "/tmp/MyApp.ipa": ".ipa",
      "/tmp/MyApp.zip": ".zip",
      "/tmp/MyApp.apk.zip": ".zip",
      "/tmp/MyApp.": ".",
      "/tmp/.apk": "",
      "/tmp/MyApp": ""
    };

    test.each(androidRejections)("Android rejects a %s", async (_name, artifactPath) => {
      const perf = createPerformanceTracker(true, fakeTimer);
      const installApp = new InstallApp(device, fakeAdbFactory, fakeHost, fakeLocator, () => perf);

      await expect(installApp.execute(artifactPath)).rejects.toThrow(
        `Android devices only support .apk files, but got "${androidExpectedExt[artifactPath]}" file. Use an .apk file for Android installation.`
      );
    });

    // iOS simulator accepts only .app; an .ipa gets a simulator-specific message,
    // anything else falls through to the generic "only .app/.ipa" message.
    const iosSimulatorRejections: Array<[string, string, string]> = [
      [
        ".ipa file",
        "/tmp/MyApp.ipa",
        "iOS simulators do not support .ipa files. Use a .app bundle built for the simulator instead."
      ],
      [
        ".apk file",
        "/tmp/app-debug.apk",
        'iOS devices only support .app bundles (simulator) and .ipa files (physical device), but got ".apk" file.'
      ],
      [
        ".zip file",
        "/tmp/MyApp.zip",
        'iOS devices only support .app bundles (simulator) and .ipa files (physical device), but got ".zip" file.'
      ],
      [
        "trailing dot",
        "/tmp/MyApp.",
        'iOS devices only support .app bundles (simulator) and .ipa files (physical device), but got "." file.'
      ],
      [
        "no extension",
        "/tmp/MyApp",
        'iOS devices only support .app bundles (simulator) and .ipa files (physical device), but got "" file.'
      ]
    ];

    test.each(iosSimulatorRejections)(
      "iOS simulator rejects a %s",
      async (_name, artifactPath, expectedMessage) => {
        const perf = createPerformanceTracker(true, fakeTimer);
        const installApp = new InstallApp(iosSimulatorDevice, fakeAdbFactory, null, null, () => perf);

        await expect(installApp.execute(artifactPath)).rejects.toThrow(expectedMessage);
      }
    );

    // iOS physical accepts only .ipa; a .app gets a physical-specific message.
    const iosPhysicalRejections: Array<[string, string, string]> = [
      [
        ".app bundle",
        "/tmp/MyApp.app",
        "iOS physical devices do not support .app bundles. Use a signed .ipa file instead."
      ],
      [
        ".apk file",
        "/tmp/app-debug.apk",
        'iOS devices only support .app bundles (simulator) and .ipa files (physical device), but got ".apk" file.'
      ]
    ];

    test.each(iosPhysicalRejections)(
      "iOS physical device rejects a %s",
      async (_name, artifactPath, expectedMessage) => {
        const perf = createPerformanceTracker(true, fakeTimer);
        const installApp = new InstallApp(iosPhysicalDevice, fakeAdbFactory, null, null, () => perf);

        await expect(installApp.execute(artifactPath)).rejects.toThrow(expectedMessage);
      }
    );
  });

  test("resolves relative artifact path to absolute", async () => {
    const perf = createPerformanceTracker(true, fakeTimer);

    fakeLocator.setTool({ tool: "aapt2", path: "/sdk/build-tools/35.0.0/aapt2" });
    fakeHost.setCommandResponse("aapt2", createExecResult("package: name='com.example.app' versionCode='1'"));
    fakeAdb.setCommandResponse("shell pm list packages --user 0 -f com.example.app", createExecResult("0"));

    const expectedAbsolute = path.resolve(process.cwd(), "relative", "path", "app.apk");
    fakeAdb.setCommandResponse(`install --user 0 -r "${expectedAbsolute}"`, createExecResult("Success"));

    const installApp = new InstallApp(device, fakeAdbFactory, fakeHost, fakeLocator, () => perf);
    const result = await installApp.execute(path.join("relative", "path", "app.apk"));

    expect(result.success).toBe(true);
    expect(fakeAdb.wasCommandExecuted(`install --user 0 -r "${expectedAbsolute}"`)).toBe(true);
  });

  test("resolves relative artifact path from daemon launch cwd when daemon cwd is stable", async () => {
    const perf = createPerformanceTracker(true, fakeTimer);
    const launchCwd = mkdtempSync(path.join(tmpdir(), "install-app-launch-cwd-"));
    tempDirs.push(launchCwd);
    process.env[DAEMON_LAUNCH_CWD_ENV] = launchCwd;

    fakeLocator.setTool({ tool: "aapt2", path: "/sdk/build-tools/35.0.0/aapt2" });
    fakeHost.setCommandResponse("aapt2", createExecResult("package: name='com.example.app' versionCode='1'"));
    fakeAdb.setCommandResponse("shell pm list packages --user 0 -f com.example.app", createExecResult("0"));

    const expectedAbsolute = path.resolve(launchCwd, "relative", "path", "app.apk");
    fakeAdb.setCommandResponse(`install --user 0 -r "${expectedAbsolute}"`, createExecResult("Success"));

    const installApp = new InstallApp(device, fakeAdbFactory, fakeHost, fakeLocator, () => perf);
    const result = await installApp.execute(path.join("relative", "path", "app.apk"));

    expect(result.success).toBe(true);
    expect(fakeAdb.wasCommandExecuted(`install --user 0 -r "${expectedAbsolute}"`)).toBe(true);
  });

  test("detects iOS simulator upgrade when bundle already installed", async () => {
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
    const appPath = "/tmp/MyApp.app";
    const perf = createPerformanceTracker(true, fakeTimer);
    const sequencedSimctl = new SequencedFakeSimctl();
    sequencedSimctl.setListResponses([
      [],
      [{ bundleId: "com.example.a" }, { bundleId: "com.example.b" }]
    ]);
    fakeHost.setCommandResponse("plutil", createExecResult(""));

    const installApp = new InstallApp(iosSimulatorDevice, fakeAdbFactory, fakeHost, null, () => perf, sequencedSimctl, null, fakePlist(""));
    const result = await installApp.execute(appPath);

    expect(result.success).toBe(true);
    expect(result.packageName).toBeUndefined();
    expect(result.warning).toContain("multiple new bundle IDs");
  });

  test("warns when no bundle ID can be determined on iOS simulator", async () => {
    const appPath = "/tmp/MyApp.app";
    const perf = createPerformanceTracker(true, fakeTimer);
    const sequencedSimctl = new SequencedFakeSimctl();
    sequencedSimctl.setListResponses([
      [{ bundleId: "com.example.existing" }],
      [{ bundleId: "com.example.existing" }]
    ]);
    fakeHost.setCommandResponse("plutil", createExecResult(""));

    const installApp = new InstallApp(iosSimulatorDevice, fakeAdbFactory, fakeHost, null, () => perf, sequencedSimctl, null, fakePlist(""));
    const result = await installApp.execute(appPath);

    expect(result.success).toBe(true);
    expect(result.packageName).toBeUndefined();
    expect(result.warning).toContain("bundle ID could not be determined");
  });

  test("iOS simulator install fails when expected bundle is absent after simctl success", async () => {
    const appPath = "/tmp/MyApp.app";
    const perf = createPerformanceTracker(true, fakeTimer);
    const sequencedSimctl = new SequencedFakeSimctl();
    sequencedSimctl.setListResponses([
      [],
      []
    ]);
    fakeHost.setCommandResponse("plutil", createExecResult("com.example.app\n"));

    const installApp = new InstallApp(iosSimulatorDevice, fakeAdbFactory, fakeHost, null, () => perf, sequencedSimctl, null, fakePlist("com.example.app\n"));

    await expect(installApp.execute(appPath)).rejects.toThrow(
      "Install reported success, but bundle com.example.app was not present"
    );
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

  test("treats grep -c failure as not installed instead of throwing", async () => {
    const apkPath = "/tmp/app-debug.apk";
    const perf = createPerformanceTracker(true, fakeTimer);

    fakeLocator.setTool({ tool: "aapt2", path: "/sdk/build-tools/35.0.0/aapt2" });
    fakeHost.setCommandResponse("aapt2", createExecResult("package: name='com.example.app' versionCode='1'"));

    fakeAdb.setUsers([{ userId: 0, name: "Owner", flags: 13, running: true }]);
    // Simulate grep -c exiting with code 1 when package is not found
    fakeAdb.setCommandError("grep -c com.example.app", new Error("Command failed with exit code 1"));
    fakeAdb.setCommandResponse(`install --user 0 -r "${apkPath}"`, createExecResult("Success"));

    const installApp = new InstallApp(device, fakeAdbFactory, fakeHost, fakeLocator, () => perf);
    const result = await installApp.execute(apkPath);

    expect(result.success).toBe(true);
    expect(result.upgrade).toBe(false);
    expect(result.packageName).toBe("com.example.app");
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

  test("iOS physical device install returns warning about bundle ID detection", async () => {
    const ipaPath = "/tmp/MyApp.ipa";
    const perf = createPerformanceTracker(true, fakeTimer);
    const fakeInstaller = new FakeDeviceAppInstaller();

    const installApp = new InstallApp(iosPhysicalDevice, fakeAdbFactory, null, null, () => perf, undefined, fakeInstaller);
    const result = await installApp.execute(ipaPath);

    expect(result.warning).toContain("Bundle ID detection is not available");
    expect(result.upgrade).toBe(false);
  });

  test("Android recovers from version downgrade by uninstalling then reinstalling", async () => {
    const apkPath = "/tmp/app-debug.apk";
    const perf = createPerformanceTracker(true, fakeTimer);

    fakeLocator.setTool({ tool: "aapt2", path: "/sdk/build-tools/35.0.0/aapt2" });
    fakeHost.setCommandResponse("aapt2", createExecResult("package: name='com.example.app' versionCode='1'"));
    fakeAdb.setUsers([{ userId: 0, name: "Owner", flags: 13, running: true }]);
    fakeAdb.setCommandResponse("shell pm list packages --user 0 -f com.example.app", createExecResult("1"));
    fakeAdb.setCommandResponseSequence(`install --user 0 -r "${apkPath}"`, [
      createExecResult("", "Failure [INSTALL_FAILED_VERSION_DOWNGRADE]"),
      createExecResult("Success")
    ]);

    const installApp = new InstallApp(device, fakeAdbFactory, fakeHost, fakeLocator, () => perf);
    const result = await installApp.execute(apkPath);

    expect(result.success).toBe(true);
    expect(result.upgrade).toBe(false);
    expect(result.packageName).toBe("com.example.app");
    expect(result.warning).toContain("uninstalled it and reinstalled");
    expect(fakeAdb.wasCommandExecuted("uninstall com.example.app")).toBe(true);
  });

  test("invalidates the cache when downgrade recovery uninstalls but reinstall fails", async () => {
    const apkPath = "/tmp/app-debug.apk";
    const perf = createPerformanceTracker(true, fakeTimer);
    const repo = new FakeInstalledAppsRepository();
    await repo.upsertInstalledApp(device.deviceId, 0, "com.example.app", false, 1_000);

    fakeLocator.setTool({ tool: "aapt2", path: "/sdk/build-tools/35.0.0/aapt2" });
    fakeHost.setCommandResponse("aapt2", createExecResult("package: name='com.example.app' versionCode='1'"));
    fakeAdb.setUsers([{ userId: 0, name: "Owner", flags: 13, running: true }]);
    fakeAdb.setCommandResponse("shell pm list packages --user 0 -f com.example.app", createExecResult("1"));
    fakeAdb.setCommandResponseSequence(`install --user 0 -r "${apkPath}"`, [
      createExecResult("", "Failure [INSTALL_FAILED_VERSION_DOWNGRADE]"),
      createExecResult("", "Failure [INSTALL_FAILED_INVALID_APK]")
    ]);

    const installApp = new InstallApp(
      device,
      fakeAdbFactory,
      fakeHost,
      fakeLocator,
      () => perf,
      null,
      null,
      undefined,
      repo
    );

    const result = await installApp.execute(apkPath);

    expect(result.success).toBe(false);
    expect(await repo.getLatestVerification(device.deviceId)).toBe(0);
  });

  test("Android downgrade without a resolvable package name surfaces a clear error", async () => {
    const apkPath = "/tmp/app-debug.apk";
    const perf = createPerformanceTracker(true, fakeTimer);

    fakeLocator.setTool(null); // no aapt2 → package name cannot be determined
    fakeAdb.setCommandResponse(
      `install --user 0 -r "${apkPath}"`,
      createExecResult("", "Failure [INSTALL_FAILED_VERSION_DOWNGRADE]")
    );

    const installApp = new InstallApp(device, fakeAdbFactory, fakeHost, fakeLocator, () => perf);

    await expect(installApp.execute(apkPath)).rejects.toThrow("INSTALL_FAILED_VERSION_DOWNGRADE");
    expect(fakeAdb.wasCommandExecuted("uninstall")).toBe(false);
  });

  test("Android non-downgrade install failure throws the original error without uninstalling", async () => {
    const apkPath = "/tmp/app-debug.apk";
    const perf = createPerformanceTracker(true, fakeTimer);

    fakeLocator.setTool({ tool: "aapt2", path: "/sdk/build-tools/35.0.0/aapt2" });
    fakeHost.setCommandResponse("aapt2", createExecResult("package: name='com.example.app' versionCode='1'"));
    fakeAdb.setCommandResponse("shell pm list packages --user 0 -f com.example.app", createExecResult("0"));
    fakeAdb.setCommandError(`install --user 0 -r "${apkPath}"`, new Error("Failure [INSTALL_FAILED_INVALID_APK]"));

    const installApp = new InstallApp(device, fakeAdbFactory, fakeHost, fakeLocator, () => perf);

    await expect(installApp.execute(apkPath)).rejects.toThrow("INSTALL_FAILED_INVALID_APK");
    expect(fakeAdb.wasCommandExecuted("uninstall com.example.app")).toBe(false);
  });

  test("iOS simulator recovers from version downgrade by uninstalling then reinstalling", async () => {
    const appPath = "/tmp/MyApp.app";
    const perf = createPerformanceTracker(true, fakeTimer);
    const simctl = new DowngradeFakeSimctl();
    simctl.installError = new Error("Unable to install. A newer version of this application is already installed.");
    simctl.setListResponses([
      [{ bundleId: "com.example.app", bundlePath: "/tmp/MyApp.app" }],
      [{ bundleId: "com.example.app", bundlePath: "/tmp/MyApp.app" }]
    ]);
    fakeHost.setCommandResponse("plutil", createExecResult("com.example.app\n"));

    const installApp = new InstallApp(iosSimulatorDevice, fakeAdbFactory, fakeHost, null, () => perf, simctl, null, fakePlist("com.example.app\n"));
    const result = await installApp.execute(appPath);

    expect(result.success).toBe(true);
    expect(result.upgrade).toBe(false);
    expect(result.warning).toContain("uninstalled it and reinstalled");
    expect(simctl.wasMethodCalled("uninstallApp")).toBe(true);
    expect(simctl.getMethodCalls("uninstallApp")[0].bundleId).toBe("com.example.app");
    // Only the successful reinstall is recorded; the first attempt threw before recording.
    expect(simctl.getMethodCallCount("installApp")).toBe(1);
  });

  test("iOS simulator downgrade fails clearly when bundle ID cannot be read", async () => {
    const appPath = "/tmp/MyApp.app";
    const perf = createPerformanceTracker(true, fakeTimer);
    const simctl = new DowngradeFakeSimctl();
    simctl.installError = new Error("A newer version of this application is already installed.");
    simctl.setListResponses([[], []]);
    fakeHost.setCommandResponse("plutil", createExecResult("")); // empty → unresolved bundle id

    const installApp = new InstallApp(iosSimulatorDevice, fakeAdbFactory, fakeHost, null, () => perf, simctl, null, fakePlist(""));

    await expect(installApp.execute(appPath)).rejects.toThrow("bundle identifier could not be read");
    expect(simctl.wasMethodCalled("uninstallApp")).toBe(false);
  });

  test("iOS physical downgrade surfaces actionable uninstall guidance", async () => {
    const ipaPath = "/tmp/MyApp.ipa";
    const perf = createPerformanceTracker(true, fakeTimer);
    const fakeInstaller = new FakeDeviceAppInstaller();
    fakeInstaller.shouldThrow = new Error("Unable to Install. A newer version of this application is already installed.");

    const installApp = new InstallApp(iosPhysicalDevice, fakeAdbFactory, null, null, () => perf, undefined, fakeInstaller);

    await expect(installApp.execute(ipaPath)).rejects.toThrow("Uninstall the app first with uninstallApp");
  });
});
