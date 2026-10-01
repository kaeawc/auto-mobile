package dev.jasonpearson.automobile.ctrlproxy

import org.junit.Assert.assertEquals
import org.junit.Test

class ServerLifecycleTest {
  @Test
  fun `unbind closes listener once before same-process replacement`() {
    val stopped = mutableListOf<String>()
    val lifecycle = ServerLifecycle<String> { stopped += it }

    lifecycle.replace("first")
    lifecycle.stop()
    lifecycle.stop() // onDestroy after onUnbind
    lifecycle.replace("second")
    lifecycle.stop()

    assertEquals(listOf("first", "second"), stopped)
  }

  @Test
  fun `replacement closes old listener before publishing the new one`() {
    val stopped = mutableListOf<Int>()
    val lifecycle = ServerLifecycle<Int> { stopped += it }

    lifecycle.replace(1)
    lifecycle.replace(2)
    assertEquals(listOf(1), stopped)
    lifecycle.stop()
    assertEquals(listOf(1, 2), stopped)
  }
}
