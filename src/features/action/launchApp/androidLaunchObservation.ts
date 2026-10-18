import type { BootedDevice, LaunchAppResult, ObserveResult } from "../../../models";
import type { PerformanceTracker } from "../../../utils/PerformanceTracker";
import type { AdbClientFactory } from "../../../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { logger } from "../../../utils/logger";
import { serverConfig } from "../../../utils/ServerConfig";
import { DisplayedTimeMetricsCollector } from "../../performance/DisplayedTimeMetricsCollector";
import type { BaseVisualChange } from "../BaseVisualChange";
import {
  LaunchPackageRemovedError,
  PACKAGE_NOT_INSTALLED_ERROR,
} from "../LaunchPackageRemovedError";
import { OBSERVED_INTERACTION_PROFILES } from "../observedInteractionProfiles";
import { captureAndroidLaunchMetrics } from "./androidLaunchMetrics";

interface AndroidLaunchObservationOptions {
  device: BootedDevice;
  adb: AdbExecutor;
  adbFactory: AdbClientFactory;
  packageName: string;
  targetUserId: number;
  activityName?: string;
  clearAppData: boolean;
  skipUiStability?: boolean;
  signal?: AbortSignal;
  perf: PerformanceTracker;
  alreadyForeground: boolean | null;
  observedInteraction: BaseVisualChange["observedInteraction"];
  performLaunch: () => Promise<LaunchAppResult>;
  waitForForeground: () => Promise<boolean>;
  settleObservation: (result: LaunchAppResult) => Promise<LaunchAppResult>;
  captureScreenshot: (observation: ObserveResult | undefined) => Promise<void>;
  waitForColdFrame: (result: LaunchAppResult) => Promise<void>;
}

async function observeAlreadyForegroundAndroidApp({
  perf,
  packageName,
  targetUserId,
  activityName,
  skipUiStability,
  signal,
  observedInteraction,
  settleObservation,
  captureScreenshot,
}: AndroidLaunchObservationOptions): Promise<LaunchAppResult> {
  // "Make this app foreground" is a goal, not a transition: the goal already
  // holds, so this is a success flagged with `alreadyForeground` — not an
  // error a client has to string-match to decide whether to continue, which
  // also discarded the observation a launch normally returns (issue #6868).
  const result = await observedInteraction(
    async () => {
      perf.end();
      return {
        success: true,
        alreadyForeground: true,
        packageName,
        activityName,
        userId: targetUserId,
      };
    },
    {
      ...OBSERVED_INTERACTION_PROFILES.appLaunch,
      perf,
      packageName,
      signal,
      skipUiStability: skipUiStability ?? false,
    },
  );
  // The foreground read and this observation are two separate device reads,
  // so another app or a system surface can take over in between. Reconcile
  // through the SAME validation the launch path uses rather than asserting
  // `alreadyForeground: true` over a capture of a different app, which
  // `buildLaunchAppResponse` would surface as a clean success with a
  // mismatched `observedAppId` and no error (issue #6868 review).
  const settledResult = await settleObservation(result);
  await captureScreenshot(settledResult.observation);
  return settledResult;
}

export async function observeAndroidAppLaunch(
  options: AndroidLaunchObservationOptions,
): Promise<LaunchAppResult> {
  if (options.alreadyForeground) {
    return observeAlreadyForegroundAndroidApp(options);
  }
  const {
    device,
    adb,
    adbFactory,
    packageName,
    targetUserId,
    clearAppData,
    skipUiStability,
    signal,
    perf,
    observedInteraction,
    performLaunch,
    waitForForeground,
    settleObservation,
    captureScreenshot,
    waitForColdFrame,
  } = options;
  logger.info(`[LaunchApp] Proceeding with app launch`);
  signal?.throwIfAborted();

  const captureDisplayedMetrics = serverConfig.isUiPerfModeEnabled();
  logger.info(
    `[LaunchApp] captureDisplayedMetrics=${captureDisplayedMetrics} (isUiPerfModeEnabled)`,
  );
  const displayedMetricsCollector = captureDisplayedMetrics
    ? new DisplayedTimeMetricsCollector(device, adbFactory)
    : null;
  let displayedMetricsStartMs: number | null = null;

  let observationTimestampMs: number | undefined;

  const launchResult = await observedInteraction<LaunchAppResult>(
    async () => {
      if (displayedMetricsCollector) {
        displayedMetricsStartMs = await perf.track("displayedLogcatStartTime", () =>
          adb.getDeviceTimestampMs(),
        );
      }
      const launchOutcome = await performLaunch();
      signal?.throwIfAborted();
      const foregroundReady = await waitForForeground();
      if (!foregroundReady) {
        logger.warn(
          `[LaunchApp] ${packageName} did not become the foreground app before observation; continuing to validate launch observation`,
        );
      }
      observationTimestampMs = await adb.getDeviceTimestampMs();
      return launchOutcome;
    },
    {
      ...OBSERVED_INTERACTION_PROFILES.appLaunch,
      perf,
      skipUiStability: skipUiStability ?? false,
      packageName,
      foregroundAppMayChange: true,
      observationTimestampProvider: () => observationTimestampMs,
      signal,
    },
  ).catch((error: unknown) => {
    if (error instanceof LaunchPackageRemovedError) {
      perf.end();
      return { success: false, packageName, userId: targetUserId, error: error.message };
    }
    throw error;
  });

  signal?.throwIfAborted();
  if (!launchResult.success && launchResult.error === PACKAGE_NOT_INSTALLED_ERROR) {
    return launchResult;
  }
  const settledLaunchResult = await settleObservation(launchResult);
  if (clearAppData && settledLaunchResult.success && settledLaunchResult.observation) {
    await waitForColdFrame(settledLaunchResult);
  }
  await captureScreenshot(settledLaunchResult.observation);

  await captureAndroidLaunchMetrics({
    collector: displayedMetricsCollector,
    startMs: displayedMetricsStartMs,
    result: settledLaunchResult,
    perf,
    adb,
    deviceId: device.deviceId,
    packageName,
  });

  return settledLaunchResult;
}
