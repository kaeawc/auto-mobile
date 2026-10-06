import { SimCtlClient } from "../../../src/utils/ios-cmdline-tools/SimCtlClient";
import { DeviceAppManager } from "../../../src/utils/ios-cmdline-tools/DeviceAppManager";
import { DefaultDeviceWindowCacheInvalidator } from "../../../src/features/action/TerminateApp";
import { SimctlCommandTimeoutError } from "../../../src/utils/ios-cmdline-tools/SimctlCommandTimeoutError";
import { SIMULATOR_UNINSTALL_TIMEOUT_MS } from "../../../src/utils/ios-cmdline-tools/simulatorUninstallBound";
import { PlistClient } from "../../../src/utils/ios-cmdline-tools/PlistClient";
import { DefaultHostCommandExecutor } from "../../../src/utils/HostCommandExecutor";
import { DefaultAndroidBuildToolsLocator } from "../../../src/utils/android-cmdline-tools/AndroidBuildToolsLocator";
import { expect, describe, test, beforeEach, afterEach, spyOn } from "bun:test";
import {
  InstallApp as ProductionInstallApp,
  type DeviceAppInstaller,
} from "../../../src/features/action/InstallApp";
import {
  createPerformanceTracker,
  setDebugPerfEnabled,
  type TimingEntry,
} from "../../../src/utils/PerformanceTracker";
import type { BootedDevice, ExecResult } from "../../../src/models";
import { AdbClientFactory } from "../../../src/utils/android-cmdline-tools/AdbClientFactory";
import { AdbCommandTimeoutError } from "../../../src/utils/android-cmdline-tools/AdbClient";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeHostCommandExecutor } from "../../fakes/FakeHostCommandExecutor";
import { FakeAndroidBuildToolsLocator } from "../../fakes/FakeAndroidBuildToolsLocator";
import { FakeTimer } from "../../fakes/FakeTimer";
import { getAbortSignal, runWithAbortSignal } from "../../../src/utils/AbortContext";
import { FakeSimctl } from "../../fakes/FakeSimctl";
import { FakeInstalledAppsRepository } from "../../fakes/FakeInstalledAppsRepository";
import path from "path";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { DAEMON_LAUNCH_CWD_ENV } from "../../../src/utils/workingDirectory";
import type { PlistReader } from "../../../src/utils/ios-cmdline-tools/PlistClient";
import { ActionableError } from "../../../src/models/ActionableError";
import { logger } from "../../../src/utils/logger";
import AdmZip from "adm-zip";
import type { IosPhysicalAppLister } from "../../../src/features/observe/ListInstalledApps";

const playgroundBadgingOutput = readFileSync(
  path.join(import.meta.dir, "../../fixtures/android-playground-debug-badging.txt"),
  "utf8",
);

// Keep action tests isolated from the production SQLite repository even when a
// scenario does not need to inspect stale-marker rows explicitly.
class InstallApp extends ProductionInstallApp {
  constructor(...args: ConstructorParameters<typeof ProductionInstallApp>) {
    const [device, adbFactory, options = {}] = args;
    super(device, adbFactory, {
      ...options,
      installedAppsRepository: options.installedAppsRepository ?? new FakeInstalledAppsRepository(),
    });
  }
}

const createExecResult = (stdout: string, stderr: string = ""): ExecResult => ({
  stdout,
  stderr,
  toString: () => stdout,
  trim: () => stdout.trim(),
  includes: (searchString: string) => stdout.includes(searchString),
});

class InstallAppFakeAdbExecutor extends FakeAdbExecutor {
  honourRequestAbort = false;
  reinstallOperation?: () => Promise<ExecResult>;
  private installAttempts = 0;
  private installSucceeded = false;
  postInstallListingError?: Error;
  reinstallError?: Error;
  postRestoreListingError?: Error;
  postRestoreAbortController?: AbortController;
  private otherUserRestoreCompleted = false;

  override async executeCommand(
    command: string,
    timeoutMs?: number,
    maxBuffer?: number,
    noRetry?: boolean,
    signal?: AbortSignal,
    waitForProcessSettlementAfterAbort?: boolean,
  ): Promise<ExecResult> {
    // Match AdbClient's explicit-or-ambient selection before dispatching.
    const resolvedSignal = this.honourRequestAbort ? (signal ?? getAbortSignal()) : signal;
    if (this.honourRequestAbort) {
      resolvedSignal?.throwIfAborted();
    }
    let result = await super.executeCommand(
      command,
      timeoutMs,
      maxBuffer,
      noRetry,
      resolvedSignal,
      waitForProcessSettlementAfterAbort,
    );
    if (command.startsWith("install ") && ++this.installAttempts === 2 && this.reinstallOperation) {
      result = await this.reinstallOperation();
      if (this.honourRequestAbort) {
        resolvedSignal?.throwIfAborted();
      }
    }
    if (this.otherUserRestoreCompleted && command === "shell pm list packages --user 0") {
      this.postRestoreAbortController?.abort();
    }
    if (command.includes("install-existing")) {
      this.otherUserRestoreCompleted = true;
    }
    if (command.includes("install-existing") && this.postRestoreListingError) {
      this.setCommandError("shell pm list packages --user 0", this.postRestoreListingError);
    }
    if (command.startsWith("install ") && result.stdout.trim() === "Success") {
      this.installSucceeded = true;
      if (this.postInstallListingError) {
        this.setCommandError("shell pm list packages --user ", this.postInstallListingError);
      }
    }
    if (
      command.startsWith("install ") &&
      result.stderr.includes("INSTALL_FAILED_VERSION_DOWNGRADE")
    ) {
      if (this.reinstallError) {
        this.setCommandError(command, this.reinstallError);
      }
    }
    if (
      this.installSucceeded &&
      command.includes("shell pm list packages --user ") &&
      !result.stdout.trim()
    ) {
      return createExecResult("package: com.example.app");
    }
    return result;
  }
}

class SequencedFakeSimctl extends FakeSimctl {
  private listResponses: any[][] = [];
  private strictListResponses: Array<any[] | Error> = [];
  strictListCalls = 0;

  setListResponses(responses: any[][]): void {
    this.listResponses = [...responses];
  }

  override async listApps(deviceId?: string): Promise<any[]> {
    return this.listResponses.shift() ?? super.listApps(deviceId);
  }

  setStrictListResponses(responses: Array<any[] | Error>): void {
    this.strictListResponses = [...responses];
  }

