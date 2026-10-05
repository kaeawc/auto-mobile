import type {
  RestoreSnapshotArgs,
  RestoreSnapshotResult,
  RestoreSnapshotFailure,
} from "../../models/DeviceSnapshot";
export type {
  RestoreSnapshotArgs,
  RestoreSnapshotResult,
  RestoreSnapshotFailure,
} from "../../models/DeviceSnapshot";
import {
  resolveIosSnapshotBackend,
  type IosSnapshotBackend,
  type IosSimulatorSnapshotBackend,
} from "../../utils/ios-cmdline-tools/IosSnapshotBackend";
import { errorMessage } from "../../utils/describeUnknownError";
import {
  BootedDevice,
  ActionableError,
  DeviceSnapshotManifest,
  DeviceSnapshotType,
  toActionableError,
} from "../../models";
import type { SnapshotRestoreProvider } from "../../utils/interfaces/SnapshotProvider";
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
import { IOS_APP_DATA_FOLDERS } from "../../utils/ios-cmdline-tools/iosAppContainer";
import { pathExists } from "../../utils/filesystem/DefaultFileSystem";
import { logger } from "../../utils/logger";
import { shellQuote } from "../../utils/shellQuote";
import { promises as fs } from "fs";
import * as path from "path";
import { Timer, defaultTimer } from "../../utils/SystemTimer";
import { AndroidCtrlProxyClient } from "../observe/android/AndroidCtrlProxyClient";
import type { SettingsNamespace } from "../observe/android";
import {
  defaultEmulatorConsoleBusyRegistry,
  type EmulatorConsoleBusyRegistry,
} from "../../utils/android-cmdline-tools/EmulatorConsoleBusyRegistry";

/** Parse only complete iOS snapshot version shapes; patch versions do not affect compatibility. */
export function parseIosSnapshotOsVersion(
  version: string,
): { major: number; minor?: number } | null {
  const value = version.trim();
  const match =
    value.match(/^(\d+)(?:\.(\d+))?(?:\.\d+)?$/) ??
    value.match(/^[iI][oO][sS][- _]?(\d+)(?:[.\-_ ](\d+))?(?:[.\-_ ]\d+)?$/) ??
    value.match(/^com\.apple\.CoreSimulator\.SimRuntime\.[iI][oO][sS]-(\d+)(?:-(\d+))?(?:-\d+)?$/);
  if (!match) {
    return null;
  }

  const major = Number(match[1]);
  const minor = match[2] === undefined ? undefined : Number(match[2]);
  return Number.isFinite(major) && (minor === undefined || Number.isFinite(minor))
    ? { major, minor }
    : null;
}

interface IosRestoreOperations {
  pathExists(path: string): Promise<boolean>;
  terminateAppIfRunning(deviceId: string, bundleId: string): Promise<void>;
  getAppDataContainerPath(deviceId: string, bundleId: string): Promise<string | null | undefined>;
  rm(path: string, options: { recursive: true; force: true }): Promise<void>;
  cp(source: string, destination: string, options: { recursive: true }): Promise<void>;
}

const RESTORABLE_SETTINGS_NAMESPACES = new Set<string>(["global", "secure", "system"]);

function isSettingsNamespace(value: string): value is SettingsNamespace {
  return RESTORABLE_SETTINGS_NAMESPACES.has(value);
}

function getAndroidRestoreDetails(
  snapshotType: DeviceSnapshotType,
  usedVmSnapshot: boolean,
  isEmulator: boolean,
  deviceId: string,
): Pick<RestoreSnapshotResult, "snapshotType" | "restoreMode" | "restoreNote"> {
  const degradedVmRestore = snapshotType === "vm" && !usedVmSnapshot;
  const reason = isEmulator ? "useVmSnapshot is disabled" : `device ${deviceId} is not an emulator`;
  return {
    snapshotType: usedVmSnapshot ? "vm" : "adb",
    restoreMode: usedVmSnapshot ? "vm" : "settings_only",
    ...(degradedVmRestore
      ? {
          restoreNote: `VM state was not restored; only captured Android settings were applied because ${reason}.`,
        }
      : {}),
  };
}

