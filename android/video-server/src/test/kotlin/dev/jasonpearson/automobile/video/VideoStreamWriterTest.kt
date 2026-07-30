package dev.jasonpearson.automobile.video

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class VideoStreamWriterTest {
  @Test
  fun scratchBufferGrowsOnceAndIsReusedForSmallerFrames() {
    // Inter frames reuse a growable scratch buffer instead of allocating per frame.
    val first = growScratch(ByteArray(0), size = 1_024)
    assertEquals(1_024, first.size)

    // A smaller subsequent frame reuses the same array — no new allocation.
    val reused = growScratch(first, size = 512)
    assertSame(first, reused)

    // Only a larger frame forces a single reallocation.
    val grown = growScratch(reused, size = 2_048)
    assertNotSame(reused, grown)
    assertEquals(2_048, grown.size)
  }

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
