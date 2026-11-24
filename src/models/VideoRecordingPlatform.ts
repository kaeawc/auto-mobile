import { ActionableError } from "./ActionableError";
import { PLATFORM_LABELS, type Platform } from "./Platform";

/**
 * Platforms `videoRecording` captures: Android, and the Apple simulators `simctl io recordVideo`
 * drives (iOS, Apple TV and Apple Watch). Vision Pro simulators are refused before any capture.
 */
export type VideoRecordingPlatform = "android" | "ios" | "tvos" | "watchos";

/** Platforms captured by `simctl io <udid> recordVideo` (iOS, Apple TV and Apple Watch simulators). */
export type SimctlVideoPlatform = Exclude<VideoRecordingPlatform, "android">;

export function isSimctlVideoPlatform(platform: string): platform is SimctlVideoPlatform {
  return platform === "ios" || platform === "tvos" || platform === "watchos";
}

export function isVideoRecordingPlatform(platform: string): platform is VideoRecordingPlatform {
  return platform === "android" || isSimctlVideoPlatform(platform);
}

/** Narrows a device platform for recording, or throws an ActionableError naming it. */
export function requireVideoRecordingPlatform(
  platform: Platform,
  operation: string,
): VideoRecordingPlatform {
  if (isVideoRecordingPlatform(platform)) {
    return platform;
  }
  throw new ActionableError(
    `${operation} is not supported on ${PLATFORM_LABELS[platform]} yet. ` +
      "Target an Android, iOS, Apple TV or Apple Watch device instead.",
  );
}
