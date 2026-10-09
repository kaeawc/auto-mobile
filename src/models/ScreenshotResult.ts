import type { ScreenshotFormat, ScreenshotMimeType } from "../features/observe/ScreenshotMetadata";

/**
 * Result of a screenshot operation
 */
export interface ScreenshotResult {
  success: boolean;
  path?: string;
  screenshotImageSize?: { width: number; height: number };
  error?: string;
  screenshotFormat?: ScreenshotFormat;
  screenshotMimeType?: ScreenshotMimeType;
  /** True when the capture was taken with the device's own overlay hidden (#9305). */
  overlaysHidden?: boolean;
}
