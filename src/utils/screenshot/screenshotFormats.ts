/**
 * Canonical mapping between the screenshot formats AutoMobile captures and the
 * file extensions it writes into the screenshot cache directory.
 *
 * Writers (TakeScreenshot) and readers (ScreenshotCache.getScreenshotFiles, and
 * through it the accessibility auditor's latest-screenshot fallback and
 * ScreenshotMatcher) must agree on this set. They previously drifted: the
 * Android CtrlProxy path writes `.jpg` by default, which the lookup filter did
 * not recognise, so the cache never hit on the default Android path (#6599).
 */

/** Screenshot formats callers can request. */
export type ScreenshotFormat = "jpeg" | "png" | "webp";

/**
 * File extension (without the dot) used on disk for a capture format.
 * JPEG captures are written as `.jpg`.
 */
export function screenshotExtensionForFormat(format: ScreenshotFormat): string {
  return format === "jpeg" ? "jpg" : format;
}

/** Every extension a screenshot file in the cache directory can carry. */
export const SCREENSHOT_FILE_EXTENSIONS: readonly string[] = ["png", "jpg", "jpeg", "webp"];

/** True when a file name carries one of the supported screenshot extensions. */
export function isScreenshotFile(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return SCREENSHOT_FILE_EXTENSIONS.some((extension) => lower.endsWith(`.${extension}`));
}