/**
 * Restore device state from snapshot, dispatching on device platform.
 *
 * - **Android**: VM snapshot restoration for emulators; settings-only restore
 *   otherwise (the deprecated `adb backup`/`adb restore` app-data path was
 *   dropped in #5708).
 * - **iOS**: app container restore via `simctl` (app_data snapshots only).
 */
export class RestoreSnapshot implements SnapshotRestoreProvider {
  private device: BootedDevice;
  private adb: AdbExecutor;
  private emulator: AndroidEmulatorClient;
  private store: DeviceSnapshotStore;
  private timer: Timer;
  private iosSnapshotBackend: IosSnapshotBackend;
  private iosRestoreOperations: IosRestoreOperations;

  constructor(
    device: BootedDevice,
    adbFactory: AdbClientFactory = defaultAdbClientFactory,
    emulator?: AndroidEmulatorClient,
    timer: Timer = defaultTimer,
    store: DeviceSnapshotStore = new DeviceSnapshotStore(),
    simctl?: SimCtlClient,
    private readonly consoleBusyRegistry: EmulatorConsoleBusyRegistry = defaultEmulatorConsoleBusyRegistry,
    iosRestoreOperations?: IosRestoreOperations,
  ) {
    this.device = device;
    this.adb = adbFactory.create(device);
    this.emulator = emulator || new AndroidEmulatorClient();
    this.store = store;
    this.timer = timer;
    this.iosSnapshotBackend = resolveIosSnapshotBackend(device.deviceId, {
      simctl: simctl || new SimCtlClient(device),
    });
    this.iosRestoreOperations = iosRestoreOperations ?? {
      pathExists,
      terminateAppIfRunning: (_deviceId, bundleId) =>
        this.simulatorSnapshotBackend.terminateAppIfRunning(bundleId),
      getAppDataContainerPath: (_deviceId, bundleId) =>
        this.simulatorSnapshotBackend.getAppDataContainerPath(bundleId),
      rm: (destination, options) => fs.rm(destination, options),
      cp: (source, destination, options) => fs.cp(source, destination, options),
    };
  }

  private get simulatorSnapshotBackend(): IosSimulatorSnapshotBackend {
    if (this.iosSnapshotBackend.kind === "physical") {
      throw new Error("Snapshot app listing is not supported for physical iOS devices");
    }
    return this.iosSnapshotBackend;
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
    // Reject a traversal/absolute snapshotName before any filesystem read or
    // `adb emu avd snapshot load`/`simctl` call resolves a path from it (#5705).
    assertSafeSnapshotName(args.snapshotName);

    switch (this.device.platform) {
      case "android":
        return this.executeAndroid(args);
      case "ios":
        // Physical iOS devices are discoverable now, but iOS snapshot restore drives
        // simctl for settings and app-container operations, which only works on a
        // Simulator. Reject a physical iPhone with an actionable error rather than
        // half-applying a restore over a failing simctl transport.
        if (this.iosSnapshotBackend.kind === "physical") {
          throw new ActionableError(
            `Device snapshots are not supported on physical iOS devices (${this.device.deviceId}); ` +
              "they require a Simulator (simctl).",
          );
        }
        return this.executeIos(args);
      default:
        throw new ActionableError(
          `Snapshot restore is not supported for platform '${this.device.platform}'`,
        );
    }
  }

