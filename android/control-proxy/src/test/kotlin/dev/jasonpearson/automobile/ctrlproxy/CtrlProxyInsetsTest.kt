package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.ctrlproxy.models.DisplayCutoutInfo
import dev.jasonpearson.automobile.ctrlproxy.models.ElementBounds
import dev.jasonpearson.automobile.ctrlproxy.models.ObservationInsetsInfo
import dev.jasonpearson.automobile.ctrlproxy.models.SystemBarsInsetsInfo
import dev.jasonpearson.automobile.ctrlproxy.models.SystemChromeInfo
import dev.jasonpearson.automobile.ctrlproxy.models.SystemInsetsInfo
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class CtrlProxyInsetsTest {

  @Test
  fun `legacy system insets preserve system gesture exclusion edges`() {
    val bars = SystemInsetsInfo(top = 24, bottom = 48)
    val result =
      CtrlProxy.legacySystemInsets(
        ObservationInsetsInfo(
          systemBars = SystemBarsInsetsInfo(visible = bars, stable = bars),
          systemGestures = SystemInsetsInfo(left = 32, right = 32),
        )
      )

    assertEquals(SystemInsetsInfo(top = 24, bottom = 48, left = 32, right = 32), result)
  }

  @Test
  fun `system chrome classifies all combinations of status and navigation visibility`() {
    assertEquals(
      SystemChromeInfo(
        visibility = "visible",
        statusBar = "visible",
        navigationBar = "visible",
        source = "android-window-insets",
      ),
      SystemChromeInfo.fromAndroidBars(statusBarVisible = true, navigationBarVisible = true),
    )
    assertEquals(
      SystemChromeInfo(
        visibility = "partial",
        statusBar = "visible",
        navigationBar = "hidden",
        source = "android-window-insets",
      ),
      SystemChromeInfo.fromAndroidBars(statusBarVisible = true, navigationBarVisible = false),
    )
    assertEquals(
      SystemChromeInfo(
        visibility = "partial",
        statusBar = "hidden",
        navigationBar = "visible",
        source = "android-window-insets",
      ),
      SystemChromeInfo.fromAndroidBars(statusBarVisible = false, navigationBarVisible = true),
    )
    assertEquals(
      SystemChromeInfo(
        visibility = "hidden",
        statusBar = "hidden",
        navigationBar = "hidden",
        source = "android-window-insets",
      ),
      SystemChromeInfo.fromAndroidBars(statusBarVisible = false, navigationBarVisible = false),
    )
  }

  @Test
  fun `display cutout classifier reports no cutout and unavailable metadata explicitly`() {
    assertEquals(
      DisplayCutoutInfo(classification = "none"),
      DisplayCutoutInfo.none(),
    )
    assertEquals(
      DisplayCutoutInfo(classification = "unknown"),
      DisplayCutoutInfo.unknown(),
    )
  }

  @Test
  fun `display cutout classifier reports broad edge obstruction as a notch`() {
    val bounds = listOf(ElementBounds(left = 360, top = 0, right = 720, bottom = 100))

    assertEquals(
      DisplayCutoutInfo(classification = "notch", bounds = bounds),
      DisplayCutoutInfo.fromBoundingRects(screenWidth = 1080, screenHeight = 2400, bounds = bounds),
    )
  }

  @Test
  fun `display cutout classifier reports small inset obstruction as a hole punch across rotation`() {
    val portraitBounds = listOf(ElementBounds(left = 480, top = 30, right = 600, bottom = 150))
    val landscapeBounds = listOf(ElementBounds(left = 30, top = 480, right = 150, bottom = 600))

    assertEquals(
      DisplayCutoutInfo(classification = "hole_punch", bounds = portraitBounds),
      DisplayCutoutInfo.fromBoundingRects(
        screenWidth = 1080,
        screenHeight = 2400,
        bounds = portraitBounds,
      ),
    )
    assertEquals(
      DisplayCutoutInfo(classification = "hole_punch", bounds = landscapeBounds),
      DisplayCutoutInfo.fromBoundingRects(
        screenWidth = 2400,
        screenHeight = 1080,
        bounds = landscapeBounds,
      ),
    )
  }

  @Test
  fun `display cutout classifier leaves small edge obstruction unknown`() {
    val bounds = listOf(ElementBounds(left = 480, top = 0, right = 600, bottom = 100))

    assertEquals(
      DisplayCutoutInfo(classification = "unknown", bounds = bounds),
      DisplayCutoutInfo.fromBoundingRects(screenWidth = 1080, screenHeight = 2400, bounds = bounds),
    )
  }

  @Test
  fun `display cutout classifier preserves ambiguous geometry as unknown`() {
    val bounds =
      listOf(
        ElementBounds(left = 0, top = 100, right = 80, bottom = 300),
        ElementBounds(left = 1000, top = 100, right = 1080, bottom = 300),
      )

    assertEquals(
      DisplayCutoutInfo(classification = "unknown", bounds = bounds),
      DisplayCutoutInfo.fromBoundingRects(screenWidth = 1080, screenHeight = 2400, bounds = bounds),
    )
  }
}
