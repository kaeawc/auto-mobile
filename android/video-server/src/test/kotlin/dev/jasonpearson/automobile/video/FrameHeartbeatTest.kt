package dev.jasonpearson.automobile.video

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pins the idle-screen frame-nudge decision for issue #4383: on a static screen the mirrored
 * VirtualDisplay stops submitting surface buffers, so the encoder emits its initial burst and then
 * stalls, and a keyframe request cannot produce a fresh IDR without new surface input.
 * [FrameHeartbeat] decides when the capture path must force a surface submission — periodically
 * while idle, and promptly after a keyframe request.
 */
class FrameHeartbeatTest {
  private class FakeClock(var nowMs: Long = 0) : FrameHeartbeat.Clock {
    override fun nowMs(): Long = nowMs
  }

  private fun heartbeat(
    clock: FrameHeartbeat.Clock,
    idleForceIntervalMs: Long = 1_000,
    keyFrameGraceMs: Long = 150,
  ) = FrameHeartbeat(clock, idleForceIntervalMs, keyFrameGraceMs).also { it.start() }

  @Test
  fun idleScreenForcesFrameOncePerInterval() {
    val clock = FakeClock()
    val heartbeat = heartbeat(clock, idleForceIntervalMs = 1_000)

    // Before the idle interval elapses, no nudge.
    clock.nowMs = 999
    assertFalse(heartbeat.poll())

    // At the idle interval, force a fresh surface submission.
    clock.nowMs = 1_000
    assertTrue(heartbeat.poll())

    // Immediately after a nudge, no second nudge (throttled to once per interval).
    assertFalse(heartbeat.poll())

    // A full interval after the nudge, force again — a static screen keeps repeating.
    clock.nowMs = 2_000
    assertTrue(heartbeat.poll())
  }

  @Test
  fun emittedFrameResetsIdleTimer() {
    val clock = FakeClock()
    val heartbeat = heartbeat(clock, idleForceIntervalMs = 1_000)

    clock.nowMs = 800
    heartbeat.onFrameEmitted()

    // Only 900ms since start but 100ms since the frame: not yet due.
    clock.nowMs = 900
    assertFalse(heartbeat.poll())

    // 1_000ms after the frame: due again.
    clock.nowMs = 1_800
    assertTrue(heartbeat.poll())
  }

  @Test
  fun keyFrameRequestForcesFrameAfterGrace() {
    val clock = FakeClock()
    val heartbeat = heartbeat(clock, idleForceIntervalMs = 10_000, keyFrameGraceMs = 150)

    clock.nowMs = 500
    heartbeat.onKeyFrameRequested()

    // Within the grace window the encoder may still emit on its own; do not nudge yet.
    clock.nowMs = 600
    assertFalse(heartbeat.poll())

    // Grace elapsed with no frame: force a fresh submission so the IDR request lands.
    clock.nowMs = 650
    assertTrue(heartbeat.poll())
  }

  @Test
  fun emittedFrameSatisfiesPendingKeyFrameRequest() {
    val clock = FakeClock()
    val heartbeat = heartbeat(clock, idleForceIntervalMs = 10_000, keyFrameGraceMs = 150)

    clock.nowMs = 500
    heartbeat.onKeyFrameRequested()

    // A frame lands before the grace elapses: the request is satisfied, no nudge.
    clock.nowMs = 600
    heartbeat.onFrameEmitted()

    clock.nowMs = 800
    assertFalse(heartbeat.poll())
  }

  @Test
  fun keyFrameRequestKeepsNudgingUntilFrameLands() {
    val clock = FakeClock()
    val heartbeat = heartbeat(clock, idleForceIntervalMs = 10_000, keyFrameGraceMs = 150)

    clock.nowMs = 0
    heartbeat.onKeyFrameRequested()

    clock.nowMs = 150
    assertTrue(heartbeat.poll())

    // The forced submission produced nothing; keep nudging each grace period so a
    // wedged surface is not left without a fresh frame after a viewer's PLI.
    clock.nowMs = 250
    assertFalse(heartbeat.poll())
    clock.nowMs = 300
    assertTrue(heartbeat.poll())
  }
}