  private async executeAndroid(args: RestoreSnapshotArgs): Promise<RestoreSnapshotResult> {
    const {
      snapshotName,
      manifest,
      useVmSnapshot = true,
      vmSnapshotTimeoutMs = 30000,
      onVmSnapshotLoaded,
      onBeforeVmSnapshotLoad,
    } = args;

    logger.info(
      `Restoring snapshot '${snapshotName}' (type: ${manifest.snapshotType}) to device ${this.device.deviceId}`,
    );

    // Verify device compatibility
    if (manifest.platform !== this.device.platform) {
      throw new ActionableError(
        `Snapshot platform '${manifest.platform}' does not match device platform '${this.device.platform}'`,
      );
    }

    // Determine restoration method
    const isEmulator = this.device.deviceId.startsWith("emulator-");
    const shouldUseVmSnapshot = useVmSnapshot && manifest.snapshotType === "vm" && isEmulator;

    let failures: RestoreSnapshotFailure[] = [];
    if (shouldUseVmSnapshot) {
      await this.restoreVmSnapshot(
        snapshotName,
        manifest,
        vmSnapshotTimeoutMs,
        onVmSnapshotLoaded,
        onBeforeVmSnapshotLoad,
      );
    } else {
      failures = await this.restoreSettingsSnapshot(manifest);
    }

    if (failures.length === 0) {
      logger.info(`Snapshot '${snapshotName}' restored successfully`);
    } else {
      logger.warn(
        `Snapshot '${snapshotName}' partially restored: ${failures.length} item(s) failed`,
      );
    }

    const restoreDetails = getAndroidRestoreDetails(
      manifest.snapshotType,
      shouldUseVmSnapshot,
      isEmulator,
      this.device.deviceId,
    );

    return {
      ...restoreDetails,
      restoredAt: new Date().toISOString(),
      success: failures.length === 0,
      failures,
    };
  }

  /**
   * Restore VM snapshot using emulator console
   */
  private async restoreVmSnapshot(
    snapshotName: string,
    manifest: DeviceSnapshotManifest,
    vmSnapshotTimeoutMs: number,
    onVmSnapshotLoaded?: () => Promise<void> | void,
    onBeforeVmSnapshotLoad?: () => Promise<void> | void,
  ): Promise<void> {
    logger.info(`Restoring VM snapshot for emulator ${this.device.deviceId}`);

    try {
      // Load VM snapshot using ADB emu command
      const loadCommand = buildVmSnapshotCommand("load", snapshotName);
      logger.info(`Executing: adb -s ${this.device.deviceId} ${loadCommand}`);

      await onBeforeVmSnapshotLoad?.();

      let result;
      try {
        result = await this.consoleBusyRegistry.runExclusive(this.device.deviceId, () =>
          this.adb.execute(loadCommand.split(" "), {
            timeoutMs: vmSnapshotTimeoutMs,
            waitForProcessSettlementAfterAbort: true,
          }),
        );
      } catch (error) {
        throw new Error(formatVmSnapshotExecutionError("load", snapshotName, error));
      }

      const evaluation = evaluateVmSnapshotResult("load", snapshotName, result);
      if (!evaluation.ok) {
        const failure = Object.assign(new Error(evaluation.errorMessage), {
          isDefinitiveVmSnapshotLoadFailure: true as const,
        });
        throw failure;
      }

      logger.info(`VM snapshot restored successfully`);
      await onVmSnapshotLoaded?.();

      await this.emulator.waitForEmulatorReady(
        manifest.deviceName,
        vmSnapshotTimeoutMs,
        null,
        this.device.deviceId,
        undefined,
        { skipWakeAndUnlock: true },
      );

      logger.info("VM snapshot restoration complete");
    } catch (error) {
      const message = errorMessage(error);
      logger.error(`Failed to restore VM snapshot: ${message}`);
      const context = `Failed to restore VM snapshot '${snapshotName}' on device ${this.device.deviceId}`;
      const actionableError =
        error instanceof ActionableError
          ? new ActionableError(`${context}: ${error.message}`, { cause: error })
          : toActionableError(error, context);
      if (
        error instanceof Error &&
        (error as { isDefinitiveVmSnapshotLoadFailure?: boolean })
          .isDefinitiveVmSnapshotLoadFailure === true
      ) {
        Object.assign(actionableError, { isDefinitiveVmSnapshotLoadFailure: true });
      }
      throw actionableError;
    }
  }

