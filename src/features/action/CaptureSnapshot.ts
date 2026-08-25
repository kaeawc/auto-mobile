import { errorMessage } from "../../utils/describeUnknownError";
import {
  BootedDevice,
  ActionableError,
  toActionableError,
  DeviceSnapshotManifest,
  DeviceSnapshotType,
  IosBundleCaptureStatus,
} from "../../models";
import {
  getIosInstalledAppBundleId,
  type IosInstalledAppRecord,
} from "../../utils/ios-cmdline-tools/iosInstalledApp";
import type { SnapshotCaptureProvider } from "../../utils/interfaces/SnapshotProvider";
import {
  AdbClientFactory,
  defaultAdbClientFactory,
} from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { AndroidEmulatorClient } from "../../utils/android-cmdline-tools/AndroidEmulatorClient";
import {
  buildVmSnapshotCommand,
  evaluateVmSnapshotResult,
  formatVmSnapshotExecutionError,
} from "../../utils/android-cmdline-tools/vmSnapshot";
import { DeviceSnapshotStore, SnapshotPathOptions } from "../../utils/DeviceSnapshotStore";
import { SimCtlClient } from "../../utils/ios-cmdline-tools/SimCtlClient";
import {
  getAppDataContainerPath,
  IOS_APP_DATA_FOLDERS,
} from "../../utils/ios-cmdline-tools/iosAppContainer";
import {
  captureIosSettings,
  type IosSettingsSnapshot,
} from "../../utils/ios-cmdline-tools/iosSettings";
import { pathExists } from "../../utils/filesystem/DefaultFileSystem";
import { logger } from "../../utils/logger";
import { promises as fs } from "fs";
import * as path from "path";
import { Timer, defaultTimer } from "../../utils/SystemTimer";
import { AndroidCtrlProxyClient } from "../observe/android";
import type { SettingsNamespace } from "../observe/android";

export interface CaptureSnapshotArgs {
  snapshotName: string;
  includeAppData?: boolean;
  includeSettings?: boolean;
  useVmSnapshot?: boolean;
  strictBackupMode?: boolean; // If true, fail entire snapshot if app data backup fails
  backupTimeoutMs?: number; // Timeout in milliseconds for adb backup (default: 30000ms)
  userApps?: "current" | "all"; // Which apps to backup: "current" (foreground app only) or "all" (all user apps)
  vmSnapshotTimeoutMs?: number; // Timeout in milliseconds for emulator VM snapshot commands (default: 30000ms)
  appBundleIds?: string[]; // iOS-only: bundle identifiers to include in app data snapshot
}

export interface CaptureSnapshotResult {
  snapshotName: string;
  timestamp: string;
  snapshotType: DeviceSnapshotType;
  manifest: DeviceSnapshotManifest;
}

/**
 * Capture device state snapshot, dispatching on device platform.
 *
 * - **Android**: VM snapshots for emulators, ADB-based capture otherwise.
 * - **iOS**: app container backups via `simctl` (portable across restores).
 */
