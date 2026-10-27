import type { StartupTimingSummary } from "../../models/PerfSnapshot";
import { defaultTimer } from "../../utils/SystemTimer";
import { logger } from "../../utils/logger";

// TTI (Time to Interactive) store - tracks last known TTI per device and package
// TTI is an event-based metric captured at app launch, not continuous
export const ttiStore = new Map<string, Map<string, { ttiMs: number; timestamp: number }>>();

/** Startup timing is only relevant for recent launches (within 5 minutes). */
export const STARTUP_MAX_AGE_MS = 5 * 60 * 1000;

/**
 * Store the last known TTI for a package.
 * Called by LaunchApp after measuring displayed time.
 */
export function setLastTtiMs(deviceId: string, packageName: string, ttiMs: number): void {
  let timings = ttiStore.get(deviceId);
  if (!timings) {
    timings = new Map();
    ttiStore.set(deviceId, timings);
  }
  timings.set(packageName, { ttiMs, timestamp: defaultTimer.now() });
  logger.debug(`[PerformanceMonitor] Stored TTI for ${packageName}: ${ttiMs}ms`);
}

/**
 * Get the last known TTI for a package.
 * Returns null if no TTI has been recorded or if it's stale (>5 minutes old).
 */
export function getLastTtiMs(deviceId: string, packageName: string): number | null {
  const timings = ttiStore.get(deviceId);
  const entry = timings?.get(packageName);
  if (!entry) {
    return null;
  }
  if (defaultTimer.now() - entry.timestamp > STARTUP_MAX_AGE_MS) {
    timings?.delete(packageName);
    return null;
  }
  return entry.ttiMs;
}

/**
 * Startup timing for a package's most recent launch, for the observe
 * `perfSnapshot`. Reads the same in-memory launch cache as {@link getLastTtiMs}
 * (populated by `launchApp` from the ActivityManager "Displayed" time), so it
 * adds no device work. Returns null when no launch is recorded or the last one
 * is stale (>5 minutes).
 */
export function getLastStartupTimingMs(
  deviceId: string,
  packageName: string,
): StartupTimingSummary | null {
  const timings = ttiStore.get(deviceId);
  const entry = timings?.get(packageName);
  if (!entry) {
    return null;
  }
  const ageMs = defaultTimer.now() - entry.timestamp;
  if (ageMs > STARTUP_MAX_AGE_MS) {
    timings?.delete(packageName);
    return null;
  }
  return { displayedMs: entry.ttiMs, ageMs };
}
