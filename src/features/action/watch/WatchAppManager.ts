import path from "path";
import type { BootedDevice, InstallAppResult } from "../../../models";
import { ActionableError, toActionableError } from "../../../models/ActionableError";
import type { UninstallAppResult } from "../../../models/UninstallAppResult";
import { resolvePathFromDaemonLaunchWorkingDirectory } from "../../../utils/workingDirectory";
import { PlistClient, type PlistReader } from "../../../utils/ios-cmdline-tools/PlistClient";
import { SimCtlClient } from "../../../utils/ios-cmdline-tools/SimCtlClient";
import {
  getIosInstalledAppBundleId,
  type IosInstalledAppRecord,
} from "../../../utils/ios-cmdline-tools/iosInstalledApp";
import type { InstallAppCall } from "../InstallAppTypes";
import type { UninstallAppCall } from "../UninstallApp";

/** The simctl calls a watch app manager makes; nothing else on the client is reachable. */
export type WatchAppsSimctl = Pick<SimCtlClient, "installApp" | "uninstallApp" | "listAppsOrThrow">;

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
  constructor(
    private readonly device: BootedDevice,
    private readonly simctl: WatchAppsSimctl = new SimCtlClient(device),
    private readonly plist: WatchBundleIdReader = new PlistClient(),
    /** The daemon chdirs at startup, so a relative path names the directory it was launched in. */
    private readonly resolveArtifactPath: (artifactPath: string) => string = (artifactPath) =>
      resolvePathFromDaemonLaunchWorkingDirectory(artifactPath),
  ) {}

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
    if (call.guard || call.userId !== undefined) {
      throw new ActionableError(
        `uninstallApp on watchOS does not support: ${call.guard ? "expectedSigningSha256" : "userId"} (Android only).`,
      );
    }
    const wasInstalled = await this.isInstalled(appId, call.signal);
    if (wasInstalled) {
      call.signal?.throwIfAborted();
      await this.simctl.uninstallApp(appId, this.device.deviceId, { signal: call.signal });
    }
    return { success: true, packageName: appId, keepData: false, wasInstalled };
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
