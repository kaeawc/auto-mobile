import type { ObserveResult } from "../models/ObserveResult";
import { hierarchyUpdatedAtToMillis } from "../features/observe/observeTimestamp";

/**
 * Largest screenshot-after-hierarchy lag still treated as one frame (#17765).
 * Above it the screenshot may show a later screen than `viewHierarchy`.
 */
export const SCREENSHOT_HIERARCHY_LAG_THRESHOLD_MS = 500;

export const SCREENSHOT_HIERARCHY_LAG_WARNING =
  "Screenshot was captured later than the viewHierarchy and may show a later frame";

/**
 * Stamp `screenshotHierarchyLagMs` (screenshot capture time minus the device-authored
 * hierarchy `updatedAt`) on a published observation, and mark a lag above
 * `thresholdMs` with `screenshotHierarchyMismatch` and a freshness warning.
 *
 * The two timestamps come from different clocks (host file time, device extraction
 * time), so a small negative value is clock skew, never a mismatch.
 * Returns whether the observation changed.
 */
export function stampScreenshotHierarchyLag(
  observation: ObserveResult,
  thresholdMs: number = SCREENSHOT_HIERARCHY_LAG_THRESHOLD_MS,
): boolean {
  const lagMs = screenshotHierarchyLagMs(observation);
  if (lagMs === undefined) {
    // A failed capture drops its screenshot fields; never leave a lag for absent pixels.
    const stamped = observation.screenshotHierarchyLagMs !== undefined;
    delete observation.screenshotHierarchyLagMs;
    delete observation.screenshotHierarchyMismatch;
    return stamped;
  }
  observation.screenshotHierarchyLagMs = lagMs;
  if (lagMs > thresholdMs) {
    markMismatch(observation);
  } else {
    delete observation.screenshotHierarchyMismatch;
  }
  return true;
}

function screenshotHierarchyLagMs(observation: ObserveResult): number | undefined {
  const hierarchyAt = hierarchyUpdatedAtToMillis(observation.viewHierarchy);
  const capturedAt =
    observation.screenshotCapturedAt === undefined
      ? Number.NaN
      : Date.parse(observation.screenshotCapturedAt);
  if (hierarchyAt === undefined || !Number.isFinite(capturedAt)) {
    return undefined;
  }
  return Math.round(capturedAt - hierarchyAt);
}

function markMismatch(observation: ObserveResult): void {
  observation.screenshotHierarchyMismatch = true;
  const { isFresh = true, warning } = observation.freshness ?? {};
  if (warning?.includes(SCREENSHOT_HIERARCHY_LAG_WARNING)) {
    return;
  }
  observation.freshness = {
    ...observation.freshness,
    isFresh,
    warning: [warning, SCREENSHOT_HIERARCHY_LAG_WARNING].filter(Boolean).join("; "),
  };
}
