package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The non-default-display floor for prototypes, per API level (#9934 item 4). */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [30])
class PrototypeDisplayRoutingTest {
  private val context: Context = ApplicationProvider.getApplicationContext()

  private fun displays(sdkInt: Int) = AndroidPrototypeDisplays(context, sdkInt)

  @Test
  fun `the default display is supported on every API level`() {
    for (sdk in 26..37) {
      assertNull("API $sdk", displays(sdk).unsupportedReason(0))
      assertNull("API $sdk", PrototypeDisplayRouting.error(0, sdk))
    }
  }

  @Test
  fun `a non-default display is refused below the floor with a capability error`() {
    for (sdk in 26 until PrototypeDisplayRouting.DISPLAY_API) {
      val reason = displays(sdk).unsupportedReason(2)
      assertNotNull("API $sdk", reason)
      assertTrue(reason.orEmpty().contains("API ${PrototypeDisplayRouting.DISPLAY_API}"))
      assertTrue(reason.orEmpty().contains("API $sdk"))
    }
  }

  @Test
  fun `a non-default display is allowed at and above the floor`() {
    for (sdk in PrototypeDisplayRouting.DISPLAY_API..37) {
      assertNull("API $sdk", displays(sdk).unsupportedReason(2))
    }
  }

  @Test
  fun `API 30 and 31 are below the floor`() {
    assertEquals(true, PrototypeDisplayRouting.error(1, 30) != null)
    assertEquals(true, PrototypeDisplayRouting.error(2, 31) != null)
  }
}
