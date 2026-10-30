import path from "path";
import type {
  BootedDevice,
  InstallAppResult,
  LaunchAppResult,
  TerminateAppResult,
} from "../../../models";
import { ActionableError, toActionableError } from "../../../models/ActionableError";
import type { UninstallAppResult } from "../../../models/UninstallAppResult";
import { errorMessage } from "../../../utils/describeUnknownError";
import type { IosClearDataBackendDeps } from "../../../utils/ios-cmdline-tools/IosDeviceBackend";
import { isProcessAlreadyGoneError } from "../../../utils/ios-cmdline-tools/iosProcessErrors";
import { logger } from "../../../utils/logger";
import { resolvePathFromDaemonLaunchWorkingDirectory } from "../../../utils/workingDirectory";
import { PlistClient, type PlistReader } from "../../../utils/ios-cmdline-tools/PlistClient";
import { SimCtlClient } from "../../../utils/ios-cmdline-tools/SimCtlClient";
import {
  getIosInstalledAppBundleId,
  type IosInstalledAppRecord,
} from "../../../utils/ios-cmdline-tools/iosInstalledApp";
import { SimulatorIosClearDataBackend } from "../../../utils/ios-cmdline-tools/SimulatorIosClearDataBackend";
import type { InstallAppCall } from "../InstallAppTypes";
import type { LaunchAppCall } from "../LaunchAppTypes";
import { PACKAGE_NOT_INSTALLED_ERROR } from "../LaunchPackageRemovedError";
import type { UninstallAppCall } from "../UninstallApp";

/** The simctl calls a watch app manager makes; nothing else on the client is reachable. */
export type WatchAppsSimctl = Pick<
  SimCtlClient,
  | "installApp"
  | "uninstallApp"
  | "listAppsOrThrow"
  | "launchApp"
  | "terminateApp"
  | "executeCommandArgs"
>;

/** How clearAppData finds and removes the watch app's data container (tests inject both). */
export type WatchDataWipe = Pick<IosClearDataBackendDeps, "rm" | "containerOwnership">;

/** Reads `CFBundleIdentifier` from a `.app` bundle's Info.plist. */
export type WatchBundleIdReader = Pick<PlistReader, "extractRawFile">;

const ANDROID_INSTALL_OPTIONS = ["splits", "bundle", "grantAllPermissions", "allowDowngrade"];
const GUARD_INSTALL_OPTIONS = ["expectedSigningSha256", "allowDestructiveRecovery"];

/** Names every install option the caller set that only Android supports. */
function androidOnlyInstallOptions(call: InstallAppCall): string[] {
  const set = (source: object | undefined, keys: string[]) =>
    source ? keys.filter((key) => Reflect.get(source, key) !== undefined) : [];
  return [
    ...set(call.android, ANDROID_INSTALL_OPTIONS),
    ...set(call.guard, GUARD_INSTALL_OPTIONS),
    ...(call.userId === undefined ? [] : ["userId"]),
  ];
}

/** Names every launch option the caller set that only Android supports. */
function androidOnlyLaunchOptions(call: LaunchAppCall): string[] {
  return (["intent", "activityName", "userId"] as const).filter((key) => call[key] !== undefined);
}

/** A watch simulator installs only a `.app` bundle built for the watchOS simulator. */
function assertAppBundle(artifactPath: string): void {
  const extension = path.posix.extname(artifactPath.replace(/[\\/]+$/, "")).toLowerCase();
  if (extension !== ".app") {
    throw new ActionableError(
      `installApp on watchOS needs a .app bundle built for the watchOS simulator; ` +
        `'${extension || artifactPath}' is not supported (.ipa, .apk, .apks and .aab are not).`,
    );
  }
}

/**
 * installApp, uninstallApp and the installed-app listing for an Apple Watch simulator (#14908),
 * over `simctl install|uninstall|listapps` on the watch's own UDID. No CtrlProxy, adb or devicectl
 * step runs, and every Android-only option is refused by name instead of being ignored.
 */
