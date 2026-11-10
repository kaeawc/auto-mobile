import type { ObserveResult } from "../models/ObserveResult";
import type { Platform } from "../models/Platform";
import { hierarchyUpdatedAtToMillis } from "../features/observe/observeTimestamp";

/**
 * Largest screenshot-after-hierarchy lag still treated as one frame (#17765).
 * Above it the screenshot may show a later screen than `viewHierarchy`.
 */
export const SCREENSHOT_HIERARCHY_LAG_THRESHOLD_MS = 500;

export const SCREENSHOT_HIERARCHY_LAG_WARNING =
  "Screenshot was captured later than the viewHierarchy and may show a later frame";

export interface ScreenshotHierarchyLagOptions {
  /** Lag above which the pair is marked mismatched; defaults to the 500 ms threshold. */
  thresholdMs?: number;
  /**
   * The observed device's platform. Only Apple platforms may fall back to the
   * hierarchy's device `updatedAt`, because they share the host clock (#5377).
   */
  platform?: Platform;
}

/**
 * Stamp `screenshotHierarchyLagMs` (screenshot capture time minus the host time the
 * hierarchy arrived) on a published observation, and mark a lag above the threshold
 * with `screenshotHierarchyMismatch` and a freshness warning.
 *
 * Both operands are host-clock times (#17787): `screenshotCapturedAt` is the host
 * file time and `viewHierarchy.receivedAt` the host receipt time. A device-authored
 * `updatedAt` is only used where the device shares the host clock (Apple platforms);
 * an Android tree, or one with no known platform, gets no lag without a receipt time
 * rather than one that mixes clocks.
 * Returns whether the observation changed.
 */
export function stampScreenshotHierarchyLag(
  observation: ObserveResult,
  {
    thresholdMs = SCREENSHOT_HIERARCHY_LAG_THRESHOLD_MS,
    platform,
  }: ScreenshotHierarchyLagOptions = {},
): boolean {
  const lagMs = screenshotHierarchyLagMs(observation, platform);
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

/** The hierarchy's time on the host clock, or `undefined` when none is known. */
function hostHierarchyTimeMs(
  observation: ObserveResult,
  platform: Platform | undefined,
): number | undefined {
  const receivedAt = observation.viewHierarchy?.receivedAt;
  if (typeof receivedAt === "number" && Number.isFinite(receivedAt)) {
    return receivedAt;
  }
  return platform !== undefined && platform !== "android"
    ? hierarchyUpdatedAtToMillis(observation.viewHierarchy)
    : undefined;
}

function screenshotHierarchyLagMs(
  observation: ObserveResult,
  platform: Platform | undefined,
): number | undefined {
  const hierarchyAt = hostHierarchyTimeMs(observation, platform);
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
