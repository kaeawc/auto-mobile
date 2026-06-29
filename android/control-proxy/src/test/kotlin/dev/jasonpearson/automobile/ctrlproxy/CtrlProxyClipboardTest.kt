package dev.jasonpearson.automobile.ctrlproxy

import android.content.ClipData
import android.os.Build
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class CtrlProxyClipboardTest {

  @Test
  fun `classifies null clipboard read on Android 10 and newer as restricted`() {
    val result = CtrlProxyClipboard.readResultFromPrimaryClip(null, Build.VERSION_CODES.Q)

    assertFalse(result.success)
    assertNull(result.text)
    val error = result.error ?: error("Expected restricted read error")
    assertTrue(error.contains("restricted"))
    assertTrue(error.contains("foreground"))
  }

  @Test
  fun `classifies null clipboard read before Android 10 as empty`() {
    val result = CtrlProxyClipboard.readResultFromPrimaryClip(null, Build.VERSION_CODES.P)

    assertTrue(result.success)
    assertEquals("", result.text)
    assertNull(result.error)
  }

  @Test
  fun `returns clipboard text when a primary clip is readable`() {
    val clip = ClipData.newPlainText("AutoMobile", "CLIPMARKER777")

    val result = CtrlProxyClipboard.readResultFromPrimaryClip(clip, Build.VERSION_CODES.UPSIDE_DOWN_CAKE)

    assertTrue(result.success)
    assertEquals("CLIPMARKER777", result.text)
    assertNull(result.error)
  }
}