  override async listAppsOrThrow(deviceId?: string): Promise<any[]> {
    this.strictListCalls += 1;
    const response = this.strictListResponses.shift();
    if (response instanceof Error) {
      throw response;
    }
    return response ?? this.listApps(deviceId);
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

class CountingInstalledAppsRepository extends FakeInstalledAppsRepository {
  markStaleCalls = 0;

  override async markDeviceStale(deviceId: string): Promise<void> {
    this.markStaleCalls++;
    await super.markDeviceStale(deviceId);
  }
}

function fakePlist(bundleId: string): PlistReader {
  return {
    readJsonFile: async () => ({}),
    readJsonBytes: async () => ({ CFBundleIdentifier: bundleId }),
    readXmlFile: async () => "",
    readXmlBytes: async () => "",
    extractRawFile: async () => bundleId,
  };
}

describe("InstallApp", () => {
  const device: BootedDevice = {
    deviceId: "emulator-5554",
    name: "Test Device",
    platform: "android",
  };
  const iosSimulatorDevice: BootedDevice = {
    deviceId: "A1B2C3D4-E5F6-7890-ABCD-EF1234567890",
    name: "iPhone 15",
    platform: "ios",
  };
  const iosPhysicalDevice: BootedDevice = {
    deviceId: "00008101-001A2B3C4D5E6F78",
    name: "Jason's iPhone",
    platform: "ios",
  };

  let fakeAdb: FakeAdbExecutor;
  let fakeAdbFactory: AdbClientFactory;
  let fakeHost: FakeHostCommandExecutor;
  let fakeLocator: FakeAndroidBuildToolsLocator;
  let fakeTimer: FakeTimer;
  const tempDirs: string[] = [];
  const originalLaunchCwd = process.env[DAEMON_LAUNCH_CWD_ENV];

  function ipaWithBundleId(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "automobile-install-ipa-"));
    tempDirs.push(dir);
    const ipaPath = path.join(dir, "MyApp.ipa");
    const zip = new AdmZip();
    zip.addFile("Payload/MyApp.app/Info.plist", Buffer.from("plist fixture"));
    zip.writeZip(ipaPath);
    return ipaPath;
  }

  beforeEach(() => {
    fakeAdb = new InstallAppFakeAdbExecutor();
    fakeAdbFactory = { create: () => fakeAdb };
    fakeHost = new FakeHostCommandExecutor();
    fakeLocator = new FakeAndroidBuildToolsLocator();
    fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
  });

  afterEach(() => {
    setDebugPerfEnabled(false);
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

  test("preserves default dependency implementations with omitted options", () => {
    const app = new ProductionInstallApp(device, fakeAdbFactory);
    expect(app["cacheInvalidatorOverride"]).toBeUndefined();
    expect(app["cacheInvalidator"]).toBeInstanceOf(DefaultDeviceWindowCacheInvalidator);
    expect(app["deviceAppInstaller"]).toBeInstanceOf(DeviceAppManager);
    expect(app["simctl"]).toBeInstanceOf(SimCtlClient);
    expect(app["plist"]).toBeInstanceOf(PlistClient);
    expect(app["hostExecutor"]).toBeInstanceOf(DefaultHostCommandExecutor);
    expect(app["buildToolsLocator"]).toBeInstanceOf(DefaultAndroidBuildToolsLocator);
  });

  test("installs using aapt2 and targets work profile user", async () => {
    const apkPath = "/tmp/app-debug.apk";
    const perf = createPerformanceTracker(true, fakeTimer);

    fakeLocator.setTool({ tool: "aapt2", path: "/sdk/build-tools/35.0.0/aapt2" });
    fakeHost.setCommandResponse(
      "aapt2",
      createExecResult("package: name='com.example.app' versionCode='1'"),
    );

    fakeAdb.setUsers([
      { userId: 0, name: "Owner", flags: 0x13, running: true },
      { userId: 10, name: "Work", flags: 0x30, running: true },
    ]);
    fakeAdb.setCommandResponse("shell pm list packages --user 10", createExecResult(""));
    fakeAdb.setCommandResponse(`install --user 10 -r "${apkPath}"`, createExecResult("Success"));

    const installApp = new InstallApp(device, fakeAdbFactory, {
      hostExecutor: fakeHost,
      buildToolsLocator: fakeLocator,
      performanceTrackerFactory: () => perf,
    });

    const result = await installApp.execute(apkPath);

    expect(result.success).toBe(true);
    expect(result.upgrade).toBe(false);
    expect(result.userId).toBe(10);
    expect(result.packageName).toBe("com.example.app");
    expect(result.warning).toBeUndefined();
    expect(fakeHost.wasCommandExecuted("aapt2")).toBe(true);
    expect(fakeAdb.wasCommandExecuted("install --user 10 -r")).toBe(true);
    expect(
      fakeAdb.getCommandCalls().find((call) => call.command.startsWith("install "))?.timeoutMs,
    ).toBe(120_000);

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

  describe("install-aware user targeting with a running work profile", () => {
    const apkPath = "/tmp/app-debug.apk";

    const setup = (installed: { personal: boolean; work: boolean }) => {
      fakeLocator.setTool({ tool: "aapt2", path: "/sdk/build-tools/35.0.0/aapt2" });
      fakeHost.setCommandResponse(
        "aapt2",
        createExecResult("package: name='com.example.app' versionCode='1'"),
      );
      fakeAdb.setForegroundApp({ packageName: "com.android.launcher3", userId: 0 });
      fakeAdb.setUsers([
        { userId: 0, name: "Owner", flags: 0x4c13, running: true },
        { userId: 10, name: "Work profile", flags: 0x1030, running: true },
      ]);
      const listing = (isInstalled: boolean) =>
        createExecResult(isInstalled ? "package:com.example.app" : "");
      fakeAdb.setCommandResponse("shell pm list packages --user 0", listing(installed.personal));
      fakeAdb.setCommandResponse("shell pm list packages --user 10", listing(installed.work));
      fakeAdb.setCommandResponse(`install --user 0 -r "${apkPath}"`, createExecResult("Success"));
      fakeAdb.setCommandResponse(`install --user 10 -r "${apkPath}"`, createExecResult("Success"));
      return new InstallApp(device, fakeAdbFactory, {
        hostExecutor: fakeHost,
        buildToolsLocator: fakeLocator,
        performanceTrackerFactory: () => createPerformanceTracker(true, fakeTimer),
      });
    };

    test("reinstalls a personal-only app for the personal user instead of adding a work copy", async () => {
      const result = await setup({ personal: true, work: false }).execute(apkPath);
      expect(result).toMatchObject({ success: true, userId: 0, upgrade: true });
      expect(fakeAdb.wasCommandExecuted(`install --user 0 -r "${apkPath}"`)).toBe(true);
      expect(fakeAdb.wasCommandExecuted("install --user 10")).toBe(false);
    });

    test("reinstalls a work-only app for the work profile", async () => {
      const result = await setup({ personal: false, work: true }).execute(apkPath);
      expect(result).toMatchObject({ success: true, userId: 10, upgrade: true });
      expect(fakeAdb.wasCommandExecuted("install --user 10 -r")).toBe(true);
      expect(fakeAdb.wasCommandExecuted("install --user 0")).toBe(false);
    });

    test("keeps the work-profile tie-break when the app is installed for both users", async () => {
      const result = await setup({ personal: true, work: true }).execute(apkPath);
      expect(result).toMatchObject({ success: true, userId: 10, upgrade: true });
      expect(fakeAdb.wasCommandExecuted("install --user 0")).toBe(false);
    });

    test("first install (installed nowhere) keeps the work-profile default", async () => {
      const result = await setup({ personal: false, work: false }).execute(apkPath);
      expect(result).toMatchObject({ success: true, userId: 10, upgrade: false });
      expect(fakeAdb.wasCommandExecuted("install --user 0")).toBe(false);
    });

    test("an explicit userId wins over where the app is installed", async () => {
      const result = await setup({ personal: true, work: false }).execute(apkPath, 10);
      expect(result).toMatchObject({ success: true, userId: 10 });
      expect(fakeAdb.wasCommandExecuted("install --user 10 -r")).toBe(true);
    });
  });

  test("reports when aapt's package ID differs from the package installed on device", async () => {
    const apkPath = "/tmp/app-debug.apk";
    const parsedPackageName = "dev.jasonpearson.automobile.playground";
    const installedPackageName = "dev.jasonpearson.automobile.playground.runtime";

    fakeLocator.setTool({ tool: "aapt2", path: "/sdk/build-tools/36.0.0/aapt2" });
    fakeHost.setCommandResponse("aapt2", createExecResult(playgroundBadgingOutput));
    fakeAdb.setCommandResponseSequence("shell pm list packages --user 0", [
      createExecResult(""),
      createExecResult(""),
      createExecResult(`package: ${installedPackageName}`),
    ]);
    fakeAdb.setCommandResponse(`install --user 0 -r "${apkPath}"`, createExecResult("Success"));

    const installApp = new InstallApp(device, fakeAdbFactory, {
      hostExecutor: fakeHost,
      buildToolsLocator: fakeLocator,
      performanceTrackerFactory: () => createPerformanceTracker(false, fakeTimer),
    });

    await expect(installApp.execute(apkPath)).rejects.toThrow(
      `aapt reported "${parsedPackageName}", but the device reported "${installedPackageName}"`,
    );
  });

  test("returns the install timing tree when --debug-perf is enabled", async () => {
    const apkPath = "/tmp/app-debug.apk";
    setDebugPerfEnabled(true);
    fakeLocator.setTool({ tool: "aapt2", path: "/sdk/build-tools/35.0.0/aapt2" });
    fakeHost.setCommandResponse(
      "aapt2",
      createExecResult("package: name='com.example.app' versionCode='1'"),
    );
    fakeAdb.setUsers([{ userId: 0, name: "Owner", flags: 0x13, running: true }]);
    fakeAdb.setCommandResponse("shell pm list packages --user 0", createExecResult(""));
    fakeAdb.setCommandResponse(`install --user 0 -r "${apkPath}"`, createExecResult("Success"));

    const result = await new InstallApp(device, fakeAdbFactory, {
      hostExecutor: fakeHost,
      buildToolsLocator: fakeLocator,
      performanceTrackerFactory: () => createPerformanceTracker(true, fakeTimer),
    }).execute(apkPath);

    expect(result.perfTiming).toBeDefined();
    expect((result.perfTiming as TimingEntry[])[0]?.name).toBe("installApp");
  });

  test("omits perfTiming when --debug-perf is disabled", async () => {
    const apkPath = "/tmp/app-debug.apk";
    fakeLocator.setTool({ tool: "aapt2", path: "/sdk/build-tools/35.0.0/aapt2" });
    fakeHost.setCommandResponse(
      "aapt2",
      createExecResult("package: name='com.example.app' versionCode='1'"),
    );
    fakeAdb.setUsers([{ userId: 0, name: "Owner", flags: 0x13, running: true }]);
    fakeAdb.setCommandResponse("shell pm list packages --user 0", createExecResult(""));
    fakeAdb.setCommandResponse(`install --user 0 -r "${apkPath}"`, createExecResult("Success"));

    const result = await new InstallApp(device, fakeAdbFactory, {
      hostExecutor: fakeHost,
      buildToolsLocator: fakeLocator,
      performanceTrackerFactory: () => createPerformanceTracker(false, fakeTimer),
    }).execute(apkPath);

    expect(result).toEqual({
      success: true,
      upgrade: false,
      userId: 0,
      packageName: "com.example.app",
      warning: undefined,
    });
    expect("perfTiming" in result).toBe(false);
  });

  test("marks the Android installed-apps cache stale after a successful install", async () => {
    const apkPath = "/tmp/app-debug.apk";
    const repo = new FakeInstalledAppsRepository();
    await repo.seedInstalledApp(device.deviceId, 0, "com.example.previous", false, 1_000);

    fakeLocator.setTool({ tool: "aapt2", path: "/sdk/build-tools/35.0.0/aapt2" });
    fakeHost.setCommandResponse(
      "aapt2",
      createExecResult("package: name='com.example.app' versionCode='1'"),
    );
    fakeAdb.setUsers([{ userId: 0, name: "Owner", flags: 0x13, running: true }]);
    fakeAdb.setCommandResponse("shell pm list packages --user 0", createExecResult(""));
    fakeAdb.setCommandResponse(`install --user 0 -r "${apkPath}"`, createExecResult("Success"));

    const installApp = new InstallApp(device, fakeAdbFactory, {
      hostExecutor: fakeHost,
      buildToolsLocator: fakeLocator,
      performanceTrackerFactory: () => createPerformanceTracker(true, fakeTimer),
      installedAppsRepository: repo,
    });

    await installApp.execute(apkPath);

    expect(await repo.getCacheVerifiedAt(device.deviceId)).toBe(0);
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
        signal?: AbortSignal,
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
      createExecResult("package:com.example.before\npackage:com.example.new\n"),
    ]);
    sequencedAdb.setCommandResponse(
      `install --user 0 -r \"${apkPath}\"`,
      createExecResult("Success"),
    );

    const installApp = new InstallApp(
      device,
      { create: () => sequencedAdb },
      {
        hostExecutor: fakeHost,
        buildToolsLocator: fakeLocator,
        performanceTrackerFactory: () => perf,
      },
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
    await repo.seedInstalledApp(device.deviceId, 0, "com.example.previous", false, 1_000);

    fakeLocator.setTool(null);

    const installApp = new InstallApp(device, fakeAdbFactory, {
      hostExecutor: fakeHost,
      buildToolsLocator: fakeLocator,
      performanceTrackerFactory: () => perf,
      installedAppsRepository: repo,
    });

    const result = await installApp.execute(apkPath);

    expect(result.success).toBe(false);
    expect(result.warning).toContain("aapt2");
    expect(await repo.getCacheVerifiedAt(device.deviceId)).toBe(1_000);
  });

  test("invalidates the cache before package discovery after a successful install", async () => {
    class PackageDiscoveryFailureAdb extends FakeAdbExecutor {
      private listPackagesCalls = 0;

      override async executeCommand(
        command: string,
        timeoutMs?: number,
        maxBuffer?: number,
        noRetry?: boolean,
        signal?: AbortSignal,
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
    await repo.seedInstalledApp(device.deviceId, 0, "com.example.previous", false, 1_000);
    fakeLocator.setTool(null);
    adb.setCommandResponse(
      "shell pm list packages --user 0",
      createExecResult("package:com.example.previous\n"),
    );
    adb.setCommandResponse(`install --user 0 -r "${apkPath}"`, createExecResult("Success"));

    const installApp = new InstallApp(
      device,
      { create: () => adb },
      {
        hostExecutor: fakeHost,
        buildToolsLocator: fakeLocator,
        performanceTrackerFactory: () => createPerformanceTracker(true, fakeTimer),
        installedAppsRepository: repo,
      },
    );

    const result = await installApp.execute(apkPath);
    expect(result.success).toBe(true);
    expect(result.packageName).toBeUndefined();
    expect(result.warning).toContain("could not verify");
    expect(result.warning).toContain("ADB disconnected after install");
    expect(result.error).toBeUndefined();

    expect(await repo.getCacheVerifiedAt(device.deviceId)).toBe(0);
  });

  test("installs iOS .app on simulator via simctl and detects new bundle id", async () => {
    const appPath = "/tmp/MyApp.app";
    const perf = createPerformanceTracker(true, fakeTimer);
    const sequencedSimctl = new SequencedFakeSimctl();
    sequencedSimctl.setListResponses([
      [{ bundleId: "com.example.old" }],
      [{ bundleId: "com.example.old" }, { bundleId: "com.example.new" }],
    ]);
    fakeHost.setCommandResponse("plutil", createExecResult("com.example.unused\n"));
    const repo = new FakeInstalledAppsRepository();
    await repo.seedInstalledApp(iosSimulatorDevice.deviceId, 0, "com.example.old", false, 1_000);

    const installApp = new InstallApp(iosSimulatorDevice, fakeAdbFactory, {
      hostExecutor: fakeHost,
      performanceTrackerFactory: () => perf,
      simctl: sequencedSimctl,
      installedAppsRepository: repo,
    });

    const result = await installApp.execute(appPath);

    expect(result.success).toBe(true);
    expect(result.packageName).toBe("com.example.new");
    expect(result.upgrade).toBe(false);
    expect(sequencedSimctl.wasMethodCalled("installApp")).toBe(true);
    expect(fakeHost.wasCommandExecuted("plutil")).toBe(false);
    expect(await repo.getCacheVerifiedAt(iosSimulatorDevice.deviceId)).toBe(0);
  });

  test.each(["simulator", "physical"])(
    "routes %s install and verification through an injected backend",
    async (transport) => {
      const device = transport === "simulator" ? iosSimulatorDevice : iosPhysicalDevice;
      const artifactPath = transport === "simulator" ? "/tmp/MyApp.app" : ipaWithBundleId();
      const calls: string[] = [];
      const installApp = new InstallApp(device, fakeAdbFactory, {
        performanceTrackerFactory: () => createPerformanceTracker(false, fakeTimer),
        simctl: new FakeSimctl(),
        deviceAppInstaller: new FakeDeviceAppInstaller(),
        plist: fakePlist("com.example.app"),
        installedAppsRepository: new FakeInstalledAppsRepository(),
        timer: fakeTimer,
        iosInstallBackendResolver: (deviceId) => {
          calls.push(`resolve:${deviceId}`);
          return {
            kind: transport === "simulator" ? "simulator" : "physical",
            installApp: async (path) => {
              calls.push(`install:${path}`);
            },
            listApps: async () => {
              calls.push("list");
              return [{ bundleId: "com.example.app", bundlePath: artifactPath }];
            },
          };
        },
      });

      await installApp.execute(artifactPath);
      expect(calls).toEqual(
        transport === "simulator"
          ? [`resolve:${device.deviceId}`, "list", `install:${artifactPath}`, "list"]
          : [`resolve:${device.deviceId}`, `install:${artifactPath}`, "list"],
      );
    },
  );

  test("malformed IDs still reject simulator artifacts with the physical error", async () => {
    const simctl = new FakeSimctl();
    const installer = new FakeDeviceAppInstaller();
    const action = new InstallApp(
      { ...iosPhysicalDevice, deviceId: "unrecognized-device" },
      fakeAdbFactory,
      {
        performanceTrackerFactory: () => createPerformanceTracker(false, fakeTimer),
        simctl: simctl,
        deviceAppInstaller: installer,
      },
    );
    await expect(action.execute("/tmp/MyApp.app")).rejects.toThrow(
      "iOS physical devices do not support .app bundles. Use a signed .ipa file instead.",
    );
    expect(installer.calls).toEqual([]);
    expect(simctl.wasMethodCalled("installApp")).toBe(false);
  });

  test("installs iOS .ipa on physical device via devicectl", async () => {
    const ipaPath = "/tmp/MyApp.ipa";
    const perf = createPerformanceTracker(true, fakeTimer);
    const fakeInstaller = new FakeDeviceAppInstaller();

    const installApp = new InstallApp(iosPhysicalDevice, fakeAdbFactory, {
      performanceTrackerFactory: () => perf,
      deviceAppInstaller: fakeInstaller,
    });

    const result = await installApp.execute(ipaPath);

    expect(result.success).toBe(true);
    expect(result.userId).toBe(0);
    expect(fakeInstaller.calls).toHaveLength(1);
    expect(fakeInstaller.calls[0].deviceUdid).toBe(iosPhysicalDevice.deviceId);
    expect(fakeInstaller.calls[0].artifactPath).toBe(ipaPath);
  });

  test("verifies an installed bundle on an iOS physical device", async () => {
    const ipaPath = ipaWithBundleId();
    const fakeInstaller = new FakeDeviceAppInstaller();
    const lister: IosPhysicalAppLister = {
      listInstalledApps: async () => [{ bundleIdentifier: "com.example.app" }],
    };
    const installApp = new InstallApp(iosPhysicalDevice, fakeAdbFactory, {
      performanceTrackerFactory: () => createPerformanceTracker(true, fakeTimer),
      deviceAppInstaller: fakeInstaller,
      plist: fakePlist("com.example.app"),
      physicalAppLister: lister,
      timer: fakeTimer,
    });

    const result = await installApp.execute(ipaPath);

    expect(result.success).toBe(true);
    expect(result.packageName).toBe("com.example.app");
    expect(result.warning).toBeUndefined();
  });

  test("rejects a physical install when its bundle is absent", async () => {
    const ipaPath = ipaWithBundleId();
    let queries = 0;
    const lister: IosPhysicalAppLister = {
      listInstalledApps: async () => {
        queries += 1;
        return [];
      },
    };
    const installApp = new InstallApp(iosPhysicalDevice, fakeAdbFactory, {
      performanceTrackerFactory: () => createPerformanceTracker(true, fakeTimer),
      deviceAppInstaller: new FakeDeviceAppInstaller(),
      plist: fakePlist("com.example.app"),
      physicalAppLister: lister,
      timer: fakeTimer,
    });

    await expect(installApp.execute(ipaPath)).rejects.toThrow(
      "bundle com.example.app was not present",
    );
    expect(queries).toBe(3);
    expect(fakeTimer.getSleepHistory()).toEqual([200, 200]);
  });

  test("accepts a physical bundle that appears on the second query", async () => {
    const ipaPath = ipaWithBundleId();
    let queries = 0;
    const lister: IosPhysicalAppLister = {
      listInstalledApps: async () => {
        queries += 1;
        return queries === 2 ? [{ bundleIdentifier: "com.example.app" }] : [];
      },
    };
    const installApp = new InstallApp(iosPhysicalDevice, fakeAdbFactory, {
      performanceTrackerFactory: () => createPerformanceTracker(true, fakeTimer),
      deviceAppInstaller: new FakeDeviceAppInstaller(),
      plist: fakePlist("com.example.app"),
      physicalAppLister: lister,
      timer: fakeTimer,
    });

    const result = await installApp.execute(ipaPath);

    expect(result.success).toBe(true);
    expect(result.packageName).toBe("com.example.app");
    expect(result.warning).toBeUndefined();
    expect(queries).toBe(2);
    expect(fakeTimer.getSleepHistory()).toEqual([200]);
  });

  test("stops physical verification when the caller aborts between queries", async () => {
    const ipaPath = ipaWithBundleId();
    const controller = new AbortController();
    let queries = 0;
    const lister: IosPhysicalAppLister = {
      listInstalledApps: async () => {
        queries += 1;
        controller.abort();
        return [];
      },
    };
    const installApp = new InstallApp(iosPhysicalDevice, fakeAdbFactory, {
      performanceTrackerFactory: () => createPerformanceTracker(true, fakeTimer),
      deviceAppInstaller: new FakeDeviceAppInstaller(),
      plist: fakePlist("com.example.app"),
      physicalAppLister: lister,
      timer: fakeTimer,
    });

    await expect(installApp.execute(ipaPath, undefined, controller.signal)).rejects.toThrow();
    expect(queries).toBe(1);
  });

  test("logs and reports a failed physical install verification query", async () => {
    const ipaPath = ipaWithBundleId();
    const warning = spyOn(logger, "warn").mockImplementation(() => {});
    const lister: IosPhysicalAppLister = {
      listInstalledApps: async () => {
        throw new Error("device disconnected");
      },
    };
    const installApp = new InstallApp(iosPhysicalDevice, fakeAdbFactory, {
      performanceTrackerFactory: () => createPerformanceTracker(true, fakeTimer),
      deviceAppInstaller: new FakeDeviceAppInstaller(),
      plist: fakePlist("com.example.app"),
      physicalAppLister: lister,
      timer: fakeTimer,
    });

    try {
      const result = await installApp.execute(ipaPath);
      expect(result).toMatchObject({
        success: true,
        upgrade: false,
        packageName: "com.example.app",
        warning: "Installed, but could not verify the bundle is present: device disconnected",
      });
      expect(warning).toHaveBeenCalled();
    } finally {
      warning.mockRestore();
    }
  });

  test("bounds physical install verification with the injected timer", async () => {
    const ipaPath = ipaWithBundleId();
    const lister: IosPhysicalAppLister = {
      listInstalledApps: () => new Promise(() => {}),
    };
    const warning = spyOn(logger, "warn").mockImplementation(() => {});
    const installApp = new InstallApp(iosPhysicalDevice, fakeAdbFactory, {
      performanceTrackerFactory: () => createPerformanceTracker(true, fakeTimer),
      deviceAppInstaller: new FakeDeviceAppInstaller(),
      plist: fakePlist("com.example.app"),
      physicalAppLister: lister,
      timer: fakeTimer,
    });

    try {
      const result = await installApp.execute(ipaPath);
      expect(result).toMatchObject({
        success: true,
        upgrade: false,
        packageName: "com.example.app",
        warning: expect.stringContaining("timed out after 10000ms"),
      });
      expect(warning).toHaveBeenCalled();
    } finally {
      warning.mockRestore();
    }
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
      ["no extension", "/tmp/MyApp"],
    ];
    const androidExpectedExt: Record<string, string> = {
      "/tmp/MyApp.app": ".app",
      "/tmp/MyApp.ipa": ".ipa",
      "/tmp/MyApp.zip": ".zip",
      "/tmp/MyApp.apk.zip": ".zip",
      "/tmp/MyApp.": ".",
      "/tmp/.apk": "",
      "/tmp/MyApp": "",
    };

    test.each(androidRejections)("Android rejects a %s", async (_name, artifactPath) => {
      const perf = createPerformanceTracker(true, fakeTimer);
      const installApp = new InstallApp(device, fakeAdbFactory, {
        hostExecutor: fakeHost,
        buildToolsLocator: fakeLocator,
        performanceTrackerFactory: () => perf,
      });

      await expect(installApp.execute(artifactPath)).rejects.toThrow(
        `Android devices only support .apk files, but got "${androidExpectedExt[artifactPath]}" file. Use an .apk file for Android installation.`,
      );
    });

    // iOS simulator accepts only .app; an .ipa gets a simulator-specific message,
    // anything else falls through to the generic "only .app/.ipa" message.
    const iosSimulatorRejections: Array<[string, string, string]> = [
      [
        ".ipa file",
        "/tmp/MyApp.ipa",
        "iOS simulators do not support .ipa files. Use a .app bundle built for the simulator instead.",
      ],
      [
        ".apk file",
        "/tmp/app-debug.apk",
        'iOS devices only support .app bundles (simulator) and .ipa files (physical device), but got ".apk" file.',
      ],
      [
        ".zip file",
        "/tmp/MyApp.zip",
        'iOS devices only support .app bundles (simulator) and .ipa files (physical device), but got ".zip" file.',
      ],
      [
        "trailing dot",
        "/tmp/MyApp.",
        'iOS devices only support .app bundles (simulator) and .ipa files (physical device), but got "." file.',
      ],
      [
        "no extension",
        "/tmp/MyApp",
        'iOS devices only support .app bundles (simulator) and .ipa files (physical device), but got "" file.',
      ],
    ];

    test.each(iosSimulatorRejections)(
      "iOS simulator rejects a %s",
      async (_name, artifactPath, expectedMessage) => {
        const perf = createPerformanceTracker(true, fakeTimer);
        const installApp = new InstallApp(iosSimulatorDevice, fakeAdbFactory, {
          performanceTrackerFactory: () => perf,
        });

        await expect(installApp.execute(artifactPath)).rejects.toThrow(expectedMessage);
      },
    );

    // iOS physical accepts only .ipa; a .app gets a physical-specific message.
    const iosPhysicalRejections: Array<[string, string, string]> = [
      [
        ".app bundle",
        "/tmp/MyApp.app",
        "iOS physical devices do not support .app bundles. Use a signed .ipa file instead.",
      ],
      [
        ".apk file",
        "/tmp/app-debug.apk",
        'iOS devices only support .app bundles (simulator) and .ipa files (physical device), but got ".apk" file.',
      ],
    ];

    test.each(iosPhysicalRejections)(
      "iOS physical device rejects a %s",
      async (_name, artifactPath, expectedMessage) => {
        const perf = createPerformanceTracker(true, fakeTimer);
        const installApp = new InstallApp(iosPhysicalDevice, fakeAdbFactory, {
          performanceTrackerFactory: () => perf,
        });

        await expect(installApp.execute(artifactPath)).rejects.toThrow(expectedMessage);
      },
    );
  });

  test("resolves relative artifact path to absolute", async () => {
    const perf = createPerformanceTracker(true, fakeTimer);

    fakeLocator.setTool({ tool: "aapt2", path: "/sdk/build-tools/35.0.0/aapt2" });
    fakeHost.setCommandResponse(
      "aapt2",
      createExecResult("package: name='com.example.app' versionCode='1'"),
    );
    fakeAdb.setCommandResponse("shell pm list packages --user 0", createExecResult(""));

    const expectedAbsolute = path.resolve(process.cwd(), "relative", "path", "app.apk");
    fakeAdb.setCommandResponse(
      `install --user 0 -r "${expectedAbsolute}"`,
      createExecResult("Success"),
    );

    const installApp = new InstallApp(device, fakeAdbFactory, {
      hostExecutor: fakeHost,
      buildToolsLocator: fakeLocator,
      performanceTrackerFactory: () => perf,
    });
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
    fakeHost.setCommandResponse(
      "aapt2",
      createExecResult("package: name='com.example.app' versionCode='1'"),
    );
    fakeAdb.setCommandResponse("shell pm list packages --user 0", createExecResult(""));

    const expectedAbsolute = path.resolve(launchCwd, "relative", "path", "app.apk");
    fakeAdb.setCommandResponse(
      `install --user 0 -r "${expectedAbsolute}"`,
      createExecResult("Success"),
    );

    const installApp = new InstallApp(device, fakeAdbFactory, {
      hostExecutor: fakeHost,
      buildToolsLocator: fakeLocator,
      performanceTrackerFactory: () => perf,
    });
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
      [{ bundleId: "com.example.app", bundlePath: "/tmp/MyApp.app" }],
    ]);

    const installApp = new InstallApp(iosSimulatorDevice, fakeAdbFactory, {
      performanceTrackerFactory: () => perf,
      simctl: sequencedSimctl,
    });
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
      [{ bundleId: "com.example.pathmatched", bundlePath: "/tmp/MyApp.app" }],
    ]);

    const installApp = new InstallApp(iosSimulatorDevice, fakeAdbFactory, {
      performanceTrackerFactory: () => perf,
      simctl: sequencedSimctl,
    });
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
      [{ bundleId: "com.example.a" }, { bundleId: "com.example.b" }],
    ]);
    fakeHost.setCommandResponse("plutil", createExecResult(""));

    const installApp = new InstallApp(iosSimulatorDevice, fakeAdbFactory, {
      hostExecutor: fakeHost,
      performanceTrackerFactory: () => perf,
      simctl: sequencedSimctl,
      plist: fakePlist(""),
    });
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
      [{ bundleId: "com.example.existing" }],
    ]);
    fakeHost.setCommandResponse("plutil", createExecResult(""));

    const installApp = new InstallApp(iosSimulatorDevice, fakeAdbFactory, {
      hostExecutor: fakeHost,
      performanceTrackerFactory: () => perf,
      simctl: sequencedSimctl,
      plist: fakePlist(""),
    });
    const result = await installApp.execute(appPath);

    expect(result.success).toBe(true);
    expect(result.packageName).toBeUndefined();
    expect(result.warning).toContain("bundle ID could not be determined");
  });

  test("iOS simulator install fails when expected bundle is absent after simctl success", async () => {
    const appPath = "/tmp/MyApp.app";
    const perf = createPerformanceTracker(true, fakeTimer);
    const sequencedSimctl = new SequencedFakeSimctl();
    sequencedSimctl.setListResponses([[], []]);
    fakeHost.setCommandResponse("plutil", createExecResult("com.example.app\n"));

    const installApp = new InstallApp(iosSimulatorDevice, fakeAdbFactory, {
      hostExecutor: fakeHost,
      performanceTrackerFactory: () => perf,
      simctl: sequencedSimctl,
      plist: fakePlist("com.example.app\n"),
    });

    await expect(installApp.execute(appPath)).rejects.toThrow(
      "Install reported success, but bundle com.example.app was not present",
    );
  });

  test("propagates devicectl failure for iOS physical device install", async () => {
    const ipaPath = "/tmp/MyApp.ipa";
    const perf = createPerformanceTracker(true, fakeTimer);
    const fakeInstaller = new FakeDeviceAppInstaller();
    fakeInstaller.shouldThrow = new Error("devicectl: device not paired");

    const installApp = new InstallApp(iosPhysicalDevice, fakeAdbFactory, {
      performanceTrackerFactory: () => perf,
      deviceAppInstaller: fakeInstaller,
    });

    await expect(installApp.execute(ipaPath)).rejects.toThrow("devicectl: device not paired");
  });

  test("respects abort signal for iOS simulator install", async () => {
    const appPath = "/tmp/MyApp.app";
    const perf = createPerformanceTracker(true, fakeTimer);
    const controller = new AbortController();
    controller.abort();

    const installApp = new InstallApp(iosSimulatorDevice, fakeAdbFactory, {
      performanceTrackerFactory: () => perf,
    });

    await expect(installApp.execute(appPath, undefined, controller.signal)).rejects.toThrow(
      "Operation cancelled",
    );
  });

  test("respects abort signal for iOS physical device install", async () => {
    const ipaPath = "/tmp/MyApp.ipa";
    const perf = createPerformanceTracker(true, fakeTimer);
    const fakeInstaller = new FakeDeviceAppInstaller();
    const controller = new AbortController();
    controller.abort();

    const installApp = new InstallApp(iosPhysicalDevice, fakeAdbFactory, {
      performanceTrackerFactory: () => perf,
      deviceAppInstaller: fakeInstaller,
    });

    await expect(installApp.execute(ipaPath, undefined, controller.signal)).rejects.toThrow(
      "Operation cancelled",
    );
  });

  test("does not match a prefix-superset package in the package listing", async () => {
    const apkPath = "/tmp/app-debug.apk";
    const perf = createPerformanceTracker(true, fakeTimer);
    const debugSpy = spyOn(logger, "debug").mockImplementation(() => {});

    fakeLocator.setTool({ tool: "aapt2", path: "/sdk/build-tools/35.0.0/aapt2" });
    fakeHost.setCommandResponse(
      "aapt2",
      createExecResult("package: name='com.example.app' versionCode='1'"),
    );

    fakeAdb.setUsers([{ userId: 0, name: "Owner", flags: 13, running: true }]);
    fakeAdb.setCommandResponseSequence("shell pm list packages --user 0", [
      createExecResult("package:com.example.app2"),
      createExecResult("package:com.example.app2"),
      createExecResult("package:com.example.app2\npackage:com.example.app"),
    ]);

    fakeAdb.setCommandResponse(`install --user 0 -r "${apkPath}"`, createExecResult("Success"));

    const installApp = new InstallApp(device, fakeAdbFactory, {
      hostExecutor: fakeHost,
      buildToolsLocator: fakeLocator,
      performanceTrackerFactory: () => perf,
    });
    try {
      const result = await installApp.execute(apkPath);

      expect(result.success).toBe(true);
      expect(result.upgrade).toBe(false);
      expect(result.packageName).toBe("com.example.app");
      expect(fakeAdb.wasCommandExecuted("shell pm list packages --user 0")).toBe(true);
      expect(
        debugSpy.mock.calls.some(([message]) => String(message).includes("fallback failed")),
      ).toBe(false);
    } finally {
      debugSpy.mockRestore();
    }
  });

  test("detects Android upgrade when package already installed", async () => {
    const apkPath = "/tmp/app-debug.apk";
    const perf = createPerformanceTracker(true, fakeTimer);

    fakeLocator.setTool({ tool: "aapt2", path: "/sdk/build-tools/35.0.0/aapt2" });
    fakeHost.setCommandResponse(
      "aapt2",
      createExecResult("package: name='com.example.app' versionCode='2'"),
    );
    fakeAdb.setCommandResponse(
      "shell pm list packages --user 0",
      createExecResult("package:com.example.app"),
    );
    fakeAdb.setCommandResponse(`install --user 0 -r "${apkPath}"`, createExecResult("Success"));

    const installApp = new InstallApp(device, fakeAdbFactory, {
      hostExecutor: fakeHost,
      buildToolsLocator: fakeLocator,
      performanceTrackerFactory: () => perf,
    });
    const result = await installApp.execute(apkPath);

    expect(result.success).toBe(true);
    expect(result.upgrade).toBe(true);
    expect(result.packageName).toBe("com.example.app");
  });

  test("handles case-insensitive extensions", async () => {
    const perf = createPerformanceTracker(true, fakeTimer);

    fakeLocator.setTool({ tool: "aapt2", path: "/sdk/build-tools/35.0.0/aapt2" });
    fakeHost.setCommandResponse(
      "aapt2",
      createExecResult("package: name='com.example.app' versionCode='1'"),
    );
    fakeAdb.setCommandResponse("shell pm list packages --user 0", createExecResult(""));
    fakeAdb.setCommandResponse('install --user 0 -r "/tmp/app.APK"', createExecResult("Success"));

    const installApp = new InstallApp(device, fakeAdbFactory, {
      hostExecutor: fakeHost,
      buildToolsLocator: fakeLocator,
      performanceTrackerFactory: () => perf,
    });
    const result = await installApp.execute("/tmp/app.APK");

    expect(result.success).toBe(true);
  });

  test("iOS physical device install warns when the IPA bundle ID is unavailable", async () => {
    const ipaPath = "/tmp/MyApp.ipa";
    const perf = createPerformanceTracker(true, fakeTimer);
    const fakeInstaller = new FakeDeviceAppInstaller();

    const installApp = new InstallApp(iosPhysicalDevice, fakeAdbFactory, {
      performanceTrackerFactory: () => perf,
      deviceAppInstaller: fakeInstaller,
    });
    const result = await installApp.execute(ipaPath);

    expect(result.warning).toContain("installation was not verified");
    expect(result.upgrade).toBe(false);
  });

  test("Android recovers from version downgrade by uninstalling then reinstalling", async () => {
    const apkPath = "/tmp/app-debug.apk";
    const perf = createPerformanceTracker(true, fakeTimer);

    fakeLocator.setTool({ tool: "aapt2", path: "/sdk/build-tools/35.0.0/aapt2" });
    fakeHost.setCommandResponse(
      "aapt2",
      createExecResult("package: name='com.example.app' versionCode='1'"),
    );
    fakeAdb.setUsers([{ userId: 0, name: "Owner", flags: 13, running: true }]);
    fakeAdb.setCommandResponse(
      "shell pm list packages --user 0",
      createExecResult("package:com.example.app"),
    );
    fakeAdb.setCommandResponseSequence(`install --user 0 -r "${apkPath}"`, [
      createExecResult("", "Failure [INSTALL_FAILED_VERSION_DOWNGRADE]"),
      createExecResult("Success"),
    ]);
    const repo = new CountingInstalledAppsRepository();

    const installApp = new InstallApp(device, fakeAdbFactory, {
      hostExecutor: fakeHost,
      buildToolsLocator: fakeLocator,
      performanceTrackerFactory: () => perf,
      installedAppsRepository: repo,
    });
    const result = await installApp.execute(apkPath);

    expect(result.success).toBe(true);
    expect(result.upgrade).toBe(false);
    expect(result.packageName).toBe("com.example.app");
    expect(result.warning).toBe(
      "Installed version of com.example.app was newer than the artifact; uninstalled it and reinstalled the provided version.",
    );
    expect(fakeAdb.wasCommandExecuted("install-existing")).toBe(false);
    expect(fakeAdb.wasCommandExecuted("uninstall com.example.app")).toBe(true);
    expect(
      fakeAdb
        .getCommandCalls()
        .filter((call) => call.command.startsWith("install "))
        .map((call) => call.noRetry),
    ).toEqual([true, true]);
    expect(
      fakeAdb.getCommandCalls().find((call) => call.command.startsWith("uninstall "))?.timeoutMs,
    ).toBe(120_000);
    expect(repo.markStaleCalls).toBe(2);
  });

  test("invalidates the cache when downgrade recovery uninstalls but reinstall fails", async () => {
    const apkPath = "/tmp/app-debug.apk";
    const perf = createPerformanceTracker(true, fakeTimer);
    const repo = new FakeInstalledAppsRepository();
    await repo.seedInstalledApp(device.deviceId, 0, "com.example.app", false, 1_000);

    fakeLocator.setTool({ tool: "aapt2", path: "/sdk/build-tools/35.0.0/aapt2" });
    fakeHost.setCommandResponse(
      "aapt2",
      createExecResult("package: name='com.example.app' versionCode='1'"),
    );
    fakeAdb.setUsers([{ userId: 0, name: "Owner", flags: 13, running: true }]);
    fakeAdb.setCommandResponse(
      "shell pm list packages --user 0",
      createExecResult("package:com.example.app"),
    );
    fakeAdb.setCommandResponseSequence(`install --user 0 -r "${apkPath}"`, [
      createExecResult("", "Failure [INSTALL_FAILED_VERSION_DOWNGRADE]"),
      createExecResult("", "Failure [INSTALL_FAILED_INVALID_APK]"),
    ]);

    const installApp = new InstallApp(device, fakeAdbFactory, {
      hostExecutor: fakeHost,
      buildToolsLocator: fakeLocator,
      performanceTrackerFactory: () => perf,
      installedAppsRepository: repo,
    });

    const result = await installApp.execute(apkPath);

    expect(result.success).toBe(false);
    expect(await repo.getCacheVerifiedAt(device.deviceId)).toBe(0);
  });

  describe("Android downgrade recovery and post-install verification", () => {
    const apkPath = "/tmp/app-debug.apk";
    const packageName = "dev.jasonpearson.automobile.playground";
    const present = () => createExecResult(`package:${packageName}`);

    function androidAction(adbFactory: AdbClientFactory = fakeAdbFactory): InstallApp {
      fakeLocator.setTool({ tool: "aapt2", path: "/sdk/build-tools/36.0.0/aapt2" });
      fakeHost.setCommandResponse("aapt2", createExecResult(playgroundBadgingOutput));
      return new InstallApp(device, adbFactory, {
        hostExecutor: fakeHost,
        buildToolsLocator: fakeLocator,
        performanceTrackerFactory: () => createPerformanceTracker(false, fakeTimer),
        timer: fakeTimer,
      });
    }

    function configureDowngrade(targetUserId = 10): string {
      fakeAdb.setUsers([
        { userId: 0, name: "Owner", flags: 0x13, running: true },
        { userId: 10, name: "Work", flags: 0x30, running: true },
      ]);
      fakeAdb.setCommandResponse("shell pm list packages --user 0", present());
      fakeAdb.setCommandResponse("shell pm list packages --user 10", present());
      const installCommand = `install --user ${targetUserId} -r "${apkPath}"`;
      fakeAdb.setCommandResponseSequence(installCommand, [
        createExecResult("", "Failure [INSTALL_FAILED_VERSION_DOWNGRADE]"),
        createExecResult("Success"),
      ]);
      fakeAdb.setCommandResponse(
        "install-existing",
        createExecResult("Package installed for user"),
      );
      return installCommand;
    }

    /** After the package-wide uninstall, the target user's listing no longer has the app. */
    function emptyUserTenListingAfterUninstall(adb: InstallAppFakeAdbExecutor): void {
      const execute = adb.executeCommand.bind(adb);
      spyOn(adb, "executeCommand").mockImplementation(async (...args) => {
        const result = await execute(...args);
        if (args[0].startsWith("uninstall ")) {
          adb.setCommandResponse("shell pm list packages --user 10", createExecResult(""));
        }
        return result;
      });
    }

    test.each([false, true])(
      "restores other users after downgrade (stopped user: %s)",
      async (stopped) => {
        const installCommand = configureDowngrade();
        fakeAdb.setUsers([
          { userId: 0, name: "Owner", flags: 0x13, running: !stopped },
          { userId: 10, name: "Work", flags: 0x30, running: true },
        ]);
        const result = await androidAction().execute(apkPath, 10);
        expect(result).toMatchObject({ success: true, userId: 10, packageName, upgrade: false });
        const commands = fakeAdb.getExecutedCommands();
        const uninstallIndex = commands.indexOf(`uninstall ${packageName}`);
        expect(uninstallIndex).toBeGreaterThan(commands.indexOf("shell pm list packages --user 0"));
        expect(commands.slice(uninstallIndex)).toEqual([
          `uninstall ${packageName}`,
          installCommand,
          `shell pm install-existing --user 0 '${packageName}'`,
          "shell pm list packages --user 0",
          "shell pm list packages --user 10",
        ]);
        expect(result.warning).toContain("App data was lost for users: 0, 10");
        expect(result.warning).toContain("Package restored for users: 0, 10");
      },
    );

    test.each(["returned", "thrown"])(
      "warns and continues when install-existing fails (%s)",
      async (failure) => {
        configureDowngrade();
        fakeAdb.setUsers([
          { userId: 0, name: "Owner", flags: 0x13, running: true },
          { userId: 10, name: "Work", flags: 0x30, running: true },
          { userId: 11, name: "Other", flags: 0x30, running: false },
        ]);
        fakeAdb.setCommandResponse("shell pm list packages --user 11", present());
        const restoreCommand = `shell pm install-existing --user 0 '${packageName}'`;
        if (failure === "thrown") {
          fakeAdb.setCommandError(restoreCommand, new Error("adb: device offline"));
        } else {
          fakeAdb.setCommandResponse(restoreCommand, createExecResult("Failure [restore failed]"));
        }
        // Override the broad success response for the returned-failure case.
        fakeAdb.setCommandResponseSequence(restoreCommand, [
          createExecResult("Failure [restore failed]"),
        ]);
        const warn = spyOn(logger, "warn").mockImplementation(() => {});
        try {
          const result = await androidAction().execute(apkPath, 10);
          expect(result.success).toBe(true);
          expect(result.error).toBeUndefined();
          expect(result.warning).toContain("App data was lost for users: 0, 10, 11");
          expect(result.warning).toContain("Package restored for users: 10, 11");
          expect(result.warning).toContain("Could not restore package for user 0");
          expect(fakeAdb.wasCommandExecuted(`install-existing --user 11 '${packageName}'`)).toBe(
            true,
          );
          expect(warn.mock.calls.some(([message]) => String(message).includes("user 0"))).toBe(
            true,
          );
        } finally {
          warn.mockRestore();
        }
      },
    );

    test("failed reinstall reports removed users and preserves adb output", async () => {
      const command = configureDowngrade();
      fakeAdb.setCommandResponseSequence(command, [
        createExecResult("", "Failure [INSTALL_FAILED_VERSION_DOWNGRADE]"),
        createExecResult(
          "Performing Streamed Install",
          "Failure [INSTALL_FAILED_INSUFFICIENT_STORAGE]",
        ),
      ]);
      const result = await androidAction().execute(apkPath, 10);
      expect(result.success).toBe(false);
      expect(result.error).toContain(
        `The previous version of ${packageName} was uninstalled during downgrade recovery (INSTALL_FAILED_VERSION_DOWNGRADE)`,
      );
      expect(result.error).toContain("device now has no copy of the app");
      expect(result.error).toContain("removed for users: 0, 10");
      expect(result.error).toContain(
        "Performing Streamed Install\nFailure [INSTALL_FAILED_INSUFFICIENT_STORAGE]",
      );
      expect(fakeAdb.wasCommandExecuted("install-existing")).toBe(false);
      const commands = fakeAdb.getExecutedCommands();
      expect(commands.slice(commands.indexOf(`uninstall ${packageName}`))).toEqual([
        `uninstall ${packageName}`,
        command,
      ]);
    });

    test("thrown reinstall preserves the cause and reports that the app was removed", async () => {
      const command = configureDowngrade();
      const error = Object.assign(new Error("adb: device offline"), {
        stdout: "Performing Streamed Install",
        stderr: "Failure [INSTALL_FAILED_INVALID_APK]",
      });
      fakeAdb.reinstallError = error;
      const execution = androidAction().execute(apkPath, 10);
      await expect(execution).rejects.toThrow(
        `The previous version of ${packageName} was uninstalled`,
      );
      await expect(execution).rejects.toThrow("device now has no copy of the app");
      await expect(execution).rejects.toThrow("removed for users: 0, 10");
      await expect(execution).rejects.toThrow("adb: device offline");
      await expect(execution).rejects.toThrow("Performing Streamed Install");
      await expect(execution).rejects.toThrow("Failure [INSTALL_FAILED_INVALID_APK]");
      await expect(execution).rejects.toHaveProperty("cause", error);
      const commands = fakeAdb.getExecutedCommands();
      expect(commands.slice(commands.indexOf(`uninstall ${packageName}`))).toEqual([
        `uninstall ${packageName}`,
        command,
      ]);
    });

    const cancellationSources = ["explicit", "ambient", "ambient with explicit"] as const;

    function executeWithCancellation(
      source: (typeof cancellationSources)[number],
      controller: AbortController,
    ) {
      const signal =
        source === "ambient"
          ? undefined
          : source === "explicit"
            ? controller.signal
            : new AbortController().signal;
      return runWithAbortSignal(source === "explicit" ? undefined : controller.signal, () =>
        androidAction().execute(apkPath, 10, signal),
      );
    }

    test.each(
      cancellationSources.flatMap(
        (source) =>
          [
            [source, false],
            [source, true],
          ] as const,
      ),
    )(
      "downgrade reinstall finishes before reporting cancellation: %s (during reinstall: %s)",
      async (source, duringReinstall) => {
        const command = configureDowngrade();
        const adb = fakeAdb as InstallAppFakeAdbExecutor;
        adb.honourRequestAbort = true;
        const controller = new AbortController();
        const pending = Promise.withResolvers<ExecResult>();
        const started = Promise.withResolvers<boolean>();
        adb.reinstallOperation = () => {
          if (duringReinstall) {
            controller.abort(new DOMException("Client cancelled", "AbortError"));
          }
          started.resolve(true);
          return pending.promise;
        };
        if (!duringReinstall) {
          adb.abortAfterCommand("uninstall ", controller);
        }
        let settled = false;
        const execution = executeWithCancellation(source, controller);
        const outcome = execution.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );
        try {
          expect(await Promise.race([started.promise, outcome.then(() => false)])).toBe(true);
          expect(settled).toBe(false);
          expect(
            adb
              .getCommandCalls()
              .filter((call) => call.command === command)
              .at(-1)?.signal,
          ).toBeUndefined();
          pending.resolve(createExecResult("Success"));
          await expect(execution).rejects.toThrow("reinstalled for target user 10");
          await expect(execution).rejects.toHaveProperty("cause", controller.signal.reason);
          expect(adb.getExecutedCommands().filter((call) => call === command)).toHaveLength(2);
          expect(adb.wasCommandExecuted("install-existing")).toBe(false);
          expect(fakeTimer.getPendingTimeoutCount()).toBe(0);
        } finally {
          pending.resolve(createExecResult("Success"));
          await outcome;
        }
      },
    );

    test.each(cancellationSources)(
      "cancelled downgrade reinstall failure discloses missing app: %s",
      async (source) => {
        const command = configureDowngrade();
        const adb = fakeAdb as InstallAppFakeAdbExecutor;
        adb.honourRequestAbort = true;
        const failure = new Error("adb: device offline");
        adb.reinstallError = failure;
        const controller = new AbortController();
        adb.abortAfterCommand("uninstall ", controller);
        const execution = executeWithCancellation(source, controller);
        await expect(execution).rejects.toThrow("was uninstalled during downgrade recovery");
        await expect(execution).rejects.toThrow("not installed");
        await expect(execution).rejects.toThrow("adb: device offline");
        await expect(execution).rejects.toHaveProperty("cause", failure);
        expect(adb.getExecutedCommands().filter((call) => call === command)).toHaveLength(2);
        expect(adb.wasCommandExecuted("install-existing")).toBe(false);
      },
    );

    test.each(cancellationSources)(
      "cancelled downgrade reinstall output failure discloses missing app: %s",
      async (source) => {
        const command = configureDowngrade();
        const adb = fakeAdb as InstallAppFakeAdbExecutor;
        adb.honourRequestAbort = true;
        adb.setCommandResponseSequence(command, [
          createExecResult("", "Failure [INSTALL_FAILED_VERSION_DOWNGRADE]"),
          createExecResult("", "Failure [INSTALL_FAILED_INSUFFICIENT_STORAGE]"),
        ]);
        const controller = new AbortController();
        adb.abortAfterCommand("uninstall ", controller);
        const result = await executeWithCancellation(source, controller);
        expect(result.success).toBe(false);
        expect(result.error).toContain("was uninstalled during downgrade recovery");
        expect(result.error).toContain("not installed");
        expect(result.error).toContain("INSTALL_FAILED_INSUFFICIENT_STORAGE");
        expect(adb.getExecutedCommands().filter((call) => call === command)).toHaveLength(2);
        expect(adb.wasCommandExecuted("install-existing")).toBe(false);
      },
    );

    test.each(["explicit", "ambient"] as const)(
      "cancellation before downgrade uninstall prevents removal and reinstall: %s",
      async (source) => {
        const command = configureDowngrade();
        const adb = fakeAdb as InstallAppFakeAdbExecutor;
        adb.honourRequestAbort = true;
        const controller = new AbortController();
        adb.abortAfterCommand("shell am force-stop", controller);
        const execution = executeWithCancellation(source, controller);
        await expect(execution).rejects.toHaveProperty("name", "AbortError");
        await expect(execution).rejects.toBe(controller.signal.reason);
        expect(adb.wasCommandExecuted("uninstall ")).toBe(false);
        expect(adb.getExecutedCommands().filter((call) => call === command)).toHaveLength(1);
      },
    );

    test.each(["explicit", "ambient"] as const)(
      "cancellation during downgrade uninstall does not trigger reinstall: %s",
      async (source) => {
        const command = configureDowngrade();
        const adb = fakeAdb as InstallAppFakeAdbExecutor;
        adb.honourRequestAbort = true;
        const controller = new AbortController();
        const uninstall = adb.executeCommand.bind(adb);
        spyOn(adb, "executeCommand").mockImplementation(async (...args) => {
          if (args[0].startsWith("uninstall ")) {
            controller.abort();
            throw controller.signal.reason;
          }
          return uninstall(...args);
        });
        const execution = executeWithCancellation(source, controller);
        await expect(execution).rejects.toHaveProperty("name", "AbortError");
        await expect(execution).rejects.toBe(controller.signal.reason);
        expect(adb.getExecutedCommands().filter((call) => call === command)).toHaveLength(1);
        expect(adb.wasCommandExecuted("install-existing")).toBe(false);
      },
    );

    test.each(["explicit", "ambient"] as const)(
      "cancelled downgrade reinstall retains its step deadline: %s",
      async (source) => {
        configureDowngrade();
        fakeTimer = new FakeTimer();
        const adb = fakeAdb as InstallAppFakeAdbExecutor;
        adb.honourRequestAbort = true;
        emptyUserTenListingAfterUninstall(adb);
        const pending = Promise.withResolvers<ExecResult>();
        const started = Promise.withResolvers<boolean>();
        adb.reinstallOperation = () => {
          started.resolve(true);
          return pending.promise;
        };
        const controller = new AbortController();
        adb.abortAfterCommand("uninstall ", controller);
        const execution = executeWithCancellation(source, controller);
        const outcome = execution.then(
          () => undefined,
          () => undefined,
        );
        try {
          expect(await Promise.race([started.promise, outcome.then(() => false)])).toBe(true);
          expect(fakeTimer.getPendingTimeouts()).toEqual([120_000]);
          fakeTimer.enableAutoAdvance();
          fakeTimer.advanceTime(120_000);
          await expect(execution).rejects.toThrow("timed out after 120000ms");
          await expect(execution).rejects.toThrow("was uninstalled during downgrade recovery");
          await expect(execution).rejects.toThrow("indeterminate");
          await expect(execution).rejects.toThrow("do not retry automatically");
          expect(adb.wasCommandExecuted("install-existing")).toBe(false);
          expect(fakeTimer.getPendingTimeoutCount()).toBe(0);
        } finally {
          pending.resolve(createExecResult("Success"));
          await outcome;
        }
      },
    );

    test("uninstall errors propagate unchanged without claiming removal", async () => {
      configureDowngrade();
      const error = new Error("uninstall denied");
      fakeAdb.setCommandError(`uninstall ${packageName}`, error);
      await expect(androidAction().execute(apkPath, 10)).rejects.toBe(error);
    });

    test("unavailable user enumeration falls back to the target user", async () => {
      const installCommand = configureDowngrade();
      fakeAdb.setUsers([]);
      const result = await androidAction().execute(apkPath, 10);
      expect(result.success).toBe(true);
      expect(result.warning).toContain(
        "Other users could not be checked and may have lost the app",
      );
      const commands = fakeAdb.getExecutedCommands();
      expect(commands.slice(commands.indexOf(`uninstall ${packageName}`))).toEqual([
        `uninstall ${packageName}`,
        installCommand,
        "shell pm list packages --user 10",
      ]);
    });

    test("failed other-user listing proceeds and names the unchecked user", async () => {
      configureDowngrade();
      fakeAdb.setCommandError("shell pm list packages --user 0", new Error("listing failed"));
      const result = await androidAction().execute(apkPath, 10);
      expect(result.success).toBe(true);
      expect(result.warning).toContain("User 0 could not be checked and may have lost the app");
      expect(result.warning).toContain("listing failed");
      expect(fakeAdb.wasCommandExecuted(`uninstall ${packageName}`)).toBe(true);
      expect(fakeAdb.wasCommandExecuted("install-existing")).toBe(false);
    });

    test("cancellation during other-user listing still propagates", async () => {
      configureDowngrade();
      const cancellation = new DOMException("Listing aborted", "AbortError");
      fakeAdb.setCommandError("shell pm list packages --user 0", cancellation);
      await expect(androidAction().execute(apkPath, 10)).rejects.toBe(cancellation);
      expect(fakeAdb.wasCommandExecuted("uninstall ")).toBe(false);
    });

    test("cancel mid-restore reports progress and issues no further adb commands", async () => {
      configureDowngrade();
      fakeAdb.setUsers([
        { userId: 0, name: "Owner", flags: 0x13, running: true },
        { userId: 10, name: "Work", flags: 0x30, running: true },
        { userId: 11, name: "Other", flags: 0x30, running: false },
      ]);
      fakeAdb.setCommandResponse("shell pm list packages --user 11", present());
      const controller = new AbortController();
      const restoreCommand = `shell pm install-existing --user 0 '${packageName}'`;
      // Deliberately lenient fake: the action must stop even if ADB ignores the signal.
      fakeAdb.abortAfterCommand(restoreCommand, controller);
      const execution = androidAction().execute(apkPath, 10, controller.signal);
      await expect(execution).rejects.toBeInstanceOf(ActionableError);
      await expect(execution).rejects.toHaveProperty("cause", controller.signal.reason);
      await expect(execution).rejects.toThrow("was uninstalled");
      await expect(execution).rejects.toThrow("reinstalled for target user 10");
      await expect(execution).rejects.toThrow("restored for users: 0");
      await expect(execution).rejects.toThrow("NOT restored for users: 11");
      const commands = fakeAdb.getExecutedCommands();
      expect(commands.slice(commands.indexOf(restoreCommand))).toEqual([restoreCommand]);
    });

    test("thrown restore cancellation preserves its cause and stops other users", async () => {
      configureDowngrade();
      const cancellation = new DOMException("Restore aborted", "AbortError");
      const restoreCommand = `shell pm install-existing --user 0 '${packageName}'`;
      fakeAdb.setCommandError(restoreCommand, cancellation);
      const execution = androidAction().execute(apkPath, 10);
      await expect(execution).rejects.toBeInstanceOf(ActionableError);
      await expect(execution).rejects.toHaveProperty("cause", cancellation);
      await expect(execution).rejects.toThrow("NOT restored for users: 0");
      const commands = fakeAdb.getExecutedCommands();
      expect(commands.slice(commands.indexOf(restoreCommand))).toEqual([restoreCommand]);
    });

    test("cancellation after restore confirmation stops before target verification", async () => {
      configureDowngrade();
      const controller = new AbortController();
      // The first listing is discovery; only the second listing confirms the restore.
      fakeAdb.setCommandResponseSequence("shell pm list packages --user 0", [present(), present()]);
      fakeAdb.postRestoreAbortController = controller;
      const execution = androidAction().execute(apkPath, 10, controller.signal);
      await expect(execution).rejects.toBeInstanceOf(ActionableError);
      await expect(execution).rejects.toHaveProperty("cause", controller.signal.reason);
      await expect(execution).rejects.toThrow("reinstalled for target user 10");
      const commands = fakeAdb.getExecutedCommands();
      const restoreIndex = commands.indexOf(`shell pm install-existing --user 0 '${packageName}'`);
      expect(commands.slice(restoreIndex)).toEqual([
        `shell pm install-existing --user 0 '${packageName}'`,
        "shell pm list packages --user 0",
      ]);
    });

    test.each([false, true])(
      "no users: none wording when no user had the package (reinstall fails: %s)",
      async (fails) => {
        const installCommand = configureDowngrade();
        fakeAdb.setCommandResponse(
          "shell pm list packages --user 0",
          createExecResult("package:other"),
        );
        fakeAdb.setCommandResponseSequence("shell pm list packages --user 10", [
          present(),
          present(),
          createExecResult("package:other"),
          present(),
        ]);
        if (fails) {
          fakeAdb.setCommandResponseSequence(installCommand, [
            createExecResult("", "Failure [INSTALL_FAILED_VERSION_DOWNGRADE]"),
            createExecResult("Failure [INSTALL_FAILED_INVALID_APK]"),
          ]);
        }
        const result = await androidAction().execute(apkPath, 10);
        expect(result.success).toBe(!fails);
        expect(result.warning ?? result.error).not.toContain("users: none");
        if (!fails) {
          expect(result.warning).toBe(
            `Installed version of ${packageName} was newer than the artifact; uninstalled it and reinstalled the provided version.`,
          );
        }
      },
    );

    test("successful install-existing without package presence reports not restored", async () => {
      configureDowngrade();
      fakeAdb.setCommandResponseSequence("shell pm list packages --user 0", [
        present(),
        createExecResult("package:other"),
      ]);
      const result = await androidAction().execute(apkPath, 10);
      expect(result.success).toBe(true);
      expect(result.warning).toContain("NOT restored for users: 0");
      expect(result.warning).toContain("Package restored for users: 10");
      expect(fakeAdb.getExecutedCommands().slice(-2)).toEqual([
        "shell pm list packages --user 0",
        "shell pm list packages --user 10",
      ]);
    });

    test("failed restore confirmation warns without failing the target install", async () => {
      configureDowngrade();
      fakeAdb.postRestoreListingError = new Error("confirmation offline");
      const result = await androidAction().execute(apkPath, 10);
      expect(result.success).toBe(true);
      expect(result.warning).toContain("could not confirm");
      expect(result.warning).toContain("user 0");
      expect(result.warning).toContain("confirmation offline");
      expect(result.warning).not.toContain("Package restored for users: 0");
    });

    test("does not restore users who did not have the package", async () => {
      configureDowngrade();
      fakeAdb.setCommandResponse(
        "shell pm list packages --user 0",
        createExecResult("package:com.example.other"),
      );
      const result = await androidAction().execute(apkPath, 10);
      expect(result.warning).toBe(
        `Installed version of ${packageName} was newer than the artifact; uninstalled it and reinstalled the provided version.`,
      );
      expect(fakeAdb.wasCommandExecuted("install-existing")).toBe(false);
    });

    test("failed post-install listing keeps known package name and logs a warning", async () => {
      const error = new Error("adb: device offline");
      fakeAdb.postInstallListingError = error;
      fakeAdb.setCommandResponse(`install --user 0 -r "${apkPath}"`, createExecResult("Success"));
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      try {
        const result = await androidAction().execute(apkPath, 0);
        expect(result.success).toBe(true);
        expect(result.packageName).toBe(packageName);
        expect(result.error).toBeUndefined();
        expect(result.warning).toContain(
          "Install completed but could not verify installed package on the device: adb: device offline",
        );
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not verify"), error);
      } finally {
        warn.mockRestore();
      }
    });

    test("post-install listing cancellation propagates", async () => {
      const controller = new AbortController();
      fakeAdb.setThrowOnAbortedSignal();
      fakeAdb.abortAfterCommand("install --user 0", controller);
      fakeAdb.setCommandResponse(`install --user 0 -r "${apkPath}"`, createExecResult("Success"));
      await expect(androidAction().execute(apkPath, 0, controller.signal)).rejects.toThrow(
        "Operation cancelled",
      );
    });

    test("post-install listing AbortError propagates without an aborted signal", async () => {
      const error = new DOMException("Listing aborted", "AbortError");
      fakeAdb.postInstallListingError = error;
      fakeAdb.setCommandResponse(`install --user 0 -r "${apkPath}"`, createExecResult("Success"));
      await expect(androidAction().execute(apkPath, 0)).rejects.toBe(error);
    });

    test.each(["", "package:com.example.other"])(
      "successful listing without the package retains the exact mismatch error (%s)",
      async (listing) => {
        const adb = new FakeAdbExecutor();
        adb.setCommandResponse(`install --user 0 -r "${apkPath}"`, createExecResult("Success"));
        adb.setCommandResponseSequence("shell pm list packages --user 0", [
          createExecResult(""),
          createExecResult(""),
          createExecResult(listing),
        ]);
        await expect(androidAction({ create: () => adb }).execute(apkPath, 0)).rejects.toThrow(
          `APK package name mismatch: aapt reported "${packageName}", but the device reported "${listing ? "com.example.other" : "no installed package"}" after installation. Verify the APK manifest application ID and install the matching APK.`,
        );
      },
    );

    test.each([false, true])(
      "normal install command sequence remains unchanged (upgrade: %s)",
      async (upgrade) => {
        fakeAdb.setCommandResponse(
          "shell pm list packages --user 0",
          upgrade ? present() : createExecResult(""),
        );
        fakeAdb.setCommandResponse(`install --user 0 -r "${apkPath}"`, createExecResult("Success"));
        // Explicit post-install presence avoids the fake's com.example.app fallback.
        fakeAdb.setCommandResponseSequence("shell pm list packages --user 0", [
          upgrade ? present() : createExecResult(""),
          upgrade ? present() : createExecResult(""),
          present(),
        ]);
        const result = await androidAction().execute(apkPath, 0);
        expect(result).toEqual({
          success: true,
          error: undefined,
          userId: 0,
          packageName,
          upgrade,
          warning: undefined,
        });
        expect(fakeAdb.getExecutedCommands()).toEqual([
          "shell pm list packages --user 0",
          "shell pm list packages --user 0",
          // An upgrade snapshots the installed version so a timed-out install can be judged.
          ...(upgrade ? [`shell dumpsys package '${packageName}'`] : []),
          `install --user 0 -r "${apkPath}"`,
          "shell pm list packages --user 0",
        ]);
      },
    );
  });

  test("Android downgrade without a resolvable package name surfaces a clear error", async () => {
    const apkPath = "/tmp/app-debug.apk";
    const perf = createPerformanceTracker(true, fakeTimer);

    fakeLocator.setTool(null); // no aapt2 → package name cannot be determined
    fakeAdb.setCommandResponse(
      `install --user 0 -r "${apkPath}"`,
      createExecResult("", "Failure [INSTALL_FAILED_VERSION_DOWNGRADE]"),
    );

    const installApp = new InstallApp(device, fakeAdbFactory, {
      hostExecutor: fakeHost,
      buildToolsLocator: fakeLocator,
      performanceTrackerFactory: () => perf,
    });

    await expect(installApp.execute(apkPath)).rejects.toThrow("INSTALL_FAILED_VERSION_DOWNGRADE");
    expect(fakeAdb.wasCommandExecuted("uninstall")).toBe(false);
  });

  test("Android non-downgrade install failure throws the original error without uninstalling", async () => {
    const apkPath = "/tmp/app-debug.apk";
    const perf = createPerformanceTracker(true, fakeTimer);

    fakeLocator.setTool({ tool: "aapt2", path: "/sdk/build-tools/35.0.0/aapt2" });
    fakeHost.setCommandResponse(
      "aapt2",
      createExecResult("package: name='com.example.app' versionCode='1'"),
    );
    fakeAdb.setCommandResponse("shell pm list packages --user 0", createExecResult(""));
    fakeAdb.setCommandError(
      `install --user 0 -r "${apkPath}"`,
      new Error("Failure [INSTALL_FAILED_INVALID_APK]"),
    );

    const installApp = new InstallApp(device, fakeAdbFactory, {
      hostExecutor: fakeHost,
      buildToolsLocator: fakeLocator,
      performanceTrackerFactory: () => perf,
    });

    await expect(installApp.execute(apkPath)).rejects.toThrow("INSTALL_FAILED_INVALID_APK");
    expect(fakeAdb.wasCommandExecuted("uninstall com.example.app")).toBe(false);
  });

  test("iOS simulator recovers from version downgrade by uninstalling then reinstalling", async () => {
    const appPath = "/tmp/MyApp.app";
    const perf = createPerformanceTracker(true, fakeTimer);
    const simctl = new DowngradeFakeSimctl();
    simctl.installError = new Error(
      "Unable to install. A newer version of this application is already installed.",
    );
    simctl.setListResponses([
      [{ bundleId: "com.example.app", bundlePath: "/tmp/MyApp.app" }],
      [{ bundleId: "com.example.app", bundlePath: "/tmp/MyApp.app" }],
    ]);
    fakeHost.setCommandResponse("plutil", createExecResult("com.example.app\n"));

    const installApp = new InstallApp(iosSimulatorDevice, fakeAdbFactory, {
      hostExecutor: fakeHost,
      performanceTrackerFactory: () => perf,
      simctl: simctl,
      plist: fakePlist("com.example.app\n"),
    });
    const result = await installApp.execute(appPath);

    expect(result.success).toBe(true);
    expect(result.upgrade).toBe(false);
    expect(result.warning).toContain("uninstalled it and reinstalled");
    expect(simctl.wasMethodCalled("uninstallApp")).toBe(true);
    expect(simctl.getMethodCalls("uninstallApp")[0].bundleId).toBe("com.example.app");
    // Only the successful reinstall is recorded; the first attempt threw before recording.
    expect(simctl.getMethodCallCount("installApp")).toBe(1);
  });

  test.each([
    "success",
    "terminate failure",
    "uninstall failure",
    "reinstall failure",
    "no backend",
  ])("uses the injected downgrade recovery backend: %s", async (outcome) => {
    const calls: string[] = [];
    const originalError = new Error("A newer version of this application is already installed.");
    const uninstallError = new Error("uninstall rejected");
    const reinstallError = new Error("reinstall rejected");
    const simctl = new FakeSimctl();
    const repository = new CountingInstalledAppsRepository();
    let attempts = 0;
    let listings = 0;
    const installApp = new InstallApp(iosSimulatorDevice, fakeAdbFactory, {
      simctl,
      timer: fakeTimer,
      performanceTrackerFactory: () => createPerformanceTracker(false, fakeTimer),
      plist: fakePlist("com.example.app"),
      installedAppsRepository: repository,
      cacheInvalidator: {
        invalidate: () => {
          calls.push("invalidate");
        },
      },
      iosInstallBackendResolver: () => ({
        kind: "simulator",
        listApps: async () => {
          if (listings++ > 0) {
            throw new Error("post-install listing unavailable");
          }
          return [];
        },
        installApp: async () => {
          calls.push(attempts++ === 0 ? "install" : "reinstall");
          if (attempts > 1) {
            expect(repository.markStaleCalls).toBe(1);
          }
          if (attempts === 1) {
            throw originalError;
          }
          if (outcome === "reinstall failure") {
            throw reinstallError;
          }
        },
      }),
      iosDowngradeRecoveryBackendResolver: (deviceId, deps) => {
        expect(deviceId).toBe(iosSimulatorDevice.deviceId);
        expect(deps.simctl).toBe(simctl);
        calls.push("resolve recovery");
        return outcome === "no backend"
          ? null
          : {
              kind: "simulator",
              terminateApp: async (bundleId) => {
                expect(bundleId).toBe("com.example.app");
                calls.push("terminate");
                if (outcome === "terminate failure") {
                  throw new Error("not running");
                }
              },
              uninstallApp: async (bundleId) => {
                expect(bundleId).toBe("com.example.app");
                calls.push("uninstall");
                if (outcome === "uninstall failure") {
                  throw uninstallError;
                }
              },
            };
      },
    });

    if (outcome === "no backend") {
      await expect(installApp.execute("/tmp/MyApp.app")).rejects.toBe(originalError);
      expect(calls).toEqual(["install", "resolve recovery"]);
      expect(repository.markStaleCalls).toBe(0);
    } else if (outcome === "uninstall failure") {
      await expect(installApp.execute("/tmp/MyApp.app")).rejects.toBe(uninstallError);
      expect(calls).toEqual(["install", "resolve recovery", "terminate", "uninstall"]);
      expect(repository.markStaleCalls).toBe(0);
    } else {
      if (outcome === "reinstall failure") {
        const failure = await installApp.execute("/tmp/MyApp.app").catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(ActionableError);
        expect((failure as ActionableError).cause).toBe(reinstallError);
        expect((failure as ActionableError).message).toContain(
          "was uninstalled during downgrade recovery",
        );
      } else {
        expect((await installApp.execute("/tmp/MyApp.app")).success).toBe(true);
      }
      expect(calls.slice(0, 6)).toEqual([
        "install",
        "resolve recovery",
        "terminate",
        "uninstall",
        "invalidate",
        "reinstall",
      ]);
      expect(repository.markStaleCalls).toBe(outcome === "reinstall failure" ? 1 : 2);
    }
    expect(simctl.getMethodCalls("terminateApp")).toEqual([]);
    expect(simctl.getMethodCalls("uninstallApp")).toEqual([]);
  });

  test.each([false, true])(
    "resolves a pre-existing iOS bundle after listing (baseline retry: %s)",
    async (retry) => {
      const calls: string[] = [];
      let listings = 0;
      const bundleId = "com.example.app";
      const installApp = new InstallApp(iosSimulatorDevice, fakeAdbFactory, {
        timer: fakeTimer,
        performanceTrackerFactory: () => createPerformanceTracker(false, fakeTimer),
        plist: {
          ...fakePlist(bundleId),
          extractRawFile: async () => {
            calls.push("resolve bundle");
            return bundleId;
          },
        },
        cacheInvalidator: {
          invalidate: () => {
            calls.push("invalidate");
          },
        },
        installedAppsRepository: Object.assign(new FakeInstalledAppsRepository(), {
          markDeviceStale: async () => {
            calls.push("stale");
          },
        }),
        iosInstallBackendResolver: () => ({
          kind: "simulator",
          listApps: async () => {
            calls.push("list");
            if (listings++ === 0 && retry) {
              throw new Error("transient listing failure");
            }
            return [{ bundleId }];
          },
          installApp: async () => {
            calls.push("install");
          },
        }),
      });
      const result = await installApp.execute("/tmp/MyApp.app");
      expect(result).toMatchObject({ success: true, packageName: bundleId, upgrade: true });
      expect(result.warning).toBeUndefined();
      expect(calls).toEqual([
        "list",
        ...(retry ? ["list"] : []),
        "install",
        "invalidate",
        "stale",
        "list",
        "resolve bundle",
      ]);
      expect(fakeAdb.getExecutedCommands()).toEqual([]);
    },
  );

  test("keeps iOS simulator install successful when post-install listing fails", async () => {
    const simctl = new SequencedFakeSimctl();
    simctl.setStrictListResponses([[], new Error("simctl listapps temporarily unavailable")]);
    const appPath = "/tmp/MyApp.app";
    const installApp = new InstallApp(iosSimulatorDevice, fakeAdbFactory, {
      hostExecutor: fakeHost,
      buildToolsLocator: fakeLocator,
      simctl: simctl,
      plist: fakePlist("com.example.app"),
      installedAppsRepository: new FakeInstalledAppsRepository(),
    });

    const result = await installApp.execute(appPath);

    expect(result.success).toBe(true);
    expect(result.warning).toContain("Could not verify installed bundle");
    expect(result.packageName).toBeUndefined();
    expect(simctl.getMethodCalls("installApp")).toHaveLength(1);
  });

  test("retries the pre-install iOS simulator listing once and then fails loudly", async () => {
    const simctl = new SequencedFakeSimctl();
    simctl.setStrictListResponses([
      new Error("first listapps failure"),
      new Error("second listapps failure"),
    ]);
    const installApp = new InstallApp(iosSimulatorDevice, fakeAdbFactory, {
      hostExecutor: fakeHost,
      buildToolsLocator: fakeLocator,
      simctl: simctl,
      plist: fakePlist("com.example.app"),
      installedAppsRepository: new FakeInstalledAppsRepository(),
    });

    await expect(installApp.execute("/tmp/MyApp.app")).rejects.toThrow("second listapps failure");
    expect(simctl.strictListCalls).toBe(2);
    expect(simctl.getMethodCalls("installApp")).toHaveLength(0);
  });

  test("iOS simulator downgrade fails clearly when bundle ID cannot be read", async () => {
    const appPath = "/tmp/MyApp.app";
    const perf = createPerformanceTracker(true, fakeTimer);
    const simctl = new DowngradeFakeSimctl();
    simctl.installError = new Error("A newer version of this application is already installed.");
    simctl.setListResponses([[], []]);
    fakeHost.setCommandResponse("plutil", createExecResult("")); // empty → unresolved bundle id

    const installApp = new InstallApp(iosSimulatorDevice, fakeAdbFactory, {
      hostExecutor: fakeHost,
      performanceTrackerFactory: () => perf,
      simctl: simctl,
      plist: fakePlist(""),
    });

    await expect(installApp.execute(appPath)).rejects.toThrow(
      "bundle identifier could not be read",
    );
    expect(simctl.wasMethodCalled("uninstallApp")).toBe(false);
  });

  test("iOS physical downgrade surfaces actionable uninstall guidance", async () => {
    const ipaPath = "/tmp/MyApp.ipa";
    const perf = createPerformanceTracker(true, fakeTimer);
    const fakeInstaller = new FakeDeviceAppInstaller();
    fakeInstaller.shouldThrow = new Error(
      "Unable to Install. A newer version of this application is already installed.",
    );

    const installApp = new InstallApp(iosPhysicalDevice, fakeAdbFactory, {
      performanceTrackerFactory: () => perf,
      deviceAppInstaller: fakeInstaller,
    });

    await expect(installApp.execute(ipaPath)).rejects.toThrow(
      "Uninstall the app first with uninstallApp",
    );
  });

  // #10191: the adb install step budget only kills the host process; the device may finish.
  describe("Android install that hits the adb timeout (#10191)", () => {
    const apkPath = "/tmp/app-debug.apk";
    const packageName = "dev.jasonpearson.automobile.playground";
    const installCommand = `install --user 0 -r "${apkPath}"`;
    const listCommand = "shell pm list packages --user 0";
    const dumpsysCommand = `shell dumpsys package '${packageName}'`;
    const present = () => createExecResult(`package:${packageName}`);
    const absent = () => createExecResult("");
    // The "before" snapshot is the captured fixture; the "after" snapshot only moves its
    // lastUpdateTime, as a committed upgrade would.
    const dumpsysBefore = readFileSync(
      path.join(
        import.meta.dir,
        "../../fixtures/android-dumpsys-package/dumpsys-package-installed.txt",
      ),
      "utf8",
    );
    const dumpsysAfter = dumpsysBefore.replace(
      "lastUpdateTime=2026-10-03 17:28:08",
      "lastUpdateTime=2026-10-06 09:15:42",
    );
    const timeoutError = () =>
      new AdbCommandTimeoutError(`Command timed out after 120000ms: adb -s x ${installCommand}`);

    function setup(installTimesOut = true): {
      repo: CountingInstalledAppsRepository;
      installApp: InstallApp;
    } {
      fakeLocator.setTool({ tool: "aapt2", path: "/sdk/build-tools/36.0.0/aapt2" });
      fakeHost.setCommandResponse("aapt2", createExecResult(playgroundBadgingOutput));
      fakeAdb.setUsers([{ userId: 0, name: "Owner", flags: 0x13, running: true }]);
      if (installTimesOut) {
        fakeAdb.setCommandError(installCommand, timeoutError());
      }
      const repo = new CountingInstalledAppsRepository();
      const installApp = new InstallApp(device, fakeAdbFactory, {
        hostExecutor: fakeHost,
        buildToolsLocator: fakeLocator,
        performanceTrackerFactory: () => createPerformanceTracker(false, fakeTimer),
        timer: fakeTimer,
        installedAppsRepository: repo,
      });
      return { repo, installApp };
    }

    test("first install the device finishes after the timeout reports success with a warning", async () => {
      const { repo, installApp } = setup();
      await repo.seedInstalledApp(device.deviceId, 0, "com.other", false, 1_000);
      fakeAdb.setCommandResponseSequence(listCommand, [absent(), absent(), present()]);

      const result = await installApp.execute(apkPath, 0);

      expect(result).toMatchObject({ success: true, upgrade: false, userId: 0, packageName });
      expect(result.warning).toContain("timed out but the device finished installing");
      expect(fakeAdb.getExecutedCommands()).toEqual([
        listCommand,
        listCommand,
        installCommand,
        listCommand, // live re-read after the timeout
        listCommand, // post-install verification
      ]);
      expect(repo.markStaleCalls).toBeGreaterThan(0);
      expect(await repo.getCacheVerifiedAt(device.deviceId)).toBe(0);
    });

    test("first install absent from the device is indeterminate, never a flat failure", async () => {
      const { repo, installApp } = setup();
      await repo.seedInstalledApp(device.deviceId, 0, "com.other", false, 1_000);
      fakeAdb.setCommandResponse(listCommand, absent());

      const result = await installApp.execute(apkPath, 0);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Install outcome is indeterminate");
      expect(result.error).toContain("may still complete; do not retry automatically");
      expect(result.error).toContain(`${packageName} is not listed for user 0`);
      expect(result.error).not.toContain("Failed to install");
      // Two pre-install reads, the install, then three bounded live re-reads.
      expect(fakeAdb.getExecutedCommands()).toEqual([
        listCommand,
        listCommand,
        installCommand,
        listCommand,
        listCommand,
        listCommand,
      ]);
      expect(fakeTimer.getSleepHistory()).toEqual([2_000, 2_000]);
      expect(repo.markStaleCalls).toBeGreaterThan(0);
      expect(await repo.getCacheVerifiedAt(device.deviceId)).toBe(0);
    });

    test("upgrade whose lastUpdateTime moved after the timeout is a success", async () => {
      const { repo, installApp } = setup();
      await repo.seedInstalledApp(device.deviceId, 0, packageName, false, 1_000);
      fakeAdb.setCommandResponse(listCommand, present());
      fakeAdb.setCommandResponseSequence("shell dumpsys package", [
        createExecResult(dumpsysBefore),
        createExecResult(dumpsysAfter),
      ]);

      const result = await installApp.execute(apkPath, 0);

      expect(result).toMatchObject({ success: true, upgrade: true, packageName });
      expect(result.warning).toContain("timed out but the device finished installing");
      expect(fakeAdb.getExecutedCommands()).toEqual([
        listCommand,
        listCommand,
        dumpsysCommand,
        installCommand,
        listCommand,
        dumpsysCommand,
        listCommand,
      ]);
      expect(await repo.getCacheVerifiedAt(device.deviceId)).toBe(0);
    });

    test("upgrade still showing the pre-install copy is indeterminate", async () => {
      const { repo, installApp } = setup();
      await repo.seedInstalledApp(device.deviceId, 0, packageName, false, 1_000);
      fakeAdb.setCommandResponse(listCommand, present());
      fakeAdb.setCommandResponse("shell dumpsys package", createExecResult(dumpsysBefore));

      const result = await installApp.execute(apkPath, 0);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Install outcome is indeterminate");
      expect(result.error).toContain("still the pre-install copy");
      expect(await repo.getCacheVerifiedAt(device.deviceId)).toBe(0);
    });

    test("a failed live re-read is indeterminate and names the read failure", async () => {
      const { installApp } = setup();
      fakeAdb.setCommandResponseSequence(listCommand, [absent(), absent()]);
      const execute = fakeAdb.executeCommand.bind(fakeAdb);
      let installed = false;
      spyOn(fakeAdb, "executeCommand").mockImplementation(async (...args) => {
        if (installed && args[0] === listCommand) {
          throw new Error("adb: device offline");
        }
        installed ||= args[0] === installCommand;
        return execute(...args);
      });

      const result = await installApp.execute(apkPath, 0);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Install outcome is indeterminate");
      expect(result.error).toContain("the package-state check failed: adb: device offline");
    });

    test("downgrade reinstall that times out then appears is reported as installed", async () => {
      const { repo, installApp } = setup(false);
      await repo.seedInstalledApp(device.deviceId, 0, packageName, false, 1_000);
      fakeAdb.setCommandResponse(listCommand, present());
      const execute = fakeAdb.executeCommand.bind(fakeAdb);
      let installs = 0;
      spyOn(fakeAdb, "executeCommand").mockImplementation(async (...args) => {
        if (args[0] === installCommand) {
          if (++installs === 1) {
            return createExecResult("", "Failure [INSTALL_FAILED_VERSION_DOWNGRADE]");
          }
          throw timeoutError();
        }
        return execute(...args);
      });

      const result = await installApp.execute(apkPath, 0);

      expect(result.success).toBe(true);
      expect(result.warning).toContain("timed out but the device finished installing");
      expect(await repo.getCacheVerifiedAt(device.deviceId)).toBe(0);
    });

    test("downgrade reinstall that times out and is absent never claims the app is not installed", async () => {
      const { installApp } = setup(false);
      fakeAdb.setCommandResponse(listCommand, present());
      const execute = fakeAdb.executeCommand.bind(fakeAdb);
      let installs = 0;
      spyOn(fakeAdb, "executeCommand").mockImplementation(async (...args) => {
        if (args[0] === installCommand) {
          if (++installs === 1) {
            return createExecResult("", "Failure [INSTALL_FAILED_VERSION_DOWNGRADE]");
          }
          throw timeoutError();
        }
        if (args[0].startsWith("uninstall ")) {
          fakeAdb.setCommandResponse(listCommand, absent());
        }
        return execute(...args);
      });

      const rejection = installApp.execute(apkPath, 0);
      await expect(rejection).rejects.toThrow("was uninstalled during downgrade recovery");
      await expect(rejection).rejects.toThrow("Install outcome is indeterminate");
      await expect(rejection).rejects.toThrow("do not retry automatically");
      await expect(rejection).rejects.not.toThrow("the app is not installed");
    });

    test("error classification ignores the echoed command line and APK path", async () => {
      const { installApp } = setup(false);
      const hostile = `/tmp/INSTALL_FAILED_VERSION_DOWNGRADE.apk`;
      const command = `install --user 0 -r "${hostile}"`;
      fakeAdb.setCommandError(
        command,
        Object.assign(new Error(`Command failed: adb ${command}`), {
          stderr: "Failure [INSTALL_FAILED_INSUFFICIENT_STORAGE]",
        }),
      );

      await expect(installApp.execute(hostile, 0)).rejects.toThrow("Command failed");
      expect(fakeAdb.wasCommandExecuted("uninstall ")).toBe(false);
    });
  });

  // The failure texts below are SYNTHETIC: no captured `simctl install` / `devicectl device install`
  // rejection exists under test/fixtures. To capture real ones, run
  // `xcrun simctl install <udid> <damaged-or-wrong-arch .app>` and
  // `xcrun devicectl device install app --device <udid> <bad .ipa>` and record stderr.
  describe("iOS downgrade classification and recovery disclosure", () => {
    const bundleId = "com.example.app";
    const downgradeDirApp = "/tmp/downgrade-fixtures/MyApp.app";
    const downgradeDirIpa = "/tmp/downgrade-fixtures/MyApp.ipa";
    const unrelatedStderr =
      "An error was encountered processing the command (domain=IXUserPresentableErrorDomain, code=1)";
    const newerStderr =
      "Unable to install. A newer version of this application is already installed.";

    function execRejection(file: string, artifact: string, stderr: string | undefined): Error {
      const error = new Error(`Command failed: ${file} ${artifact}${stderr ? `\n${stderr}` : ""}`);
      return stderr === undefined ? error : Object.assign(error, { code: 1, stderr });
    }

    interface SimulatorHarness {
      calls: string[];
      action: InstallApp;
    }

    function simulatorHarness(options: {
      firstInstallError: Error;
      onUninstall?: () => void;
      reinstall?: () => Promise<void>;
    }): SimulatorHarness {
      const calls: string[] = [];
      let attempts = 0;
      const action = new InstallApp(iosSimulatorDevice, fakeAdbFactory, {
        timer: fakeTimer,
        performanceTrackerFactory: () => createPerformanceTracker(false, fakeTimer),
        plist: fakePlist(bundleId),
        installedAppsRepository: new FakeInstalledAppsRepository(),
        iosInstallBackendResolver: () => ({
          kind: "simulator",
          listApps: async () => (attempts > 1 ? [{ bundleId }] : []),
          installApp: async () => {
            if (attempts++ === 0) {
              calls.push("install");
              throw options.firstInstallError;
            }
            calls.push("reinstall");
            await options.reinstall?.();
          },
        }),
        iosDowngradeRecoveryBackendResolver: () => ({
          kind: "simulator",
          terminateApp: async () => {
            calls.push("terminate");
          },
          uninstallApp: async () => {
            calls.push("uninstall");
            options.onUninstall?.();
          },
        }),
      });
      return { calls, action };
    }

    test.each([
      ["stderr attached", unrelatedStderr],
      ["message only", undefined],
    ])(
      "simulator: a path containing 'downgrade' does not trigger recovery (%s)",
      async (_label, stderr) => {
        const error = execRejection(`xcrun simctl install UDID`, downgradeDirApp, stderr);
        const { calls, action } = simulatorHarness({ firstInstallError: error });
        await expect(action.execute(downgradeDirApp)).rejects.toBe(error);
        expect(calls).toEqual(["install"]);
      },
    );

    test.each([
      ["the full artifact path", `Unable to install ${downgradeDirApp}: damaged bundle`],
      ["the artifact basename", "Unable to install MyDowngrade.app: damaged bundle"],
    ])("simulator: tool output echoing %s does not trigger recovery", async (label, stderr) => {
      const artifact =
        label === "the artifact basename" ? "/tmp/builds/MyDowngrade.app" : downgradeDirApp;
      const error = execRejection(`xcrun simctl install UDID`, artifact, stderr);
      const { calls, action } = simulatorHarness({ firstInstallError: error });
      await expect(action.execute(artifact)).rejects.toBe(error);
      expect(calls).toEqual(["install"]);
    });

    test("simulator: a real rejection that also echoes the artifact path still recovers", async () => {
      const error = execRejection(
        `xcrun simctl install UDID`,
        downgradeDirApp,
        `${downgradeDirApp}: ${newerStderr}`,
      );
      const { calls, action } = simulatorHarness({ firstInstallError: error });
      const result = await action.execute(downgradeDirApp);
      expect(result.success).toBe(true);
      expect(calls).toEqual(["install", "terminate", "uninstall", "reinstall"]);
    });

    test("simulator: a real downgrade rejection still recovers when the path contains 'downgrade'", async () => {
      const error = execRejection(`xcrun simctl install UDID`, downgradeDirApp, newerStderr);
      const { calls, action } = simulatorHarness({ firstInstallError: error });
      const result = await action.execute(downgradeDirApp);
      expect(result.success).toBe(true);
      expect(calls).toEqual(["install", "terminate", "uninstall", "reinstall"]);
    });

    test.each([
      ["stderr attached", unrelatedStderr],
      ["message only", undefined],
    ])(
      "physical: a path containing 'downgrade' does not claim a newer version is installed (%s)",
      async (_label, stderr) => {
        const installer = new FakeDeviceAppInstaller();
        const error = execRejection(
          `xcrun devicectl device install app --device UDID`,
          downgradeDirIpa,
          stderr,
        );
        installer.shouldThrow = error;
        const action = new InstallApp(iosPhysicalDevice, fakeAdbFactory, {
          performanceTrackerFactory: () => createPerformanceTracker(false, fakeTimer),
          deviceAppInstaller: installer,
        });
        await expect(action.execute(downgradeDirIpa)).rejects.toBe(error);
      },
    );

    test("physical: a downgrade rejection wrapped with a cause still gives uninstall guidance", async () => {
      const installer = new FakeDeviceAppInstaller();
      installer.shouldThrow = new ActionableError(
        `Failed to install app on physical iOS device: Command failed: xcrun devicectl ${downgradeDirIpa}`,
        { cause: execRejection("xcrun devicectl", downgradeDirIpa, newerStderr) },
      );
      const action = new InstallApp(iosPhysicalDevice, fakeAdbFactory, {
        performanceTrackerFactory: () => createPerformanceTracker(false, fakeTimer),
        deviceAppInstaller: installer,
      });
      await expect(action.execute(downgradeDirIpa)).rejects.toThrow(
        "Uninstall the app first with uninstallApp",
      );
    });

    test.each(["explicit", "ambient"] as const)(
      "simulator: cancellation after the uninstall still finishes the reinstall (%s)",
      async (source) => {
        const controller = new AbortController();
        const reinstallSawAbort: boolean[] = [];
        const { calls, action } = simulatorHarness({
          firstInstallError: new Error(newerStderr),
          onUninstall: () => controller.abort(),
          reinstall: async () => {
            // simctl reads the ambient signal; an aborted request would reject it at once.
            reinstallSawAbort.push(getAbortSignal()?.aborted === true);
            if (getAbortSignal()?.aborted) {
              throw new Error("simctl aborted");
            }
          },
        });
        const run = runWithAbortSignal(source === "ambient" ? controller.signal : undefined, () =>
          action.execute(
            "/tmp/MyApp.app",
            undefined,
            source === "explicit" ? controller.signal : undefined,
          ),
        );
        if (source === "explicit") {
          await expect(run).rejects.toThrow("Operation cancelled");
        } else {
          expect((await run).success).toBe(true);
        }
        expect(calls).toEqual(["install", "terminate", "uninstall", "reinstall"]);
        expect(reinstallSawAbort).toEqual([false]);
      },
    );

    describe("downgrade recovery uses the bounded, cancellable simulator uninstall (#10077)", () => {
      type UninstallOptions = { timeoutMs?: number; signal?: AbortSignal } | undefined;

      class RecoverySimctl extends DowngradeFakeSimctl {
        events: string[] = [];
        uninstallOptions: UninstallOptions[] = [];
        onTerminate?: () => void;
        onUninstall?: () => Error | undefined;

        override async terminateApp(
          bundle: string,
          deviceId?: string,
          options?: { timeoutMs?: number; signal?: AbortSignal },
        ): Promise<void> {
          this.events.push("terminate");
          this.onTerminate?.();
          return super.terminateApp(bundle, deviceId, options);
        }

        override async uninstallApp(
          bundle: string,
          deviceId?: string,
          options?: UninstallOptions,
        ): Promise<void> {
          this.events.push("uninstall");
          this.uninstallOptions.push(options);
          const failure = this.onUninstall?.();
          if (failure) {
            throw failure;
          }
          return super.uninstallApp(bundle, deviceId, options);
        }

        override async installApp(appPath: string, deviceId?: string): Promise<void> {
          this.events.push("install");
          return super.installApp(appPath, deviceId);
        }
      }

      function realRecovery() {
        const simctl = new RecoverySimctl();
        simctl.installError = new Error(newerStderr);
        simctl.setListResponses([[], [{ bundleId, bundlePath: "/tmp/MyApp.app" }]]);
        const repository = new CountingInstalledAppsRepository();
        const action = new InstallApp(iosSimulatorDevice, fakeAdbFactory, {
          timer: fakeTimer,
          performanceTrackerFactory: () => createPerformanceTracker(false, fakeTimer),
          simctl,
          plist: fakePlist(bundleId),
          installedAppsRepository: repository,
        });
        return { simctl, action, repository };
      }

      test("bounds the uninstall and carries the request signal to simctl", async () => {
        const { simctl, action } = realRecovery();
        const controller = new AbortController();

        const result = await action.execute("/tmp/MyApp.app", undefined, controller.signal);

        expect(result.success).toBe(true);
        expect(simctl.events).toEqual(["install", "terminate", "uninstall", "install"]);
        expect(simctl.uninstallOptions).toHaveLength(1);
        expect(simctl.uninstallOptions[0]?.timeoutMs).toBe(SIMULATOR_UNINSTALL_TIMEOUT_MS);
        expect(simctl.uninstallOptions[0]?.signal).toBe(controller.signal);
      });

      test("a cancel between the terminate and the uninstall leaves the app installed", async () => {
        const { simctl, action, repository } = realRecovery();
        const controller = new AbortController();
        simctl.onTerminate = () => controller.abort();

        const failure = await action.execute("/tmp/MyApp.app", undefined, controller.signal).then(
          () => undefined,
          (error: unknown) => error,
        );

        expect((failure as Error).message).toContain("Operation cancelled");
        expect(simctl.events).toEqual(["install", "terminate"]);
        expect(repository.markStaleCalls).toBe(0);
      });

      test("a cancel that kills the dispatched uninstall does not run the reinstall", async () => {
        const { simctl, action } = realRecovery();
        const controller = new AbortController();
        simctl.onUninstall = () => {
          controller.abort();
          return new Error("simctl uninstall killed");
        };

        const failure = await action.execute("/tmp/MyApp.app", undefined, controller.signal).then(
          () => undefined,
          (error: unknown) => error,
        );

        expect((failure as Error).message).toContain("Operation cancelled");
        expect(simctl.events).toEqual(["install", "terminate", "uninstall"]);
      });

      test("a cancel that arrives after the uninstall returned still finishes the reinstall", async () => {
        const { simctl, action } = realRecovery();
        const controller = new AbortController();
        const baseUninstall = simctl.uninstallApp.bind(simctl);
        simctl.uninstallApp = async (bundle, deviceId, options) => {
          await baseUninstall(bundle, deviceId, options);
          controller.abort();
        };

        const failure = await action.execute("/tmp/MyApp.app", undefined, controller.signal).then(
          () => undefined,
          (error: unknown) => error,
        );

        // The explicit signal still reports the cancellation, but only once the reinstall ran.
        expect((failure as Error).message).toContain("Operation cancelled");
        expect(simctl.events).toEqual(["install", "terminate", "uninstall", "install"]);
      });

      test("an uninstall that times out is reported as indeterminate and the reinstall is not attempted", async () => {
        const { simctl, action, repository } = realRecovery();
        const timeout = new SimctlCommandTimeoutError("Command timed out after 30000ms");
        simctl.onUninstall = () => timeout;

        const failure = await action.execute("/tmp/MyApp.app").then(
          () => undefined,
          (error: unknown) => error,
        );

        expect(failure).toBeInstanceOf(ActionableError);
        expect((failure as ActionableError).message).toContain(
          "Uninstall outcome is indeterminate",
        );
        expect((failure as ActionableError).message).not.toContain(
          "was uninstalled during downgrade recovery",
        );
        expect((failure as ActionableError).cause).toBe(timeout);
        expect(simctl.events).toEqual(["install", "terminate", "uninstall"]);
        expect(repository.markStaleCalls).toBe(0);
      });
    });

    describe("the reinstall's explicit budget reaches the real simctl child", () => {
      // Real SimCtlClient over a fake process seam: the reinstall runs with no ambient signal, so
      // without an explicit timeout simctl falls back to its own 60 s default and kills the child
      // before the stated 120 s budget can fire.
      function wedgedReinstall() {
        const clientTimer = new FakeTimer();
        const reinstallStarted = Promise.withResolvers<void>();
        const installChildren: Array<{ aborted: boolean }> = [];
        const simctl = new SimCtlClient(
          null,
          async (_file, args, _maxBuffer, signal) => {
            if (args[1] !== "install") {
              return createExecResult("", "");
            }
            installChildren.push({ aborted: false });
            const child = installChildren[installChildren.length - 1]!;
            if (installChildren.length === 1) {
              throw Object.assign(new Error(`Command failed: xcrun ${args.join(" ")}`), {
                code: 1,
                stderr: newerStderr,
              });
            }
            reinstallStarted.resolve();
            return new Promise<never>((_resolve, reject) => {
              signal?.addEventListener(
                "abort",
                () => {
                  child.aborted = true;
                  reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
                },
                { once: true },
              );
            });
          },
          clientTimer,
          "darwin",
          undefined,
          undefined,
          undefined,
          // Listings parse through plutil; keep every process behind a fake.
          fakePlist(bundleId),
        );
        const action = new InstallApp(iosSimulatorDevice, fakeAdbFactory, {
          // A separate clock: only simctl's own bound is under test, not the 120 s race.
          timer: new FakeTimer(),
          performanceTrackerFactory: () => createPerformanceTracker(false, fakeTimer),
          simctl,
          plist: fakePlist(bundleId),
          installedAppsRepository: new FakeInstalledAppsRepository(),
        });
        return { action, clientTimer, reinstallStarted, installChildren };
      }

      test("a 60-120 s reinstall is not killed at simctl's 60 s default", async () => {
        const { action, clientTimer, reinstallStarted, installChildren } = wedgedReinstall();
        const execution = action.execute("/tmp/MyApp.app");
        const outcome = execution.then(
          () => undefined,
          (error: unknown) => error,
        );

        await Promise.race([reinstallStarted.promise, outcome]);
        expect(installChildren).toHaveLength(2);

        clientTimer.advanceTime(60_000);
        await Promise.resolve();
        expect(installChildren[1]?.aborted).toBe(false);

        clientTimer.advanceTime(60_000);
        const failure = await outcome;
        expect(installChildren[1]?.aborted).toBe(true);
        expect((failure as Error).message).toContain("was uninstalled during downgrade recovery");
      });
    });

    test("simulator: a failed reinstall says the app was uninstalled and keeps the cause", async () => {
      const reinstallError = new Error("damaged bundle");
      const { action } = simulatorHarness({
        firstInstallError: new Error(newerStderr),
        reinstall: async () => {
          throw reinstallError;
        },
      });
      const failure = await action.execute("/tmp/MyApp.app").then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(ActionableError);
      const { message, cause } = failure as ActionableError;
      expect(message).toContain(
        `The previous version of ${bundleId} was uninstalled during downgrade recovery`,
      );
      expect(message).toContain("the app is not installed");
      expect(message).toContain("damaged bundle");
      expect(cause).toBe(reinstallError);
    });

    test("simulator: a reinstall that never settles hits its step deadline and discloses the uninstall", async () => {
      fakeTimer = new FakeTimer();
      const pending = Promise.withResolvers<void>();
      const started = Promise.withResolvers<boolean>();
      const { action } = simulatorHarness({
        firstInstallError: new Error(newerStderr),
        reinstall: () => {
          started.resolve(true);
          return pending.promise;
        },
      });
      const execution = action.execute("/tmp/MyApp.app");
      const outcome = execution.then(
        () => undefined,
        () => undefined,
      );
      try {
        expect(await Promise.race([started.promise, outcome.then(() => false)])).toBe(true);
        expect(fakeTimer.getPendingTimeouts()).toEqual([120_000]);
        fakeTimer.advanceTime(120_000);
        await expect(execution).rejects.toThrow("iOS downgrade reinstall timed out after 120000ms");
        await expect(execution).rejects.toThrow("was uninstalled during downgrade recovery");
        expect(fakeTimer.getPendingTimeoutCount()).toBe(0);
      } finally {
        pending.resolve();
        await outcome;
      }
    });
  });
});
