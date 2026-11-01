package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.view.accessibility.AccessibilityWindowInfo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PrototypeForegroundReadTest {
  private val app = AccessibilityWindowInfo.TYPE_APPLICATION
  private val failures = mutableListOf<Exception>()

  private fun read(windows: () -> List<PrototypeForegroundWindow>) =
    prototypeForegroundOrUnscoped(windows, ownPackage = "dev.automobile") { failures += it }

  @Test
  fun `a readable window list yields the foreground app`() {
    val foreground = read {
      listOf(
        PrototypeForegroundWindow(app, false, "com.example.top"),
        PrototypeForegroundWindow(app, true, "com.example.active"),
      )
    }

    assertEquals("com.example.active", foreground)
    assertTrue(failures.isEmpty())
  }

  @Test
  fun `no qualifying window leaves the prototype unscoped without a report`() {
    assertNull(read { listOf(PrototypeForegroundWindow(app, true, "dev.automobile")) })
    assertTrue(failures.isEmpty())
  }

  @Test
  fun `an unreadable window list leaves the prototype unscoped and is reported`() {
    val foreground = read { throw IllegalStateException("binder died") }

    assertNull("the prototype is shown everywhere rather than hidden", foreground)
    assertEquals(listOf("binder died"), failures.map { it.message })
  }
}
