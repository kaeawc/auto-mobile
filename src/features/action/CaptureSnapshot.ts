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
import { assertSafeSnapshotName } from "../../utils/snapshotNameValidation";
import { SimCtlClient } from "../../utils/ios-cmdline-tools/SimCtlClient";
import { isIosPhysicalUdid } from "../../utils/ios-cmdline-tools/iosDeviceType";
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
  strictBackupMode?: boolean; // iOS-only: if true, fail the whole snapshot unless every requested bundle is backed up (all-or-nothing)
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
 * - **Android**: VM snapshots for emulators; settings-only snapshots otherwise
 *   (the deprecated `adb backup` app-data path was dropped in #5708).
 * - **iOS**: app container backups via `simctl` (portable across restores).
 */
export class CaptureSnapshot implements SnapshotCaptureProvider {
  private device: BootedDevice;
  private adb: AdbExecutor;
  private emulator: AndroidEmulatorClient;
  private store: DeviceSnapshotStore;
  private simctl: SimCtlClient;

  constructor(
    device: BootedDevice,
    adbFactory: AdbClientFactory = defaultAdbClientFactory,
    emulator?: AndroidEmulatorClient,
    _timer: Timer = defaultTimer,
    store: DeviceSnapshotStore = new DeviceSnapshotStore(),
    simctl?: SimCtlClient,
  ) {
    this.device = device;
    this.adb = adbFactory.create(device);
    this.emulator = emulator || new AndroidEmulatorClient();
    this.store = store;
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
    // Reject a traversal/absolute snapshotName before any filesystem write or
    // `adb emu avd snapshot save`/`simctl` call can act on it (issue #5705).
    assertSafeSnapshotName(args.snapshotName);

    switch (this.device.platform) {
      case "android":
        return this.executeAndroid(args);
      case "ios":
        // Physical iOS devices are discoverable now, but iOS snapshot capture uses
        // simctl for metadata/settings/app-container operations, which only works on a
        // Simulator. Reject a physical iPhone with an actionable error rather than
        // producing a partial, simctl-transport-failed snapshot.
        if (isIosPhysicalUdid(this.device.deviceId)) {
          throw new ActionableError(
            `Device snapshots are not supported on physical iOS devices (${this.device.deviceId}); ` +
              "they require a Simulator (simctl).",
          );
        }
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
      manifest = await this.captureSettingsSnapshot(snapshotName, includeAppData, includeSettings);
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
   * Capture a settings-only Android snapshot.
   *
   * The deprecated `adb backup` app-data path was dropped in #5708 — it is
   * deprecated since API 31, requires interactive on-device confirmation, and
   * produced no `backup.ab` in practice on API 34. VM snapshots (emulators)
   * remain the way to capture app data; targeted app-data inspection is covered
   * by the DataStore / shared-storage / `sqlQuery` tools. Non-VM Android
   * (physical devices and emulators with `useVmSnapshot: false`) therefore
   * captures device settings and foreground-app state only, using the CtrlProxy
   * settings namespaces (with an ADB fallback) — never `adb backup`.
   */
  private async captureSettingsSnapshot(
    snapshotName: string,
    includeAppData: boolean,
    includeSettings: boolean,
  ): Promise<DeviceSnapshotManifest> {
    logger.info(`Using settings-only snapshot for device ${this.device.deviceId}`);

    if (includeAppData) {
      logger.warn(
        "App-data snapshots are not supported on non-VM Android (the adb backup path was removed in #5708); capturing settings only. Use a VM snapshot on an emulator to capture app data.",
      );
    }

    try {
      // Foreground-app state is cheap metadata and drives restore's relaunch.
      const foregroundApp = await this.getForegroundApp();

      // Capture settings if requested
      let settings;
      if (includeSettings) {
        settings = await this.captureSettings();
        await this.saveSettings(snapshotName, settings);
      }

      // Create manifest. includeAppData is always false: non-VM Android no
      // longer captures app data, so the manifest must reflect what was taken.
      const manifest: DeviceSnapshotManifest = {
        snapshotName,
        timestamp: new Date().toISOString(),
        deviceId: this.device.deviceId,
        deviceName: this.device.name,
        platform: "android",
        snapshotType: "adb",
        includeAppData: false,
        includeSettings,
        foregroundApp,
        settings,
      };

      return manifest;
    } catch (error) {
      logger.error(`Failed to capture settings snapshot: ${error}`);
      throw new ActionableError(`Failed to capture settings snapshot: ${error}`);
    }
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
    // Ensure snapshot directory exists before writing. Android emulator
    // snapshots are scoped by AVD name so the same name can be reused across
    // AVDs without colliding on disk (#5707).
    const pathOptions = this.getAndroidPathOptions();
    const snapshotDir = this.store.getSnapshotPathWithOptions(snapshotName, pathOptions);
    await fs.mkdir(snapshotDir, { recursive: true });

    const settingsPath = this.store.getSettingsPath(snapshotName, pathOptions);
    await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
    logger.info(`Saved settings to ${settingsPath}`);
  }

  /**
   * AVD-scoped path options for Android emulator snapshots. Returns undefined
   * for physical Android devices (no AVD name), which keep the unscoped path.
   */
  private getAndroidPathOptions(): SnapshotPathOptions | undefined {
    if (this.device.deviceId.startsWith("emulator-")) {
      return { platform: "android", avdName: this.device.name };
    }
    return undefined;
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
        bundleStatuses.push({ bundleId, status: "failed" });
      }
    }

    // strict = all-or-nothing (#5711): fail the whole snapshot unless every
    // requested bundle was actually backed up. `failedPackages` alone is not
    // enough — a bundle with no data container lands in `skippedPackages` yet
    // still leaves the requested set uncovered, so key the check on coverage.
    if (strictBackupMode && backedUpPackages.length < sanitized.length) {
      const backedUp = new Set(backedUpPackages);
      const notBackedUp = sanitized.filter((bundleId) => !backedUp.has(bundleId));
      throw new ActionableError(
        `Failed to backup app data for ${notBackedUp.length} of ${sanitized.length} ` +
          `requested app(s) in strictBackupMode (all-or-nothing): ${notBackedUp.join(", ")}.`,
      );
    }

    // When app data was requested but nothing was actually captured, the
    // snapshot is empty — reporting "success" hides the failure until the caller
    // digs into manifest.appDataBackup. Fail loudly instead (issue #5710). This
    // fires regardless of strictBackupMode: an all-skipped set (e.g. a system app
    // with no data container) has no failedPackages yet still captures nothing.
    if (backedUpPackages.length === 0) {
      const parts = [
        `iOS app-data capture backed up 0 of ${sanitized.length} requested app(s) ` +
          `(${sanitized.join(", ")}).`,
      ];
      if (failedPackages.length > 0) {
        parts.push(`Failed: ${failedPackages.join(", ")}.`);
      }
      if (skippedPackages.length > 0) {
        parts.push(`Skipped (no data container): ${skippedPackages.join(", ")}.`);
      }
      parts.push(
        "Pass appBundleIds for installed apps that have a data container, or set " +
          "includeAppData:false for a settings-only snapshot.",
      );
      throw new ActionableError(parts.join(" "));
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
