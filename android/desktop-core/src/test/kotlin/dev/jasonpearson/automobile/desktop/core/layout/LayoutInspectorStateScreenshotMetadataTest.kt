package dev.jasonpearson.automobile.desktop.core.layout

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

class LayoutInspectorStateScreenshotMetadataTest {

  @Test
  fun `updateScreenshot defaults metadata to absent when not provided`() {
    val state = LayoutInspectorState()

    state.updateScreenshot(data = byteArrayOf(1), width = 100, height = 200, timestamp = 1L)

    assertFalse(state.screenshotFallback)
    assertNull(state.screenshotFallbackReason)
    assertNull(state.screenshotFormat)
    assertNull(state.screenshotCaptureSource)
  }

  @Test
  fun `updateScreenshot stores provided metadata`() {
    val state = LayoutInspectorState()

    state.updateScreenshot(
      data = byteArrayOf(1),
      width = 100,
      height = 200,
      timestamp = 1L,
      fallback = true,
      fallbackReason = "websocket_unavailable",
      format = "png",
      captureSource = "android_adb_screencap",
    )

    assertEquals(true, state.screenshotFallback)
    assertEquals("websocket_unavailable", state.screenshotFallbackReason)
    assertEquals("png", state.screenshotFormat)
    assertEquals("android_adb_screencap", state.screenshotCaptureSource)
  }

  @Test
  fun `a later update without fallback clears a previously reported fallback`() {
    val state = LayoutInspectorState()
    state.updateScreenshot(
      data = byteArrayOf(1),
      width = 100,
      height = 200,
      timestamp = 1L,
      fallback = true,
      fallbackReason = "websocket_unavailable",
    )

    state.updateScreenshot(data = byteArrayOf(2), width = 100, height = 200, timestamp = 2L)

    assertFalse(state.screenshotFallback)
    assertNull(state.screenshotFallbackReason)
  }

  @Test
  fun `disconnect clears screenshot metadata`() {
    val state = LayoutInspectorState()
    state.updateScreenshot(
      data = byteArrayOf(1),
      width = 100,
      height = 200,
      timestamp = 1L,
      fallback = true,
      fallbackReason = "websocket_unavailable",
      format = "png",
      captureSource = "android_adb_screencap",
    )

    state.disconnect()

    assertFalse(state.screenshotFallback)
    assertNull(state.screenshotFallbackReason)
    assertNull(state.screenshotFormat)
    assertNull(state.screenshotCaptureSource)
  }
}
