import type { BootedDevice, ObserveResult } from "../../models";
import type { Timer } from "../../utils/SystemTimer";
import { logger } from "../../utils/logger";
import { getPerfWindowBuffer } from "../performance/PerfWindowBuffer";
import {
  getObservePerfWindowMs,
  isObservePerfSnapshotEnabled,
} from "../performance/observePerfSnapshotConfig";

/**
 * Attach a windowed performance snapshot to the result when the
 * `AUTOMOBILE_OBSERVE_PERF_SNAPSHOT` opt-in is enabled. Ensures per-device
 * sampling is running (so the window fills across successive observes) and
 * rolls the live stream up over the configured window. A no-op when disabled,
 * or when there is no active app to attribute the metrics to. Never throws:
 * a snapshot failure must not fail the observation.
 */
export async function attachObservePerfSnapshot(
  result: ObserveResult,
  device: BootedDevice,
  timer: Timer,
): Promise<void> {
  if (!isObservePerfSnapshotEnabled()) {
    return;
  }

  const appId = result.activeWindow?.appId;
  if (!appId) {
    logger.debug("[PerfSnapshot] Skipping snapshot, no active app");
    return;
  }

  try {
    // Ensure continuous sampling is active for this device/package. The first
    // observe warms the window; subsequent observes see a fuller snapshot.
    // start() schedules the sampling interval (idempotent); startMonitoring()
    // alone only registers the device and would never accumulate samples if
    // the daemon had not already started the monitor.
    const { getPerformanceMonitor, getLastStartupTimingMs } =
      await import("../performance/PerformanceMonitor");
    const monitor = getPerformanceMonitor();
    monitor.start();
    monitor.startMonitoring(device.deviceId, appId, device.platform);

    const snapshot = getPerfWindowBuffer().snapshot(
      device.deviceId,
      timer.now(),
      getObservePerfWindowMs(),
    );
    // Startup timing is package-keyed and event-based, so it is not in the
    // sample ring; fill it from the launch cache (an in-memory read).
    snapshot.startup = getLastStartupTimingMs(device.deviceId, appId);
    result.perfSnapshot = snapshot;
  } catch (error) {
    // Best-effort: an audit/snapshot failure should not pollute observation.
    logger.warn(`[PerfSnapshot] Failed to attach performance snapshot: ${error}`);
  }
}
