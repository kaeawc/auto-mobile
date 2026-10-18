import {
  outputLooksLikeShellFailure,
  packageListingContains,
} from "../../utils/android-cmdline-tools/shellOutputHeuristics";
import { errorMessage } from "../../utils/describeUnknownError";
import path from "path";
import {
  AdbClientFactory,
  defaultAdbClientFactory,
} from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { AndroidUserTargetResolver } from "../../utils/android-cmdline-tools/AndroidUserTargetResolver";
import { BootedDevice } from "../../models";
import { ActionableError } from "../../models/ActionableError";
import type { InstallAppResult } from "../../models/InstallAppResult";
import {
  createGlobalPerformanceTracker,
  type PerformanceTracker,
} from "../../utils/PerformanceTracker";
import { hasAmbientPerfTracker, runWithNestedPerfTracker } from "../../utils/PerfContext";
import {
  DefaultHostCommandExecutor,
  type HostCommandExecutor,
} from "../../utils/HostCommandExecutor";
import {
  DefaultAndroidBuildToolsLocator,
  type AndroidBuildToolsLocator,
} from "../../utils/android-cmdline-tools/AndroidBuildToolsLocator";
import { throwIfAborted } from "../../utils/toolUtils";
import { getAbortSignal, runWithAbortSignal } from "../../utils/AbortContext";
import { OPERATION_CANCELLED_MESSAGE } from "../../utils/constants";
import { SimCtlClient } from "../../utils/ios-cmdline-tools/SimCtlClient";
import { DeviceAppManager } from "../../utils/ios-cmdline-tools/DeviceAppManager";
import { AndroidCtrlProxyClient } from "../observe/android";
import { logger } from "../../utils/logger";
import { resolvePathFromDaemonLaunchWorkingDirectory } from "../../utils/workingDirectory";
import { PlistClient, type PlistReader } from "../../utils/ios-cmdline-tools/PlistClient";
import { IOSCtrlProxyClient } from "../observe/ios";
import { shellQuote } from "../../utils/shellQuote";
import { InspectPackageSigning } from "../observe/InspectPackageSigning";
import { checkSigningIdentity, type PackageSigningInspector } from "./SigningIdentityGuard";
import { SigningGuardError } from "../../models/SigningGuardError";
import { withAndroidPackageMutationLock } from "../../utils/androidPackageMutationLock";
import { normalizeSignerSet } from "../../utils/signingIdentity";
import { InstalledAppsRepository, type InstalledAppsStore } from "../../db/installedAppsRepository";
import { getDbWriteBarrier } from "../../db/dbWriteBarrier";
import { getInstalledAppsCacheWriteCoordinator } from "../../db/installedAppsCacheWriteCoordinator";
import type { IosPhysicalAppLister } from "../observe/ListInstalledApps";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import {
  resolveIosInstallBackend,
  resolveIosDowngradeRecoveryBackend,
  type IosInstallBackend,
} from "../../utils/ios-cmdline-tools/IosDeviceBackend";
import {
  DefaultDeviceWindowCacheInvalidator,
  type DeviceWindowCacheInvalidator,
} from "./TerminateApp";

import { ANDROID_PACKAGE_TRANSFER_TIMEOUT_MS } from "./installAppTimeout";
import { AdbCommandTimeoutError } from "../../utils/android-cmdline-tools/AdbClient";
import { adbFailureOutput } from "../../utils/android-cmdline-tools/adbFailureOutput";
import {
  ANDROID_INSTALL_OUTLIVED_WARNING,
  indeterminateAndroidInstallMessage,
  readAndroidPriorPackageState,
  resolveTimedOutAndroidInstall,
  type AndroidPriorPackageState,
  type TimedOutInstallVerdict,
} from "./androidInstallTimeoutRecovery";
import type { ActionCall } from "./ActionCall";

export { ANDROID_PACKAGE_TRANSFER_TIMEOUT_MS } from "./installAppTimeout";

import { IosAppInstaller } from "./IosAppInstaller";
import { diffSets, extractErrorText } from "./installAppParsing";

export { IOS_INSTALL_VERIFY_ATTEMPTS, IOS_PHYSICAL_VERIFY_ATTEMPTS } from "./IosAppInstaller";

interface AndroidInstallAttempt {
  success: boolean;
  output: string;
  /** Only the command's own stdout/stderr; never the echoed command line or APK path. */
  diagnostics: string;
  threw: boolean;
  /** The adb call hit its step budget: the device-side install may still commit. */
  timedOut?: boolean;
  error?: unknown;
}

interface AndroidInstallStepOptions {
  signal?: AbortSignal;
  /** False refuses the uninstall-and-reinstall downgrade recovery. Default true. */
  allowDestructiveRecovery?: boolean;
}

function installStepOptions(
  guard: InstallGuardOptions | undefined,
  signal: AbortSignal | undefined,
): AndroidInstallStepOptions {
  return { signal, allowDestructiveRecovery: guard?.allowDestructiveRecovery !== false };
}