export class CaptureSnapshot implements SnapshotCaptureProvider {
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
    simctl?: SimCtlClient,
  ) {
    this.device = device;
    this.adb = adbFactory.create(device);
    this.emulator = emulator || new AndroidEmulatorClient();
    this.store = store;
    this.timer = timer;
    this.simctl = simctl || new SimCtlClient(device);
  }

  /**
   * Platform-agnostic capture entry point — satisfies
   * {@link SnapshotCaptureProvider}. Delegates to {@link execute}.
   */
  async capture(args: CaptureSnapshotArgs): Promise<CaptureSnapshotResult> {
    return this.execute(args);
  }

  /**
   * Execute snapshot capture
   */
  async execute(args: CaptureSnapshotArgs): Promise<CaptureSnapshotResult> {
    switch (this.device.platform) {
      case "android":
        return this.executeAndroid(args);
      case "ios":
        return this.executeIos(args);
      default:
        throw new ActionableError(
          `Snapshot capture is not supported for platform '${this.device.platform}'`,
        );
    }
  }

  private async executeAndroid(args: CaptureSnapshotArgs): Promise<CaptureSnapshotResult> {
    const {
      snapshotName,
      includeAppData = true,
      includeSettings = true,
      useVmSnapshot = true,
      strictBackupMode = false,
      backupTimeoutMs = 30000,
      userApps = "current",
      vmSnapshotTimeoutMs = 30000,
    } = args;

    logger.info(`Capturing snapshot '${snapshotName}' for device ${this.device.deviceId}`);

    // Determine if we can use VM snapshot
    const isEmulator = this.device.deviceId.startsWith("emulator-");
    const shouldUseVmSnapshot = useVmSnapshot && isEmulator;

    let manifest: DeviceSnapshotManifest;

    if (shouldUseVmSnapshot) {
      manifest = await this.captureVmSnapshot(snapshotName, includeSettings, vmSnapshotTimeoutMs);
    } else {
      manifest = await this.captureAdbSnapshot(
        snapshotName,
        includeAppData,
        includeSettings,
        strictBackupMode,
        backupTimeoutMs,
        userApps,
      );
    }

    logger.info(
      `Snapshot '${snapshotName}' captured successfully (type: ${manifest.snapshotType})`,
    );

    return {
      snapshotName: manifest.snapshotName,
      timestamp: manifest.timestamp,
      snapshotType: manifest.snapshotType,
      manifest,
    };
  }

  /**
   * Capture VM snapshot using emulator console
   */
  private async captureVmSnapshot(
    snapshotName: string,
    includeSettings: boolean,
    vmSnapshotTimeoutMs: number,
  ): Promise<DeviceSnapshotManifest> {
    logger.info(`Using VM snapshot for emulator ${this.device.deviceId}`);

    try {
      // Save VM snapshot using ADB emu command
      const saveCommand = buildVmSnapshotCommand("save", snapshotName);
      logger.info(`Executing: adb -s ${this.device.deviceId} ${saveCommand}`);

      let result;
      try {
        result = await this.adb.executeCommand(saveCommand, vmSnapshotTimeoutMs);
      } catch (error) {
        throw new Error(formatVmSnapshotExecutionError("save", snapshotName, error));
      }

      const evaluation = evaluateVmSnapshotResult("save", snapshotName, result);
      if (!evaluation.ok) {
        throw new Error(evaluation.errorMessage);
      }

      logger.info(`VM snapshot saved successfully`);

      // Capture settings if requested (VM snapshot doesn't include this metadata)
      let settings;
      if (includeSettings) {
        settings = await this.captureSettings();
      }

      // Get foreground app
      const foregroundApp = await this.getForegroundApp();

      // Create manifest
      const manifest: DeviceSnapshotManifest = {
        snapshotName,
        timestamp: new Date().toISOString(),
        deviceId: this.device.deviceId,
        deviceName: this.device.name,
        platform: "android",
        snapshotType: "vm",
        includeAppData: true, // VM snapshot includes everything
        includeSettings: includeSettings,
        foregroundApp,
        settings,
      };

      return manifest;
    } catch (error) {
      const message = errorMessage(error);
      logger.error(`Failed to capture VM snapshot: ${message}`);
      throw new ActionableError(`Failed to capture VM snapshot: ${message}`);
    }
  }

  /**
   * Capture ADB-based snapshot
   */
  private async captureAdbSnapshot(
    snapshotName: string,
    includeAppData: boolean,
    includeSettings: boolean,
    strictBackupMode: boolean,
    backupTimeoutMs: number,
    userApps: "current" | "all",
  ): Promise<DeviceSnapshotManifest> {
    logger.info(`Using ADB-based snapshot for device ${this.device.deviceId}`);

    try {
      // Get foreground app first (needed if userApps is "current")
      const foregroundApp = await this.getForegroundApp();

      // Get list of installed packages
      const packages = await this.getInstalledPackages();
      logger.info(`Found ${packages.length} installed packages`);

      // Capture settings if requested
      let settings;
      if (includeSettings) {
        settings = await this.captureSettings();
        await this.saveSettings(snapshotName, settings);
      }

      // Capture app data if requested
      let appDataBackup;
      if (includeAppData) {
        appDataBackup = await this.captureAppData(
          snapshotName,
          packages,
          strictBackupMode,
          backupTimeoutMs,
          userApps,
          foregroundApp,
        );
      }

      // Create manifest
      const manifest: DeviceSnapshotManifest = {
        snapshotName,
        timestamp: new Date().toISOString(),
        deviceId: this.device.deviceId,
        deviceName: this.device.name,
        platform: "android",
        snapshotType: "adb",
        includeAppData,
        includeSettings,
        packages,
        foregroundApp,
        settings,
        appDataBackup,
      };

      return manifest;
    } catch (error) {
      logger.error(`Failed to capture ADB snapshot: ${error}`);
      throw new ActionableError(`Failed to capture ADB snapshot: ${error}`);
    }
  }

  /**
   * Get list of installed packages
   */
  private async getInstalledPackages(): Promise<string[]> {
    try {
      const a11y = AndroidCtrlProxyClient.getInstance(this.device);
      const result = await a11y.requestInstalledPackages(true, undefined, 4000);
      if (result.success) {
        return result.packages.map((p) => p.packageName);
      }
    } catch (error) {
      logger.debug(`[CaptureSnapshot] a11y package list failed, falling back to ADB: ${error}`);
    }
    const result = await this.adb.executeCommand("shell pm list packages");
    return result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("package:"))
      .map((line) => line.replace("package:", ""));
  }

  /**
   * Get currently foreground app
   */
  private async getForegroundApp(): Promise<string | undefined> {
    try {
      const foregroundApp = await this.adb.getForegroundApp();
      return foregroundApp?.packageName;
    } catch (error) {
      logger.warn(`Failed to get foreground app: ${error}`);
      return undefined;
    }
  }

  /**
   * Capture device settings
   */
  private async captureSettings(): Promise<{
    global: Record<string, string>;
    secure: Record<string, string>;
    system: Record<string, string>;
  }> {
    logger.info("Capturing device settings");

    const settingsTypes = ["global", "secure", "system"];
    const settings: any = {};

    for (const type of settingsTypes) {
      try {
        let captured = false;
        try {
          const a11y = AndroidCtrlProxyClient.getInstance(this.device);
          const a11yResult = await a11y.requestSettingsList(type as SettingsNamespace);
          if (a11yResult.success && a11yResult.entries) {
            settings[type] = a11yResult.entries;
            captured = true;
          }
        } catch (error) {
          logger.debug(`[CaptureSnapshot] a11y settings list failed for ${type}: ${error}`);
        }
        if (!captured) {
          const result = await this.adb.executeCommand(`shell settings list ${type}`);
          settings[type] = this.parseSettings(result.stdout);
        }
        logger.info(`Captured ${Object.keys(settings[type]).length} ${type} settings`);
      } catch (error) {
        logger.warn(`Failed to capture ${type} settings: ${error}`);
        settings[type] = {};
      }
    }

    return settings;
  }

  /**
   * Parse settings output into key-value pairs
   */
  private parseSettings(output: string): Record<string, string> {
    const settings: Record<string, string> = {};

    for (const line of output.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      const match = trimmed.match(/^(.+?)=(.*)$/);
      if (match) {
        settings[match[1]] = match[2];
      }
    }

    return settings;
  }

  /**
   * Save settings to snapshot directory
   */
  private async saveSettings(snapshotName: string, settings: any): Promise<void> {
    // Ensure snapshot directory exists before writing
    const snapshotDir = this.store.getSnapshotPath(snapshotName);
    await fs.mkdir(snapshotDir, { recursive: true });

    const settingsPath = this.store.getSettingsPath(snapshotName);
    await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
    logger.info(`Saved settings to ${settingsPath}`);
  }

  /**
   * Capture app data using adb backup
   */
  private async captureAppData(
    snapshotName: string,
    packages: string[],
    strictBackupMode: boolean,
    backupTimeoutMs: number,
    userApps: "current" | "all",
    foregroundApp: string | undefined,
  ): Promise<DeviceSnapshotManifest["appDataBackup"]> {
    logger.info(`Capturing app data (scope: ${userApps})`);

    const appDataPath = this.store.getAppDataPath(snapshotName);
    await fs.mkdir(appDataPath, { recursive: true });

    // Save package list for reference
    const packageListPath = path.join(appDataPath, "packages.txt");
    await fs.writeFile(packageListPath, packages.join("\n"), "utf-8");

    // Filter to user apps only (exclude system apps)
    let userPackages = await this.filterUserPackages(packages);
    logger.info(
      `Found ${userPackages.length} user-installed apps (excluding ${packages.length - userPackages.length} system apps)`,
    );

    // If userApps is "current", only backup the foreground app
    if (userApps === "current") {
      if (!foregroundApp) {
        logger.warn("No foreground app detected, cannot backup current app");
        return {
          backupMethod: "none",
          totalPackages: packages.length,
          backedUpPackages: [],
          skippedPackages: [],
          failedPackages: [],
        };
      }

      if (userPackages.includes(foregroundApp)) {
        userPackages = [foregroundApp];
        logger.info(`Backing up current foreground app: ${foregroundApp}`);
      } else {
        logger.warn(`Foreground app ${foregroundApp} is not a user app, skipping backup`);
        return {
          backupMethod: "none",
          totalPackages: packages.length,
          backedUpPackages: [],
          skippedPackages: [],
          failedPackages: [],
        };
      }
    }

    // Filter out packages that don't allow backup
    const { allowedPackages, skippedPackages } =
      await this.filterBackupAllowedPackages(userPackages);
    logger.info(
      `${allowedPackages.length} apps allow backup, ${skippedPackages.length} apps disallow backup`,
    );

    if (skippedPackages.length > 0) {
      logger.info(
        `Skipped apps (android:allowBackup="false"): ${skippedPackages.slice(0, 10).join(", ")}${skippedPackages.length > 10 ? "..." : ""}`,
      );
    }

    if (allowedPackages.length === 0) {
      logger.warn("No apps available for backup");
      return {
        backupMethod: "none",
        totalPackages: packages.length,
        backedUpPackages: [],
        skippedPackages,
        failedPackages: [],
      };
    }

    // Attempt adb backup
    const backupFilePath = this.store.getBackupFilePath(snapshotName);
    const backupResult = await this.performAdbBackup(
      allowedPackages,
      backupFilePath,
      backupTimeoutMs,
    );

    // Check if backup succeeded
    let backupSucceeded = false;
    try {
      const stats = await fs.stat(backupFilePath);
      backupSucceeded = stats.size > 0;
    } catch {
      backupSucceeded = false;
    }

    if (!backupSucceeded) {
      const errorMessage = `App data backup failed or timed out. User may need to confirm backup on device. ${allowedPackages.length} apps were attempted.`;
      logger.warn(errorMessage);

      if (strictBackupMode) {
        throw new ActionableError(errorMessage);
      }

      return {
        backupMethod: "adb_backup",
        totalPackages: packages.length,
        backedUpPackages: [],
        skippedPackages,
        failedPackages: allowedPackages,
        backupTimedOut: backupResult.timedOut,
      };
    }

    logger.info(`Successfully backed up ${allowedPackages.length} apps to ${backupFilePath}`);

    return {
      backupFile: path.basename(backupFilePath),
      backupMethod: "adb_backup",
      totalPackages: packages.length,
      backedUpPackages: allowedPackages,
      skippedPackages,
      failedPackages: [],
      backupTimedOut: false,
    };
  }

  /**
   * Filter packages to only include user-installed apps
   */
  private async filterUserPackages(packages: string[]): Promise<string[]> {
    // Try WebSocket-backed PackageManager once and partition.
    try {
      const a11y = AndroidCtrlProxyClient.getInstance(this.device);
      const result = await a11y.requestInstalledPackages(true, undefined, 4000);
      if (result.success) {
        const userSet = new Set(
          result.packages.filter((p) => !p.isSystem).map((p) => p.packageName),
        );
        return packages.filter((p) => userSet.has(p));
      }
    } catch (error) {
      logger.debug(
        `[CaptureSnapshot] a11y filterUserPackages failed, falling back to ADB: ${error}`,
      );
    }

    const userPackages: string[] = [];

    for (const packageName of packages) {
      try {
        const result = await this.adb.executeCommand(`shell pm list packages -3 ${packageName}`);
        if (result.stdout.includes(packageName)) {
          userPackages.push(packageName);
        }
      } catch (error) {
        logger.debug(`Failed to check if ${packageName} is user app: ${error}`);
      }
    }

    return userPackages;
  }

  /**
   * Filter packages to only include those that allow backup
   */
  private async filterBackupAllowedPackages(packages: string[]): Promise<{
    allowedPackages: string[];
    skippedPackages: string[];
  }> {
    const allowedPackages: string[] = [];
    const skippedPackages: string[] = [];
    const a11y = AndroidCtrlProxyClient.getInstance(this.device);

    for (const packageName of packages) {
      let resolved = false;
      try {
        const info = await a11y.requestPackageInfo(
          packageName,
          { includePermissions: false },
          2000,
        );
        if (info.success && info.allowBackup !== undefined) {
          if (info.allowBackup === false) {
            skippedPackages.push(packageName);
          } else {
            allowedPackages.push(packageName);
          }
          resolved = true;
        }
      } catch {
        // fall through to ADB
      }
      if (resolved) {
        continue;
      }

      try {
        const result = await this.adb.executeCommand(`shell dumpsys package ${packageName}`);
        if (result.stdout.includes("ALLOW_BACKUP=false")) {
          skippedPackages.push(packageName);
        } else {
          allowedPackages.push(packageName);
        }
      } catch (error) {
        logger.debug(`Failed to check backup flag for ${packageName}, assuming allowed: ${error}`);
        allowedPackages.push(packageName);
      }
    }

    return { allowedPackages, skippedPackages };
  }

  /**
   * Perform adb backup with timeout
   */
  private async performAdbBackup(
    packages: string[],
    backupFilePath: string,
    timeoutMs: number,
  ): Promise<{ timedOut: boolean }> {
    logger.info(`Starting adb backup for ${packages.length} packages (timeout: ${timeoutMs}ms)`);
    logger.info("Please confirm the backup on your device if prompted");

    // Declared outside try so the catch block can clear a pending timeout.
    let timeoutHandle: NodeJS.Timeout | null = null;

    try {
      // Build adb backup command
      // -f: file path, -noapk: don't backup APK files, -obb: include OBB files
      // -shared: include shared storage, -all: backup all data
      const packageList = packages.join(" ");
      const command = `backup -f "${backupFilePath}" -noapk ${packageList}`;

      // Execute backup with timeout using timer
      let timedOut = false;

      const result = await Promise.race([
        this.adb.executeCommand(command),
        new Promise<{ stdout: string; stderr: string; timedOut: true }>((resolve) => {
          timeoutHandle = this.timer.setTimeout(() => {
            timedOut = true;
            resolve({ stdout: "", stderr: "Backup timed out", timedOut: true });
          }, timeoutMs);
        }),
      ]);

      // Clear timeout if command completed first
      if (timeoutHandle && !timedOut) {
        this.timer.clearTimeout(timeoutHandle);
      }

      if ("timedOut" in result && result.timedOut) {
        logger.warn(
          `Backup timed out after ${timeoutMs}ms - user may not have confirmed on device`,
        );
        return { timedOut: true };
      }

      return { timedOut: false };
    } catch (error) {
      // Clear timeout to avoid keeping process alive
      if (timeoutHandle) {
        this.timer.clearTimeout(timeoutHandle);
      }
      logger.error(`Backup failed: ${error}`);
      return { timedOut: false };
    }
  }

  private async executeIos(args: CaptureSnapshotArgs): Promise<CaptureSnapshotResult> {
    const {
      snapshotName,
      includeAppData = true,
      includeSettings = true,
      useVmSnapshot = true,
      strictBackupMode = false,
      appBundleIds,
    } = args;

    logger.info(`[iOS] Capturing snapshot '${snapshotName}' for simulator ${this.device.deviceId}`);

    if (useVmSnapshot) {
      logger.info("[iOS] useVmSnapshot is ignored; using app container backups for portability");
    }

    const metadata = await this.getIosDeviceMetadata();
    const pathOptions = this.getIosPathOptions();

    let iosSettings: IosSettingsSnapshot | undefined;
    if (includeSettings) {
      iosSettings = await captureIosSettings(this.simctl, this.device.deviceId);
    }

    const appDataBackup = includeAppData
      ? await this.captureIosAppData(snapshotName, appBundleIds, strictBackupMode, pathOptions)
      : undefined;

    const manifest: DeviceSnapshotManifest = {
      snapshotName,
      timestamp: new Date().toISOString(),
      deviceId: this.device.deviceId,
      deviceName: this.device.name,
      platform: "ios",
      deviceType: metadata.deviceType,
      osVersion: metadata.osVersion,
      snapshotType: "app_data",
      includeAppData,
      includeSettings,
      ...(iosSettings ? { iosSettings } : {}),
      appDataBackup,
    };

    await this.saveIosMetadata(snapshotName, manifest, pathOptions);

    logger.info(
      `[iOS] Snapshot '${snapshotName}' captured successfully (type: ${manifest.snapshotType})`,
    );

    return {
      snapshotName: manifest.snapshotName,
      timestamp: manifest.timestamp,
      snapshotType: manifest.snapshotType,
      manifest,
    };
  }

  private getIosPathOptions(): SnapshotPathOptions {
    return { platform: "ios", deviceId: this.device.deviceId };
  }

  private async captureIosAppData(
    snapshotName: string,
    appBundleIds: string[] | undefined,
    strictBackupMode: boolean,
    pathOptions: SnapshotPathOptions,
  ): Promise<DeviceSnapshotManifest["appDataBackup"]> {
    // Sanitize first: trim, drop blank entries, and de-dupe while preserving order.
    const sanitized = Array.from(
      new Set((appBundleIds ?? []).map((value) => value.trim()).filter(Boolean)),
    );

    // Empty `appBundleIds` with `includeAppData:true` used to "succeed" while
    // capturing nothing. That is a caller mistake — fail loudly instead of
    // producing an empty backup (issue #5712).
    if (sanitized.length === 0) {
      throw new ActionableError(
        "No app bundle IDs provided for iOS app-data capture. Pass appBundleIds " +
          "with at least one installed app, or set includeAppData:false for a " +
          "settings-only snapshot.",
      );
    }

    logger.info("[iOS] Capturing app data containers");

    const appDataPath = this.store.getAppDataPath(snapshotName, pathOptions);
    await fs.mkdir(appDataPath, { recursive: true });

    // Validate installation up front so an unknown bundle is reported as
    // not-installed rather than silently "succeeding".
    const installedBundleIds = await this.getInstalledIosBundleIds();

    const bundleStatuses: IosBundleCaptureStatus[] = [];
    const backedUpPackages: string[] = [];
    const skippedPackages: string[] = [];
    const failedPackages: string[] = [];

    for (const bundleId of sanitized) {
      if (!installedBundleIds.has(bundleId)) {
        logger.warn(`[iOS] ${bundleId} is not installed; skipping app data capture`);
        failedPackages.push(bundleId);
        bundleStatuses.push({ bundleId, status: "not-installed" });
        continue;
      }

      try {
        const containerPath = await getAppDataContainerPath(
          this.simctl,
          this.device.deviceId,
          bundleId,
        );
        if (!containerPath) {
          logger.warn(`[iOS] ${bundleId} has no data container; skipping app data capture`);
          skippedPackages.push(bundleId);
          bundleStatuses.push({ bundleId, status: "skipped-no-container" });
          continue;
        }

        logger.info(`[iOS] Backing up app data: ${bundleId}`);
        await this.copyIosAppContainer(containerPath, appDataPath, bundleId);
        backedUpPackages.push(bundleId);
        bundleStatuses.push({ bundleId, status: "captured" });
      } catch (error) {
        // A container that resolved but failed to copy is a genuine capture
        // failure, not a missing app; count it as failed so strict mode rejects.
        logger.warn(`[iOS] Failed to backup app data for ${bundleId}: ${error}`);
        failedPackages.push(bundleId);
        bundleStatuses.push({ bundleId, status: "skipped-no-container" });
      }
    }

    if (strictBackupMode && failedPackages.length > 0) {
      throw new ActionableError(
        `Failed to backup app data for ${failedPackages.length} app(s): ${failedPackages.join(", ")}`,
      );
    }

    return {
      backupMethod: "simctl_copy",
      totalPackages: sanitized.length,
      backedUpPackages,
      skippedPackages,
      failedPackages,
      bundleStatuses,
    };
  }

  /**
   * Resolve the set of installed bundle identifiers on the simulator. Uses the
   * strict `listAppsOrThrow` so a listing failure surfaces as an error (we can
   * no longer validate installation) instead of being collapsed into "no apps
   * installed" and mislabeling every requested bundle as not-installed.
   */
  private async getInstalledIosBundleIds(): Promise<Set<string>> {
    let apps: IosInstalledAppRecord[];
    try {
      apps = await this.simctl.listAppsOrThrow(this.device.deviceId);
    } catch (error) {
      throw toActionableError(error, "Failed to list installed iOS apps to validate appBundleIds");
    }

    const installed = new Set<string>();
    for (const app of apps) {
      const bundleId = getIosInstalledAppBundleId(app);
      if (bundleId) {
        installed.add(bundleId);
      }
    }
    return installed;
  }

  private async copyIosAppContainer(
    containerPath: string,
    appDataPath: string,
    bundleId: string,
  ): Promise<void> {
    const targetRoot = path.join(appDataPath, bundleId);
    await fs.mkdir(targetRoot, { recursive: true });

    for (const folder of IOS_APP_DATA_FOLDERS) {
      const sourcePath = path.join(containerPath, folder);
      const destinationPath = path.join(targetRoot, folder);
      if (await pathExists(sourcePath)) {
        await fs.cp(sourcePath, destinationPath, { recursive: true });
      }
    }
  }

  private async getIosDeviceMetadata(): Promise<{ deviceType?: string; osVersion?: string }> {
    try {
      const deviceInfo = await this.simctl.getDeviceInfo(this.device.deviceId);
      if (!deviceInfo) {
        return {};
      }

      const deviceType = deviceInfo.deviceTypeIdentifier ?? deviceInfo.model;
      let osVersion: string | undefined = deviceInfo.os_version;

      if (!osVersion && deviceInfo.runtime) {
        const runtimes = await this.simctl.getRuntimes();
        const runtime = runtimes.find((entry) => entry.identifier === deviceInfo.runtime);
        osVersion = runtime?.version || runtime?.name;
      }

      return { deviceType, osVersion };
    } catch (error) {
      logger.warn(`[iOS] Failed to read simulator metadata: ${error}`);
      return {};
    }
  }

  private async saveIosMetadata(
    snapshotName: string,
    manifest: DeviceSnapshotManifest,
    pathOptions: SnapshotPathOptions,
  ): Promise<void> {
    const snapshotDir = this.store.getSnapshotPathWithOptions(snapshotName, pathOptions);
    await fs.mkdir(snapshotDir, { recursive: true });
    const metadataPath = this.store.getMetadataPath(snapshotName, pathOptions);
    await fs.writeFile(metadataPath, JSON.stringify(manifest, null, 2), "utf-8");
    logger.info(`[iOS] Wrote metadata to ${metadataPath}`);
  }
}
