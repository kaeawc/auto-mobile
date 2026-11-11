package dev.jasonpearson.automobile.ctrlproxy

import android.graphics.Point
import android.graphics.Rect
import android.hardware.display.DisplayManager
import android.view.Display
import android.view.WindowManager
import dev.jasonpearson.automobile.ctrlproxy.models.ObservationInsetsInfo
import dev.jasonpearson.automobile.ctrlproxy.models.ScreenDimensions
import io.mockk.every
import io.mockk.mockk
import io.mockk.verify
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class DisplayControllerScreenDimensionsApi34Test {
  private class FakeHost : DisplayController.Host {
    var displayManager: DisplayManager? = null
    var windowManager: WindowManager? = null
    private val insets =
      object : DisplayInsetsProvider {
        override fun insetsFor(displayId: Int, screenDimensions: ScreenDimensions?) =
          ObservationInsetsInfo(source = "fake-$displayId")
      }

    override fun displayManager() = displayManager

    override fun windowManager() = windowManager

    override fun displayInsetsProvider(): DisplayInsetsProvider = insets

    override fun frameworkDimenPx(name: String) = 0

    override fun densityDpi() = 420
  }

  private fun realDisplay(width: Int, height: Int): Display = mockk {
    every { getRealSize(any()) } answers { firstArg<Point>().set(width, height) }
  }

  private fun displayManagerWith(displayId: Int, display: Display?): DisplayManager = mockk {
    every { getDisplay(displayId) } returns display
  }

  private fun windowManagerWithImeFrame(): WindowManager = mockk {
    every { currentWindowMetrics } returns mockk { every { bounds } returns Rect(0, 0, 1080, 608) }
    every { maximumWindowMetrics } returns mockk { every { bounds } returns Rect(0, 0, 2560, 2558) }
  }

  @Test
  fun defaultDisplayUsesRealSizeInsteadOfImeFrame() {
    val host =
      FakeHost().apply {
        displayManager = displayManagerWith(Display.DEFAULT_DISPLAY, realDisplay(2560, 2558))
        windowManager = windowManagerWithImeFrame()
      }

    assertEquals(ScreenDimensions(2560, 2558), DisplayController(host).getScreenDimensions())
    verify(exactly = 0) { host.windowManager!!.currentWindowMetrics }
    verify(exactly = 0) { host.windowManager!!.maximumWindowMetrics }
  }

  @Test
  fun phoneUsesRealSizeWithoutWindowManager() {
    val host =
      FakeHost().apply {
        displayManager = displayManagerWith(Display.DEFAULT_DISPLAY, realDisplay(1080, 2400))
      }

    assertEquals(ScreenDimensions(1080, 2400), DisplayController(host).getScreenDimensions())
  }

  @Test
  fun secondaryDisplayUsesItsRealSize() {
    val host =
      FakeHost().apply {
        displayManager = displayManagerWith(2, realDisplay(1920, 1080))
        windowManager = windowManagerWithImeFrame()
      }

    assertEquals(ScreenDimensions(1920, 1080), DisplayController(host).getScreenDimensions(2))
  }

  @Test
  fun missingSecondaryDisplayReturnsNullInsteadOfDefaultDisplayBounds() {
    val host =
      FakeHost().apply {
        displayManager = displayManagerWith(2, null)
        windowManager = windowManagerWithImeFrame()
      }

    assertNull(DisplayController(host).getScreenDimensions(2))
    host.displayManager = null
    assertNull(DisplayController(host).getScreenDimensions(2))
  }

  @Test
  fun defaultDisplayWithoutDisplayManagerUsesMaximumBoundsInsteadOfImeFrame() {
    val host = FakeHost().apply { windowManager = windowManagerWithImeFrame() }

    assertEquals(ScreenDimensions(2560, 2558), DisplayController(host).getScreenDimensions())
    verify(exactly = 0) { host.windowManager!!.currentWindowMetrics }
  }

  @Test
  fun missingDefaultDisplayUsesMaximumBounds() {
    val host =
      FakeHost().apply {
        displayManager = displayManagerWith(Display.DEFAULT_DISPLAY, null)
        windowManager = windowManagerWithImeFrame()
      }

    assertEquals(ScreenDimensions(2560, 2558), DisplayController(host).getScreenDimensions())
    verify(exactly = 0) { host.windowManager!!.currentWindowMetrics }
  }

  @Test
  fun unavailableDefaultDisplayAndWindowManagerReturnNull() {
    assertNull(DisplayController(FakeHost()).getScreenDimensions())
    val host =
      FakeHost().apply { displayManager = displayManagerWith(Display.DEFAULT_DISPLAY, null) }
    assertNull(DisplayController(host).getScreenDimensions())
  }

  @Test
  fun landscapeRealSizeIsReturnedAsIs() {
    val host =
      FakeHost().apply {
        displayManager = displayManagerWith(Display.DEFAULT_DISPLAY, realDisplay(2400, 1080))
      }

    assertEquals(ScreenDimensions(2400, 1080), DisplayController(host).getScreenDimensions())
  }

  @Test
  fun realSizeIsReadAgainAfterFoldStateChanges() {
    val display = realDisplay(2208, 1840)
    val host =
      FakeHost().apply { displayManager = displayManagerWith(Display.DEFAULT_DISPLAY, display) }
    val controller = DisplayController(host)
    assertEquals(ScreenDimensions(2208, 1840), controller.getScreenDimensions())

    every { display.getRealSize(any()) } answers { firstArg<Point>().set(1080, 2092) }

    assertEquals(ScreenDimensions(1080, 2092), controller.getScreenDimensions())
  }
}