interface AndroidInstallRecovery {
  installAttempt: AndroidInstallAttempt;
  warning?: string;
  /** Downgrade recovery uninstalled the old copy, so the reinstall is effectively fresh. */
  removedPriorCopy?: boolean;
}

interface AndroidPackageUsers {
  installedUserIds: number[];
  warnings: string[];
}

interface AndroidRestoreProgress {
  restoredUserIds: number[];
  unconfirmedUserIds: number[];
  warnings: string[];
}

export interface DeviceAppInstaller {
  installApp(deviceUdid: string, artifactPath: string): Promise<void>;
}

export interface InstallAppOptions {
  hostExecutor?: HostCommandExecutor;
  buildToolsLocator?: AndroidBuildToolsLocator;
  performanceTrackerFactory?: () => PerformanceTracker;
  simctl?: SimCtlClient;
  deviceAppInstaller?: DeviceAppInstaller;
  plist?: PlistReader;
  installedAppsRepository?: InstalledAppsStore;
  physicalAppLister?: IosPhysicalAppLister;
  timer?: Timer;
  iosInstallBackendResolver?: typeof resolveIosInstallBackend;
  iosDowngradeRecoveryBackendResolver?: typeof resolveIosDowngradeRecoveryBackend;
  cacheInvalidator?: DeviceWindowCacheInvalidator;
  signingInspector?: PackageSigningInspector;
}

/** Call context for {@link InstallApp.execute}: the target user and install guard ride beside the signal. */
export interface InstallAppCall extends ActionCall {
  userId?: number;
  guard?: InstallGuardOptions;
}

/** Opt-in Android guards; omitting them keeps the historical install behavior. */
export interface InstallGuardOptions {
  /**
   * Complete signer set (SHA-256 digests) an already installed copy must have before it is
   * replaced. An installed copy with any other signers, or one whose signers cannot be read,
   * refuses the install before it starts. A package that is not installed is not replaced, so
   * it passes.
   */
  expectedSigningSha256?: string[];
  /**
   * False refuses the uninstall-and-reinstall recovery after INSTALL_FAILED_VERSION_DOWNGRADE;
   * the downgrade then fails and the existing package stays installed. Default true.
   */
  allowDestructiveRecovery?: boolean;
}

export class InstallApp {
  private adb: AdbExecutor;
  private adbFactory: AdbClientFactory;
  private signingInspectorOverride?: PackageSigningInspector;
  private hostExecutor: HostCommandExecutor;
  private buildToolsLocator: AndroidBuildToolsLocator;
  private createPerformanceTracker: () => PerformanceTracker;
  private simctl: SimCtlClient;
  private device: BootedDevice;
  private deviceAppInstaller: DeviceAppInstaller;
  private physicalAppLister?: IosPhysicalAppLister;
  private timer?: Timer;
  private plist: PlistReader;
  private readonly iosInstallBackendResolver?: typeof resolveIosInstallBackend;
  private readonly iosDowngradeRecoveryBackendResolver: typeof resolveIosDowngradeRecoveryBackend;
  private cacheInvalidatorOverride?: DeviceWindowCacheInvalidator;
  private installedAppsRepository: InstalledAppsStore = new InstalledAppsRepository();

  constructor(
    device: BootedDevice,
    adbFactory: AdbClientFactory = defaultAdbClientFactory,
    options: InstallAppOptions = {},
  ) {
    const plist = options.plist ?? new PlistClient();
    this.iosInstallBackendResolver = options.iosInstallBackendResolver;
    this.iosDowngradeRecoveryBackendResolver =
      options.iosDowngradeRecoveryBackendResolver ?? resolveIosDowngradeRecoveryBackend;
    this.device = device;
    this.adb = adbFactory.create(device);
    this.adbFactory = adbFactory;
    this.signingInspectorOverride = options.signingInspector;
    this.hostExecutor = options.hostExecutor ?? new DefaultHostCommandExecutor();
    this.buildToolsLocator = options.buildToolsLocator ?? new DefaultAndroidBuildToolsLocator();
    this.createPerformanceTracker =
      options.performanceTrackerFactory ?? createGlobalPerformanceTracker;
    this.simctl = options.simctl ?? new SimCtlClient(device);
    this.deviceAppInstaller = options.deviceAppInstaller ?? new DeviceAppManager();
    this.physicalAppLister = options.physicalAppLister;
    this.timer = options.timer;
    this.plist = plist;
    this.cacheInvalidatorOverride = options.cacheInvalidator;
    this.setInstalledAppsRepository(options.installedAppsRepository);
  }

  private get signingInspector(): PackageSigningInspector {
    return (this.signingInspectorOverride ??= new InspectPackageSigning(
      this.device,
      this.adbFactory,
    ));
  }

  private get cacheInvalidator(): DeviceWindowCacheInvalidator {
    return (this.cacheInvalidatorOverride ??= new DefaultDeviceWindowCacheInvalidator());
  }