  /**
   * Restore a settings-only Android snapshot.
   *
   * The deprecated `adb backup`/`adb restore` app-data path was dropped in
   * #5708, so non-VM Android restore reapplies captured device settings and
   * relaunches the foreground app only. There is no app-data clear/restore
   * phase — `pm clear` and `adb restore` are never issued.
   */
  private async restoreSettingsSnapshot(
    manifest: DeviceSnapshotManifest,
  ): Promise<RestoreSnapshotFailure[]> {
    logger.info(`Restoring settings-only snapshot for device ${this.device.deviceId}`);

    try {
      let failures: RestoreSnapshotFailure[] = [];
      if (manifest.includeSettings && manifest.settings) {
        failures = await this.restoreSettings(manifest.settings);
      }

      // Restore foreground app if captured
      if (manifest.foregroundApp) {
        await this.restoreForegroundApp(manifest.foregroundApp);
      }

      logger.info("Settings snapshot restoration complete");
      return failures;
    } catch (error) {
      logger.error(`Failed to restore settings snapshot: ${errorMessage(error)}`, error);
      throw toActionableError(error, "Failed to restore settings snapshot");
    }
  }

  /**
   * Restore device settings
   */
  private async restoreSettings(settings: {
    global?: Record<string, string>;
    secure?: Record<string, string>;
    system?: Record<string, string>;
  }): Promise<RestoreSnapshotFailure[]> {
    logger.info("Restoring device settings");
    const failures: RestoreSnapshotFailure[] = [];

    for (const [settingsType, values] of Object.entries(settings)) {
      if (!values || Object.keys(values).length === 0) {
        continue;
      }

      logger.info(`Restoring ${Object.keys(values).length} ${settingsType} settings`);
      let successCount = 0;
      let failureCount = 0;

      if (!isSettingsNamespace(settingsType)) {
        failureCount = Object.keys(values).length;
        logger.warn(`Skipping unsupported settings namespace ${settingsType}`);
        for (const key of Object.keys(values)) {
          failures.push({
            kind: "android_setting",
            namespace: settingsType,
            key,
            reason: "unsupported settings namespace",
          });
        }
        logger.info(
          `${settingsType} settings restored: ${successCount} succeeded, ${failureCount} failed`,
        );
        continue;
      }

      for (const [key, value] of Object.entries(values)) {
        if (!/^[A-Za-z0-9_.:-]+$/.test(key)) {
          failureCount++;
          logger.warn(`Failed to restore ${settingsType} setting ${key}: invalid settings key`);
          failures.push({
            kind: "android_setting",
            namespace: settingsType,
            key,
            reason: "invalid settings key",
          });
          continue;
        }
        try {
          await this.applyAndroidSetting(settingsType, key, value);
          successCount++;
        } catch (error) {
          failureCount++;
          logger.warn(`Failed to restore ${settingsType} setting ${key}: ${error}`);
          failures.push({
            kind: "android_setting",
            namespace: settingsType,
            key,
            reason: errorMessage(error),
          });
        }
      }

      logger.info(
        `${settingsType} settings restored: ${successCount} succeeded, ${failureCount} failed`,
      );
    }
    return failures;
  }

  private async applyAndroidSetting(
    settingsType: SettingsNamespace,
    key: string,
    value: string,
  ): Promise<void> {
    let applied = false;
    try {
      const a11y = AndroidCtrlProxyClient.getInstance(this.device);
      const a11yResult = await a11y.requestSettingsPut(settingsType, key, value, "string");
      if (a11yResult.success) {
        applied = true;
      }
    } catch (error) {
      logger.debug(
        `[RestoreSnapshot] a11y settings put failed for ${settingsType}/${key}: ${error}`,
      );
    }
    if (!applied) {
      // ADB hands the command to the device shell, so preserve the key and value as literal words.
      await this.adb.executeCommand(
        `shell settings put ${settingsType} ${shellQuote(key)} ${shellQuote(value)}`,
      );
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
        `shell am start -a android.intent.action.MAIN -c android.intent.category.LAUNCHER ${shellQuote(packageName)}`,
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
        `Snapshot platform '${manifest.platform}' does not match device platform '${this.device.platform}'`,
      );
    }

    if (manifest.snapshotType !== "app_data") {
      throw new ActionableError(
        `Unsupported iOS snapshot type '${manifest.snapshotType}'. Re-capture using app container backups.`,
      );
    }

    await this.validateIosSnapshotCompatibility(manifest);