export class WatchAppManager {
  private readonly simctl: WatchAppsSimctl;
  private readonly plist: WatchBundleIdReader;
  /** The daemon chdirs at startup, so a relative path names the directory it was launched in. */
  private readonly resolveArtifactPath: (artifactPath: string) => string;
  private readonly dataWipe: WatchDataWipe;

  constructor(
    private readonly device: BootedDevice,
    {
      simctl = new SimCtlClient(device),
      plist = new PlistClient(),
      resolveArtifactPath = (artifactPath) =>
        resolvePathFromDaemonLaunchWorkingDirectory(artifactPath),
      dataWipe = {},
    }: {
      simctl?: WatchAppsSimctl;
      plist?: WatchBundleIdReader;
      resolveArtifactPath?: (artifactPath: string) => string;
      dataWipe?: WatchDataWipe;
    } = {},
  ) {
    this.simctl = simctl;
    this.plist = plist;
    this.resolveArtifactPath = resolveArtifactPath;
    this.dataWipe = dataWipe;
  }

  async install(artifactPath: string, call: InstallAppCall = {}): Promise<InstallAppResult> {
    const unsupported = androidOnlyInstallOptions(call);
    if (unsupported.length > 0) {
      throw new ActionableError(
        `installApp on watchOS does not support: ${unsupported.join(", ")} (Android only).`,
      );
    }
    assertAppBundle(artifactPath);
    const appPath = this.resolveArtifactPath(artifactPath);
    const bundleId = await this.readBundleId(appPath, call.signal);
    const upgrade = await this.isInstalled(bundleId, call.signal);
    call.signal?.throwIfAborted();
    await this.simctl.installApp(appPath, this.device.deviceId, { signal: call.signal });
    return { success: true, artifactPath: appPath, packageName: bundleId, upgrade };
  }

  async uninstall(appId: string, call: UninstallAppCall = {}): Promise<UninstallAppResult> {
    if (call.keepData) {
      throw new ActionableError(
        "uninstallApp on watchOS cannot keep app data: simctl uninstall always removes it. " +
          "Omit keepData or pass keepData: false.",
      );
    }
    const unsupported = [
      ...(call.guard ? ["expectedSigningSha256"] : []),
      ...(call.userId === undefined ? [] : ["userId"]),
    ];
    if (unsupported.length > 0) {
      throw new ActionableError(
        `uninstallApp on watchOS does not support: ${unsupported.join(", ")} (Android only).`,
      );
    }
    const wasInstalled = await this.isInstalled(appId, call.signal);
    if (wasInstalled) {
      call.signal?.throwIfAborted();
      await this.simctl.uninstallApp(appId, this.device.deviceId, { signal: call.signal });
    }
    return { success: true, packageName: appId, keepData: false, wasInstalled };
  }

  /**
   * `simctl launch` on the watch. coldBoot stops a running process first; clearAppData stops it
   * and wipes the app's data container (Documents, Library, tmp) on this watch, and a failed
   * wipe launches nothing. Android-only options are refused by name.
   */
  async launch(appId: string, call: LaunchAppCall): Promise<LaunchAppResult> {
    const unsupported = androidOnlyLaunchOptions(call);
    if (unsupported.length > 0) {
      throw new ActionableError(
        `launchApp on watchOS does not support: ${unsupported.join(", ")} (Android only).`,
      );
    }
    if (!(await this.isInstalled(appId, call.signal))) {
      return { success: false, packageName: appId, error: PACKAGE_NOT_INSTALLED_ERROR };
    }
    call.signal?.throwIfAborted();
    const prepared = await this.prepareLaunch(appId, call);
    if (prepared) {
      return prepared;
    }
    call.signal?.throwIfAborted();
    const launched = await this.simctl.launchApp(
      appId,
      { launchArguments: call.launchArguments },
      this.device.deviceId,
    );
    return launched.success
      ? { success: true, packageName: appId, pid: launched.pid }
      : { success: false, packageName: appId, error: launched.error };
  }

