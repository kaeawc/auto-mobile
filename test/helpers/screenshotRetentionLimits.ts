import {
  DEFAULT_SCREENSHOT_RETENTION_LIMITS,
  type ScreenshotRetentionLimits,
} from "../../src/features/observe/screenshotCacheEviction";

/**
 * Production defaults with the ceiling pinned to the base capacity, so byte pressure (and with
 * it eviction inside the 10-minute guarantee) starts at the base cap instead of growing toward
 * the real ceiling (#15182).
 */
export const BASE_CAP_SCREENSHOT_LIMITS: Readonly<ScreenshotRetentionLimits> = {
  ...DEFAULT_SCREENSHOT_RETENTION_LIMITS,
  ceilingBytes: DEFAULT_SCREENSHOT_RETENTION_LIMITS.baseBytes,
};
