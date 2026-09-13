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

/**
 * Filename segment identifying the device a capture belongs to.
 *
 * Screenshot files from every device (and, in production, from every agent
 * process sharing the temp dir) land in one flat directory, so the name is the
 * only device identity a disk scan can see. Device ids can carry characters
 * that are awkward in filenames (`127.0.0.1:5555`), so they are reduced to
 * `[A-Za-z0-9-]`.
 */
export function screenshotDeviceToken(deviceId: string): string {
  const token = deviceId.replace(/[^A-Za-z0-9-]/g, "-");
  return token.length > 0 ? token : "unknown";
}

/**
 * Canonical screenshot file name: `screenshot_<timestamp>_<device>_<unique>.<ext>`.
 * `uniqueId` comes from the injected `IdGenerator`, so it never contains `_`.
 */
export function screenshotFileName(
  timestamp: number,
  deviceId: string,
  uniqueId: string,
  extension: string,
): string {
  return `screenshot_${timestamp}_${screenshotDeviceToken(deviceId)}_${uniqueId}.${extension}`;
}

/**
 * Device token carried by a screenshot file name, or undefined when the name
 * does not follow the canonical shape (a capture from an older build, say).
 */
export function screenshotFileDeviceToken(fileName: string): string | undefined {
  const withoutExtension = fileName.replace(/\.[^.]*$/, "");
  const parts = withoutExtension.split("_");
  if (parts.length !== 4 || parts[0] !== "screenshot") {
    return undefined;
  }
  return parts[2];
}

/** True when a screenshot file name identifies a capture from `deviceId`. */
export function screenshotFileBelongsToDevice(fileName: string, deviceId: string): boolean {
  return screenshotFileDeviceToken(fileName) === screenshotDeviceToken(deviceId);
}
