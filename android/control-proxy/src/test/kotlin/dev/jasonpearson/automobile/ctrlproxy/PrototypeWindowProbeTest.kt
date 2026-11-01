package dev.jasonpearson.automobile.ctrlproxy

import android.os.Build
import android.view.Display
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PrototypeWindowProbeTest {
  /**
   * The accessibility windows a device reports, as "title:package" strings ("-" for an untitled
   * window, a null package for an unreadable root), logging which source each probe read.
   */
  private class FakeWindows : PrototypeWindowProbe.Source<String> {
    var legacy: List<String>? = emptyList()
    val perDisplay = mutableMapOf<Int, List<String>>()
    var failWith: RuntimeException? = null
    val reads = mutableListOf<String>()

    override fun legacyWindows(): List<String>? {
      reads += "legacy"
      failWith?.let { throw it }
      return legacy
    }

    override fun displayWindows(displayId: Int): List<String> {
      reads += "display:$displayId"
      failWith?.let { throw it }
      return perDisplay[displayId].orEmpty()
    }

    override fun hasTitle(window: String) = !window.startsWith("-")

    override fun rootPackage(window: String) =
      window.substringAfter(':').takeUnless { it == "null" }
  }

  private val windows = FakeWindows()
  private val failures = mutableListOf<Exception>()

  private fun probe(sdkInt: Int) =
    PrototypeWindowProbe(
      sdkInt = sdkInt,
      source = windows,
      ownPackage = "dev.automobile",
      onFailure = { failures += it },
    )

  @Test
  fun `from Android 11 each display's own windows are read`() {
    windows.perDisplay[2] = listOf("-:dev.automobile", "prototype:dev.automobile")

    assertEquals(true, probe(Build.VERSION_CODES.R).isOnScreen(2))
    assertEquals(false, probe(Build.VERSION_CODES.R).isOnScreen(0))
    assertEquals(listOf("display:2", "display:0"), windows.reads)
  }

  @Test
  fun `before Android 11 only the default display's window list is known`() {
    windows.legacy = listOf("prototype:dev.automobile")
    val probe = probe(Build.VERSION_CODES.Q)

    assertEquals(true, probe.isOnScreen(Display.DEFAULT_DISPLAY))
    assertNull("another display cannot be told apart", probe.isOnScreen(3))
    assertTrue("the per-display API is never called", windows.reads.none { it.startsWith("d") })
  }

  @Test
  fun `an unavailable or unreadable window list never claims absence`() {
    windows.legacy = null
    assertNull(probe(Build.VERSION_CODES.Q).isOnScreen(Display.DEFAULT_DISPLAY))

    windows.perDisplay[0] = listOf("prototype:null", "other:com.example")
    assertNull(probe(Build.VERSION_CODES.R).isOnScreen(0))
    assertTrue(failures.isEmpty())
  }

  @Test
  fun `a failed read is unknown and reported`() {
    windows.failWith = IllegalStateException("binder died")

    assertNull(probe(Build.VERSION_CODES.R).isOnScreen(0))
    assertNull(probe(Build.VERSION_CODES.Q).isOnScreen(0))
    assertEquals(2, failures.size)
  }
}
