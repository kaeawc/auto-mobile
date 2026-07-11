package dev.jasonpearson.automobile.ctrlproxy

import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class WebSocketServerMaxFrameSizeTest {

  /**
   * The inbound frame-size cap must be bounded. `Long.MAX_VALUE` disabled ktor's default cap, so a
   * single hostile frame advertising a multi-GB length would be buffered into memory ->
   * OutOfMemoryError (issue #3711). It must be a sane maximum: above any legitimate payload, far
   * below unbounded.
   */
  @Test
  fun `max frame size is bounded, not Long MAX_VALUE`() {
    assertNotEquals(Long.MAX_VALUE, WebSocketServer.MAX_FRAME_SIZE_BYTES)
    assertTrue(
      "cap should be a sane size (1 MiB..1 GiB), was ${WebSocketServer.MAX_FRAME_SIZE_BYTES}",
      WebSocketServer.MAX_FRAME_SIZE_BYTES in (1L shl 20)..(1L shl 30),
    )
  }
}