  private iosInstaller(): IosAppInstaller {
    return new IosAppInstaller({
      device: this.device,
      simctl: this.simctl,
      plist: this.plist,
      timer: this.timer,
      downgradeRecoveryBackendResolver: this.iosDowngradeRecoveryBackendResolver,
      onAppsChanged: async () => {
        this.cacheInvalidator.invalidate(this.device);
        await this.markInstalledAppsCacheStale(true);
      },
    });
  }

  private getIosInstallBackend(): IosInstallBackend {
    return (this.iosInstallBackendResolver ?? resolveIosInstallBackend)(this.device.deviceId, {
      simctl: this.simctl,
      deviceAppInstaller: this.deviceAppInstaller,
      physicalAppLister: {
        listInstalledApps: (deviceId) =>
          (this.physicalAppLister ?? new DeviceAppManager()).listInstalledApps(deviceId),
      },
    });
  }

  async execute(artifactPath: string, call?: InstallAppCall): Promise<InstallAppResult>;
  /** @deprecated Pass an {@link ActionCall} instead of positional arguments. */
  async execute(
    artifactPath: string,
    userId?: number,
    signal?: AbortSignal,
    guard?: InstallGuardOptions,
  ): Promise<InstallAppResult>;
  async execute(
    artifactPath: string,
    userIdOrCall?: number | InstallAppCall,
    signalArg?: AbortSignal,
    guardArg?: InstallGuardOptions,
  ): Promise<InstallAppResult> {
    const { userId, signal, guard } =
      typeof userIdOrCall === "object"
        ? userIdOrCall
        : { userId: userIdOrCall, signal: signalArg, guard: guardArg };
    const perf = this.createPerformanceTracker();
    const nested = hasAmbientPerfTracker();
    const result = await runWithNestedPerfTracker(perf, () =>
      this.executeInner(artifactPath, userId, perf, signal, guard),
    );
    if (!nested && perf.isEnabled()) {
      const timings = perf.getTimings();
      if (timings) {
        return { ...result, perfTiming: timings };
      }
    }
    return result;
  }

