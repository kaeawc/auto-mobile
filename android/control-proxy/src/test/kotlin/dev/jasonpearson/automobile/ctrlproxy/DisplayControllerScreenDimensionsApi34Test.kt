package dev.jasonpearson.automobile.ctrlproxy

import android.graphics.Point
import android.graphics.Rect
import android.hardware.display.DisplayManager
import android.view.Display
import android.view.Surface
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
    var xrSpatialDevice = false
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

    override fun isXrSpatialDevice() = xrSpatialDevice

    override fun densityDpi() = 420
  }

  private fun realDisplay(width: Int, height: Int): Display = mockk {
    every { getRealSize(any()) } answers { firstArg<Point>().set(width, height) }
  }

  private class FakePhysicalSizeReader(var size: Point? = Point(2560, 2558)) :
    DisplayPhysicalSizeReader {
    var calls = 0
      private set

    override fun read(display: Display): Point? {
      calls++
      return size
    }
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
  fun xrUsesPhysicalModeInsteadOfContaminatedRealSize() {
    val display = realDisplay(1080, 608)
    val reader = FakePhysicalSizeReader()
    every { display.rotation } returns Surface.ROTATION_0
    val host =
      FakeHost().apply {
        xrSpatialDevice = true
        displayManager = displayManagerWith(Display.DEFAULT_DISPLAY, display)
      }

    assertEquals(
      ScreenDimensions(2560, 2558),
      DisplayController(host, reader).getScreenDimensions(),
    )
    verify(exactly = 0) { display.getRealSize(any()) }
  }

  @Test
  fun nonXrUsesContaminatedRealSizeWithoutReadingPhysicalSize() {
    val display = realDisplay(1080, 608)
    val reader = FakePhysicalSizeReader()
    val host =
      FakeHost().apply { displayManager = displayManagerWith(Display.DEFAULT_DISPLAY, display) }

    assertEquals(ScreenDimensions(1080, 608), DisplayController(host, reader).getScreenDimensions())
    verify(exactly = 1) { display.getRealSize(any()) }
    assertEquals(0, reader.calls)
  }

  @Test
  fun xrSwapsPhysicalModeDimensionsForQuarterTurns() {
    val display = realDisplay(1080, 608)
    val reader = FakePhysicalSizeReader(Point(2558, 2560))
    val host =
      FakeHost().apply {
        xrSpatialDevice = true
        displayManager = displayManagerWith(Display.DEFAULT_DISPLAY, display)
      }

    for (rotation in listOf(Surface.ROTATION_90, Surface.ROTATION_270)) {
      every { display.rotation } returns rotation
      assertEquals(
        ScreenDimensions(2560, 2558),
        DisplayController(host, reader).getScreenDimensions(),
      )
    }
    verify(exactly = 0) { display.getRealSize(any()) }
  }

  @Test
  fun xrWithUnavailablePhysicalSizeFallsBackToRealSize() {
    val display = realDisplay(1080, 608)
    val reader = FakePhysicalSizeReader()
    val host =
      FakeHost().apply {
        xrSpatialDevice = true
        displayManager = displayManagerWith(Display.DEFAULT_DISPLAY, display)
      }

    val controller = DisplayController(host, reader)
    for (size in listOf(null, Point(0, 2558), Point(2560, 0), Point(-1, 2558), Point(2560, -1))) {
      reader.size = size
      assertEquals(ScreenDimensions(1080, 608), controller.getScreenDimensions())
    }
    assertEquals(5, reader.calls)
    verify(exactly = 5) { display.getRealSize(any()) }
    verify(exactly = 0) { display.rotation }
  }

  @Test
  fun xrMissingSecondaryDisplayReturnsNull() {
    val reader = FakePhysicalSizeReader()
    val host =
      FakeHost().apply {
        xrSpatialDevice = true
        displayManager = displayManagerWith(2, null)
        windowManager = windowManagerWithImeFrame()
      }

    assertNull(DisplayController(host, reader).getScreenDimensions(2))
    host.displayManager = null
    assertNull(DisplayController(host, reader).getScreenDimensions(2))
    assertEquals(0, reader.calls)
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
