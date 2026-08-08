package dev.jasonpearson.automobile.ctrlproxy

import android.accessibilityservice.AccessibilityService

/**
 * Wire error strings for accessibility screenshot failures (issue #4927).
 *
 * The daemon classifies a failed CtrlProxy screenshot into a fallback reason from the error string
 * carried on the `screenshot_error` frame. Collapsing every `takeScreenshot()` failure to one
 * generic message hid the platform rate limit
 * ([AccessibilityService.ERROR_TAKE_SCREENSHOT_INTERVAL_TIME_SHORT]) behind `ctrlproxy_failed`,
 * making an animation's constant fallover to ADB screencap indistinguishable from a real failure.
 *
 * Kept in its own object so the mapping is unit-testable without a Robolectric harness — the
 * [AccessibilityService] error codes are compile-time constants. The strings must stay
 * byte-identical to the daemon's `screenshotFallbackReason.ts` constants.
 */
internal object CtrlProxyScreenshotWire {
  /**
   * Generic failure message. An older runner that predates the rate-limit classification also emits
   * this, so the daemon maps it to `ctrlproxy_failed` — preserving backward compatibility.
   */
  const val GENERIC_ERROR = "Failed to capture screenshot"

  /**
   * Distinguishable message for a platform rate limit; the daemon maps it to
   * `ctrlproxy_rate_limited`.
   */
  const val RATE_LIMITED_ERROR = "Screenshot rate limited"

  /**
   * Map an [AccessibilityService] `takeScreenshot` error code to its wire error string. Only a
   * short inter-capture interval is the rate limit; every other code (and a null/unknown code)
   * stays the generic message so nothing else changes classification.
   */
  fun errorMessageForCode(errorCode: Int?): String =
    if (errorCode == AccessibilityService.ERROR_TAKE_SCREENSHOT_INTERVAL_TIME_SHORT) {
      RATE_LIMITED_ERROR
    } else {
      GENERIC_ERROR
    }
}
