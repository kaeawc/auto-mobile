export type ScreenshotFormat = "jpeg" | "png";

export type ScreenshotMimeType = "image/jpeg" | "image/png";

export type ScreenshotCaptureSource =
  | "android_ctrlproxy_a11y"
  | "android_adb_screencap"
  | "ios_ctrlproxy";

export type ScreenshotFallbackReason =
  | "a11y_screenshot_unsupported"
  | "websocket_unavailable"
  | "ctrlproxy_failed"
  | "ctrlproxy_timeout"
  | "ctrlproxy_exception";

export interface ScreenshotMetadata {
  screenshotMimeType?: ScreenshotMimeType;
  screenshotFormat?: ScreenshotFormat;
  screenshotCaptureSource?: ScreenshotCaptureSource;
  screenshotFallback?: boolean;
  screenshotFallbackReason?: ScreenshotFallbackReason | null;
}

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
  format?: string
): ScreenshotMetadata {
  switch (format) {
    case "jpeg":
      return {
        ...metadata,
        screenshotMimeType: "image/jpeg",
        screenshotFormat: "jpeg",
      };
    case "png":
      return {
        ...metadata,
        screenshotMimeType: "image/png",
        screenshotFormat: "png",
      };
    default:
      return metadata;
  }
}
