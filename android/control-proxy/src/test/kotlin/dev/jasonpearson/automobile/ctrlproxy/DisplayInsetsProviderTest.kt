package dev.jasonpearson.automobile.ctrlproxy

import android.graphics.Insets
import android.graphics.Rect
import android.os.Build
import android.view.DisplayCutout
import android.view.WindowInsets
import dev.jasonpearson.automobile.ctrlproxy.models.DisplayCutoutInfo
import dev.jasonpearson.automobile.ctrlproxy.models.ElementBounds
import dev.jasonpearson.automobile.ctrlproxy.models.ObservationInsetsInfo
import dev.jasonpearson.automobile.ctrlproxy.models.ScreenDimensions
import dev.jasonpearson.automobile.ctrlproxy.models.SystemBarsInsetsInfo
import dev.jasonpearson.automobile.ctrlproxy.models.SystemChromeInfo
import dev.jasonpearson.automobile.ctrlproxy.models.SystemInsetsInfo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [30])
class DisplayInsetsProviderTest {
  private val dimensions = ScreenDimensions(width = 400, height = 800)

  @Test
  fun `API 30 maps visible and stable bars cutout gestures and chrome`() {
    val lookup = FakeWindowInsetsLookup(windowInsets())
    val provider = WindowMetricsDisplayInsetsProvider(Build.VERSION_CODES.R, lookup::insetsFor)

    assertEquals(expectedInsets(), provider.insetsFor(2, dimensions))
    assertEquals(listOf(2), lookup.requestedDisplayIds)
  }

  @Test
  @Config(sdk = [33])
  fun `API 33 preserves the same complete mapping`() {
    val lookup = FakeWindowInsetsLookup(windowInsets())
    val provider =
      WindowMetricsDisplayInsetsProvider(Build.VERSION_CODES.TIRAMISU, lookup::insetsFor)

    assertEquals(expectedInsets(), provider.insetsFor(7, dimensions))
    assertEquals(listOf(7), lookup.requestedDisplayIds)
  }

  @Test
  @Config(sdk = [29])
  fun `API 29 is unavailable without consulting the lookup`() {
    val lookup = FakeWindowInsetsLookup(failure = IllegalStateException("must not be called"))
    val provider = WindowMetricsDisplayInsetsProvider(Build.VERSION_CODES.Q, lookup::insetsFor)

    assertEquals(unavailableInsets(), provider.insetsFor(2, dimensions))
    assertEquals(emptyList<Int>(), lookup.requestedDisplayIds)
  }

  @Test
  @Config(sdk = [24])
  fun `API 24 is unavailable without consulting the lookup`() {
    val lookup = FakeWindowInsetsLookup()
    val provider = WindowMetricsDisplayInsetsProvider(Build.VERSION_CODES.N, lookup::insetsFor)

    assertEquals(unavailableInsets(), provider.insetsFor(2, dimensions))
    assertEquals(emptyList<Int>(), lookup.requestedDisplayIds)
  }

  @Test
  fun `missing display returns the unchanged unavailable object`() {
    val lookup = FakeWindowInsetsLookup()
    val provider = WindowMetricsDisplayInsetsProvider(Build.VERSION_CODES.R, lookup::insetsFor)

    assertEquals(unavailableInsets(), provider.insetsFor(9, dimensions))
    assertEquals(listOf(9), lookup.requestedDisplayIds)
  }

  @Test
  fun `lookup exception returns unavailable without escaping`() {
    val lookup = FakeWindowInsetsLookup(failure = IllegalStateException("display removed"))
    val provider = WindowMetricsDisplayInsetsProvider(Build.VERSION_CODES.R, lookup::insetsFor)

    assertEquals(unavailableInsets(), provider.insetsFor(2, dimensions))
    assertEquals(listOf(2), lookup.requestedDisplayIds)
  }

  @Test
  fun `each capture looks up only its requested display and does not reuse stale insets`() {
    val lookup = FakeWindowInsetsLookup(windowInsets())
    val provider = WindowMetricsDisplayInsetsProvider(Build.VERSION_CODES.R, lookup::insetsFor)

    assertEquals(expectedInsets(), provider.insetsFor(2, dimensions))
    lookup.result = null
    assertEquals(unavailableInsets(), provider.insetsFor(7, dimensions))
    assertEquals(unavailableInsets(), provider.insetsFor(2, dimensions))
    assertEquals(listOf(2, 7, 2), lookup.requestedDisplayIds)
  }

  @Test
  fun `legacy system insets merge stable bars with larger gesture edges`() {
    val lookup = FakeWindowInsetsLookup(windowInsets())
    val provider = WindowMetricsDisplayInsetsProvider(Build.VERSION_CODES.R, lookup::insetsFor)

    assertEquals(
      SystemInsetsInfo(top = 24, bottom = 64, left = 12, right = 16),
      CtrlProxy.legacySystemInsets(provider.insetsFor(2, dimensions)),
    )
    lookup.result = null
    assertNull(CtrlProxy.legacySystemInsets(provider.insetsFor(2, dimensions)))
  }

