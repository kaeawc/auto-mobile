import { errorMessage } from "../../utils/describeUnknownError";
import { BootedDevice, ActionableError, DeviceSnapshotManifest, DeviceSnapshotType } from "../../models";
import type { SnapshotRestoreProvider } from "../../utils/interfaces/SnapshotProvider";
import { AdbClientFactory, defaultAdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { AndroidEmulatorClient } from "../../utils/android-cmdline-tools/AndroidEmulatorClient";
import {
  buildVmSnapshotCommand,
  evaluateVmSnapshotResult,
  formatVmSnapshotExecutionError
} from "../../utils/android-cmdline-tools/vmSnapshot";
import { DeviceSnapshotStore, SnapshotPathOptions } from "../../utils/DeviceSnapshotStore";
import { SimCtlClient } from "../../utils/ios-cmdline-tools/SimCtlClient";
import { getAppDataContainerPath, IOS_APP_DATA_FOLDERS, terminateAppIfRunning } from "../../utils/ios-cmdline-tools/iosAppContainer";
import { restoreIosSettings } from "../../utils/ios-cmdline-tools/iosSettings";
import { pathExists } from "../../utils/filesystem/DefaultFileSystem";
import { logger } from "../../utils/logger";
import { shellQuote } from "../../utils/shellQuote";
import { promises as fs } from "fs";
import * as path from "path";
import { Timer, defaultTimer } from "../../utils/SystemTimer";
import { AndroidCtrlProxyClient } from "../observe/android/AndroidCtrlProxyClient";
import type { SettingsNamespace } from "../observe/android";

export interface RestoreSnapshotArgs {
  snapshotName: string;
  manifest: DeviceSnapshotManifest;
  useVmSnapshot?: boolean;
  vmSnapshotTimeoutMs?: number; // Timeout in milliseconds for emulator VM snapshot commands (default: 30000ms)
}

export interface RestoreSnapshotResult {
  snapshotType: DeviceSnapshotType;
  restoredAt: string;
}

/**
 * Restore device state from snapshot, dispatching on device platform.
 *
 * - **Android**: VM snapshot restoration for emulators, ADB-based restore
 *   otherwise.
 * - **iOS**: app container restore via `simctl` (app_data snapshots only).
 */
export class RestoreSnapshot implements SnapshotRestoreProvider {
  private device: BootedDevice;
  private adb: AdbExecutor;
  private emulator: AndroidEmulatorClient;
  private store: DeviceSnapshotStore;
  private timer: Timer;
  private simctl: SimCtlClient;

  constructor(
    device: BootedDevice,
    adbFactory: AdbClientFactory = defaultAdbClientFactory,
    emulator?: AndroidEmulatorClient,
    timer: Timer = defaultTimer,
    store: DeviceSnapshotStore = new DeviceSnapshotStore(),
    simctl?: SimCtlClient
  ) {
    this.device = device;
    this.adb = adbFactory.create(device);
    this.emulator = emulator || new AndroidEmulatorClient();
    this.store = store;
    this.timer = timer;
    this.simctl = simctl || new SimCtlClient(device);
  }

  /**
   * Platform-agnostic restore entry point — satisfies
   * {@link SnapshotRestoreProvider}. Delegates to {@link execute}.
   */
  async restore(args: RestoreSnapshotArgs): Promise<RestoreSnapshotResult> {
    return this.execute(args);
  }

  /**
   * Execute snapshot restoration
   */
  async execute(args: RestoreSnapshotArgs): Promise<RestoreSnapshotResult> {
    switch (this.device.platform) {
      case "android":
        return this.executeAndroid(args);
      case "ios":
        return this.executeIos(args);
      default:
        throw new ActionableError(`Snapshot restore is not supported for platform '${this.device.platform}'`);
    }
  }

  private async executeAndroid(args: RestoreSnapshotArgs): Promise<RestoreSnapshotResult> {
    const { snapshotName, manifest, useVmSnapshot = true, vmSnapshotTimeoutMs = 30000 } = args;

    logger.info(`Restoring snapshot '${snapshotName}' (type: ${manifest.snapshotType}) to device ${this.device.deviceId}`);

    // Verify device compatibility
    if (manifest.platform !== this.device.platform) {
      throw new ActionableError(
        `Snapshot platform '${manifest.platform}' does not match device platform '${this.device.platform}'`
      );
    }

    // Determine restoration method
    const isEmulator = this.device.deviceId.startsWith("emulator-");
    const shouldUseVmSnapshot = useVmSnapshot && manifest.snapshotType === "vm" && isEmulator;

    if (shouldUseVmSnapshot) {
      await this.restoreVmSnapshot(snapshotName, manifest, vmSnapshotTimeoutMs);
    } else {
      await this.restoreAdbSnapshot(snapshotName, manifest);
    }

    logger.info(`Snapshot '${snapshotName}' restored successfully`);

    return {
      snapshotType: manifest.snapshotType,
      restoredAt: new Date().toISOString()
    };
  }

  /**
   * Restore VM snapshot using emulator console
   */
  private async restoreVmSnapshot(
    snapshotName: string,
    manifest: DeviceSnapshotManifest,
    vmSnapshotTimeoutMs: number
  ): Promise<void> {
    logger.info(`Restoring VM snapshot for emulator ${this.device.deviceId}`);

    try {
      // Load VM snapshot using ADB emu command
      const loadCommand = buildVmSnapshotCommand("load", snapshotName);
      logger.info(`Executing: adb -s ${this.device.deviceId} ${loadCommand}`);

      let result;
      try {
        result = await this.adb.executeCommand(loadCommand, vmSnapshotTimeoutMs);
      } catch (error) {
        throw new Error(formatVmSnapshotExecutionError("load", snapshotName, error));
      }

      const evaluation = evaluateVmSnapshotResult("load", snapshotName, result);
      if (!evaluation.ok) {
        throw new Error(evaluation.errorMessage);
      }

      logger.info(`VM snapshot restored successfully`);

      // Wait a moment for emulator to stabilize after snapshot load
      await this.timer.sleep(2000);

      logger.info("VM snapshot restoration complete");
    } catch (error) {
      const message = errorMessage(error);
      logger.error(`Failed to restore VM snapshot: ${message}`);
      throw new ActionableError(`Failed to restore VM snapshot: ${message}`);
    }
  }

  /**
   * Restore ADB-based snapshot
   */
  private async restoreAdbSnapshot(
    snapshotName: string,
    manifest: DeviceSnapshotManifest
  ): Promise<void> {
    logger.info(`Restoring ADB-based snapshot for device ${this.device.deviceId}`);

    try {
      // Restore settings first: it is fast, independent of app data, and must not
      // be lost if the app-data phase is slow or cannot complete (#4236).
      if (manifest.includeSettings && manifest.settings) {
        await this.restoreSettings(manifest.settings);
      }

      // Clear only the packages whose data was actually captured.
      //
      // manifest.packages is every installed package (CaptureSnapshot populates it
      // from getInstalledPackages -- ~244 on a stock emulator), but only
      // appDataBackup.backedUpPackages was backed up. Clearing all of them wiped
      // data that could never be restored, and awaiting ~244 sequential `pm clear`
      // calls exhausted the request budget so the restore timed out before app
      // data or the foreground app were restored (#4236). Scoping to the backed-up
      // set makes the default restore finish inside the budget.
      const restorablePackages = manifest.appDataBackup?.backedUpPackages ?? [];
      if (manifest.includeAppData && restorablePackages.length > 0) {
        await this.clearCurrentAppData(restorablePackages);
      }

      // Restore app data if it was captured
      if (manifest.includeAppData) {
        await this.restoreAppData(snapshotName, manifest);
      }

      // Restore foreground app if captured
      if (manifest.foregroundApp) {
        await this.restoreForegroundApp(manifest.foregroundApp);
      }

      logger.info("ADB snapshot restoration complete");
    } catch (error) {
      logger.error(`Failed to restore ADB snapshot: ${error}`);
      throw new ActionableError(`Failed to restore ADB snapshot: ${error}`);
    }
  }

  /**
   * Clear app data for all packages
   */
  private async clearCurrentAppData(packages: string[]): Promise<void> {
    logger.info(`Clearing app data for ${packages.length} packages`);

    let successCount = 0;
    let failureCount = 0;

    for (const packageName of packages) {
      try {
        // Use pm clear to reset app data
        const result = await this.adb.executeCommand(`shell pm clear ${packageName}`);

        if (result.stdout.includes("Success")) {
          successCount++;
          logger.debug(`Cleared data for ${packageName}`);
        } else {
          failureCount++;
          logger.warn(`Failed to clear data for ${packageName}: ${result.stdout}`);
        }
      } catch (error) {
        failureCount++;
        logger.warn(`Error clearing data for ${packageName}: ${error}`);
      }
    }

    logger.info(`App data cleared: ${successCount} succeeded, ${failureCount} failed`);
  }

  /**
   * Restore device settings
   */
  private async restoreSettings(settings: {
    global?: Record<string, string>;
    secure?: Record<string, string>;
    system?: Record<string, string>;
  }): Promise<void> {
    logger.info("Restoring device settings");

    for (const [settingsType, values] of Object.entries(settings)) {
      if (!values || Object.keys(values).length === 0) {
        continue;
      }

      logger.info(`Restoring ${Object.keys(values).length} ${settingsType} settings`);
      let successCount = 0;
      let failureCount = 0;

      for (const [key, value] of Object.entries(values)) {
        try {
          let applied = false;
          try {
            const a11y = AndroidCtrlProxyClient.getInstance(this.device);
            const a11yResult = await a11y.requestSettingsPut(settingsType as SettingsNamespace, key, value, "string");
            if (a11yResult.success) {
              applied = true;
            }
          } catch (error) {
            logger.debug(`[RestoreSnapshot] a11y settings put failed for ${settingsType}/${key}: ${error}`);
          }
          if (!applied) {
            // ADB hands the command to the device shell, so preserve the setting value as one literal word.
            await this.adb.executeCommand(`shell settings put ${settingsType} ${key} ${shellQuote(value)}`);
          }
          successCount++;
        } catch (error) {
          failureCount++;
          logger.warn(`Failed to restore ${settingsType} setting ${key}: ${error}`);
        }
      }

      logger.info(`${settingsType} settings restored: ${successCount} succeeded, ${failureCount} failed`);
    }
  }

  /**
   * Restore app data from snapshot
   */
  private async restoreAppData(
    snapshotName: string,
    manifest: DeviceSnapshotManifest
  ): Promise<void> {
    logger.info("Restoring app data");

    // Check if backup metadata exists
    if (!manifest.appDataBackup) {
      logger.warn("No app data backup metadata found in manifest");
      return;
    }

    const { backupFile, backupMethod, backedUpPackages } = manifest.appDataBackup;

    // If no backup was performed, skip restore
    if (backupMethod === "none" || !backupFile || !backedUpPackages || backedUpPackages.length === 0) {
      logger.info(`No app data backup available (method: ${backupMethod || "none"})`);
      return;
    }

    // Get backup file path
    const backupFilePath = path.join(this.store.getAppDataPath(snapshotName), backupFile);

    try {
      // Check if backup file exists
      await fs.access(backupFilePath);

      const stats = await fs.stat(backupFilePath);
      if (stats.size === 0) {
        logger.warn("Backup file is empty, skipping restore");
        return;
      }

      logger.info(`Found backup file: ${backupFilePath} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);
      logger.info(`Restoring ${backedUpPackages.length} apps using adb restore`);
      logger.info("Please confirm the restore on your device if prompted");

      // Perform adb restore
      const restoreResult = await this.performAdbRestore(backupFilePath);

      if (restoreResult.success) {
        logger.info(`Successfully restored app data for ${backedUpPackages.length} apps`);
      } else if (restoreResult.timedOut) {
        logger.warn("App data restore timed out - user may not have confirmed on device");
      } else {
        logger.warn("App data restore may have failed - check device");
      }
    } catch (error) {
      logger.warn(`Could not restore app data: ${error}`);
    }
  }

  /**
   * Perform adb restore with timeout
   */
  private async performAdbRestore(
    backupFilePath: string,
    timeoutMs: number = 30000
  ): Promise<{ success: boolean; timedOut: boolean }> {
    // Declared outside try so the catch block can clear a pending timeout.
    let timeoutHandle: NodeJS.Timeout | null = null;

    try {
      // Execute restore with timeout using timer
      let timedOut = false;

      const result = await Promise.race([
        this.adb.executeCommand(`restore "${backupFilePath}"`),
        new Promise<{ stdout: string; stderr: string; timedOut: true }>(resolve => {
          timeoutHandle = this.timer.setTimeout(() => {
            timedOut = true;
            resolve({ stdout: "", stderr: "Restore timed out", timedOut: true });
          }, timeoutMs);
        })
      ]);

      // Clear timeout if command completed first
      if (timeoutHandle && !timedOut) {
        this.timer.clearTimeout(timeoutHandle);
      }

      if ("timedOut" in result && result.timedOut) {
        logger.warn(`Restore timed out after ${timeoutMs}ms - user may not have confirmed on device`);
        return { success: false, timedOut: true };
      }

      // Check if restore was successful
      // adb restore doesn't provide clear success/failure output, so we assume success
      return { success: true, timedOut: false };
    } catch (error) {
      // Clear timeout to avoid keeping process alive
      if (timeoutHandle) {
        this.timer.clearTimeout(timeoutHandle);
      }
      logger.error(`Restore failed: ${error}`);
      return { success: false, timedOut: false };
    }
  }

  /**
   * Restore foreground app
   */
  private async restoreForegroundApp(packageName: string): Promise<void> {
    logger.info(`Restoring foreground app: ${packageName}`);

    try {
      // Launch the app to restore foreground state
      await this.adb.executeCommand(
        `shell am start -a android.intent.action.MAIN -c android.intent.category.LAUNCHER ${packageName}`
      );
      logger.info(`Launched ${packageName}`);
    } catch (error) {
      logger.warn(`Failed to restore foreground app: ${error}`);
    }
  }

  private async executeIos(args: RestoreSnapshotArgs): Promise<RestoreSnapshotResult> {
    const { snapshotName, manifest } = args;

    logger.info(`[iOS] Restoring snapshot '${snapshotName}' (type: ${manifest.snapshotType})`);

    if (manifest.platform !== "ios") {
      throw new ActionableError(
        `Snapshot platform '${manifest.platform}' does not match device platform '${this.device.platform}'`
      );
    }

    if (manifest.snapshotType !== "app_data") {
      throw new ActionableError(
        `Unsupported iOS snapshot type '${manifest.snapshotType}'. Re-capture using app container backups.`
      );
    }

    await this.validateIosSnapshotCompatibility(manifest);

    if (manifest.includeSettings && manifest.iosSettings) {
      await restoreIosSettings(this.simctl, this.device.deviceId, manifest.iosSettings);
    }

    await this.restoreIosAppData(snapshotName, manifest);

    logger.info(`[iOS] Snapshot '${snapshotName}' restored successfully`);

    return {
      snapshotType: manifest.snapshotType,
      restoredAt: new Date().toISOString(),
    };
  }

  private getIosPathOptions(deviceId?: string): SnapshotPathOptions {
    return { platform: "ios", deviceId: deviceId ?? this.device.deviceId };
  }

  private async restoreIosAppData(
    snapshotName: string,
    manifest: DeviceSnapshotManifest
  ): Promise<void> {
    if (!manifest.includeAppData) {
      logger.info("[iOS] Snapshot does not include app data; skipping restore");
      return;
    }

    const appDataPath = await this.resolveIosAppDataPath(snapshotName, manifest);
    if (!appDataPath) {
      logger.warn(`[iOS] App data directory not found for snapshot '${snapshotName}'`);
      return;
    }

    if (manifest.appDataBackup?.backupMethod === "none") {
      logger.info("[iOS] Snapshot app data backup method is 'none'; skipping restore");
      return;
    }

    const bundleIds = await this.resolveIosSnapshotBundleIds(appDataPath, manifest);
    if (bundleIds.length === 0) {
      logger.warn("[iOS] No app bundle IDs found to restore");
      return;
    }

    const installedBundles = await this.getInstalledIosBundleIds();
    if (installedBundles.size > 0) {
      const missingBundles = bundleIds.filter(bundleId => !installedBundles.has(bundleId));
      if (missingBundles.length > 0) {
        throw new ActionableError(
          `App(s) not installed on simulator: ${missingBundles.join(", ")}. Please reinstall and retry restore.`
        );
      }
    } else {
      logger.warn("[iOS] Unable to verify installed apps; proceeding with restore");
    }

    for (const bundleId of bundleIds) {
      try {
        await this.restoreIosBundleContainer(bundleId, appDataPath);
      } catch (error) {
        logger.warn(`[iOS] Failed to restore app data for ${bundleId}: ${error}`);
      }
    }
  }

  /**
   * Resolve the on-disk app-data directory for an iOS snapshot, preferring the
   * manifest's capturing device and falling back to the current device's path
   * (snapshots are portable across simulators). Returns undefined when neither
   * location exists.
   */
  private async resolveIosAppDataPath(
    snapshotName: string,
    manifest: DeviceSnapshotManifest
  ): Promise<string | undefined> {
    const manifestPath = this.store.getAppDataPath(snapshotName, this.getIosPathOptions(manifest.deviceId));
    if (await pathExists(manifestPath)) {
      return manifestPath;
    }

    if (!manifest.deviceId || manifest.deviceId === this.device.deviceId) {
      return undefined;
    }

    const fallbackPath = this.store.getAppDataPath(snapshotName, this.getIosPathOptions(this.device.deviceId));
    if (!(await pathExists(fallbackPath))) {
      return undefined;
    }

    logger.info(
      `[iOS] App data not found for '${manifest.deviceId}', using current device path '${this.device.deviceId}'`
    );
    return fallbackPath;
  }

  /**
   * Restore a single bundle's captured data folders back into its live app
   * container. Extracted from {@link restoreIosAppData} so the per-bundle
   * body's folder loop does not nest under the outer bundle loop.
   */
  private async restoreIosBundleContainer(bundleId: string, appDataPath: string): Promise<void> {
    await terminateAppIfRunning(this.simctl, this.device.deviceId, bundleId);
    const containerPath = await getAppDataContainerPath(this.simctl, this.device.deviceId, bundleId);
    if (!containerPath) {
      return;
    }

    const snapshotBundlePath = path.join(appDataPath, bundleId);
    for (const folder of IOS_APP_DATA_FOLDERS) {
      const sourcePath = path.join(snapshotBundlePath, folder);
      if (!(await pathExists(sourcePath))) {
        continue;
      }
      const destinationPath = path.join(containerPath, folder);
      await fs.rm(destinationPath, { recursive: true, force: true });
      await fs.cp(sourcePath, destinationPath, { recursive: true });
    }
  }

  private async validateIosSnapshotCompatibility(manifest: DeviceSnapshotManifest): Promise<void> {
    if (!manifest.osVersion) {
      logger.warn("[iOS] Snapshot OS version missing; skipping compatibility check");
      return;
    }

    const deviceOsVersion = await this.getIosDeviceOsVersion();
    if (!deviceOsVersion) {
      logger.warn("[iOS] Unable to read simulator OS version; skipping compatibility check");
      return;
    }

    const snapshotVersion = this.parseIosOsVersion(manifest.osVersion);
    const targetVersion = this.parseIosOsVersion(deviceOsVersion);

    if (!snapshotVersion || !targetVersion) {
      logger.warn("[iOS] Unable to parse OS versions for compatibility check; proceeding");
      return;
    }

    if (snapshotVersion.major !== targetVersion.major) {
      throw new ActionableError(
        `Snapshot iOS version '${manifest.osVersion}' is incompatible with simulator iOS '${deviceOsVersion}'. ` +
        `Please restore on an iOS ${snapshotVersion.major}.x simulator.`
      );
    }
  }

  private async getIosDeviceOsVersion(): Promise<string | undefined> {
    try {
      const deviceInfo = await this.simctl.getDeviceInfo(this.device.deviceId);
      if (!deviceInfo) {
        return undefined;
      }

      let osVersion: string | undefined = deviceInfo.os_version;
      if (!osVersion && deviceInfo.runtime) {
        const runtimes = await this.simctl.getRuntimes();
        const runtime = runtimes.find(entry => entry.identifier === deviceInfo.runtime);
        osVersion = runtime?.version || runtime?.name;
      }

      return osVersion;
    } catch (error) {
      logger.warn(`[iOS] Failed to read simulator OS version: ${error}`);
      return undefined;
    }
  }

  private parseIosOsVersion(version: string): { major: number; minor?: number } | null {
    const runtimeMatch = version.match(/iOS[-\s_]?(\d+)(?:[.\-_](\d+))?/i);
    const match = runtimeMatch ?? version.match(/(\d+)(?:\.(\d+))?/);
    if (!match) {
      return null;
    }

    const major = Number(match[1]);
    if (!Number.isFinite(major)) {
      return null;
    }

    const minorValue = match[2];
    const minor = minorValue !== undefined ? Number(minorValue) : undefined;
    return Number.isFinite(minor) || minor === undefined ? { major, minor } : { major };
  }

  private async getInstalledIosBundleIds(): Promise<Set<string>> {
    try {
      const apps = await this.simctl.listApps(this.device.deviceId);
      const bundleIds = apps
        .map((app: any) => app.bundleId || app.CFBundleIdentifier)
        .filter((value: string | undefined) => typeof value === "string" && value.length > 0);
      return new Set(bundleIds);
    } catch (error) {
      logger.warn(`[iOS] Failed to list installed apps: ${error}`);
      return new Set();
    }
  }

  private async resolveIosSnapshotBundleIds(
    appDataPath: string,
    manifest: DeviceSnapshotManifest
  ): Promise<string[]> {
    const fromManifest = manifest.appDataBackup?.backedUpPackages;
    if (fromManifest && fromManifest.length > 0) {
      return fromManifest;
    }

    try {
      const entries = await fs.readdir(appDataPath, { withFileTypes: true });
      return entries
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name);
    } catch (error) {
      logger.warn(`[iOS] Failed to read app data bundles: ${error}`);
      return [];
    }
  }
}
