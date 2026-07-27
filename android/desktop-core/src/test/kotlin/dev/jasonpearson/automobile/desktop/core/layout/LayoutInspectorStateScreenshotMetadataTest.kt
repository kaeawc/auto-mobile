package dev.jasonpearson.automobile.desktop.core.layout

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
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
  fun `updateScreenshot records the source device and disconnect clears it`() {
    val state = LayoutInspectorState()
    assertNull(state.renderedDeviceId)

    state.updateScreenshot(
      data = byteArrayOf(1),
      width = 100,
      height = 200,
      timestamp = 1L,
      deviceId = "emulator-5554",
    )
    assertEquals("emulator-5554", state.renderedDeviceId)

    state.disconnect()
    assertNull(state.renderedDeviceId)
  }

  @Test
  fun `updateScreenshot records capture-time rotation and invalidation clears it`() {
    val state = LayoutInspectorState()

    state.updateScreenshot(
      data = byteArrayOf(1),
      width = 2340,
      height = 1080,
      timestamp = 1L,
      deviceId = "emulator-5554",
      rotation = 1,
    )
    assertEquals(1, state.renderedScreenshotRotation)
    assertEquals(1, state.screenshotFacts?.rotation)

    state.invalidateRenderedDeviceIdentity()
    assertNull(state.renderedScreenshotRotation)
    assertNull(state.screenshotFacts)
  }

  @Test
  fun `updateHierarchy records the source device and disconnect clears it`() {
    val state = LayoutInspectorState()

    state.updateHierarchy(
      newHierarchy = LayoutInspectorMockData.mockHierarchy,
      deviceId = "emulator-5554",
    )
    assertEquals("emulator-5554", state.renderedHierarchyDeviceId)

    state.disconnect()
    assertNull(state.renderedHierarchyDeviceId)
  }

  @Test
  fun `invalidateRenderedDeviceIdentity clears both device ids but keeps the frame`() {
    val state = LayoutInspectorState()
    state.updateScreenshot(
      data = byteArrayOf(1),
      width = 100,
      height = 200,
      timestamp = 1L,
      deviceId = "emulator-5554",
    )
    state.updateHierarchy(
      newHierarchy = LayoutInspectorMockData.mockHierarchy,
      deviceId = "emulator-5554",
    )

    state.invalidateRenderedDeviceIdentity()

    assertNull(state.renderedDeviceId)
    assertNull(state.renderedHierarchyDeviceId)
    // The frame is retained for inspection.
    assertNotNull(state.screenshotData)
    assertNotNull(state.hierarchy)
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
