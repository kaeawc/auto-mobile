import { errorMessage } from "../../utils/describeUnknownError";
import path from "path";
import {
  AdbClientFactory,
  defaultAdbClientFactory,
} from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { AndroidUserTargetResolver } from "../../utils/android-cmdline-tools/AndroidUserTargetResolver";
import { BootedDevice } from "../../models";
import {
  createGlobalPerformanceTracker,
  type PerformanceTracker,
} from "../../utils/PerformanceTracker";
import {
  DefaultHostCommandExecutor,
  type HostCommandExecutor,
} from "../../utils/HostCommandExecutor";
import {
  DefaultAndroidBuildToolsLocator,
  type AndroidBuildToolsLocator,
} from "../../utils/android-cmdline-tools/AndroidBuildToolsLocator";
import { OPERATION_CANCELLED_MESSAGE } from "../../utils/constants";
import { SimCtlClient } from "../../utils/ios-cmdline-tools/SimCtlClient";
import { DeviceAppManager } from "../../utils/ios-cmdline-tools/DeviceAppManager";
import { isIosSimulatorUdid } from "../../utils/ios-cmdline-tools/iosDeviceType";
import { AndroidCtrlProxyClient } from "../observe/android";
import { logger } from "../../utils/logger";
import { resolvePathFromDaemonLaunchWorkingDirectory } from "../../utils/workingDirectory";
import { PlistClient, type PlistReader } from "../../utils/ios-cmdline-tools/PlistClient";
import { IOSCtrlProxyClient } from "../observe/ios";
import { InstalledAppsRepository, type InstalledAppsStore } from "../../db/installedAppsRepository";
import { getDbWriteBarrier } from "../../db/dbWriteBarrier";
import { getInstalledAppsCacheWriteCoordinator } from "../../db/installedAppsCacheWriteCoordinator";

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
  private plist: PlistReader;
  private installedAppsRepository: InstalledAppsStore = new InstalledAppsRepository();

  constructor(
    device: BootedDevice,
    adbFactory: AdbClientFactory = defaultAdbClientFactory,
    hostExecutor: HostCommandExecutor | null = null,
    buildToolsLocator: AndroidBuildToolsLocator | null = null,
    performanceTrackerFactory: () => PerformanceTracker = createGlobalPerformanceTracker,
    simctl: SimCtlClient | null = null,
    deviceAppInstaller: DeviceAppInstaller | null = null,
    plist: PlistReader = new PlistClient(),
    installedAppsRepository?: InstalledAppsStore,
  ) {
    this.device = device;
    this.adb = adbFactory.create(device);
    this.hostExecutor = hostExecutor || new DefaultHostCommandExecutor();
    this.buildToolsLocator = buildToolsLocator || new DefaultAndroidBuildToolsLocator();
    this.createPerformanceTracker = performanceTrackerFactory;
    this.simctl = simctl || new SimCtlClient(device);
    this.deviceAppInstaller = deviceAppInstaller || new DeviceAppManager();
    this.plist = plist;
    this.setInstalledAppsRepository(installedAppsRepository);
  }

  private isSimulator(): boolean {
    return isIosSimulatorUdid(this.device.deviceId);
  }

  async execute(
    artifactPath: string,
    userId?: number,
    signal?: AbortSignal,
  ): Promise<{
    success: boolean;
    upgrade: boolean;
    userId: number;
    packageName?: string;
    warning?: string;
  }> {
    const perf = this.createPerformanceTracker();
    perf.serial("installApp");

    if (!path.isAbsolute(artifactPath)) {
      artifactPath = resolvePathFromDaemonLaunchWorkingDirectory(artifactPath);
    }

    const ext = path.extname(artifactPath).toLowerCase();

    if (this.device.platform === "ios") {
      this.validateiOSArtifact(ext);
      if (ext === ".ipa") {
        const result = await perf.track("iOSPhysicalInstall", () =>
          this.executeiOSPhysical(artifactPath, perf, signal),
        );
        if (result.success) {
          IOSCtrlProxyClient.getExistingInstance(this.device.deviceId)?.clearSdkScreenIdentity();
        }
        perf.end();
        return { ...result, userId: 0 };
      }
      const result = await perf.track("iOSInstall", () =>
        this.executeiOSSimulator(artifactPath, perf, signal),
      );
      if (result.success) {
        IOSCtrlProxyClient.getExistingInstance(this.device.deviceId)?.clearSdkScreenIdentity(
          result.packageName,
        );
      }
      perf.end();
      return { ...result, userId: 0 };
    }

    if (ext !== ".apk") {
      throw new Error(
        `Android devices only support .apk files, but got "${ext}" file. Use an .apk file for Android installation.`,
      );
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
      return (
        await new AndroidUserTargetResolver(this.adb).resolve({
          packageName,
          explicitUserId: userId,
          signal,
        })
      ).userId;
    });

    let isInstalled = false;
    if (packageName) {
      // Check if app is already installed for this user.
      isInstalled = await perf.track("checkInstalled", async () => {
        try {
          const a11y = AndroidCtrlProxyClient.getInstance(this.device);
          const result = await a11y.requestInstalledPackages(true, undefined, 3000);
          if (result.success && result.userId === targetUserId) {
            return result.packages.some((p) => p.packageName === packageName);
          }
        } catch {
          // fall through to ADB
        }
        try {
          const isInstalledCmd = `shell pm list packages --user ${targetUserId} -f ${packageName} | grep -c ${packageName}`;
          const isInstalledOutput = await this.adb.executeCommand(
            isInstalledCmd,
            undefined,
            undefined,
            true,
            signal,
          );
          return parseInt(isInstalledOutput.trim(), 10) > 0;
        } catch (error) {
          // Both the a11y check and this pm/grep fallback failed; treat the package as
          // not installed rather than blocking the install flow on a query error.
          logger.debug(`src/features/action/InstallApp.ts fallback failed: ${error}`, error);
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

    const installArgs = `install --user ${targetUserId} -r "${artifactPath}"`;
    let installAttempt = await perf.track("adbInstall", () =>
      this.runAndroidInstall(installArgs, signal),
    );

    if (installAttempt.success) {
      await this.markInstalledAppsCacheStale(true);
    }

    if (!installAttempt.success && this.isAndroidDowngradeError(installAttempt.output)) {
      // The installed version is newer than the artifact. `adb install -r` cannot
      // downgrade a package, so the default behavior is to uninstall the existing
      // app and reinstall the provided version.
      if (!packageName) {
        throw new Error(
          "Install failed because the installed version is newer (INSTALL_FAILED_VERSION_DOWNGRADE), " +
            "but the package name could not be determined in order to uninstall it first.",
        );
      }
      logger.warn(
        `[InstallApp] Version downgrade detected for ${packageName}; uninstalling existing version and reinstalling.`,
      );
      await perf.track("downgradeUninstall", () =>
        this.uninstallAndroidForDowngrade(packageName!, targetUserId, signal),
      );
      await this.markInstalledAppsCacheStale(true);
      installAttempt = await perf.track("adbReinstall", () =>
        this.runAndroidInstall(installArgs, signal),
      );
      if (installAttempt.success) {
        await this.markInstalledAppsCacheStale(true);
        warnings.push(
          `Installed version of ${packageName} was newer than the artifact; uninstalled it and reinstalled the provided version.`,
        );
        isInstalled = false; // The app was removed, so this is effectively a fresh install.
      }
    }

    // Preserve prior behavior: a hard install failure (non-zero exit) surfaces as a thrown error.
    if (!installAttempt.success && installAttempt.threw && installAttempt.error !== undefined) {
      throw installAttempt.error;
    }

    const success = installAttempt.success;

    if (!packageName && beforePackages) {
      const afterPackages = success
        ? await perf.track("listPackagesAfter", async () => {
            return this.listPackagesForUser(targetUserId, signal);
          })
        : beforePackages;
      const newPackages = this.diffSets(beforePackages, afterPackages);

      if (newPackages.length === 1) {
        packageName = newPackages[0];
      } else if (newPackages.length > 1) {
        warnings.push(
          "Installed APK but multiple new packages were detected; unable to determine the package name reliably.",
        );
      } else if (success) {
        warnings.push(
          "Installed APK but package name could not be determined from the device package list.",
        );
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
      warning: warning,
    };
  }

  private static readonly ANDROID_DOWNGRADE_MARKER = "INSTALL_FAILED_VERSION_DOWNGRADE";

  private setInstalledAppsRepository(installedAppsRepository?: InstalledAppsStore): void {
    if (installedAppsRepository) {
      this.installedAppsRepository = installedAppsRepository;
    }
  }

  private async markInstalledAppsCacheStale(success: boolean): Promise<void> {
    if (!success) {
      return;
    }
    try {
      await getInstalledAppsCacheWriteCoordinator().invalidate(this.device.deviceId, () =>
        getDbWriteBarrier()
          .track(() => this.installedAppsRepository.markDeviceStale(this.device.deviceId))
          .then(() => undefined),
      );
    } catch (error) {
      logger.warn(`[InstallApp] Failed to invalidate installed apps cache: ${error}`);
    }
  }

  /**
   * Run an `adb install` command, capturing failures (whether reported as a
   * non-zero exit / thrown error or as a "Failure [...]" line in the output)
   * so the caller can inspect the reason without losing the original error.
   */
  private async runAndroidInstall(
    installArgs: string,
    signal?: AbortSignal,
  ): Promise<{ success: boolean; output: string; threw: boolean; error?: unknown }> {
    try {
      const result = await this.adb.executeCommand(
        installArgs,
        undefined,
        undefined,
        undefined,
        signal,
      );
      const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
      return { success: output.includes("Success"), output, threw: false };
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
      return { success: false, output: this.extractErrorText(error), threw: true, error };
    }
  }

  private isAndroidDowngradeError(output: string): boolean {
    return output.includes(InstallApp.ANDROID_DOWNGRADE_MARKER);
  }

  /**
   * Fully uninstall an Android package so a lower-versioned artifact can be
   * installed over a newer one. The uninstall is package-wide (not per-user)
   * because the installed APK version is shared across users.
   */
  private async uninstallAndroidForDowngrade(
    packageName: string,
    userId: number,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      await this.adb.executeCommand(
        `shell am force-stop --user ${userId} ${packageName}`,
        undefined,
        undefined,
        true,
        signal,
      );
    } catch {
      // Best-effort stop; proceed with uninstall regardless.
    }
    await this.adb.executeCommand(
      `uninstall ${packageName}`,
      undefined,
      undefined,
      undefined,
      signal,
    );
  }

  private extractErrorText(error: unknown): string {
    if (error instanceof Error) {
      const details = error as Error & { stderr?: unknown; stdout?: unknown };
      return [error.message, details.stderr, details.stdout]
        .filter((value) => typeof value === "string" && value.length > 0)
        .join("\n");
    }
    return String(error);
  }

  /**
   * Detect an iOS install failure caused by the installed version being newer
   * than the artifact (simctl/devicectl downgrade rejection).
   */
  private isiOSDowngradeError(text: string): boolean {
    const lower = text.toLowerCase();
    if (lower.includes("downgrade")) {
      return true;
    }
    return lower.includes("newer version") && lower.includes("already installed");
  }

  /**
   * Read CFBundleIdentifier from a simulator .app bundle's Info.plist so the
   * existing (newer) version can be uninstalled before a downgrade reinstall.
   */
  private async resolveAppBundleId(appPath: string): Promise<string | undefined> {
    try {
      const bundleId = (
        await this.plist.extractRawFile("CFBundleIdentifier", path.join(appPath, "Info.plist"))
      ).trim();
      return bundleId || undefined;
    } catch (error) {
      logger.warn(
        `[InstallApp] Failed to read bundle identifier from ${appPath}: ${errorMessage(error)}`,
      );
      return undefined;
    }
  }

  private validateiOSArtifact(ext: string): void {
    const isSimulator = this.isSimulator();
    if (isSimulator && ext === ".ipa") {
      throw new Error(
        "iOS simulators do not support .ipa files. Use a .app bundle built for the simulator instead.",
      );
    }
    if (!isSimulator && ext === ".app") {
      throw new Error(
        "iOS physical devices do not support .app bundles. Use a signed .ipa file instead.",
      );
    }
    if (ext !== ".app" && ext !== ".ipa") {
      throw new Error(
        `iOS devices only support .app bundles (simulator) and .ipa files (physical device), but got "${ext}" file.`,
      );
    }
  }

  private async executeiOSSimulator(
    appPath: string,
    perf: PerformanceTracker,
    signal?: AbortSignal,
  ): Promise<{ success: boolean; upgrade: boolean; packageName?: string; warning?: string }> {
    if (signal?.aborted) {
      throw new Error(OPERATION_CANCELLED_MESSAGE);
    }

    const beforeApps = await perf.track("listAppsBefore", () =>
      this.simctl.listApps(this.device.deviceId),
    );
    const beforeBundleIds = this.extractBundleIds(beforeApps);

    const downgraded = await perf.track("simctlInstall", () =>
      this.installiOSSimulatorWithDowngradeRecovery(appPath, signal),
    );

    await this.markInstalledAppsCacheStale(true);

    if (signal?.aborted) {
      throw new Error(OPERATION_CANCELLED_MESSAGE);
    }

    const afterApps = await perf.track("listAppsAfter", () =>
      this.simctl.listApps(this.device.deviceId),
    );
    const afterBundleIds = this.extractBundleIds(afterApps);

    const newBundles = this.diffSets(beforeBundleIds, afterBundleIds);
    let packageName = this.findBundleIdByPath(afterApps, appPath);
    if (!packageName && newBundles.length === 1) {
      packageName = newBundles[0];
    }

    if (!packageName) {
      const expectedBundleId = await perf.track("resolveBundleId", () =>
        this.resolveAppBundleId(appPath),
      );
      if (expectedBundleId) {
        if (!afterBundleIds.has(expectedBundleId)) {
          throw new Error(
            `Install reported success, but bundle ${expectedBundleId} was not present on iOS simulator ` +
              `${this.device.deviceId} after installation.`,
          );
        }
        packageName = expectedBundleId;
      }
    }

    const warnings: string[] = [];

    if (downgraded) {
      warnings.push(
        "Installed version was newer than the artifact; uninstalled it and reinstalled the provided version.",
      );
    }

    if (!packageName) {
      if (newBundles.length > 1) {
        warnings.push(
          "Installed app but multiple new bundle IDs were detected; unable to determine the bundle ID reliably.",
        );
      } else {
        warnings.push(
          "Installed app but bundle ID could not be determined from simctl listapps output.",
        );
      }
    }

    const upgrade = downgraded ? false : packageName ? beforeBundleIds.has(packageName) : false;

    return {
      success: true,
      upgrade,
      packageName,
      warning: warnings.length > 0 ? warnings.join(" ") : undefined,
    };
  }

  /**
   * Install on an iOS simulator, recovering from a version-downgrade rejection
   * by uninstalling the existing (newer) app and reinstalling the artifact.
   * Returns true if a downgrade recovery was performed.
   */
  private async installiOSSimulatorWithDowngradeRecovery(
    appPath: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    try {
      await this.simctl.installApp(appPath, this.device.deviceId);
      return false;
    } catch (error) {
      const text = this.extractErrorText(error);
      if (!this.isiOSDowngradeError(text)) {
        throw error;
      }
      const bundleId = await this.resolveAppBundleId(appPath);
      if (!bundleId) {
        throw new Error(
          `Install failed because the installed version is newer than the artifact, and the bundle ` +
            `identifier could not be read from ${appPath} in order to uninstall it first. Original error: ${text}`,
        );
      }
      logger.warn(
        `[InstallApp] Version downgrade detected for ${bundleId}; uninstalling existing version and reinstalling.`,
      );
      try {
        await this.simctl.terminateApp(bundleId, this.device.deviceId);
      } catch {
        // Best-effort terminate; proceed with uninstall regardless.
      }
      await this.simctl.uninstallApp(bundleId, this.device.deviceId);
      await this.markInstalledAppsCacheStale(true);
      if (signal?.aborted) {
        throw new Error(OPERATION_CANCELLED_MESSAGE);
      }
      await this.simctl.installApp(appPath, this.device.deviceId);
      return true;
    }
  }

  private async executeiOSPhysical(
    ipaPath: string,
    perf: PerformanceTracker,
    signal?: AbortSignal,
  ): Promise<{ success: boolean; upgrade: boolean; packageName?: string; warning?: string }> {
    if (signal?.aborted) {
      throw new Error(OPERATION_CANCELLED_MESSAGE);
    }

    try {
      await perf.track("devicectlInstall", () =>
        this.deviceAppInstaller.installApp(this.device.deviceId, ipaPath),
      );
      await this.markInstalledAppsCacheStale(true);
    } catch (error) {
      const text = this.extractErrorText(error);
      if (this.isiOSDowngradeError(text)) {
        // devicectl has no downgrade flag and the bundle identifier cannot be
        // reliably derived from the .ipa, so guide the user to uninstall first.
        throw new Error(
          `Install failed because a newer version is already installed on the device. ` +
            `Uninstall the app first with uninstallApp, then reinstall. Original error: ${text}`,
        );
      }
      throw error;
    }

    return {
      success: true,
      upgrade: false,
      warning:
        "Bundle ID detection is not available for physical device installations via devicectl.",
    };
  }

  private async extractPackageName(
    apkPath: string,
    signal?: AbortSignal,
  ): Promise<{ packageName?: string; warning?: string }> {
    if (signal?.aborted) {
      throw new Error(OPERATION_CANCELLED_MESSAGE);
    }

    const tool = await this.buildToolsLocator.findAaptTool();
    if (!tool) {
      return {
        warning:
          "aapt2 was not found. Install Android SDK build-tools (aapt2) for reliable package detection.",
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
      signal,
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
      const bundlePath =
        typeof app.bundlePath === "string"
          ? app.bundlePath
          : typeof app.path === "string"
            ? app.path
            : undefined;
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
