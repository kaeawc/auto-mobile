import { type InstalledAppsStore } from "../../db/installedAppsRepository";
import { type HostCommandExecutor } from "../../utils/HostCommandExecutor";
import { type PerformanceTracker } from "../../utils/PerformanceTracker";
import { type Timer } from "../../utils/SystemTimer";
import { type AndroidBuildToolsLocator } from "../../utils/android-cmdline-tools/AndroidBuildToolsLocator";
import {
  resolveIosDowngradeRecoveryBackend,
  resolveIosInstallBackend,
} from "../../utils/ios-cmdline-tools/IosDeviceBackend";
import { type PlistReader } from "../../utils/ios-cmdline-tools/PlistClient";
import { SimCtlClient } from "../../utils/ios-cmdline-tools/SimCtlClient";
import type { IosPhysicalAppLister } from "../observe/ListInstalledApps";
import type { ActionCall } from "./ActionCall";
import { type PackageSigningInspector } from "./SigningIdentityGuard";
import { type DeviceWindowCacheInvalidator } from "./TerminateApp";

export interface AndroidInstallAttempt {
  success: boolean;
  output: string;
  /** Only the command's own stdout/stderr; never the echoed command line or APK path. */
  diagnostics: string;
  threw: boolean;
  /** The adb call hit its step budget: the device-side install may still commit. */
  timedOut?: boolean;
  error?: unknown;
}

export interface AndroidInstallStepOptions {
  signal?: AbortSignal;
  /** False refuses the uninstall-and-reinstall downgrade recovery. Default true. */
  allowDestructiveRecovery?: boolean;
}

export function installStepOptions(
  guard: InstallGuardOptions | undefined,
  signal: AbortSignal | undefined,
): AndroidInstallStepOptions {
  return { signal, allowDestructiveRecovery: guard?.allowDestructiveRecovery !== false };
}

export interface AndroidInstallRecovery {
  installAttempt: AndroidInstallAttempt;
  warning?: string;
  /** Downgrade recovery uninstalled the old copy, so the reinstall is effectively fresh. */
  removedPriorCopy?: boolean;
}

export interface AndroidPackageUsers {
  installedUserIds: number[];
  warnings: string[];
}

export interface AndroidRestoreProgress {
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
  simctl?: Pick<SimCtlClient, "installApp" | "listAppsOrThrow" | "terminateApp" | "uninstallApp">;
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