    if (manifest.includeSettings && manifest.iosSettings) {
      await this.simulatorSnapshotBackend.restoreSettings(manifest.iosSettings);
    }

    const failures = await this.restoreIosAppData(snapshotName, manifest);

    if (failures.length === 0) {
      logger.info(`[iOS] Snapshot '${snapshotName}' restored successfully`);
    } else {
      logger.warn(
        `[iOS] Snapshot '${snapshotName}' partially restored: ${failures.length} bundle(s) failed`,
      );
    }

    return {
      snapshotType: manifest.snapshotType,
      restoredAt: new Date().toISOString(),
      success: failures.length === 0,
      failures,
    };
  }

  private getIosPathOptions(deviceId?: string): SnapshotPathOptions {
    return { platform: "ios", deviceId: deviceId ?? this.device.deviceId };
  }

  private async restoreIosAppData(
    snapshotName: string,
    manifest: DeviceSnapshotManifest,
  ): Promise<RestoreSnapshotFailure[]> {
    if (!manifest.includeAppData) {
      logger.info("[iOS] Snapshot does not include app data; skipping restore");
      return [];
    }

    const appDataPath = await this.resolveIosAppDataPath(snapshotName, manifest);
    if (!appDataPath) {
      logger.warn(`[iOS] App data directory not found for snapshot '${snapshotName}'`);
      return [];
    }

    if (manifest.appDataBackup?.backupMethod === "none") {
      logger.info("[iOS] Snapshot app data backup method is 'none'; skipping restore");
      return [];
    }

    const bundleIds = await this.resolveIosSnapshotBundleIds(appDataPath, manifest);
    if (bundleIds.length === 0) {
      logger.warn("[iOS] No app bundle IDs found to restore");
      return [];
    }

    const installedBundles = await this.getInstalledIosBundleIds();
    if (installedBundles.size > 0) {
      const missingBundles = bundleIds.filter((bundleId) => !installedBundles.has(bundleId));
      if (missingBundles.length > 0) {
        throw new ActionableError(
          `App(s) not installed on simulator: ${missingBundles.join(", ")}. Please reinstall and retry restore.`,
        );
      }
    } else {
      logger.warn("[iOS] Unable to verify installed apps; proceeding with restore");
    }

    const failures: RestoreSnapshotFailure[] = [];
    for (const bundleId of bundleIds) {
      try {
        await this.restoreIosBundleContainer(bundleId, appDataPath);
      } catch (error) {
        logger.warn(`[iOS] Failed to restore app data for ${bundleId}: ${error}`);
        failures.push({ kind: "ios_bundle", bundleId, reason: errorMessage(error) });
      }
    }
    return failures;
  }

  /**
   * Resolve the on-disk app-data directory for an iOS snapshot, preferring the
   * manifest's capturing device and falling back to the current device's path
   * (snapshots are portable across simulators). Returns undefined when neither
   * location exists.
   */
  private async resolveIosAppDataPath(
    snapshotName: string,
    manifest: DeviceSnapshotManifest,
  ): Promise<string | undefined> {
    const manifestPath = this.store.getAppDataPath(
      snapshotName,
      this.getIosPathOptions(manifest.deviceId),
    );
    if (await this.iosRestoreOperations.pathExists(manifestPath)) {
      return manifestPath;
    }

    if (!manifest.deviceId || manifest.deviceId === this.device.deviceId) {
      return undefined;
    }

    const fallbackPath = this.store.getAppDataPath(
      snapshotName,
      this.getIosPathOptions(this.device.deviceId),
    );
    if (!(await this.iosRestoreOperations.pathExists(fallbackPath))) {
      return undefined;
    }

    logger.info(
      `[iOS] App data not found for '${manifest.deviceId}', using current device path '${this.device.deviceId}'`,
    );
    return fallbackPath;
  }

  /**
   * Restore a single bundle's captured data folders back into its live app
   * container. Extracted from {@link restoreIosAppData} so the per-bundle
   * body's folder loop does not nest under the outer bundle loop.
   */
  private async restoreIosBundleContainer(bundleId: string, appDataPath: string): Promise<void> {
    await this.iosRestoreOperations.terminateAppIfRunning(this.device.deviceId, bundleId);
    const containerPath = await this.iosRestoreOperations.getAppDataContainerPath(
      this.device.deviceId,
      bundleId,
    );
    if (!containerPath) {
      throw new ActionableError(`App data container not found for ${bundleId}`);
    }

    const snapshotBundlePath = path.join(appDataPath, bundleId);
    for (const folder of IOS_APP_DATA_FOLDERS) {
      const sourcePath = path.join(snapshotBundlePath, folder);
      if (!(await this.iosRestoreOperations.pathExists(sourcePath))) {
        continue;
      }
      const destinationPath = path.join(containerPath, folder);
      await this.iosRestoreOperations.rm(destinationPath, { recursive: true, force: true });
      try {
        await this.iosRestoreOperations.cp(sourcePath, destinationPath, { recursive: true });
      } catch (error) {
        throw new ActionableError(
          `Existing destination data was wiped/deleted and is now gone at '${destinationPath}'; restore copy failed: ${errorMessage(error)}`,
          { cause: error },
        );
      }
    }
  }

  private async validateIosSnapshotCompatibility(manifest: DeviceSnapshotManifest): Promise<void> {
    if (!manifest.osVersion) {
      logger.warn("[iOS] Snapshot OS version missing; skipping compatibility check");
      return;
    }

    const snapshotVersion = parseIosSnapshotOsVersion(manifest.osVersion);
    if (!snapshotVersion) {
      throw new ActionableError(
        `Snapshot manifest osVersion '${manifest.osVersion}' is not an iOS version. ` +
          "Expected an iOS version such as '26.5', 'iOS 26.5' or 'com.apple.CoreSimulator.SimRuntime.iOS-26-5'.",
      );
    }

    const deviceOsVersion = await this.getIosDeviceOsVersion();
    if (!deviceOsVersion) {
      logger.warn("[iOS] Unable to read simulator OS version; skipping compatibility check");
      return;
    }

    const targetVersion = parseIosSnapshotOsVersion(deviceOsVersion);
    if (!targetVersion) {
      throw new ActionableError(
        `Simulator OS version '${deviceOsVersion}' is not an iOS version. ` +
          "Expected an iOS version such as '26.5', 'iOS 26.5' or 'com.apple.CoreSimulator.SimRuntime.iOS-26-5'.",
      );
    }

    if (snapshotVersion.major !== targetVersion.major) {
      throw new ActionableError(
        `Snapshot iOS version '${manifest.osVersion}' is incompatible with simulator iOS '${deviceOsVersion}'. ` +
          `Please restore on an iOS ${snapshotVersion.major}.x simulator.`,
      );
    }
  }

  private async getIosDeviceOsVersion(): Promise<string | undefined> {
    try {
      const deviceInfo = await this.simulatorSnapshotBackend.getDeviceInfo();
      if (!deviceInfo) {
        return undefined;
      }

      let osVersion: string | undefined = deviceInfo.os_version;
      if (!osVersion && deviceInfo.runtime) {
        const runtimes = await this.simulatorSnapshotBackend.getRuntimes();
        const runtime = runtimes.find((entry) => entry.identifier === deviceInfo.runtime);
        osVersion = runtime?.version || runtime?.name;
      }

      return osVersion;
    } catch (error) {
      logger.warn(`[iOS] Failed to read simulator OS version: ${error}`);
      return undefined;
    }
  }

  private async getInstalledIosBundleIds(): Promise<Set<string>> {
    try {
      const apps = await this.simulatorSnapshotBackend.listApps();
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
    manifest: DeviceSnapshotManifest,
  ): Promise<string[]> {
    const fromManifest = manifest.appDataBackup?.backedUpPackages;
    if (fromManifest && fromManifest.length > 0) {
      return fromManifest;
    }

    try {
      const entries = await fs.readdir(appDataPath, { withFileTypes: true });
      return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch (error) {
      logger.warn(`[iOS] Failed to read app data bundles: ${error}`);
      return [];
    }
  }
}
