import type { BootedDevice, LaunchAppResult } from "../../../models";
import { toActionableError } from "../../../models/ActionableError";
import type { PerformanceTracker } from "../../../utils/PerformanceTracker";
import type { Timer } from "../../../utils/SystemTimer";
import type { AdbExecutor } from "../../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { readAndroidPackageProcesses } from "../../../utils/android-cmdline-tools/androidProcessState";
import { logger } from "../../../utils/logger";
import type {
  AndroidClearAppDataAction,
  AndroidColdBootAction,
  InstalledAppsProvider,
} from "../LaunchApp";

export function resolveAndroidLaunchInstalledApps({
  installedAppsResult,
  deviceId,
  packageName,
}: {
  installedAppsResult: PromiseSettledResult<
    Awaited<ReturnType<InstalledAppsProvider["listInstalledApps"]>>
  >;
  deviceId: string;
  packageName: string;
}): string[] {
  if (installedAppsResult.status === "rejected") {
    throw installedAppsResult.reason;
  }
  const listing = installedAppsResult.value;
  if (!listing.successful) {
    throw toActionableError(
      listing.error ??
        new Error(`installed-app listing did not complete successfully for ${deviceId}`),
      `Could not determine whether ${packageName} is installed`,
    );
  }
  const installedApps = listing.apps;
  logger.info(`[LaunchApp] Found ${installedApps.length} installed app(s)`);
  logger.info(`[LaunchApp] Looking for package: ${packageName}`);
  logger.info(`[LaunchApp] Installed apps: ${installedApps.join(", ")}`);
  return installedApps;
}

interface AndroidProcessPreparationOptions {
  device: BootedDevice;
  packageName: string;
  targetUserId: number;
  clearAppData: boolean;
  coldBoot: boolean;
  perf: PerformanceTracker;
  signal?: AbortSignal;
  adb: AdbExecutor;
  timer: Timer;
  createClearAppData: (device: BootedDevice) => AndroidClearAppDataAction;
  createColdBoot: (device: BootedDevice) => AndroidColdBootAction;
}

async function checkAndroidAppRunning({
  packageName,
  targetUserId,
  adb,
  timer,
  signal,
  perf,
}: AndroidProcessPreparationOptions): Promise<boolean> {
  return perf.track("checkRunning", async () => {
    const isRunningArgs = ["shell", "dumpsys", "activity", "processes"];
    logger.info(`[LaunchApp] Checking if app is running: ${isRunningArgs.join(" ")}`);
    const result = await readAndroidPackageProcesses(adb, packageName, {
      userId: targetUserId,
      signal,
      timer,
    });
    logger.info(
      `[LaunchApp] App running: ${result.isRunning} (processes: ${JSON.stringify(result.processes)})`,
    );
    return result.isRunning;
  });
}

async function clearAndroidAppForLaunch({
  device,
  packageName,
  targetUserId,
  createClearAppData,
  perf,
  signal,
}: AndroidProcessPreparationOptions): Promise<LaunchAppResult | undefined> {
  const clearResult = await perf.track("clearAppData", () =>
    createClearAppData(device).execute(packageName, targetUserId),
  );
  signal?.throwIfAborted();
  if (!clearResult.success) {
    const error = `Failed to clear app data: ${clearResult.error ?? "unknown error"}`;
    logger.warn(`[LaunchApp] Android clearAppData failed for ${packageName}: ${error}`);
    perf.end();
    return { success: false, packageName, userId: targetUserId, error };
  }
  return undefined;
}

async function stopAndroidAppForLaunch({
  device,
  packageName,
  targetUserId,
  createColdBoot,
  perf,
  signal,
}: AndroidProcessPreparationOptions): Promise<LaunchAppResult | undefined> {
  const coldBootResult = await perf.track("terminateApp", () =>
    createColdBoot(device).execute(packageName, { skipObservation: true, userId: targetUserId }),
  );
  signal?.throwIfAborted();
  if (!coldBootResult.success) {
    const error = `Cold boot could not stop ${packageName}: ${coldBootResult.error ?? "unknown error"}`;
    logger.warn(`[LaunchApp] ${error}`);
    perf.end();
    return { success: false, packageName, userId: targetUserId, error };
  }
  return undefined;
}

async function checkAndroidAppAlreadyForeground({
  adb,
  perf,
  signal,
  packageName,
  targetUserId,
}: AndroidProcessPreparationOptions): Promise<boolean | null> {
  const foregroundApp = await perf.track("checkForeground", () => adb.getForegroundApp());
  signal?.throwIfAborted();
  const alreadyForeground =
    foregroundApp &&
    foregroundApp.packageName === packageName &&
    foregroundApp.userId === targetUserId;
  if (alreadyForeground) {
    logger.info(`[LaunchApp] App ${packageName} is already in foreground in user ${targetUserId}`);
  }
  return alreadyForeground;
}

type AndroidProcessPreparation =
  | { failure: LaunchAppResult }
  | { isRunning: boolean; didTerminateOrClear: boolean; alreadyForeground: boolean | null };

export async function prepareAndroidLaunchProcess(
  options: AndroidProcessPreparationOptions,
): Promise<AndroidProcessPreparation> {
  const isRunning = await checkAndroidAppRunning(options);
  options.signal?.throwIfAborted();
  if (options.clearAppData) {
    // Data clearing is required even when no app process is running.
    const failure = await clearAndroidAppForLaunch(options);
    if (failure) {
      return { failure };
    }
  } else if (isRunning && options.coldBoot) {
    const failure = await stopAndroidAppForLaunch(options);
    if (failure) {
      return { failure };
    }
  }
  const didTerminateOrClear = isRunning && (options.clearAppData || options.coldBoot);
  // A terminated or cleared process cannot already be in the foreground.
  const alreadyForeground =
    isRunning && !didTerminateOrClear ? await checkAndroidAppAlreadyForeground(options) : false;
  return { isRunning, didTerminateOrClear, alreadyForeground };
}
