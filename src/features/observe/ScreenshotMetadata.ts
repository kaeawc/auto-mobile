import type { ScreenshotMetadata } from "../../models/ScreenshotMetadata";

export type { ScreenshotFormat, ScreenshotMimeType } from "../../models/ScreenshotFormat";
export type {
  ScreenshotCaptureSource,
  ScreenshotFallbackReason,
  ScreenshotStageDurationsMs,
  ScreenshotPerformanceMetadata,
  ScreenshotMetadata,
} from "../../models/ScreenshotMetadata";

export const ANDROID_CTRLPROXY_SCREENSHOT_METADATA: ScreenshotMetadata = {
  screenshotMimeType: "image/jpeg",
  screenshotFormat: "jpeg",
  screenshotCaptureSource: "android_ctrlproxy_a11y",
  screenshotFallback: false,
};

export const ANDROID_ADB_SCREENSHOT_METADATA: ScreenshotMetadata = {
  screenshotMimeType: "image/png",
  screenshotFormat: "png",
  screenshotCaptureSource: "android_adb_screencap",
  screenshotFallback: true,
};

export const IOS_CTRLPROXY_SCREENSHOT_METADATA: ScreenshotMetadata = {
  screenshotMimeType: "image/png",
  screenshotFormat: "png",
  screenshotCaptureSource: "ios_ctrlproxy",
  screenshotFallback: false,
};

export function metadataForScreenshotFormat(
  metadata: ScreenshotMetadata,
  format?: string,
): ScreenshotMetadata {
  const metadataWithoutFormat = { ...metadata };
  delete metadataWithoutFormat.screenshotMimeType;
  delete metadataWithoutFormat.screenshotFormat;

  switch (format) {
    case "jpeg":
      return {
        ...metadataWithoutFormat,
        screenshotMimeType: "image/jpeg",
        screenshotFormat: "jpeg",
      };
    case "png":
      return {
        ...metadataWithoutFormat,
        screenshotMimeType: "image/png",
        screenshotFormat: "png",
      };
    case "webp":
      return {
        ...metadataWithoutFormat,
        screenshotMimeType: "image/webp",
        screenshotFormat: "webp",
      };
    default:
      return metadataWithoutFormat;
  }
}

export function pickScreenshotMetadata(metadata: ScreenshotMetadata): ScreenshotMetadata {
  const pickedMetadata: ScreenshotMetadata = {};

  if (metadata.screenshotMimeType !== undefined) {
    pickedMetadata.screenshotMimeType = metadata.screenshotMimeType;
  }
  if (metadata.screenshotFormat !== undefined) {
    pickedMetadata.screenshotFormat = metadata.screenshotFormat;
  }
  if (metadata.screenshotCaptureSource !== undefined) {
    pickedMetadata.screenshotCaptureSource = metadata.screenshotCaptureSource;
  }
  if (metadata.screenshotFallback !== undefined) {
    pickedMetadata.screenshotFallback = metadata.screenshotFallback;
  }
  if (metadata.screenshotFallbackReason !== undefined) {
    pickedMetadata.screenshotFallbackReason = metadata.screenshotFallbackReason;
  }
  if (metadata.screenshotStageDurationsMs !== undefined) {
    pickedMetadata.screenshotStageDurationsMs = metadata.screenshotStageDurationsMs;
  }
  if (metadata.screenshotCaptureDurationMs !== undefined) {
    pickedMetadata.screenshotCaptureDurationMs = metadata.screenshotCaptureDurationMs;
  }
  if (metadata.screenshotEncodeDurationMs !== undefined) {
    pickedMetadata.screenshotEncodeDurationMs = metadata.screenshotEncodeDurationMs;
  }
  if (metadata.screenshotByteLength !== undefined) {
    pickedMetadata.screenshotByteLength = metadata.screenshotByteLength;
  }
  if (metadata.screenshotBase64Length !== undefined) {
    pickedMetadata.screenshotBase64Length = metadata.screenshotBase64Length;
  }

  return pickedMetadata;
}
