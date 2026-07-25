package dev.jasonpearson.automobile.ctrlproxy

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
}