  private async executeInner(
    artifactPath: string,
    userId: number | undefined,
    perf: PerformanceTracker,
    signal?: AbortSignal,
    guard?: InstallGuardOptions,
  ): Promise<InstallAppResult> {
    perf.serial("installApp");

    if (!path.isAbsolute(artifactPath)) {
      artifactPath = resolvePathFromDaemonLaunchWorkingDirectory(artifactPath);
    }

    const ext = path.extname(artifactPath).toLowerCase();

    if (this.device.platform === "ios") {
      if (guard) {
        throw new ActionableError(
          "expectedSigningSha256 and allowDestructiveRecovery are only supported for Android devices",
        );
      }
      const backend = this.getIosInstallBackend();
      this.iosInstaller().validateArtifact(ext, backend);
      if (ext === ".ipa") {
        const result = await perf.track("iOSPhysicalInstall", () =>
          this.iosInstaller().executePhysical(artifactPath, perf, backend, signal),
        );
        if (result.success) {
          IOSCtrlProxyClient.getExistingInstance(this.device.deviceId)?.clearSdkScreenIdentity();
        }
        perf.end();
        return { ...result, userId: 0 };
      }
      const result = await perf.track("iOSInstall", () =>
        this.iosInstaller().executeSimulator(artifactPath, perf, backend, signal),
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

    return withAndroidPackageMutationLock(this.device.deviceId, signal, () =>
      this.executeAndroid(artifactPath, userId, perf, signal, guard),
    );
  }

  private async executeAndroid(
    artifactPath: string,
    userId: number | undefined,
    perf: PerformanceTracker,
    signal?: AbortSignal,
    guard?: InstallGuardOptions,
  ): Promise<InstallAppResult> {
    const preparation = await this.prepareAndroidInstall(artifactPath, userId, perf, signal);
    let { packageName, isInstalled } = preparation;
    const { targetUserId, beforePackages, warnings, prior } = preparation;
    const signingGuard = await this.applySigningGuard(
      guard,
      packageName,
      targetUserId,
      isInstalled,
      signal,
    );

    const installation = await this.installAndroidWithRecovery(
      packageName,
      targetUserId,
      `install --user ${targetUserId} -r "${artifactPath}"`,
      prior,
      perf,
      installStepOptions(guard, signal),
    );
    const installAttempt = installation.installAttempt;
    isInstalled = this.absorbInstallRecovery(installation, warnings, isInstalled);

    // Preserve prior behavior: a hard install failure (non-zero exit) surfaces as a thrown error.
    if (!installAttempt.success && installAttempt.threw && installAttempt.error !== undefined) {
      throw installAttempt.error;
    }

    const success = installAttempt.success;

    if (success) {
      const verification = await this.verifyAndroidInstall(
        packageName,
        beforePackages,
        targetUserId,
        perf,
        signal,
      );
      packageName = verification.packageName;
      if (verification.warning) {
        warnings.push(verification.warning);
      }
      isInstalled = verification.upgrade ?? isInstalled;
    }

    perf.end();
    const warning = warnings.length > 0 ? warnings.join(" ") : undefined;
    return {
      success: success,
      error: success ? undefined : installAttempt.output || undefined,
      upgrade: isInstalled && success,
      userId: targetUserId,
      packageName: packageName,
      warning: warning,
      ...(signingGuard ? { signingGuard } : {}),
    };
  }

  private async applySigningGuard(
    guard: InstallGuardOptions | undefined,
    packageName: string | undefined,
    targetUserId: number,
    isInstalled: boolean,
    signal?: AbortSignal,
  ): Promise<InstallAppResult["signingGuard"]> {
    if (!guard?.expectedSigningSha256) {
      return undefined;
    }
    return this.requireExpectedSigningBeforeReplace(
      packageName,
      targetUserId,
      isInstalled,
      guard.expectedSigningSha256,
      signal,
    );
  }

  /**
   * Opt-in: refuse before installing over a copy that does not carry exactly the expected
   * signers. Evidence is gathered fresh for the user that holds the copy, because the package
   * (and so its signers) is shared by every user.
   */
  private async requireExpectedSigningBeforeReplace(
    packageName: string | undefined,
    targetUserId: number,
    installedForTarget: boolean,
    expectedSha256: string[],
    signal?: AbortSignal,
  ): Promise<NonNullable<InstallAppResult["signingGuard"]>> {
    const expected = normalizeSignerSet(expectedSha256);
    if (!packageName) {
      throw new SigningGuardError(
        "presence-unknown",
        "The package name could not be read from the APK, so an installed copy cannot be checked " +
          "against the expected signing identity",
        { appId: "", userId: targetUserId, expectedSha256: expected },
      );
    }
    let holder: number | undefined = installedForTarget ? targetUserId : undefined;
    if (holder === undefined) {
      const inventory = await this.listAndroidPackageUsers(packageName, targetUserId, signal);
      holder = inventory.installedUserIds[0];
      if (holder === undefined && inventory.warnings.length > 0) {
        throw new SigningGuardError(
          "presence-unknown",
          `Could not confirm that ${packageName} is not installed for other users: ` +
            inventory.warnings.join(" "),
          { appId: packageName, userId: targetUserId, expectedSha256: expected },
        );
      }
    }
    if (holder === undefined) {
      return { status: "no-existing-package" };
    }
    const inspection = await checkSigningIdentity(
      this.signingInspector,
      packageName,
      holder,
      expected,
      signal,
    );
    return inspection.presence === "absent"
      ? { status: "no-existing-package" }
      : { status: "matched", matchedSha256: expected };
  }

  /** Collect the recovery warning; a removed prior copy makes this effectively a fresh install. */
  private absorbInstallRecovery(
    installation: AndroidInstallRecovery,
    warnings: string[],
    isInstalled: boolean,
  ): boolean {
    if (installation.warning) {
      warnings.push(installation.warning);
    }
    return installation.removedPriorCopy ? false : isInstalled;
  }

  private async prepareAndroidInstall(
    artifactPath: string,
    userId: number | undefined,
    perf: PerformanceTracker,
    signal?: AbortSignal,
  ): Promise<{
    packageName?: string;
    isInstalled: boolean;
    targetUserId: number;
    beforePackages: Set<string>;
    warnings: string[];
    prior: AndroidPriorPackageState;
  }> {
    const warnings: string[] = [];

    // Extract package name from APK
    const packageNameResult = await perf.track("extractPackageName", async () => {
      return this.extractPackageName(artifactPath, signal);
    });
    if (packageNameResult.warning) {
      warnings.push(packageNameResult.warning);
    }
    const packageName = packageNameResult.packageName?.trim();

    // Auto-detect target user if not specified. installedOnly makes a reinstall
    // target the user(s) that already have the package; a first install still
    // resolves through the default policy (no running user has it).
    const targetUserId = await perf.track("detectTargetUser", async () => {
      return (
        await new AndroidUserTargetResolver(this.adb).resolve({
          packageName,
          explicitUserId: userId,
          installedOnly: true,
          signal,
        })
      ).userId;
    });

    const isInstalled = packageName
      ? await perf.track("checkInstalled", () =>
          this.isAndroidPackageInstalled(packageName!, targetUserId, signal),
        )
      : false;

    const beforePackages = await perf.track("listPackagesBefore", async () => {
      return this.listPackagesForUser(targetUserId, signal);
    });

    // Only an upgrade needs a version snapshot: if the install later times out, the old
    // copy is listed either way, so presence alone cannot show the new one committed.
    const prior = packageName
      ? await perf.track("readPriorPackageState", () =>
          readAndroidPriorPackageState(this.adb, packageName, isInstalled, signal),
        )
      : { installed: isInstalled };

    return { packageName, isInstalled, targetUserId, beforePackages, warnings, prior };
  }

  private async installAndroidWithRecovery(
    packageName: string | undefined,
    targetUserId: number,
    installArgs: string,
    prior: AndroidPriorPackageState,
    perf: PerformanceTracker,
    { signal, allowDestructiveRecovery = true }: AndroidInstallStepOptions = {},
  ): Promise<AndroidInstallRecovery> {
    const installAttempt = await perf.track("adbInstall", () =>
      this.runAndroidInstall(installArgs, signal),
    );
    if (installAttempt.success) {
      this.cacheInvalidator.invalidate(this.device);
      await this.markInstalledAppsCacheStale(true);
    }
    if (installAttempt.timedOut) {
      return this.recoverTimedOutAndroidInstall(
        installAttempt,
        packageName,
        targetUserId,
        prior,
        signal,
      );
    }
    if (installAttempt.success || !this.isAndroidDowngradeError(installAttempt.diagnostics)) {
      return { installAttempt };
    }
    if (!allowDestructiveRecovery) {
      return {
        installAttempt,
        warning:
          "Downgrade recovery is disabled (allowDestructiveRecovery=false); the existing " +
          "package was left installed.",
      };
    }
    // APK versions are package-wide, so a per-user uninstall cannot enable a downgrade.
    if (!packageName) {
      throw new Error(
        "Install failed because the installed version is newer (INSTALL_FAILED_VERSION_DOWNGRADE), " +
          "but the package name could not be determined in order to uninstall it first.",
      );
    }
    return this.recoverAndroidDowngrade(packageName, targetUserId, installArgs, perf, signal);
  }

  /**
   * A timed-out `adb install` is an unknown outcome, not a failure (the same stance as
   * UninstallApp.recoverTimedOutAndroidUninstall): the host process was killed but the
   * device-side session may still commit. Always stale the cache, then ask the device.
   */
  private async recoverTimedOutAndroidInstall(
    installAttempt: AndroidInstallAttempt,
    packageName: string | undefined,
    targetUserId: number,
    prior: AndroidPriorPackageState,
    signal?: AbortSignal,
  ): Promise<AndroidInstallRecovery> {
    const verdict = await this.resolveTimedOutInstallState(
      packageName,
      targetUserId,
      prior,
      signal,
    );
    if (verdict.outcome === "completed") {
      return {
        installAttempt: { success: true, output: "", diagnostics: "", threw: false },
        warning: ANDROID_INSTALL_OUTLIVED_WARNING,
      };
    }
    return {
      installAttempt: {
        ...installAttempt,
        threw: false,
        output: indeterminateAndroidInstallMessage(packageName, targetUserId, verdict.detail),
      },
    };
  }

  /** Stale the caches around the live read: the device may commit while it is polled. */
  private async resolveTimedOutInstallState(
    packageName: string | undefined,
    targetUserId: number,
    prior: AndroidPriorPackageState,
    signal?: AbortSignal,
  ): Promise<TimedOutInstallVerdict> {
    this.cacheInvalidator.invalidate(this.device);
    await this.markInstalledAppsCacheStale(true);
    try {
      return await resolveTimedOutAndroidInstall({
        adb: this.adb,
        timer: this.timer ?? defaultTimer,
        packageName,
        userId: targetUserId,
        prior,
        signal,
      });
    } finally {
      this.cacheInvalidator.invalidate(this.device);
      await this.markInstalledAppsCacheStale(true);
    }
  }

  private async isAndroidPackageInstalled(
    packageName: string,
    userId: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    try {
      const a11y = AndroidCtrlProxyClient.getInstance(this.device);
      const result = await a11y.requestInstalledPackages(true, undefined, 3000);
      if (result.success && result.userId === userId) {
        return result.packages.some((p) => p.packageName === packageName);
      }
    } catch (error) {
      // The optional accessibility lookup can be unavailable; ADB supplies the fallback.
      logger.debug(
        `[InstallApp] Accessibility package lookup unavailable: ${errorMessage(error)}`,
        error,
      );
    }
    try {
      const output = await this.adb.executeCommand(`shell pm list packages --user ${userId}`, {
        noRetry: true,
        signal,
      });
      return packageListingContains(output.toString(), packageName);
    } catch (error) {
      logger.warn(`[InstallApp] Package presence query failed: ${errorMessage(error)}`, error);
      return false;
    }
  }

  private async verifyAndroidInstall(
    packageName: string | undefined,
    beforePackages: Set<string>,
    userId: number,
    perf: PerformanceTracker,
    signal?: AbortSignal,
  ): Promise<{ packageName?: string; warning?: string; upgrade?: boolean }> {
    let afterPackages: Set<string>;
    try {
      afterPackages = await perf.track("listPackagesAfter", () =>
        this.listPackagesForUser(userId, signal),
      );
      throwIfAborted(signal);
    } catch (error) {
      if (this.isAndroidCancellation(error, signal)) {
        throw error;
      }
      const warning = `Install completed but could not verify installed package on the device: ${errorMessage(error)}`;
      logger.warn(`[InstallApp] ${warning}`, error);
      // A failed listing is unknown, not an empty package set. Keep only the APK's known ID.
      return { packageName, warning };
    }

    const newPackages = diffSets(beforePackages, afterPackages);
    if (packageName && !afterPackages.has(packageName)) {
      const devicePackageName =
        newPackages.length > 0 ? newPackages.join(", ") : "no installed package";
      throw new ActionableError(
        `APK package name mismatch: aapt reported "${packageName}", but the device reported "${devicePackageName}" after installation. Verify the APK manifest application ID and install the matching APK.`,
      );
    }
    if (packageName) {
      return { packageName };
    }
    if (newPackages.length === 1) {
      return { packageName: newPackages[0] };
    }
    if (newPackages.length > 1) {
      return {
        warning:
          "Installed APK but multiple new packages were detected; unable to determine the package name reliably.",
      };
    }
    return {
      warning:
        "Installed APK but package name could not be determined from the device package list.",
      upgrade: true,
    };
  }

  private async listAndroidPackageUsers(
    packageName: string,
    targetUserId: number,
    signal?: AbortSignal,
  ): Promise<AndroidPackageUsers> {
    const users = await this.adb.listUsers(signal);
    throwIfAborted(signal);
    if (users.length === 0) {
      const warning =
        "Other users could not be checked and may have lost the app during downgrade recovery.";
      logger.warn(`[InstallApp] ${warning}`);
      return { installedUserIds: [targetUserId], warnings: [warning] };
    }
    const inventory: AndroidPackageUsers = { installedUserIds: [], warnings: [] };
    // Include stopped users: a package-wide uninstall removes their app and data too.
    for (const { userId } of users) {
      await this.checkAndroidPackageUser(packageName, userId, inventory, signal);
    }
    inventory.installedUserIds.sort((a, b) => a - b);
    return inventory;
  }

  private async checkAndroidPackageUser(
    packageName: string,
    userId: number,
    inventory: AndroidPackageUsers,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      const packages = await this.listPackagesForUser(userId, signal);
      throwIfAborted(signal);
      if (packages.has(packageName)) {
        inventory.installedUserIds.push(userId);
      }
    } catch (error) {
      if (this.isAndroidCancellation(error, signal)) {
        throw error;
      }
      const warning = `User ${userId} could not be checked and may have lost the app during downgrade recovery: ${errorMessage(error)}`;
      logger.warn(`[InstallApp] ${warning}`, error);
      inventory.warnings.push(warning);
    }
  }

  private async recoverAndroidDowngrade(
    packageName: string,
    targetUserId: number,
    installArgs: string,
    perf: PerformanceTracker,
    signal?: AbortSignal,
  ): Promise<AndroidInstallRecovery> {
    const inventory = await this.listAndroidPackageUsers(packageName, targetUserId, signal);
    const { installedUserIds } = inventory;
    logger.warn(
      `[InstallApp] Version downgrade detected for ${packageName}; uninstalling existing version and reinstalling.`,
    );
    await perf.track("downgradeUninstall", () =>
      this.uninstallAndroidForDowngrade(packageName, targetUserId, signal),
    );
    this.cacheInvalidator.invalidate(this.device);
    await this.markInstalledAppsCacheStale(true);
    const removedUsers =
      installedUserIds.length > 0 ? ` (removed for users: ${installedUserIds.join(", ")})` : "";
    const uninstallNotice = `The previous version of ${packageName} was uninstalled during downgrade recovery (INSTALL_FAILED_VERSION_DOWNGRADE); the device now has no copy of the app${removedUsers}`;
    const failureContext = [
      `${uninstallNotice}; the app is not installed.`,
      ...inventory.warnings,
    ].join(" ");
    let installAttempt: AndroidInstallAttempt;
    try {
      // Once removal succeeds, finish reinstalling even if the request is cancelled.
      // Escape both explicit and ambient aborts while retaining the ADB step deadline.
      installAttempt = await runWithAbortSignal(undefined, () =>
        raceWithDeadline(
          () => perf.track("adbReinstall", () => this.runAndroidInstall(installArgs)),
          {
            timer: this.timer ?? defaultTimer,
            timeoutMs: ANDROID_PACKAGE_TRANSFER_TIMEOUT_MS,
            label: "Android downgrade reinstall",
            timeoutError: () =>
              new AdbCommandTimeoutError(
                `Android downgrade reinstall timed out after ${ANDROID_PACKAGE_TRANSFER_TIMEOUT_MS}ms`,
              ),
          },
        ),
      );
    } catch (error) {
      if (!(error instanceof AdbCommandTimeoutError)) {
        // A failed must-finish reinstall must disclose the already completed uninstall.
        throw new ActionableError(`${failureContext} ${extractErrorText(error)}`, {
          cause: error,
        });
      }
      installAttempt = {
        success: false,
        output: error.message,
        diagnostics: "",
        threw: true,
        timedOut: true,
        error,
      };
    }
    let outlivedWarning: string | undefined;
    if (installAttempt.timedOut) {
      // The reinstall may still commit on the device, so "not installed" is unverified: ask.
      const verdict = await runWithAbortSignal(undefined, () =>
        this.resolveTimedOutInstallState(packageName, targetUserId, { installed: false }),
      );
      if (verdict.outcome === "indeterminate") {
        throw new ActionableError(
          [
            `${uninstallNotice}.`,
            indeterminateAndroidInstallMessage(packageName, targetUserId, verdict.detail),
            ...inventory.warnings,
          ].join(" "),
          { cause: installAttempt.error },
        );
      }
      outlivedWarning = ANDROID_INSTALL_OUTLIVED_WARNING;
      installAttempt = { success: true, output: "", diagnostics: "", threw: false };
    }
    if (!installAttempt.success) {
      const output = `${failureContext} ${installAttempt.output}`;
      if (installAttempt.threw) {
        throw new ActionableError(output, { cause: installAttempt.error });
      }
      return { installAttempt: { ...installAttempt, output }, removedPriorCopy: true };
    }
    this.cacheInvalidator.invalidate(this.device);
    await this.markInstalledAppsCacheStale(true);
    const restoreWarning = await this.restoreAndroidPackageUsers(
      packageName,
      targetUserId,
      inventory,
      signal,
    );
    const warning = [outlivedWarning, restoreWarning].filter(Boolean).join(" ");
    return { installAttempt, warning, removedPriorCopy: true };
  }

  private async restoreAndroidPackageUsers(
    packageName: string,
    targetUserId: number,
    inventory: AndroidPackageUsers,
    signal?: AbortSignal,
  ): Promise<string> {
    const { installedUserIds } = inventory;
    const progress: AndroidRestoreProgress = {
      restoredUserIds: [],
      unconfirmedUserIds: [],
      warnings: [],
    };
    try {
      signal?.throwIfAborted();
      getAbortSignal()?.throwIfAborted();
      for (const userId of installedUserIds.filter((id) => id !== targetUserId)) {
        signal?.throwIfAborted();
        const restoration = await this.restoreAndroidPackageUser(packageName, userId, signal);
        if (restoration.warning) {
          progress.warnings.push(restoration.warning);
        } else {
          progress.restoredUserIds.push(userId);
        }
      }
      signal?.throwIfAborted();
      await this.confirmAndroidPackageUsers(packageName, progress, signal);
      signal?.throwIfAborted();
    } catch (error) {
      throw this.androidRestoreStoppedError(packageName, targetUserId, inventory, progress, error);
    }
    const originalWarning = `Installed version of ${packageName} was newer than the artifact; uninstalled it and reinstalled the provided version.`;
    if (installedUserIds.every((id) => id === targetUserId)) {
      return [originalWarning, ...inventory.warnings].join(" ");
    }
    const restored = [targetUserId, ...progress.restoredUserIds].sort((a, b) => a - b);
    return [
      originalWarning,
      `App data was lost for users: ${installedUserIds.join(", ")}.`,
      `Package restored for users: ${restored.join(", ")} (app data was not restored).`,
      ...inventory.warnings,
      ...progress.warnings,
    ].join(" ");
  }

  private androidRestoreStoppedError(
    packageName: string,
    targetUserId: number,
    inventory: AndroidPackageUsers,
    progress: AndroidRestoreProgress,
    error: unknown,
  ): ActionableError {
    const notRestored = inventory.installedUserIds.filter(
      (id) =>
        id !== targetUserId &&
        !progress.restoredUserIds.includes(id) &&
        !progress.unconfirmedUserIds.includes(id),
    );
    return new ActionableError(
      [
        `The previous version of ${packageName} was uninstalled during downgrade recovery; the package was reinstalled for target user ${targetUserId}.`,
        progress.restoredUserIds.length > 0
          ? `Package restored for users: ${progress.restoredUserIds.join(", ")} (app data was not restored; restore confirmation may be incomplete).`
          : "No other-user restoration was completed.",
        notRestored.length > 0 ? `Package NOT restored for users: ${notRestored.join(", ")}.` : "",
        ...inventory.warnings,
        ...progress.warnings,
        extractErrorText(error),
      ].join(" "),
      { cause: error },
    );
  }

  private async confirmAndroidPackageUsers(
    packageName: string,
    progress: AndroidRestoreProgress,
    signal?: AbortSignal,
  ): Promise<void> {
    // Confirm only other-user restores; the normal target verification remains unchanged.
    for (const userId of [...progress.restoredUserIds]) {
      signal?.throwIfAborted();
      const confirmation = await this.confirmAndroidPackageUser(packageName, userId, signal);
      if (confirmation.warning) {
        progress.warnings.push(confirmation.warning);
        if (confirmation.unknown) {
          progress.unconfirmedUserIds.push(userId);
        }
        progress.restoredUserIds = progress.restoredUserIds.filter((id) => id !== userId);
      }
    }
  }

  private async confirmAndroidPackageUser(
    packageName: string,
    userId: number,
    signal?: AbortSignal,
  ): Promise<{ warning?: string; unknown?: boolean }> {
    try {
      const packages = await this.listPackagesForUser(userId, signal);
      signal?.throwIfAborted();
      if (packages.has(packageName)) {
        return {};
      }
      const warning = `Package NOT restored for users: ${userId}; the package was absent from the post-restore listing.`;
      logger.warn(`[InstallApp] ${warning}`);
      return { warning };
    } catch (error) {
      if (this.isAndroidCancellation(error, signal)) {
        throw error;
      }
      const warning = `Install completed but could not confirm package restoration for user ${userId}: ${errorMessage(error)}`;
      logger.warn(`[InstallApp] ${warning}`, error);
      return { warning, unknown: true };
    }
  }

  private async restoreAndroidPackageUser(
    packageName: string,
    userId: number,
    signal?: AbortSignal,
  ): Promise<{ warning?: string }> {
    try {
      const result = await this.adb.executeCommand(
        `shell pm install-existing --user ${userId} ${shellQuote(packageName)}`,
        { noRetry: true, signal },
      );
      const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
      if (
        outputLooksLikeShellFailure(result.stdout, result.stderr) ||
        output.includes("Failure [")
      ) {
        throw new ActionableError(output);
      }
      return {};
    } catch (error) {
      if (this.isAndroidCancellation(error, signal)) {
        throw error;
      }
      // A non-cancellation failure affects only this user; continue restoring the others.
      const warning = `Could not restore package for user ${userId}: ${errorMessage(error)}`;
      logger.warn(`[InstallApp] ${warning}`, error);
      return { warning };
    }
  }

  /**
   * pm's own failure line. The `Failure [` prefix keeps an APK path that merely contains the
   * code (adb echoes the path in its stderr: `adb: failed to install <path>: Failure [...]`)
   * from reading as a downgrade, which would uninstall the app.
   */
  private static readonly ANDROID_DOWNGRADE_MARKER = "Failure [INSTALL_FAILED_VERSION_DOWNGRADE";

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
  ): Promise<AndroidInstallAttempt> {
    try {
      const result = await this.adb.executeCommand(installArgs, {
        timeoutMs: ANDROID_PACKAGE_TRANSFER_TIMEOUT_MS,
        noRetry: true,
        signal,
      });
      const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
      return { success: output.includes("Success"), output, diagnostics: output, threw: false };
    } catch (error) {
      if (this.isAndroidCancellation(error, signal)) {
        throw error;
      }
      logger.warn(`[InstallApp] ADB install failed: ${errorMessage(error)}`, error);
      return {
        success: false,
        output: extractErrorText(error),
        diagnostics: this.extractCommandStreams(error),
        threw: true,
        timedOut: error instanceof AdbCommandTimeoutError,
        error,
      };
    }
  }

