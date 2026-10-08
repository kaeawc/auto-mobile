package dev.jasonpearson.automobile.video

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pins the writer shutdown-race fix for issue #4748 and the encoder snapshot: the shutdown hook
 * nulls `streamWriter` and `encoder` on a separate thread while the encode loop reads them. Each
 * iteration snapshots the writer and then the encoder after any rotation swap, using
 * [VideoServer.encodeLoopSnapshot] and breaking on null (`?: break`). A captured encoder remains
 * available as a local even when its field is cleared. [VideoServer.isShutdownRace] distinguishes a
 * released-codec state error during intentional shutdown from errors that must propagate.
 *
 * These are deterministic contract tests for that snapshot seam — no threads, no timing — so they
 * exercise the exact null-tolerance the loop relies on without flaking under CI's timing/CPU.
 */
class VideoServerEncodeLoopTest {
  /** Stand-in for the concrete `VideoStreamWriter` so the test stays free of Android framework. */
  private class Writer

  /** Stand-in for the final MediaCodec wrapper; never constructs an Android framework class. */
  private class Encoder {
    var completedIterations = 0

    fun completeIteration() {
      completedIterations++
    }
  }

  @Test
  fun snapshotReturnsFieldWhenPresentAndNullWhenClearedByShutdown() {
    val writer = Writer()
    // A live field is handed back unchanged for the iteration to use.
    assertSame(writer, VideoServer.encodeLoopSnapshot(writer))
    // Once the shutdown hook has nulled the field, the snapshot is null: the loop breaks cleanly
    // instead of a `!!` deref throwing.
    assertNull(VideoServer.encodeLoopSnapshot<Writer>(null))
  }

  @Test
  fun encodeLoopBreaksWhenSnapshotObservesNullFromShutdown() {
    // Model the loop's guard exactly: `val currentWriter = encodeLoopSnapshot(streamWriter) ?:
    // break`.
    // While the field is live the loop keeps iterating; the instant the shutdown hook nulls it the
    // snapshot returns null and the loop breaks — no `!!` deref, no NullPointerException.
    var streamWriter: Writer? = Writer()
    var iterations = 0
    var brokeOnNull = false

    while (true) {
      val currentWriter = VideoServer.encodeLoopSnapshot(streamWriter)
      if (currentWriter == null) {
        brokeOnNull = true
        break
      }
      iterations++
      // Simulate the shutdown hook nulling the field after a couple of live iterations.
      if (iterations == 2) {
        streamWriter = null
      }
    }

    assertEquals("loop should run twice on the live writer before shutdown nulls it", 2, iterations)
    assertTrue("loop should exit via the null snapshot, not a deref throw", brokeOnNull)
  }

  @Test
  fun encoderSnapshotReturnsExactInstanceWhenPresent() {
    val encoder = Encoder()

    val currentEncoder = VideoServer.encodeLoopSnapshot(encoder)

    assertSame(encoder, currentEncoder)
    currentEncoder?.completeIteration()
    assertEquals(1, encoder.completedIterations)
  }

  @Test
  fun encodeLoopExitsWhenEncoderIsNullAtLoopTop() {
    val encoder: Encoder? = null
    var iterations = 0

    while (true) {
      val currentEncoder = VideoServer.encodeLoopSnapshot(encoder) ?: break
      currentEncoder.completeIteration()
      iterations++
    }

    assertEquals(0, iterations)
  }

  @Test
  fun encoderClearedMidIterationUsesSnapshotThenExitsOnNextIteration() {
    val originalEncoder = Encoder()
    var encoder: Encoder? = originalEncoder
    var iterations = 0

    while (true) {
      val currentEncoder = VideoServer.encodeLoopSnapshot(encoder) ?: break
      // Model shutdown clearing the field after the iteration has captured its encoder.
      encoder = null
      assertSame(originalEncoder, currentEncoder)
      currentEncoder.completeIteration()
      iterations++
    }

    assertEquals(1, iterations)
    assertEquals(1, originalEncoder.completedIterations)
    assertNull(VideoServer.encodeLoopSnapshot(encoder))
  }

