import type { ScreenshotFallbackReason } from "../ScreenshotMetadata";

/**
 * Internal timeout sentinel set by the daemon when a CtrlProxy screenshot request never resolves.
 * Distinct from the platform rate limit below — it is a daemon-side deadline, not a device signal.
 */
export const CTRLPROXY_SCREENSHOT_TIMEOUT_ERROR = "Screenshot timeout";

/**
 * Distinguishable wire error the Android CtrlProxy runner emits when
 * `AccessibilityService.takeScreenshot()` is rate-limited (ERROR_TAKE_SCREENSHOT_INTERVAL_TIME_SHORT).
 * Kept byte-identical to the runner's `CtrlProxyScreenshotWire.RATE_LIMITED_ERROR` so the two sides
 * agree over the wire (issue #4927). An older runner that predates this classification emits the
 * generic "Failed to capture screenshot" instead, which falls through to `ctrlproxy_failed`.
 */
export const CTRLPROXY_RATE_LIMITED_ERROR = "Screenshot rate limited";

/**
 * Classify a failed CtrlProxy screenshot into the fallback reason recorded on the ADB-screencap
 * frame. A genuine platform rate limit is surfaced distinctly so it is not conflated with a real
 * capture failure; anything unrecognized — including the generic message an older runner sends —
 * stays `ctrlproxy_failed`, preserving backward compatibility (issue #4927).
 */
export function fallbackReasonForCtrlProxyFailure(error?: string): ScreenshotFallbackReason {
  if (error === CTRLPROXY_SCREENSHOT_TIMEOUT_ERROR) {
    return "ctrlproxy_timeout";
  }
  if (error === CTRLPROXY_RATE_LIMITED_ERROR) {
    return "ctrlproxy_rate_limited";
  }
  return "ctrlproxy_failed";
}
