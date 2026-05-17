import path from "path";
import { AdbClientFactory, defaultAdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { BootedDevice } from "../../models";
import { createGlobalPerformanceTracker, type PerformanceTracker } from "../../utils/PerformanceTracker";
import { DefaultHostCommandExecutor, type HostCommandExecutor } from "../../utils/HostCommandExecutor";
import { DefaultAndroidBuildToolsLocator, type AndroidBuildToolsLocator } from "../../utils/android-cmdline-tools/AndroidBuildToolsLocator";
import { OPERATION_CANCELLED_MESSAGE } from "../../utils/constants";
import { SimCtlClient } from "../../utils/ios-cmdline-tools/SimCtlClient";
import { DeviceAppInspector } from "../../utils/ios-cmdline-tools/DeviceAppInspector";
import { AndroidCtrlProxyClient } from "../observe/android";

export interface DeviceAppInstaller {
  installApp(deviceUdid: string, artifactPath: string): Promise<void>;
}

export class InstallApp {
  private adb: AdbExecutor;
  private hostExecutor: HostCommandExecutor;
  private buildToolsLocator: AndroidBuildToolsLocator;
  private createPerformanceTracker: () => PerformanceTracker;
  private simctl: SimCtlClient;
  private device: BootedDevice;
  private deviceAppInstaller: DeviceAppInstaller;

  private static readonly SIMULATOR_UUID_PATTERN = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;

  constructor(
    device: BootedDevice,
    adbFactory: AdbClientFactory = defaultAdbClientFactory,
    hostExecutor: HostCommandExecutor | null = null,
    buildToolsLocator: AndroidBuildToolsLocator | null = null,
    performanceTrackerFactory: () => PerformanceTracker = createGlobalPerformanceTracker,
    simctl: SimCtlClient | null = null,
    deviceAppInstaller: DeviceAppInstaller | null = null
  ) {
    this.device = device;
    this.adb = adbFactory.create(device);
    this.hostExecutor = hostExecutor || new DefaultHostCommandExecutor();
    this.buildToolsLocator = buildToolsLocator || new DefaultAndroidBuildToolsLocator();
    this.createPerformanceTracker = performanceTrackerFactory;
    this.simctl = simctl || new SimCtlClient(device);
    this.deviceAppInstaller = deviceAppInstaller || new DeviceAppInspector();
  }

  private isSimulator(): boolean {
    return InstallApp.SIMULATOR_UUID_PATTERN.test(this.device.deviceId);
  }

  async execute(
    artifactPath: string,
    userId?: number,
    signal?: AbortSignal
  ): Promise<{ success: boolean; upgrade: boolean; userId: number; packageName?: string; warning?: string }> {
    const perf = this.createPerformanceTracker();
    perf.serial("installApp");

    if (!path.isAbsolute(artifactPath)) {
      artifactPath = path.resolve(process.cwd(), artifactPath);
    }

    const ext = path.extname(artifactPath).toLowerCase();

    if (this.device.platform === "ios") {
      this.validateiOSArtifact(ext);
      if (ext === ".ipa") {
        const result = await perf.track("iOSPhysicalInstall", () => this.executeiOSPhysical(artifactPath, perf, signal));
        perf.end();
        return { ...result, userId: 0 };
      }
      const result = await perf.track("iOSInstall", () => this.executeiOSSimulator(artifactPath, perf, signal));
      perf.end();
      return { ...result, userId: 0 };
    }

    if (ext !== ".apk") {
      throw new Error(`Android devices only support .apk files, but got "${ext}" file. Use an .apk file for Android installation.`);
    }

    const warnings: string[] = [];

    // Extract package name from APK
    const packageNameResult = await perf.track("extractPackageName", async () => {
      return this.extractPackageName(artifactPath, signal);
    });
    if (packageNameResult.warning) {
      warnings.push(packageNameResult.warning);
    }
    let packageName = packageNameResult.packageName?.trim();

    // Auto-detect target user if not specified
    const targetUserId = await perf.track("detectTargetUser", async () => {
      if (userId !== undefined) {
        return userId;
      }

      // Check if app is in foreground and get its user
      if (packageName) {
        const foregroundApp = await this.adb.getForegroundApp(signal);
        if (foregroundApp && foregroundApp.packageName === packageName) {
          return foregroundApp.userId;
        }
      }

      // Get list of users and prefer work profile
      const users = await this.adb.listUsers(signal);

      // Find first work profile (flags 30 typically indicates managed/work profile)
      const workProfile = users.find(u => u.userId > 0 && u.running);
      if (workProfile) {
        return workProfile.userId;
      }

      // Fall back to primary user
      return 0;
    });

    let isInstalled = false;
    if (packageName) {
      // Check if app is already installed for this user.
      isInstalled = await perf.track("checkInstalled", async () => {
        try {
          const a11y = AndroidCtrlProxyClient.getInstance(this.device);
          const result = await a11y.requestInstalledPackages(true, undefined, 3000);
          if (result.success && result.userId === targetUserId) {
            return result.packages.some(p => p.packageName === packageName);
          }
        } catch {
          // fall through to ADB
        }
        try {
          const isInstalledCmd = `shell pm list packages --user ${targetUserId} -f ${packageName} | grep -c ${packageName}`;
          const isInstalledOutput = await this.adb.executeCommand(isInstalledCmd, undefined, undefined, true, signal);
          return parseInt(isInstalledOutput.trim(), 10) > 0;
        } catch {
          return false;
        }
      });
    }

    let beforePackages: Set<string> | null = null;
    if (!packageName) {
      beforePackages = await perf.track("listPackagesBefore", async () => {
        return this.listPackagesForUser(targetUserId, signal);
      });
    }

    const success = await perf.track("adbInstall", async () => {
      const installOutput = await this.adb.executeCommand(`install --user ${targetUserId} -r "${artifactPath}"`, undefined, undefined, undefined, signal);
      return installOutput.includes("Success");
    });

    if (!packageName && beforePackages) {
      const afterPackages = success ? await perf.track("listPackagesAfter", async () => {
        return this.listPackagesForUser(targetUserId, signal);
      }) : beforePackages;
      const newPackages = this.diffSets(beforePackages, afterPackages);

      if (newPackages.length === 1) {
        packageName = newPackages[0];
      } else if (newPackages.length > 1) {
        warnings.push("Installed APK but multiple new packages were detected; unable to determine the package name reliably.");
      } else if (success) {
        warnings.push("Installed APK but package name could not be determined from the device package list.");
        isInstalled = true;
      }
    }

    perf.end();
    const warning = warnings.length > 0 ? warnings.join(" ") : undefined;
    return {
      success: success,
      upgrade: isInstalled && success,
      userId: targetUserId,
      packageName: packageName,
      warning: warning
    };
  }

  private validateiOSArtifact(ext: string): void {
    const isSimulator = this.isSimulator();
    if (isSimulator && ext === ".ipa") {
      throw new Error("iOS simulators do not support .ipa files. Use a .app bundle built for the simulator instead.");
    }
    if (!isSimulator && ext === ".app") {
      throw new Error("iOS physical devices do not support .app bundles. Use a signed .ipa file instead.");
    }
    if (ext !== ".app" && ext !== ".ipa") {
      throw new Error(`iOS devices only support .app bundles (simulator) and .ipa files (physical device), but got "${ext}" file.`);
    }
  }

  private async executeiOSSimulator(
    appPath: string,
    perf: PerformanceTracker,
    signal?: AbortSignal
  ): Promise<{ success: boolean; upgrade: boolean; packageName?: string; warning?: string }> {
    if (signal?.aborted) {
      throw new Error(OPERATION_CANCELLED_MESSAGE);
    }

    const beforeApps = await perf.track("listAppsBefore", () => this.simctl.listApps(this.device.deviceId));
    const beforeBundleIds = this.extractBundleIds(beforeApps);

    await perf.track("simctlInstall", () => this.simctl.installApp(appPath, this.device.deviceId));

    if (signal?.aborted) {
      throw new Error(OPERATION_CANCELLED_MESSAGE);
    }

    const afterApps = await perf.track("listAppsAfter", () => this.simctl.listApps(this.device.deviceId));
    const afterBundleIds = this.extractBundleIds(afterApps);

    const newBundles = this.diffSets(beforeBundleIds, afterBundleIds);
    let packageName = this.findBundleIdByPath(afterApps, appPath);

    const warnings: string[] = [];

    if (!packageName) {
      if (newBundles.length === 1) {
        packageName = newBundles[0];
      } else if (newBundles.length > 1) {
        warnings.push("Installed app but multiple new bundle IDs were detected; unable to determine the bundle ID reliably.");
      } else {
        warnings.push("Installed app but bundle ID could not be determined from simctl listapps output.");
      }
    }

    const upgrade = packageName ? beforeBundleIds.has(packageName) : false;

    return {
      success: true,
      upgrade,
      packageName,
      warning: warnings.length > 0 ? warnings.join(" ") : undefined
    };
  }

  private async executeiOSPhysical(
    ipaPath: string,
    perf: PerformanceTracker,
    signal?: AbortSignal
  ): Promise<{ success: boolean; upgrade: boolean; packageName?: string; warning?: string }> {
    if (signal?.aborted) {
      throw new Error(OPERATION_CANCELLED_MESSAGE);
    }

    await perf.track("devicectlInstall", () => this.deviceAppInstaller.installApp(this.device.deviceId, ipaPath));

    return {
      success: true,
      upgrade: false,
      warning: "Bundle ID detection is not available for physical device installations via devicectl."
    };
  }

  private async extractPackageName(
    apkPath: string,
    signal?: AbortSignal
  ): Promise<{ packageName?: string; warning?: string }> {
    if (signal?.aborted) {
      throw new Error(OPERATION_CANCELLED_MESSAGE);
    }

    const tool = await this.buildToolsLocator.findAaptTool();
    if (!tool) {
      return {
        warning: "aapt2 was not found. Install Android SDK build-tools (aapt2) for reliable package detection."
      };
    }

    const result = await this.hostExecutor.executeCommand(tool.path, ["dump", "badging", apkPath]);
    const output = `${result.stdout}\n${result.stderr}`;
    const match = output.match(/package:\s+name='([^']+)'/);
    if (!match) {
      throw new Error(`Failed to extract package name from ${tool.tool} output.`);
    }

    return { packageName: match[1] };
  }

  private async listPackagesForUser(userId: number, signal?: AbortSignal): Promise<Set<string>> {
    if (signal?.aborted) {
      throw new Error(OPERATION_CANCELLED_MESSAGE);
    }

    const result = await this.adb.executeCommand(
      `shell pm list packages --user ${userId}`,
      undefined,
      undefined,
      true,
      signal
    );
    const packages = new Set<string>();
    for (const line of result.stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("package:")) {
        continue;
      }
      const packageName = trimmed.slice("package:".length).trim();
      if (packageName) {
        packages.add(packageName);
      }
    }

    return packages;
  }

  private diffSets(before: Set<string>, after: Set<string>): string[] {
    const added: string[] = [];
    for (const item of after) {
      if (!before.has(item)) {
        added.push(item);
      }
    }
    return added.sort();
  }

  private extractBundleIds(apps: any[]): Set<string> {
    const bundleIds = new Set<string>();
    for (const app of apps) {
      const bundleId = this.getBundleId(app);
      if (bundleId) {
        bundleIds.add(bundleId);
      }
    }
    return bundleIds;
  }

  private getBundleId(app: any): string | undefined {
    if (!app || typeof app !== "object") {
      return undefined;
    }
    if (typeof app.bundleId === "string" && app.bundleId.trim().length > 0) {
      return app.bundleId;
    }
    if (typeof app.bundleIdentifier === "string" && app.bundleIdentifier.trim().length > 0) {
      return app.bundleIdentifier;
    }
    if (typeof app.CFBundleIdentifier === "string" && app.CFBundleIdentifier.trim().length > 0) {
      return app.CFBundleIdentifier;
    }
    return undefined;
  }

  private findBundleIdByPath(apps: any[], appPath: string): string | undefined {
    const normalizedPath = path.resolve(appPath);
    for (const app of apps) {
      if (!app || typeof app !== "object") {
        continue;
      }
      const bundleId = this.getBundleId(app);
      if (!bundleId) {
        continue;
      }
      const bundlePath = typeof app.bundlePath === "string"
        ? app.bundlePath
        : (typeof app.path === "string" ? app.path : undefined);
      if (!bundlePath) {
        continue;
      }
      if (path.resolve(bundlePath) === normalizedPath) {
        return bundleId;
      }
    }
    return undefined;
  }
}
