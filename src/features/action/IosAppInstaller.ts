import AdmZip from "adm-zip";
import path from "path";
import type { BootedDevice } from "../../models";
import { ActionableError } from "../../models/ActionableError";
import { runWithAbortSignal } from "../../utils/AbortContext";
import type { PerformanceTracker } from "../../utils/PerformanceTracker";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import { OPERATION_CANCELLED_MESSAGE } from "../../utils/constants";
import { errorMessage } from "../../utils/describeUnknownError";
import { DeviceAppManager } from "../../utils/ios-cmdline-tools/DeviceAppManager";
import {
  resolveIosDowngradeRecoveryBackend,
  resolveIosInstallBackend,
  type IosInstallBackend,
} from "../../utils/ios-cmdline-tools/IosDeviceBackend";
import { PlistClient, type PlistReader } from "../../utils/ios-cmdline-tools/PlistClient";
import { SimCtlClient } from "../../utils/ios-cmdline-tools/SimCtlClient";
import { getIosInstalledAppBundleId } from "../../utils/ios-cmdline-tools/iosInstalledApp";
import { logger } from "../../utils/logger";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import type { IosPhysicalAppLister } from "../observe/ListInstalledApps";
import type { DeviceAppInstaller, InstallAppOptions } from "./InstallApp";
import { diffInstalledPackages, extractInstallErrorText } from "./installAppParsing";
import { IOS_SIMULATOR_DOWNGRADE_REINSTALL_TIMEOUT_MS } from "./installAppTimeout";

// Preserve the existing verification bounds for simulator and physical installs.
export const IOS_INSTALL_VERIFY_ATTEMPTS = 2;
export const IOS_PHYSICAL_VERIFY_ATTEMPTS = 3;
const IOS_PHYSICAL_VERIFY_TIMEOUT_MS = 10_000;
const IOS_PHYSICAL_VERIFY_RETRY_DELAY_MS = 200;

/** Installs and verifies iOS artifacts using the injected platform backends. */
export class IosAppInstaller {
  private readonly simctl: NonNullable<InstallAppOptions["simctl"]>;
  private readonly deviceAppInstaller: DeviceAppInstaller;
  private readonly physicalAppLister?: IosPhysicalAppLister;
  private readonly timer?: Timer;
  private readonly plist: PlistReader;
  private readonly iosInstallBackendResolver?: typeof resolveIosInstallBackend;
  private readonly iosDowngradeRecoveryBackendResolver: typeof resolveIosDowngradeRecoveryBackend;
  constructor(
    private readonly device: BootedDevice,
    options: InstallAppOptions,
    private readonly invalidateCache: () => void,
    private readonly markCacheStale: (success: boolean) => Promise<void>,
  ) {
    this.simctl = options.simctl ?? new SimCtlClient(device);
    this.deviceAppInstaller = options.deviceAppInstaller ?? new DeviceAppManager();
    this.physicalAppLister = options.physicalAppLister;
    this.timer = options.timer;
    this.plist = options.plist ?? new PlistClient();
    this.iosInstallBackendResolver = options.iosInstallBackendResolver;
    this.iosDowngradeRecoveryBackendResolver =
      options.iosDowngradeRecoveryBackendResolver ?? resolveIosDowngradeRecoveryBackend;
  }

  getIosInstallBackend(): IosInstallBackend {
    return (this.iosInstallBackendResolver ?? resolveIosInstallBackend)(this.device.deviceId, {
      simctl: this.simctl,
      deviceAppInstaller: this.deviceAppInstaller,
      physicalAppLister: {
        listInstalledApps: (deviceId) =>
          (this.physicalAppLister ?? new DeviceAppManager()).listInstalledApps(deviceId),
      },
    });
  }

