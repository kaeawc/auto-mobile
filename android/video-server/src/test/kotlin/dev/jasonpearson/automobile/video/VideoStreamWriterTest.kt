package dev.jasonpearson.automobile.video

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class VideoStreamWriterTest {
  @Test
  fun reconnectWindowUsesElapsedTimeDespiteWallClockJumps() {
    var elapsedRealtimeMs = 1_000L
    val window = ReconnectWindow({ elapsedRealtimeMs }, durationMs = 10_000L)

    window.start()
    window.onClientAttached()
    elapsedRealtimeMs = 2_000L
    window.onClientDetached()

    // Wall-clock changes do not affect the injected elapsed-time domain.
    elapsedRealtimeMs = 11_999L
    assertFalse(window.isExpired())

    elapsedRealtimeMs = 12_000L
    assertTrue(window.isExpired())
  }
}