  @Test
  fun encoderSnapshotAfterRotationUsesReplacementOnNextIteration() {
    val originalEncoder = Encoder()
    val replacementEncoder = Encoder()
    var encoder: Encoder? = originalEncoder
    var rotationPending = false
    val observed = mutableListOf<Encoder>()

    while (observed.size < 2) {
      // Mirror production: apply the pending rotation before taking the encoder snapshot.
      if (rotationPending) {
        rotationPending = false
        encoder = replacementEncoder
      }
      val currentEncoder = VideoServer.encodeLoopSnapshot(encoder) ?: break
      observed.add(currentEncoder)
      currentEncoder.completeIteration()
      rotationPending = true
    }

    assertEquals(2, observed.size)
    assertSame(originalEncoder, observed[0])
    assertSame(replacementEncoder, observed[1])
    assertEquals(1, originalEncoder.completedIterations)
    assertEquals(1, replacementEncoder.completedIterations)
  }

  @Test
  fun releasedCodecStateErrorDuringShutdownIsCleanExit() {
    assertTrue(
      VideoServer.isShutdownRace(running = false, error = IllegalStateException("released")),
    )
  }

  @Test
  fun codecStateErrorWhileRunningMustPropagate() {
    assertFalse(
      VideoServer.isShutdownRace(running = true, error = IllegalStateException("released")),
    )
  }

  @Test
  fun otherErrorsMustPropagateEvenDuringShutdown() {
    assertFalse(VideoServer.isShutdownRace(running = false, error = NullPointerException()))
    assertFalse(VideoServer.isShutdownRace(running = false, error = IllegalArgumentException()))
    assertFalse(VideoServer.isShutdownRace(running = true, error = IllegalArgumentException()))
  }

  @Test
  fun codecConfigBuffersDoNotCountAsVideoStatsFrames() {
    assertFalse(VideoServer.shouldCountVideoStatsFrame(isCodecConfig = true))
    assertTrue(VideoServer.shouldCountVideoStatsFrame(isCodecConfig = false))
  }

  @Test
  fun dropGapRequestsOneRecoveryKeyFramePerDropBurst() {
    val handoff = FrameHandoff()
    val clock = FakeClock()
    val heartbeat =
      FrameHeartbeat(clock, idleForceIntervalMs = 10_000, keyFrameGraceMs = 150).also { it.start() }
    var requests = 0

    handoff.offer(frame(0))
    handoff.offer(frame(1))

    assertTrue(VideoServer.recoverFromFrameDrop(handoff::consumeDropGap, { requests++ }, heartbeat))
    assertFalse(
      VideoServer.recoverFromFrameDrop(handoff::consumeDropGap, { requests++ }, heartbeat),
    )
    assertEquals(1, requests)

    heartbeat.onFrameEmitted()
    handoff.offer(frame(2))
    assertTrue(VideoServer.recoverFromFrameDrop(handoff::consumeDropGap, { requests++ }, heartbeat))
    assertEquals(2, requests)
  }

  @Test
  fun noDropDoesNotRequestRecoveryKeyFrame() {
    val handoff = FrameHandoff()
    val heartbeat =
      FrameHeartbeat(FakeClock(), idleForceIntervalMs = 10_000, keyFrameGraceMs = 150).also {
        it.start()
      }
    var requests = 0

    assertFalse(
      VideoServer.recoverFromFrameDrop(handoff::consumeDropGap, { requests++ }, heartbeat),
    )
    assertEquals(0, requests)
  }

  @Test
  fun dropRecoveryDoesNotDuplicateAnOutstandingKeyFrameRequest() {
    val handoff = FrameHandoff()
    val heartbeat =
      FrameHeartbeat(FakeClock(), idleForceIntervalMs = 10_000, keyFrameGraceMs = 150).also {
        it.start()
      }
    var requests = 0
    heartbeat.onKeyFrameRequested()

    handoff.offer(frame(0))
    handoff.offer(frame(1))

    assertTrue(VideoServer.recoverFromFrameDrop(handoff::consumeDropGap, { requests++ }, heartbeat))
    assertEquals(0, requests)
  }

  private class FakeClock(var nowMs: Long = 0) : FrameHeartbeat.Clock {
    override fun nowMs(): Long = nowMs
  }

  private fun frame(pts: Long): EncodedVideoFrame =
    EncodedVideoFrame(
      VideoStreamProtocol.ptsAndFlags(pts, isConfig = false, isKeyFrame = false),
      byteArrayOf(1),
    )
}
