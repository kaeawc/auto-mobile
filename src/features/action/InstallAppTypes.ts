import { type InstalledAppsStore } from "../../db/installedAppsRepository";
import { type HostCommandExecutor } from "../../utils/HostCommandExecutor";
import { type PerformanceTracker } from "../../utils/PerformanceTracker";
import { type Timer } from "../../utils/SystemTimer";
import { type AndroidBuildToolsLocator } from "../../utils/android-cmdline-tools/AndroidBuildToolsLocator";
import { type BundletoolLocator } from "../../utils/android-cmdline-tools/BundletoolLocator";
import {
  resolveIosDowngradeRecoveryBackend,
  resolveIosInstallBackend,
} from "../../utils/ios-cmdline-tools/IosDeviceBackend";
import { type PlistReader } from "../../utils/ios-cmdline-tools/PlistClient";
import { SimCtlClient } from "../../utils/ios-cmdline-tools/SimCtlClient";
import type { IosPhysicalAppLister } from "../observe/ListInstalledApps";
import type { ActionCall } from "./ActionCall";
import type { AndroidArtifactHost } from "./AndroidArtifactHost";
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
  /**
   * Set by an installer whose failure text has no pm `Failure [` line (bundletool): whether it
   * reported INSTALL_FAILED_VERSION_DOWNGRADE. Unset means read the adb diagnostics.
   */
  versionDowngrade?: boolean;
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
  bundletoolLocator?: BundletoolLocator;
  artifactHost?: AndroidArtifactHost;
}

/** Call context for {@link InstallApp.execute}: the target user and install guard ride beside the signal. */
export interface InstallAppCall extends ActionCall {
  userId?: number;
  guard?: InstallGuardOptions;
  android?: AndroidInstallRequest;
}

/** Signing key for the APKs bundletool builds from an `.aab`; default is the debug keystore. */
export interface AndroidBundleKeystore {
  path: string;
  alias: string;
  storePassword: string;
  /** Defaults to `storePassword`. */
  keyPassword?: string;
}

export interface AndroidBundleOptions {
  /** `.aab` only. */
  keystore?: AndroidBundleKeystore;
  /** Dynamic feature modules to install (`_ALL_` for every module); `.aab` and `.apks`. */
  modules?: string[];
  /** `.aab` only: build with `--local-testing` so on-demand modules resolve locally. */
  localTesting?: boolean;
}

/** Android-only inputs beyond the artifact path; omitting them keeps the single-APK install. */
export interface AndroidInstallRequest {
  /** Extra split APKs installed with `artifactPath` (the base APK) via `install-multiple`. */
  splits?: string[];
  bundle?: AndroidBundleOptions;
  /** Grant every runtime permission the app requests (`install -g`). */
  grantAllPermissions?: boolean;
  /** Allow a lower versionCode over the installed one (`install -d`; debuggable apps only). */
  allowDowngrade?: boolean;
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