  /**
   * The part of an iOS install failure that the tool itself printed, for classification only.
   * The rejection's `message` is `Command failed: <argv>` plus stderr, and the argv carries the
   * user's artifact path, so searching it would match a path such as `build/downgrade-test/`.
   * Prefer stderr/stdout (walking `cause` for wrapped errors); when none is attached, drop the
   * command line from the message. Either way the artifact path (and its basename) is removed,
   * because the tool may echo it in its own output.
   */
  private iosToolOutput(error: unknown, artifactPath: string): string {
    let current: unknown = error;
    for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
      const details = {
        stderr: "stderr" in current ? current.stderr : undefined,
        stdout: "stdout" in current ? current.stdout : undefined,
      };
      const streams = [details.stderr, details.stdout].filter(
        (value): value is string => typeof value === "string" && value.length > 0,
      );
      if (streams.length > 0) {
        return this.withoutArtifactPath(streams.join("\n"), artifactPath);
      }
      current = current.cause;
    }
    return this.withoutArtifactPath(
      errorMessage(error)
        .split("\n")
        .filter((line) => !line.includes("Command failed:"))
        .join("\n"),
      artifactPath,
    );
  }

  /** Remove the artifact path, and its basename, so a tool that echoes either cannot match a keyword. */
  private withoutArtifactPath(text: string, artifactPath: string): string {
    const withoutPath = text.split(artifactPath).join("");
    const base = path.basename(artifactPath);
    return base.length > 0 ? withoutPath.split(base).join("") : withoutPath;
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

  /** Read CFBundleIdentifier from a simulator .app or physical-device .ipa. */
  async resolveAppBundleId(appPath: string): Promise<string | undefined> {
    try {
      if (path.extname(appPath).toLowerCase() === ".ipa") {
        return await this.resolveIpaBundleId(appPath);
      }
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

  private async resolveIpaBundleId(ipaPath: string): Promise<string | undefined> {
    const infoPlists = new AdmZip(ipaPath)
      .getEntries()
      .filter((entry) => /^Payload\/[^/]+\.app\/Info\.plist$/.test(entry.entryName));
    if (infoPlists.length !== 1) {
      return undefined;
    }
    const plist = await this.plist.readJsonBytes(infoPlists[0].getData());
    if (!plist || typeof plist !== "object" || Array.isArray(plist)) {
      return undefined;
    }
    const bundleId = "CFBundleIdentifier" in plist ? plist.CFBundleIdentifier : undefined;
    return typeof bundleId === "string" ? bundleId.trim() || undefined : undefined;
  }

  validateiOSArtifact(ext: string, backend: IosInstallBackend): void {
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

  async executeiOSSimulator(
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
        logger.warn(`[InstallApp] Baseline app listing failed: ${errorMessage(error)}`, error);
        // One immediate retry handles a transient baseline listing error without adding timer DI.
      }
    }
    if (!beforeApps) {
      throw beforeError;
    }
    const beforeBundleIds = this.extractBundleIds(beforeApps);

    const downgraded = await perf.track("simctlInstall", () =>
      this.installiOSSimulatorWithDowngradeRecovery(appPath, backend, signal),
    );

    this.invalidateCache();
    await this.markCacheStale(true);

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
    const afterBundleIds = this.extractBundleIds(afterApps);

    const newBundles = diffInstalledPackages(beforeBundleIds, afterBundleIds);
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
    let packageName = this.findBundleIdByPath(afterApps, appPath);
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
      await backend.installApp(appPath, { signal });
      return false;
    } catch (error) {
      const text = extractInstallErrorText(error);
      if (!this.isiOSDowngradeError(this.iosToolOutput(error, appPath))) {
        throw error;
      }
      const recoveryBackend = this.iosDowngradeRecoveryBackendResolver(this.device.deviceId, {
        simctl: this.simctl,
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
      this.invalidateCache();
      await this.markCacheStale(true);
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
            timer: this.timer ?? defaultTimer,
            timeoutMs: IOS_SIMULATOR_DOWNGRADE_REINSTALL_TIMEOUT_MS,
            label: "iOS downgrade reinstall",
          },
        ),
      );
    } catch (error) {
      // A failed must-finish reinstall must disclose the already completed uninstall.
      throw new ActionableError(
        `The previous version of ${bundleId} was uninstalled during downgrade recovery (the installed version was newer than the artifact); the simulator now has no copy of the app; the app is not installed. ${extractInstallErrorText(error)}`,
        { cause: error },
      );
    }
  }

  async executeiOSPhysical(
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
      this.invalidateCache();
      await this.markCacheStale(true);
    } catch (error) {
      const text = extractInstallErrorText(error);
      if (this.isiOSDowngradeError(this.iosToolOutput(error, ipaPath))) {
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

    const timer = this.timer ?? defaultTimer;
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