  @Test
  fun `default display mapper preserves the old inline snapshot`() {
    assertEquals(expectedInsets(), observationInsetsFromWindowInsets(windowInsets(), dimensions))
  }

  @Test
  fun `mapper reports no cutout and fully hidden chrome`() {
    val insets =
      WindowInsets.Builder()
        .setInsets(WindowInsets.Type.systemBars(), Insets.NONE)
        .setInsetsIgnoringVisibility(WindowInsets.Type.statusBars(), Insets.of(0, 24, 0, 0))
        .setInsetsIgnoringVisibility(WindowInsets.Type.navigationBars(), Insets.of(0, 0, 0, 48))
        .setVisible(WindowInsets.Type.systemBars(), false)
        .build()

    val result = observationInsetsFromWindowInsets(insets, dimensions)

    assertEquals(
      SystemBarsInsetsInfo(
        visible = SystemInsetsInfo(),
        stable = SystemInsetsInfo(top = 24, bottom = 48),
      ),
      result.systemBars,
    )
    assertEquals(DisplayCutoutInfo.none(), result.displayCutoutInfo)
    assertEquals(SystemInsetsInfo(), result.displayCutout)
    assertEquals(
      SystemChromeInfo(
        visibility = "hidden",
        statusBar = "hidden",
        navigationBar = "hidden",
        source = "android-window-insets",
      ),
      result.systemChrome,
    )
  }

  @Test
  fun `cutout classification uses the requested screen dimensions`() {
    val insets = windowInsets()

    assertEquals(
      DisplayCutoutInfo(classification = "unknown", bounds = listOf(cutoutBounds())),
      observationInsetsFromWindowInsets(insets, ScreenDimensions(2000, 800)).displayCutoutInfo,
    )
    assertEquals(
      DisplayCutoutInfo.unknown(),
      observationInsetsFromWindowInsets(insets, null).displayCutoutInfo,
    )
  }

  private fun windowInsets(): WindowInsets =
    WindowInsets.Builder()
      .setDisplayCutout(
        DisplayCutout(Insets.of(0, 60, 0, 0), null, Rect(120, 0, 280, 60), null, null),
      )
      .setInsets(WindowInsets.Type.displayCutout(), Insets.of(0, 60, 0, 0))
      .setInsetsIgnoringVisibility(WindowInsets.Type.displayCutout(), Insets.of(0, 60, 0, 0))
      .setInsets(WindowInsets.Type.statusBars(), Insets.of(0, 24, 0, 0))
      .setInsetsIgnoringVisibility(WindowInsets.Type.statusBars(), Insets.of(0, 24, 0, 0))
      .setVisible(WindowInsets.Type.statusBars(), true)
      .setInsets(WindowInsets.Type.navigationBars(), Insets.NONE)
      .setInsetsIgnoringVisibility(WindowInsets.Type.navigationBars(), Insets.of(0, 0, 0, 48))
      .setVisible(WindowInsets.Type.navigationBars(), false)
      .setInsets(WindowInsets.Type.systemGestures(), Insets.of(12, 4, 16, 64))
      .setInsets(WindowInsets.Type.mandatorySystemGestures(), Insets.of(3, 0, 5, 20))
      .setInsets(WindowInsets.Type.tappableElement(), Insets.of(0, 0, 0, 8))
      .build()

  private fun expectedInsets(): ObservationInsetsInfo =
    ObservationInsetsInfo(
      available = true,
      source = "android-window-metrics",
      units = "physical-pixels",
      systemBars =
        SystemBarsInsetsInfo(
          visible = SystemInsetsInfo(top = 24),
          stable = SystemInsetsInfo(top = 24, bottom = 48),
        ),
      displayCutout = SystemInsetsInfo(top = 60),
      displayCutoutInfo =
        DisplayCutoutInfo(classification = "notch", bounds = listOf(cutoutBounds())),
      systemGestures = SystemInsetsInfo(top = 4, bottom = 64, left = 12, right = 16),
      mandatorySystemGestures = SystemInsetsInfo(bottom = 20, left = 3, right = 5),
      tappableElement = SystemInsetsInfo(bottom = 8),
      systemChrome =
        SystemChromeInfo(
          visibility = "partial",
          statusBar = "visible",
          navigationBar = "hidden",
          source = "android-window-insets",
        ),
    )

  private fun cutoutBounds(): ElementBounds = ElementBounds(120, 0, 280, 60)

  private fun unavailableInsets(): ObservationInsetsInfo =
    ObservationInsetsInfo(
      available = false,
      source = "unavailable",
      units = "unknown",
      displayCutoutInfo = DisplayCutoutInfo.unknown(),
    )

  private class FakeWindowInsetsLookup(
    var result: WindowInsets? = null,
    private val failure: Exception? = null,
  ) {
    val requestedDisplayIds = mutableListOf<Int>()

    fun insetsFor(displayId: Int): WindowInsets? {
      requestedDisplayIds.add(displayId)
      failure?.let { throw it }
      return result
    }
  }
}
