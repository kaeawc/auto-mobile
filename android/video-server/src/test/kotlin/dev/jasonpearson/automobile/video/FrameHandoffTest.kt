package dev.jasonpearson.automobile.video

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pins the encode/transport decoupling contract for issue #4749. The encode loop must never block
 * on a slow reader, so [FrameHandoff] holds a single slot with a drop-oldest policy: newer deltas
 * supersede unsent older ones, while decoder-essential config/keyframes are protected. The policy
 * is pure and deterministic — no real threads, sockets, or timers are exercised here.
 */
class FrameHandoffTest {
  private var pts = 0L

  private fun delta(): EncodedVideoFrame =
    EncodedVideoFrame(
      VideoStreamProtocol.ptsAndFlags(pts++, isConfig = false, isKeyFrame = false),
      byteArrayOf(1),
    )

  private fun keyFrame(): EncodedVideoFrame =
    EncodedVideoFrame(
      VideoStreamProtocol.ptsAndFlags(pts++, isConfig = false, isKeyFrame = true),
      byteArrayOf(2),
    )

  private fun config(): EncodedVideoFrame =
    EncodedVideoFrame(
      VideoStreamProtocol.ptsAndFlags(pts++, isConfig = true, isKeyFrame = false),
      byteArrayOf(3),
    )

  @Test
  fun singlePacketRoundTrips() {
    val handoff = FrameHandoff()
    val frame = delta()

    assertTrue(handoff.offer(frame))
    assertSame(frame, handoff.take())
    assertEquals(0L, handoff.droppedCount())
    assertNull(handoff.poll())
  }

  @Test
  fun newerDeltaReplacesUnsentOlderDelta() {
    val handoff = FrameHandoff()
    val stale = delta()
    val fresh = delta()

    handoff.offer(stale)
    handoff.offer(fresh)

    // Latest-frame-wins: the reader advances toward the live edge, not through a backlog.
    assertSame(fresh, handoff.peek())
    assertEquals(1L, handoff.droppedCount())
    assertSame(fresh, handoff.take())
  }

  @Test
  fun droppedFrameArmsOneConsumableGap() {
    val handoff = FrameHandoff()

    handoff.offer(delta())
    handoff.offer(delta())

    assertTrue(handoff.consumeDropGap())
    assertFalse(handoff.consumeDropGap())
  }

  @Test
  fun eachDropAfterConsumptionArmsAnotherGap() {
    val handoff = FrameHandoff()

    handoff.offer(delta())
    handoff.offer(delta())
    assertTrue(handoff.consumeDropGap())

    handoff.offer(delta())
    assertTrue(handoff.consumeDropGap())
    assertFalse(handoff.consumeDropGap())
  }

  @Test
  fun deltaNeverEvictsUnsentKeyFrame() {
    val handoff = FrameHandoff()
    val idr = keyFrame()

    handoff.offer(idr)
    handoff.offer(delta())
    handoff.offer(delta())

    // A delta is undecodable without its reference IDR: the keyframe is sticky, the deltas drop.
    assertSame(idr, handoff.peek())
    assertEquals(2L, handoff.droppedCount())
  }

  @Test
  fun deltaNeverEvictsUnsentConfig() {
    val handoff = FrameHandoff()
    val sps = config()

    handoff.offer(sps)
    handoff.offer(delta())

    assertSame(sps, handoff.peek())
    assertEquals(1L, handoff.droppedCount())
  }

  @Test
  fun keyFrameEvictsAStaleDelta() {
    val handoff = FrameHandoff()
    val stale = delta()
    val idr = keyFrame()

    handoff.offer(stale)
    handoff.offer(idr)

    // A keyframe is strictly more useful than an unsent delta: it wins the slot.
    assertSame(idr, handoff.peek())
    assertEquals(1L, handoff.droppedCount())
  }

  @Test
  fun slottedCriticalIsStickyAgainstLaterCritical() {
    val handoff = FrameHandoff()
    val sps = config()

    // Guarantees SPS/PPS reaches the writer before its IDR: a single slot cannot hold both, so the
    // first-arriving critical is delivered intact and the encoder re-emits the IDR next GOP.
    handoff.offer(sps)
    handoff.offer(keyFrame())

    assertSame(sps, handoff.peek())
    assertEquals(1L, handoff.droppedCount())
  }

  @Test
  fun takingAStickyCriticalFreesTheSlotForLivePackets() {
    val handoff = FrameHandoff()
    val idr = keyFrame()

    handoff.offer(idr)
    handoff.offer(delta()) // dropped: idr sticky
    assertSame(idr, handoff.take())

    val live = delta()
    assertTrue(handoff.offer(live))
    assertSame(live, handoff.peek())
    assertEquals(1L, handoff.droppedCount())
  }

  @Test
  fun offerReturnsFalseOnceClosed() {
    val handoff = FrameHandoff()
    handoff.close()

    assertFalse(handoff.offer(delta()))
    // A closed, drained handoff returns null so the writer thread exits its loop.
    assertNull(handoff.take())
  }

  @Test
  fun closeDrainsRemainingPacketBeforeSignallingExit() {
    val handoff = FrameHandoff()
    val pending = delta()
    handoff.offer(pending)

    handoff.close()

    // The last accepted packet is still delivered; only then does take() report closure.
    assertSame(pending, handoff.take())
    assertNull(handoff.take())
  }
}
