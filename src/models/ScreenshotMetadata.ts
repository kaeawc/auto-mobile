import type { ScreenshotFormat, ScreenshotMimeType } from "./ScreenshotFormat";

export type ScreenshotCaptureSource =
  | "android_ctrlproxy_a11y"
  | "android_adb_screencap"
  | "ios_ctrlproxy";

export type ScreenshotFallbackReason =
  | "a11y_screenshot_unsupported"
  | "websocket_unavailable"
  | "ctrlproxy_failed"
  | "ctrlproxy_rate_limited"
  | "ctrlproxy_timeout"
  | "ctrlproxy_recent_failure"
  | "ctrlproxy_exception";

/** Host elapsed times, including encoding and persistence in each backend stage. */
export interface ScreenshotStageDurationsMs {
  ctrlProxyMs?: number;
  adbMs?: number;
  totalMs: number;
}

export interface ScreenshotPerformanceMetadata {
  screenshotStageDurationsMs?: ScreenshotStageDurationsMs;
  screenshotCaptureDurationMs?: number;
  screenshotEncodeDurationMs?: number;
  screenshotByteLength?: number;
  screenshotBase64Length?: number;
}

export interface ScreenshotMetadata extends ScreenshotPerformanceMetadata {
  screenshotMimeType?: ScreenshotMimeType;
  screenshotFormat?: ScreenshotFormat;
  screenshotCaptureSource?: ScreenshotCaptureSource;
  screenshotFallback?: boolean;
  screenshotFallbackReason?: ScreenshotFallbackReason | null;
}
