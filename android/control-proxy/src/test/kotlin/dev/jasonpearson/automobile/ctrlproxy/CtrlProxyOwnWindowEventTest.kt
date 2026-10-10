package dev.jasonpearson.automobile.ctrlproxy

import android.view.accessibility.AccessibilityWindowInfo
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * CtrlProxy's package also owns its keyboard (an input-method window) and MainActivity, so the
 * own-package filter in onAccessibilityEvent may drop only events from either of CtrlProxy's own
 * accessibility-overlay windows (highlight or prototype). Dropping a keyboard event would leave
 * `frameContext` frozen when the keyboard changes layer in place, letting a stale token tap old key
 * coordinates.
 */
class CtrlProxyOwnWindowEventTest {
  private val own = "dev.jasonpearson.automobile.ctrlproxy"

  @Test
  fun `own package accessibility overlay window is skipped`() {
    assertTrue(
      shouldSkipOwnWindowEvent(own, own, AccessibilityWindowInfo.TYPE_ACCESSIBILITY_OVERLAY),
    )
  }

  @Test
  fun `own package input method window is processed`() {
    assertFalse(shouldSkipOwnWindowEvent(own, own, AccessibilityWindowInfo.TYPE_INPUT_METHOD))
  }

  @Test
  fun `own package application window is processed`() {
    assertFalse(shouldSkipOwnWindowEvent(own, own, AccessibilityWindowInfo.TYPE_APPLICATION))
  }

  @Test
  fun `own package with unknown window type fails open`() {
    assertFalse(shouldSkipOwnWindowEvent(own, own, null))
  }

  @Test
  fun `own package with other window types is processed`() {
    for (type in
      listOf(
        AccessibilityWindowInfo.TYPE_SYSTEM,
        AccessibilityWindowInfo.TYPE_SPLIT_SCREEN_DIVIDER,
      )) {
      assertFalse("type $type", shouldSkipOwnWindowEvent(own, own, type))
    }
  }

  @Test
  fun `other package is processed even from an accessibility overlay window`() {
    assertFalse(
      shouldSkipOwnWindowEvent(
        "com.example.app",
        own,
        AccessibilityWindowInfo.TYPE_ACCESSIBILITY_OVERLAY,
      ),
    )
    assertFalse(
      shouldSkipOwnWindowEvent("com.example.app", own, AccessibilityWindowInfo.TYPE_APPLICATION),
    )
  }

  @Test
  fun `a missing package such as a windows-changed event is processed`() {
    assertFalse(
      shouldSkipOwnWindowEvent(null, own, AccessibilityWindowInfo.TYPE_ACCESSIBILITY_OVERLAY),
    )
    assertFalse(shouldSkipOwnWindowEvent(null, own, null))
  }

  @Test
  fun `an application-layer overlay window is skipped only while one is showing`() {
    assertFalse(shouldSkipOwnWindowEvent(own, own, AccessibilityWindowInfo.TYPE_SYSTEM, false))
    assertTrue(shouldSkipOwnWindowEvent(own, own, AccessibilityWindowInfo.TYPE_SYSTEM, true))
  }

  @Test
  fun `an application-layer overlay never hides the keyboard or activity events`() {
    for (type in
      listOf(
        AccessibilityWindowInfo.TYPE_INPUT_METHOD,
        AccessibilityWindowInfo.TYPE_APPLICATION,
        null,
      )) {
      assertFalse("type $type", shouldSkipOwnWindowEvent(own, own, type, true))
    }
    assertFalse(
      shouldSkipOwnWindowEvent("com.example.app", own, AccessibilityWindowInfo.TYPE_SYSTEM, true),
    )
  }
}
