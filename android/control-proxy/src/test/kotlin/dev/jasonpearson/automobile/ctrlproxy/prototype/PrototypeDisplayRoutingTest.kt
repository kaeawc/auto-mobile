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
import org.robolectric.shadows.ShadowDisplayManager

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
    val present = ShadowDisplayManager.addDisplay("w800dp-h480dp")
    for (sdk in PrototypeDisplayRouting.DISPLAY_API..37) {
      assertNull("API $sdk", displays(sdk).unsupportedReason(present))
    }
  }

  @Test
  fun `API 30 and 31 are below the floor`() {
    assertEquals(true, PrototypeDisplayRouting.error(1, 30) != null)
    assertEquals(true, PrototypeDisplayRouting.error(2, 31) != null)
  }

  @Test
  fun `a display hot-plugged after the service bound is refused below the fixed API until it rebinds`() {
    val provider = displays(32)
    val hotPlugged = ShadowDisplayManager.addDisplay("w800dp-h480dp")
    val reason = provider.unsupportedReason(hotPlugged)
    assertTrue(reason.orEmpty().contains("connected after the accessibility service started"))
    assertNull(provider.unsupportedReason(0))
    provider.onServiceBound()
    assertNull(provider.unsupportedReason(hotPlugged))
  }

  @Test
  fun `a display hot-plugged after bind on API 35 is refused with an actionable message`() {
    val provider = displays(35)
    val hotPlugged = ShadowDisplayManager.addDisplay("w800dp-h480dp")
    val reason = provider.unsupportedReason(hotPlugged)
    assertTrue(reason.orEmpty().contains("connected after the accessibility service started"))
  }

  @Test
  fun `a display present when the service bound is allowed and the fixed API is unchanged`() {
    val present = ShadowDisplayManager.addDisplay("w800dp-h480dp")
    assertNull(displays(32).unsupportedReason(present))
    val later = ShadowDisplayManager.addDisplay("w800dp-h480dp")
    assertNull(displays(PrototypeDisplayHotPlug.FIXED_API).unsupportedReason(later))
  }

  @Test
  fun `the hot-plug check is a pure function of the bound display set`() {
    assertNull(PrototypeDisplayHotPlug.error(0, 32, emptySet()))
    assertNull(PrototypeDisplayHotPlug.error(3, 33, setOf(0, 3)))
    assertNotNull(PrototypeDisplayHotPlug.error(3, 33, setOf(0)))
    assertNotNull(PrototypeDisplayHotPlug.error(3, 34, setOf(0)))
    assertNotNull(PrototypeDisplayHotPlug.error(3, 35, setOf(0)))
    assertNull(PrototypeDisplayHotPlug.error(3, 36, setOf(0)))
  }
}
