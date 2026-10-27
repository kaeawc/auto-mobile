import type { AndroidLaunchIntent } from "./androidLaunchIntent";
import { BootedDevice, ClearAppDataResult, TerminateAppResult } from "../../models";
import { SimCtlClient } from "../../utils/ios-cmdline-tools/SimCtlClient";
import { PerformanceTracker } from "../../utils/PerformanceTracker";
import { type PerformanceSamplingCoordinator } from "../performance/PerformanceMonitor";
import type { ActionCall } from "./ActionCall";
import { type InstalledAppsCacheStaleMarker } from "./confirmAndroidPackageInstalledLive";
import { DeviceWindowCacheInvalidator } from "./TerminateApp";

export interface TargetUserDetector {
  detectTargetUserId(packageName: string, userId?: number, signal?: AbortSignal): Promise<number>;
}

export interface InstalledAppsProvider {
  listInstalledApps(
    signal?: AbortSignal,
  ): Promise<{ apps: string[]; successful: boolean; error?: unknown }>;
}

export interface IosClearAppDataRunner {
  execute(bundleId: string): Promise<ClearAppDataResult>;
}

export interface AndroidClearAppDataAction {
  execute(packageName: string, userId?: number): Promise<ClearAppDataResult>;
}

export interface AndroidColdBootAction {
  execute(
    packageName: string,
    options?: { skipObservation?: boolean; userId?: number },
  ): Promise<TerminateAppResult>;
}

/**
 * Launch an app on a physical iOS device via devicectl. Narrow injection point
 * so tests never shell out; parallels `DeviceAppUninstaller` in UninstallApp.
 * Implemented by `DeviceAppManager`. `terminateExisting` provides cold-boot
 * relaunch (terminate + fresh process); there is no standalone device terminate
 * here because devicectl cannot reliably resolve a PID by bundle id (deferred).
 */
/** The narrow simctl surface LaunchApp consumes; lets tests pass a typed fake (#11865). */
export type LaunchAppSimctl = Pick<
  SimCtlClient,
  "launchApp" | "terminateApp" | "executeCommandArgs" | "listAppsOrThrow"
>;

export interface DeviceAppLauncher {
  launchApp(
    deviceUdid: string,
    bundleId: string,
    options?: { terminateExisting?: boolean; launchArguments?: string[] },
  ): Promise<{ success: boolean; pid?: number; error?: string }>;
}

export interface LaunchAppDependencies {
  targetUserDetector?: TargetUserDetector;
  installedAppsProvider?: InstalledAppsProvider;
  /** Marks the installed-apps cache stale when a live check contradicts it (#9976). */
  installedAppsCacheStaleMarker?: InstalledAppsCacheStaleMarker;
  performanceTrackerFactory?: () => PerformanceTracker;
  deviceAppLauncher?: DeviceAppLauncher;
  clearAppDataFactory?: (device: BootedDevice, simctl: LaunchAppSimctl) => IosClearAppDataRunner;
  createAndroidClearAppData?: (device: BootedDevice) => AndroidClearAppDataAction;
  createAndroidColdBoot?: (device: BootedDevice) => AndroidColdBootAction;
  cacheInvalidator?: DeviceWindowCacheInvalidator;
  performanceSamplingCoordinator?: PerformanceSamplingCoordinator;
}

export interface AndroidLaunchOptions {
  packageName: string;
  clearAppData: boolean;
  coldBoot: boolean;
  activityName?: string;
  /** Explicit launch intent (#14080); always starts it, even when the app is in front. */
  intent?: AndroidLaunchIntent;
  userId?: number;
  skipUiStability?: boolean;
  signal?: AbortSignal;
}

/** Launch request for {@link LaunchApp.execute}: what to launch and how, beside the call context. */
export interface LaunchAppCall extends ActionCall {
  clearAppData: boolean;
  coldBoot: boolean;
  /** Activity name to launch (Android only). */
  activityName?: string;
  /** Launch intent (Android only, #14080). */
  intent?: AndroidLaunchIntent;
  /** Android user ID (auto-detected if not provided). */
  userId?: number;
  skipUiStability?: boolean;
  launchArguments?: string[];
  /** `SIMCTL_CHILD_*` variables for a fresh iOS simulator process. */
  launchEnvironment?: Record<string, string>;
}

/** The deprecated positional parameters of {@link LaunchApp.execute} after `clearAppData`. */
export type LaunchAppPositionalTail = [
  coldBoot?: boolean,
  activityName?: string,
  userId?: number,
  skipUiStability?: boolean,
  signal?: AbortSignal,
  launchArguments?: string[],
  launchEnvironment?: Record<string, string>,
];
