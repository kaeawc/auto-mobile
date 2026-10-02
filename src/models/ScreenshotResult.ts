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
}