  /** `simctl terminate` on the watch; an app with no running process is already terminated. */
  async terminate(appId: string, call: { signal?: AbortSignal } = {}): Promise<TerminateAppResult> {
    if (!(await this.isInstalled(appId, call.signal))) {
      return {
        success: true,
        packageName: appId,
        wasInstalled: false,
        wasRunning: false,
        wasForeground: false,
      };
    }
    call.signal?.throwIfAborted();
    try {
      await this.simctl.terminateApp(appId, this.device.deviceId, { signal: call.signal });
      return { success: true, packageName: appId, wasInstalled: true, wasRunning: true };
    } catch (error) {
      const message = errorMessage(error);
      if (isProcessAlreadyGoneError(message)) {
        return {
          success: true,
          packageName: appId,
          wasInstalled: true,
          wasRunning: false,
          wasForeground: false,
        };
      }
      logger.warn(
        `[watchOS] simctl terminate ${appId} on ${this.device.deviceId} failed: ${message}`,
      );
      return { success: false, packageName: appId, error: message };
    }
  }

  /** Runs clearAppData or coldBoot before a launch; a failed result stops the launch. */
  private async prepareLaunch(
    appId: string,
    call: LaunchAppCall,
  ): Promise<LaunchAppResult | undefined> {
    if (!call.clearAppData && !call.coldBoot) {
      return undefined;
    }
    const deviceId = this.device.deviceId;
    // Both need the old process gone: a wipe under a running app, or a "cold" launch that reuses
    // it, would be wrong. Only an already-gone process is tolerated; any other failure stops here.
    const stopError = await this.stopForLaunch(appId);
    if (stopError) {
      return {
        success: false,
        packageName: appId,
        error: `Could not stop ${appId} on watch ${deviceId} before launching: ${stopError}`,
      };
    }
    if (!call.clearAppData) {
      return undefined;
    }
    const cleared = await new SimulatorIosClearDataBackend(deviceId, {
      ...this.dataWipe,
      simctl: this.simctl,
    }).clearAppData(appId, call.signal);
    return cleared.success
      ? undefined
      : {
          success: false,
          packageName: appId,
          error: `Could not clear app data for ${appId} on watch ${deviceId}: ${cleared.error}`,
        };
  }

  /** `simctl terminate`; undefined when the app stopped or was already gone, else the failure. */
  private async stopForLaunch(appId: string): Promise<string | undefined> {
    try {
      await this.simctl.terminateApp(appId, this.device.deviceId);
      return undefined;
    } catch (error) {
      const message = errorMessage(error);
      if (isProcessAlreadyGoneError(message)) {
        return undefined;
      }
      logger.warn(`[watchOS] Could not stop ${appId} on ${this.device.deviceId}: ${message}`);
      return message;
    }
  }

  /** The raw `simctl listapps` records for the watch; a failed listing throws. */
  listRecords(signal?: AbortSignal): Promise<IosInstalledAppRecord[]> {
    return this.simctl.listAppsOrThrow(this.device.deviceId, { signal });
  }

  private async isInstalled(bundleId: string, signal?: AbortSignal): Promise<boolean> {
    const records = await this.listRecords(signal);
    return records.some((record) => getIosInstalledAppBundleId(record) === bundleId);
  }

  private async readBundleId(appPath: string, signal?: AbortSignal): Promise<string> {
    let bundleId = "";
    try {
      bundleId = (
        await this.plist.extractRawFile(
          "CFBundleIdentifier",
          path.posix.join(appPath, "Info.plist"),
          {
            signal,
          },
        )
      ).trim();
    } catch (error) {
      throw toActionableError(error, `Could not read CFBundleIdentifier from ${appPath}`);
    }
    if (!bundleId) {
      throw new ActionableError(`${appPath}/Info.plist has no CFBundleIdentifier.`);
    }
    return bundleId;
  }
}
