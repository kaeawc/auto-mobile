package dev.jasonpearson.automobile.ctrlproxy.prototype

import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

class PrototypeIconCaptureTest {
  @Test
  fun `capture confirms frames at rest and always releases on failure`() = runBlocking {
    val owner = Any()
    PrototypeIconCapture.registerLoop(owner)
    var frames = 0
    val waiter = PrototypeFrameWaiter { count ->
      assertTrue(PrototypeIconCapture.held.value)
      frames += count
    }
    val result =
      PrototypeIconCapture.atRest(waiter) {
        assertTrue(PrototypeIconCapture.held.value)
        42
      }
    assertEquals(42, result)
    assertEquals(2, frames)
    assertFalse(PrototypeIconCapture.held.value)
    val failure = runCatching {
      PrototypeIconCapture.atRest(waiter) { error("capture failed") }
    }
      .exceptionOrNull()
    assertEquals("capture failed", failure?.message)
    PrototypeIconCapture.releaseLoop(owner)
    assertFalse(PrototypeIconCapture.held.value)
  }
}
