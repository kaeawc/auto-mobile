import type { LaunchAppResult } from "../../../models";
import type { PerformanceTracker } from "../../../utils/PerformanceTracker";
import type { AdbExecutor } from "../../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { logger } from "../../../utils/logger";
import type { DisplayedTimeMetricsCollector } from "../../performance/DisplayedTimeMetricsCollector";
import { setLastTtiMs } from "../../performance/PerformanceMonitor";

export async function captureAndroidLaunchMetrics({
  collector,
  startMs,
  result,
  perf,
  adb,
  deviceId,
  packageName,
}: {
  collector: Pick<DisplayedTimeMetricsCollector, "captureDisplayedMetrics"> | null;
  startMs: number | null;
  result: LaunchAppResult;
  perf: PerformanceTracker;
  adb: Pick<AdbExecutor, "getDeviceTimestampMs">;
  deviceId: string;
  packageName: string;
}): Promise<void> {
  logger.info(
    `[LaunchApp] TTI capture check: collector=${!!collector}, startMs=${startMs}, hasObservation=${!!result?.observation}`,
  );
  if (collector && startMs !== null && result?.observation) {
    const endMs = await perf.track("displayedLogcatEndTime", () => adb.getDeviceTimestampMs());
    logger.info(`[LaunchApp] Capturing displayed metrics: startMs=${startMs}, endMs=${endMs}`);
    const displayedTimeMetrics = await collector.captureDisplayedMetrics(
      { packageName, startTimestampMs: startMs, endTimestampMs: endMs },
      perf,
    );
    logger.info(`[LaunchApp] Captured ${displayedTimeMetrics.length} displayed metrics`);
    result.observation.displayedTimeMetrics = displayedTimeMetrics;

    // The first displayed metric supplies the monitor's time to first frame / interactive.
    if (displayedTimeMetrics.length > 0) {
      const firstMetric = displayedTimeMetrics[0];
      setLastTtiMs(deviceId, packageName, firstMetric.displayedTimeMs);
      logger.info(`[LaunchApp] Recorded TTI for ${packageName}: ${firstMetric.displayedTimeMs}ms`);
    } else {
      logger.info(`[LaunchApp] No displayed metrics found for ${packageName}`);
    }
  } else {
    logger.info(`[LaunchApp] Skipping TTI capture - conditions not met`);
  }
}
