package dev.jasonpearson.automobile.ctrlproxy

import android.hardware.display.DisplayManager
import android.view.Display
import android.view.WindowManager
import dev.jasonpearson.automobile.ctrlproxy.models.ObservationInsetsInfo
import dev.jasonpearson.automobile.ctrlproxy.models.ScreenDimensions
import io.mockk.every
import io.mockk.mockk
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [26])
class DisplayControllerTest {
  private class FakeHost : DisplayController.Host {
    var displayManager: DisplayManager? = null
    var windowManager: WindowManager? = null
    var density = 420
    var densityFailure: RuntimeException? = null
    val dimens = mutableMapOf<String, Int>()
    val insets =
      object : DisplayInsetsProvider {
        override fun insetsFor(displayId: Int, screenDimensions: ScreenDimensions?) =
          ObservationInsetsInfo(source = "fake-$displayId")
      }

    override fun displayManager() = displayManager

    override fun windowManager() = windowManager

    override fun displayInsetsProvider(): DisplayInsetsProvider = insets

    override fun frameworkDimenPx(name: String) = dimens[name] ?: 0

    override fun densityDpi(): Int = densityFailure?.let { throw it } ?: density
  }

  private fun windowManagerWithRotation(rotation: Int, width: Int, height: Int): WindowManager {
    val display = mockk<Display>()
    every { display.rotation } returns rotation
    every { display.getRealMetrics(any()) } answers
      {
        firstArg<android.util.DisplayMetrics>().apply {
          widthPixels = width
          heightPixels = height
        }
      }
    return mockk { every { defaultDisplay } returns display }
  }

  @Test
  fun screenDimensionsUseRealMetricsBelowApi30() {
    val host = FakeHost().apply { windowManager = windowManagerWithRotation(0, 1080, 2400) }
    assertEquals(ScreenDimensions(1080, 2400), DisplayController(host).getScreenDimensions())
  }

  @Test
  fun screenDimensionsAreNullWithoutWindowManager() {
    assertNull(DisplayController(FakeHost()).getScreenDimensions())
  }

  @Test
  fun rotationReadsDefaultDisplayAndFallsBackToZero() {
    val host = FakeHost().apply { windowManager = windowManagerWithRotation(3, 1, 1) }
    assertEquals(3, DisplayController(host).getRotationOrNull())
    assertEquals(3, DisplayController(host).getRotation())
    val missing = DisplayController(FakeHost())
    assertNull(missing.getRotationOrNull())
    assertEquals(0, missing.getRotation())
  }

  @Test
  fun nonDefaultDisplayInsetsUseTheProvider() {
    val host = FakeHost()
    assertEquals("fake-2", DisplayController(host).getObservationInsets(null, 2).source)
    assertSame(host.insets, host.displayInsetsProvider())
  }

  @Test
  fun defaultDisplayInsetsFallBackToFrameworkDimensBelowApi30() {
    val host =
      FakeHost().apply {
        windowManager = windowManagerWithRotation(0, 1, 1)
        dimens["status_bar_height"] = 63
        dimens["navigation_bar_height"] = 126
      }
    val insets = DisplayController(host).getObservationInsets(null)
    assertEquals("android-resource-fallback", insets.source)
    assertEquals(63, insets.systemBars?.stable?.top)
    assertEquals(126, insets.systemBars?.stable?.bottom)
  }

  @Test
  fun densityIsZeroWhenReadFails() {
    val host = FakeHost()
    assertEquals(420, DisplayController(host).getDensity())
    host.densityFailure = IllegalStateException("no resources")
    assertEquals(0, DisplayController(host).getDensity())
  }

  @Test
  fun panelIdentityIsAbsentWithoutDisplay() {
    val controller = DisplayController(FakeHost())
    assertNull(controller.panelUniqueId(1))
    assertNull(controller.panelFingerprint(1))
    assertEquals("fake-1", controller.getObservationInsets(null, 1).source)
  }
}
