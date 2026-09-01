package dev.jasonpearson.automobile.desktop.core.workspace.picker

import dev.jasonpearson.automobile.desktop.core.daemon.ScreenshotStreamUpdate
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class DeviceThumbnailFrameFilterTest {

  private fun frame(deviceId: String?, screenshotBase64: String? = "aGk=") =
    ScreenshotStreamUpdate(
      deviceId = deviceId,
      timestamp = 1L,
      screenshotBase64 = screenshotBase64,
      screenWidth = 1080,
      screenHeight = 2340,
    )

  @Test
  fun `accepts only a non-empty frame stamped with this device's id`() {
    assertTrue(isThumbnailFrameFor("iphone-17", frame("iphone-17")))
  }

  @Test
  fun `rejects another device's frame so a fast android frame never fills an ios card`() {
    assertFalse(isThumbnailFrameFor("iphone-17", frame("am-api34-ga-arm64")))
  }

  @Test
  fun `rejects unstamped and empty frames`() {
    assertFalse(isThumbnailFrameFor("iphone-17", frame(null)))
    assertFalse(isThumbnailFrameFor("iphone-17", frame("iphone-17", screenshotBase64 = null)))
    assertFalse(isThumbnailFrameFor("iphone-17", frame("iphone-17", screenshotBase64 = "")))
  }
}
