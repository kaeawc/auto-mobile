package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.util.Log
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.shadows.ShadowLog

/**
 * #14149: the library ships no keep rule, so an unresolvable (stripped) icon must be diagnosable.
 */
@RunWith(RobolectricTestRunner::class)
class PrototypeIconsTest {
  private fun warnings(): List<String> =
    ShadowLog.getLogsForTag("PrototypeIcons").filter { it.type == Log.WARN }.map { it.msg }

  @Test
  fun `a bundled icon resolves in every style without a warning`() {
    ShadowLog.clear()
    listOf(null, "filled", "outlined", "rounded", "sharp", "twoTone").forEach {
      assertNotNull(prototypeIcon("home", it))
    }
    assertEquals(emptyList<String>(), warnings())
  }

  @Test
  fun `a name that resolves in no style is null and warned once`() {
    ShadowLog.clear()
    assertNull(prototypeIcon("stripped_icon_probe"))
    assertNull(prototypeIcon("stripped_icon_probe"))
    assertEquals(1, warnings().size)
    assertEquals(true, warnings().single().contains("stripped_icon_probe"))
  }

  @Test
  fun `a malformed name is null without a warning`() {
    ShadowLog.clear()
    assertNull(prototypeIcon("Not-An-Icon"))
    assertNull(prototypeIcon(null))
    assertEquals(emptyList<String>(), warnings())
  }
}
