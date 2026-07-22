package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.ctrlproxy.models.ObservationInsetsInfo
import dev.jasonpearson.automobile.ctrlproxy.models.SystemBarsInsetsInfo
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
}