  /**
   * stdout/stderr of a failed command, found by walking `cause` (a real AdbClient rejection
   * keeps them on the wrapped raw error); the message echoes the command line.
   */
  private extractCommandStreams(error: unknown): string {
    const { stdout, stderr } = adbFailureOutput(error);
    return [stderr, stdout].filter((value) => value.trim().length > 0).join("\n");
  }

  private isAndroidCancellation(error: unknown, signal?: AbortSignal): boolean {
    return (
      Boolean(signal?.aborted) ||
      (error instanceof Error &&
        (error.name === "AbortError" || error.message === OPERATION_CANCELLED_MESSAGE))
    );
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
        `shell am force-stop --user ${userId} ${shellQuote(packageName)}`,
        { noRetry: true, signal },
      );
    } catch (error) {
      // Force-stop is best-effort; uninstall can still remove a package that is not running.
      logger.debug(
        `[InstallApp] Could not stop package before downgrade: ${errorMessage(error)}`,
        error,
      );
    }
    await this.adb.executeCommand(`uninstall ${packageName}`, {
      timeoutMs: ANDROID_PACKAGE_TRANSFER_TIMEOUT_MS,
      signal,
    });
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
    const match = output.match(/^package:\s+name='([^']+)'(?:\s|$)/m);
    if (!match) {
      throw new Error(`Failed to extract package name from ${tool.tool} output.`);
    }

    return { packageName: match[1] };
  }

  private async listPackagesForUser(userId: number, signal?: AbortSignal): Promise<Set<string>> {
    if (signal?.aborted) {
      throw new Error(OPERATION_CANCELLED_MESSAGE);
    }

    const result = await this.adb.executeCommand(`shell pm list packages --user ${userId}`, {
      noRetry: true,
      signal,
    });
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
}
