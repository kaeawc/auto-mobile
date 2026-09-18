import { createHash } from "node:crypto";

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

/** Characters of the sanitized device id kept in the token, for readability. */
const DEVICE_TOKEN_READABLE_LENGTH = 48;

/** Hex characters of the raw-device-id digest appended to every token. */
const DEVICE_TOKEN_DIGEST_LENGTH = 12;

/**
 * Filename segment identifying the device a capture belongs to.
 *
 * Screenshot files from every device (and, in production, from every agent
 * process sharing the temp dir) land in one flat directory, so the name is the
 * only device identity a disk scan can see. Device ids can carry characters
 * that are awkward in filenames (`127.0.0.1:5555`), so they are reduced to
 * `[A-Za-z0-9-]`.
 *
 * That reduction alone is many-to-one — `host.name:5555` and `host-name:5555`
 * both sanitize to `host-name-5555`, which would let one device's capture be
 * mistaken for the other's on a shared screenshot directory. So the readable
 * prefix is only a label; identity comes from the appended digest of the raw
 * device id, which makes the token collision-resistant and still filename-safe.
 */
export function screenshotDeviceToken(deviceId: string): string {
  const sanitized = deviceId.replace(/[^A-Za-z0-9-]/g, "-").slice(0, DEVICE_TOKEN_READABLE_LENGTH);
  const digest = createHash("sha256")
    .update(deviceId, "utf8")
    .digest("hex")
    .slice(0, DEVICE_TOKEN_DIGEST_LENGTH);
  const label = sanitized.length > 0 ? sanitized : "unknown";
  return `${label}-${digest}`;
}

/**
 * Filename-safe token for a temporary device screenshot id.
 *
 * The readable label intentionally strips unsupported characters to preserve
 * the existing temp-file shape, but that reduction is many-to-one (`a_b` and
 * `ab` both become `ab`). The digest of the raw id preserves its identity.
 */
export function screenshotTempIdToken(rawId: string): string {
  const sanitized = rawId.replace(/[^A-Za-z0-9-]/g, "").slice(0, DEVICE_TOKEN_READABLE_LENGTH);
  const digest = createHash("sha256")
    .update(rawId, "utf8")
    .digest("hex")
    .slice(0, DEVICE_TOKEN_DIGEST_LENGTH);
  const label = sanitized.length > 0 ? sanitized : "unknown";
  return `${label}-${digest}`;
}

/**
 * Canonical screenshot file name: `screenshot_<timestamp>_<device>_<unique>.<ext>`.
 * `uniqueId` comes from the injected `IdGenerator` and may itself contain `_`
 * (e.g. `new CountingIdGenerator("capture_run")`), so it is always the last
 * segment and the parser must not assume a fixed component count (#6913).
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
  // Anchored on the fixed prefix, timestamp and device fields: the device token
  // is `[A-Za-z0-9-]` by construction, so it cannot swallow the `_` that starts
  // the unique-id tail, and the tail may contain any number of underscores.
  const match = /^screenshot_\d+_([A-Za-z0-9-]+)_.+$/.exec(withoutExtension);
  return match?.[1];
}

/** True when a screenshot file name identifies a capture from `deviceId`. */
export function screenshotFileBelongsToDevice(fileName: string, deviceId: string): boolean {
  return screenshotFileDeviceToken(fileName) === screenshotDeviceToken(deviceId);
}
