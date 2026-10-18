import { errorMessage } from "../../utils/describeUnknownError";
import path from "path";
import AdmZip from "adm-zip";
import { BootedDevice } from "../../models";
import { ActionableError } from "../../models/ActionableError";
import { type PerformanceTracker } from "../../utils/PerformanceTracker";
import { runWithAbortSignal } from "../../utils/AbortContext";
import { OPERATION_CANCELLED_MESSAGE } from "../../utils/constants";
import { SimCtlClient } from "../../utils/ios-cmdline-tools/SimCtlClient";
import { logger } from "../../utils/logger";
import { type PlistReader } from "../../utils/ios-cmdline-tools/PlistClient";
import { getIosInstalledAppBundleId } from "../../utils/ios-cmdline-tools/iosInstalledApp";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import {
  resolveIosDowngradeRecoveryBackend,
  type IosInstallBackend,
} from "../../utils/ios-cmdline-tools/IosDeviceBackend";

import { IOS_SIMULATOR_DOWNGRADE_REINSTALL_TIMEOUT_MS } from "./installAppTimeout";

import {
  extractErrorText,
  iosToolOutput,
  isiOSDowngradeError,
  diffSets,
  extractBundleIds,
  findBundleIdByPath,
} from "./installAppParsing";

// Two reads preserve the existing iOS install verification bound.
export const IOS_INSTALL_VERIFY_ATTEMPTS = 2;
// Three attempts preserve the existing physical install verification bound.
export const IOS_PHYSICAL_VERIFY_ATTEMPTS = 3;

const IOS_PHYSICAL_VERIFY_TIMEOUT_MS = 10_000;
const IOS_PHYSICAL_VERIFY_RETRY_DELAY_MS = 200;

export interface IosAppInstallerDependencies {
  readonly device: BootedDevice;
  readonly simctl: SimCtlClient;
  readonly plist: PlistReader;
  readonly timer?: Timer;
  readonly downgradeRecoveryBackendResolver: typeof resolveIosDowngradeRecoveryBackend;
  /** Invalidate device-window and installed-apps caches after the installed set changed. */
  readonly onAppsChanged: () => Promise<void>;
}

/** iOS simulator (.app) and physical-device (.ipa) install flows behind {@link InstallApp}. */
export class IosAppInstaller {
  private readonly device: BootedDevice;

  constructor(private readonly deps: IosAppInstallerDependencies) {
    this.device = deps.device;
  }

  private onAppsChanged(): Promise<void> {
    return this.deps.onAppsChanged();
  }

  /** Read CFBundleIdentifier from a simulator .app or physical-device .ipa. */
  private async resolveAppBundleId(appPath: string): Promise<string | undefined> {
    try {
      if (path.extname(appPath).toLowerCase() === ".ipa") {
        return await this.resolveIpaBundleId(appPath);
      }
      const bundleId = (
        await this.deps.plist.extractRawFile("CFBundleIdentifier", path.join(appPath, "Info.plist"))
      ).trim();
      return bundleId || undefined;
    } catch (error) {
      logger.warn(
        `[InstallApp] Failed to read bundle identifier from ${appPath}: ${errorMessage(error)}`,
      );
      return undefined;
    }
  }

  private async resolveIpaBundleId(ipaPath: string): Promise<string | undefined> {
    const infoPlists = new AdmZip(ipaPath)
      .getEntries()
      .filter((entry) => /^Payload\/[^/]+\.app\/Info\.plist$/.test(entry.entryName));
    if (infoPlists.length !== 1) {
      return undefined;
    }
    const plist = await this.deps.plist.readJsonBytes(infoPlists[0].getData());
    if (!plist || typeof plist !== "object" || Array.isArray(plist)) {
      return undefined;
    }
    const bundleId = (plist as Record<string, unknown>).CFBundleIdentifier;
    return typeof bundleId === "string" ? bundleId.trim() || undefined : undefined;
  }

