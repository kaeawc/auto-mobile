package dev.jasonpearson.automobile.ctrlproxy

import android.accessibilityservice.AccessibilityServiceInfo
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * Regression coverage for the bug where every ensureConnected() call reconfigured a live
 * AccessibilityService (serviceInfo = info) even when nothing changed, disrupting in-flight
 * hierarchy capture (observed as elements=0 on every observe() for an entire CI run). The fix is
 * the equality check at the applyAccessibilityFlags call site in CtrlProxy.kt; this test covers the
 * extracted pure bitmask computation it depends on.
 */
@RunWith(RobolectricTestRunner::class)
class CtrlProxyAccessibilityFlagsTest {

  @Test
  fun `computing the same flags twice from a stable base is idempotent`() {
    val base = 0
    val first =
      CtrlProxy.computeAccessibilityServiceFlags(
        currentFlags = base,
        includeNotImportantViews = false,
        reportViewIds = true,
        retrieveInteractiveWindows = false,
      )
    val second =
      CtrlProxy.computeAccessibilityServiceFlags(
        currentFlags = first,
        includeNotImportantViews = false,
        reportViewIds = true,
        retrieveInteractiveWindows = false,
      )

    // The call-site guard (flags == info.flags) relies on this: re-applying the same
    // requested flags against the already-updated bitmask must be a true no-op.
    assertEquals(first, second)
  }

  @Test
  fun `sets each flag bit on when requested true`() {
    val flags =
      CtrlProxy.computeAccessibilityServiceFlags(
        currentFlags = 0,
        includeNotImportantViews = true,
        reportViewIds = true,
        retrieveInteractiveWindows = true,
      )

    assertEquals(
      AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS,
      flags and AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS,
    )
    assertEquals(
      AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS,
      flags and AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS,
    )
    assertEquals(
      AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS,
      flags and AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS,
    )
  }

  @Test
  fun `clears each flag bit off when requested false, leaving unrelated bits untouched`() {
    val unrelatedBit = AccessibilityServiceInfo.FLAG_REQUEST_TOUCH_EXPLORATION_MODE
    val base =
      unrelatedBit or
        AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS or
        AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS or
        AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS

    val flags =
      CtrlProxy.computeAccessibilityServiceFlags(
        currentFlags = base,
        includeNotImportantViews = false,
        reportViewIds = false,
        retrieveInteractiveWindows = false,
      )

    assertEquals(0, flags and AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS)
    assertEquals(0, flags and AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS)
    assertEquals(0, flags and AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS)
    assertEquals(unrelatedBit, flags and unrelatedBit)
  }

  @Test
  fun `requesting the currently-applied config is a true no-op on the bitmask`() {
    val current =
      CtrlProxy.computeAccessibilityServiceFlags(
        currentFlags = 0,
        includeNotImportantViews = false,
        reportViewIds = true,
        retrieveInteractiveWindows = false,
      )

    val recomputed =
      CtrlProxy.computeAccessibilityServiceFlags(
        currentFlags = current,
        includeNotImportantViews = false,
        reportViewIds = true,
        retrieveInteractiveWindows = false,
      )

    assertEquals(current, recomputed)
  }
}
