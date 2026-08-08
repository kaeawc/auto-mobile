package dev.jasonpearson.automobile.video

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class VideoStatsAccumulatorTest {
  private class FakeClock(var nowMs: Long = 0) : VideoStatsAccumulator.Clock {
    override fun nowMs(): Long = nowMs
  }

  @Test
  fun doesNotEmitBeforeTheIntervalAndFormatsTheExactBoundary() {
    val clock = FakeClock()
    var dropped = 4L
    val stats =
      VideoStatsAccumulator("video-1", clock, intervalMs = 5_000) { dropped }
        .also {
          it.start()
        }

    stats.onFrame(100)
    stats.onFrame(200)
    clock.nowMs = 4_999
    assertNull(stats.poll())

    clock.nowMs = 5_000
    assertEquals(
      "VIDEO_STATS socket=video-1 fps=0.40 bytesOut=300 dropped=4 uptimeMs=5000",
      stats.poll(),
    )
  }

  @Test
  fun bytesAreCumulativeButFpsUsesOnlyTheCurrentInterval() {
    val clock = FakeClock()
    var dropped = 1L
    val stats =
      VideoStatsAccumulator("video-1", clock, intervalMs = 5_000) { dropped }
        .also {
          it.start()
        }

    stats.onFrame(100)
    clock.nowMs = 5_000
    assertEquals(
      "VIDEO_STATS socket=video-1 fps=0.20 bytesOut=100 dropped=1 uptimeMs=5000",
      stats.poll(),
    )

    stats.onFrame(250)
    dropped = 2
    clock.nowMs = 7_500
    assertNull(stats.poll())

    clock.nowMs = 10_000
    assertEquals(
      "VIDEO_STATS socket=video-1 fps=0.20 bytesOut=350 dropped=2 uptimeMs=10000",
      stats.poll(),
    )
  }

  @Test
  fun zeroFramesStillEmitsAHealthLine() {
    val clock = FakeClock()
    val stats =
      VideoStatsAccumulator("video-1", clock, intervalMs = 5_000) { 0L }
        .also {
          it.start()
        }

    clock.nowMs = 5_000
    assertEquals(
      "VIDEO_STATS socket=video-1 fps=0.00 bytesOut=0 dropped=0 uptimeMs=5000",
      stats.poll(),
    )
  }
}