  validateArtifact(ext: string, backend: IosInstallBackend): void {
    const isSimulator = backend.kind === "simulator";
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

  async executeSimulator(
    appPath: string,
    perf: PerformanceTracker,
    backend: IosInstallBackend,
    signal?: AbortSignal,
  ): Promise<{ success: boolean; upgrade: boolean; packageName?: string; warning?: string }> {
    if (signal?.aborted) {
      throw new Error(OPERATION_CANCELLED_MESSAGE);
    }

    let beforeApps: any[] | undefined;
    let beforeError: unknown;
    for (let attempt = 1; attempt <= IOS_INSTALL_VERIFY_ATTEMPTS; attempt += 1) {
      try {
        beforeApps = await perf.track("listAppsBefore", () => backend.listApps());
        break;
      } catch (error) {
        beforeError = error;
        // One immediate retry handles a transient baseline listing error without adding timer DI.
      }
    }
    if (!beforeApps) {
      throw beforeError;
    }
    const beforeBundleIds = extractBundleIds(beforeApps);

    const downgraded = await perf.track("simctlInstall", () =>
      this.installiOSSimulatorWithDowngradeRecovery(appPath, backend, signal),
    );

    await this.onAppsChanged();

    if (signal?.aborted) {
      throw new Error(OPERATION_CANCELLED_MESSAGE);
    }

    let afterApps: any[] = [];
    let postListingWarning: string | undefined;
    try {
      afterApps = await perf.track("listAppsAfter", () => backend.listApps());
    } catch (error) {
      postListingWarning = `Could not verify installed bundle: ${errorMessage(error)}`;
      logger.warn(`[InstallApp] ${postListingWarning}`, error);
    }
    const afterBundleIds = extractBundleIds(afterApps);

    const newBundles = diffSets(beforeBundleIds, afterBundleIds);
    const packageName = await this.resolveInstalledIosSimulatorBundle(
      appPath,
      perf,
      afterApps,
      afterBundleIds,
      newBundles,
      postListingWarning,
    );
    const warnings = this.iosSimulatorInstallWarnings(
      postListingWarning,
      downgraded,
      packageName,
      newBundles,
    );

    const upgrade = downgraded ? false : packageName ? beforeBundleIds.has(packageName) : false;

    return {
      success: true,
      upgrade,
      packageName,
      warning: warnings.length > 0 ? warnings.join(" ") : undefined,
    };
  }

  private async resolveInstalledIosSimulatorBundle(
    appPath: string,
    perf: PerformanceTracker,
    afterApps: any[],
    afterBundleIds: Set<string>,
    newBundles: string[],
    postListingWarning?: string,
  ): Promise<string | undefined> {
    let packageName = findBundleIdByPath(afterApps, appPath);
    if (!packageName && newBundles.length === 1) {
      packageName = newBundles[0];
    }

    if (!packageName && !postListingWarning) {
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

    return packageName;
  }

  private iosSimulatorInstallWarnings(
    postListingWarning: string | undefined,
    downgraded: boolean,
    packageName: string | undefined,
    newBundles: string[],
  ): string[] {
    const warnings: string[] = [];

    if (postListingWarning) {
      warnings.push(postListingWarning);
    }

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

    return warnings;
  }

  /**
   * Install on an iOS simulator, recovering from a version-downgrade rejection
   * by uninstalling the existing (newer) app and reinstalling the artifact.
   * Returns true if a downgrade recovery was performed.
   */
  private async installiOSSimulatorWithDowngradeRecovery(
    appPath: string,
    backend: IosInstallBackend,
    signal?: AbortSignal,
  ): Promise<boolean> {
    try {
      await backend.installApp(appPath);
      return false;
    } catch (error) {
      const text = extractErrorText(error);
      if (!isiOSDowngradeError(iosToolOutput(error, appPath))) {
        throw error;
      }
      const recoveryBackend = this.deps.downgradeRecoveryBackendResolver(this.device.deviceId, {
        simctl: this.deps.simctl,
      });
      if (!recoveryBackend) {
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
        await recoveryBackend.terminateApp(bundleId);
      } catch (terminateError) {
        // Best-effort terminate; proceed with uninstall regardless.
        logger.debug(
          `[InstallApp] Best-effort terminate before downgrade recovery failed`,
          terminateError,
        );
      }
      // Bounded and cancellable: a cancel before this dispatches leaves the app installed. Once it
      // has returned, the reinstall below is not abandoned by a cancel (issue #10073).
      await recoveryBackend.uninstallApp(bundleId, signal);
      await this.onAppsChanged();
      await this.reinstallAfterIosDowngradeUninstall(appPath, bundleId, backend);
      return true;
    }
  }

  /** Once the uninstall has succeeded, finish the reinstall even if the request is cancelled. */
  private async reinstallAfterIosDowngradeUninstall(
    appPath: string,
    bundleId: string,
    backend: IosInstallBackend,
  ): Promise<void> {
    try {
      // Escape the ambient abort (simctl reads it) while keeping the step deadline.
      // The explicit timeout also reaches simctl: with no ambient signal it would otherwise fall
      // back to the client's 60 s default and kill the child before this 120 s budget could fire.
      await runWithAbortSignal(undefined, () =>
        raceWithDeadline(
          () =>
            backend.installApp(appPath, {
              timeoutMs: IOS_SIMULATOR_DOWNGRADE_REINSTALL_TIMEOUT_MS,
            }),
          {
            timer: this.deps.timer ?? defaultTimer,
            timeoutMs: IOS_SIMULATOR_DOWNGRADE_REINSTALL_TIMEOUT_MS,
            label: "iOS downgrade reinstall",
          },
        ),
      );
    } catch (error) {
      // A failed must-finish reinstall must disclose the already completed uninstall.
      throw new ActionableError(
        `The previous version of ${bundleId} was uninstalled during downgrade recovery (the installed version was newer than the artifact); the simulator now has no copy of the app; the app is not installed. ${extractErrorText(error)}`,
        { cause: error },
      );
    }
  }

  async executePhysical(
    ipaPath: string,
    perf: PerformanceTracker,
    backend: IosInstallBackend,
    signal?: AbortSignal,
  ): Promise<{ success: boolean; upgrade: boolean; packageName?: string; warning?: string }> {
    if (signal?.aborted) {
      throw new Error(OPERATION_CANCELLED_MESSAGE);
    }

    try {
      await perf.track("devicectlInstall", () => backend.installApp(ipaPath));
      await this.onAppsChanged();
    } catch (error) {
      const text = extractErrorText(error);
      if (isiOSDowngradeError(iosToolOutput(error, ipaPath))) {
        // devicectl has no downgrade flag, so guide the user to uninstall first.
        throw new Error(
          `Install failed because a newer version is already installed on the device. ` +
            `Uninstall the app first with uninstallApp, then reinstall. Original error: ${text}`,
        );
      }
      throw error;
    }

    const bundleId = await perf.track("resolveBundleId", () => this.resolveAppBundleId(ipaPath));
    if (!bundleId) {
      return {
        success: true,
        upgrade: false,
        warning: "Could not determine the bundle ID from the .ipa; installation was not verified.",
      };
    }

    const timer = this.deps.timer ?? defaultTimer;
    let bundlePresent: boolean;
    try {
      bundlePresent = await perf.track("verifyPhysicalInstall", () =>
        raceWithDeadline(
          async () => {
            for (let attempt = 0; attempt < IOS_PHYSICAL_VERIFY_ATTEMPTS; attempt += 1) {
              if (signal?.aborted) {
                throw new Error(OPERATION_CANCELLED_MESSAGE);
              }
              const apps = await backend.listApps();
              if (apps.some((app) => getIosInstalledAppBundleId(app) === bundleId)) {
                return true;
              }
              if (attempt < IOS_PHYSICAL_VERIFY_ATTEMPTS - 1) {
                await timer.sleep(IOS_PHYSICAL_VERIFY_RETRY_DELAY_MS);
              }
            }
            return false;
          },
          {
            timer,
            timeoutMs: IOS_PHYSICAL_VERIFY_TIMEOUT_MS,
            signal,
            label: `Verification of ${bundleId} on physical iOS device`,
          },
        ),
      );
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
      logger.warn(`[InstallApp] Failed to verify ${bundleId} on ${this.device.deviceId}`, error);
      return {
        success: true,
        upgrade: false,
        packageName: bundleId,
        warning: `Installed, but could not verify the bundle is present: ${errorMessage(error)}`,
      };
    }
    if (!bundlePresent) {
      throw new ActionableError(
        `Install reported success, but bundle ${bundleId} was not present on physical iOS device ${this.device.deviceId} after installation.`,
      );
    }
    return { success: true, upgrade: false, packageName: bundleId };
  }
}
