package dev.jasonpearson.automobile.ctrlproxy

import android.accessibilityservice.AccessibilityService
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Pins the accessibility screenshot error-code → wire-error mapping (issue #4927). A short
 * inter-capture interval is the platform rate limit; it must surface as a distinguishable wire
 * error so the daemon can classify it as `ctrlproxy_rate_limited` instead of a generic failure —
 * without a Robolectric harness, since [AccessibilityService] error codes are compile-time
 * constants.
 */
class CtrlProxyScreenshotWireTest {
  @Test
  fun `rate-limit error code maps to the distinguishable wire error`() {
    assertEquals(
      CtrlProxyScreenshotWire.RATE_LIMITED_ERROR,
      CtrlProxyScreenshotWire.errorMessageForCode(
        AccessibilityService.ERROR_TAKE_SCREENSHOT_INTERVAL_TIME_SHORT
      ),
    )
  }

  @Test
  fun `internal-error code stays the generic error for backward compatibility`() {
    assertEquals(
      CtrlProxyScreenshotWire.GENERIC_ERROR,
      CtrlProxyScreenshotWire.errorMessageForCode(
        AccessibilityService.ERROR_TAKE_SCREENSHOT_INTERNAL_ERROR
      ),
    )
  }

  @Test
  fun `a null error code stays the generic error`() {
    assertEquals(
      CtrlProxyScreenshotWire.GENERIC_ERROR,
      CtrlProxyScreenshotWire.errorMessageForCode(null),
    )
  }
}
