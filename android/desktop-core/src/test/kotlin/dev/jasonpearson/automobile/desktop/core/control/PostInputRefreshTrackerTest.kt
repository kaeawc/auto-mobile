package dev.jasonpearson.automobile.desktop.core.control

import dev.jasonpearson.automobile.desktop.domain.DeviceFrameSnapshot
import dev.jasonpearson.automobile.desktop.domain.DeviceFrameSource
import dev.jasonpearson.automobile.desktop.domain.PostInputRefreshState
import dev.jasonpearson.automobile.desktop.domain.PostInputRefreshTracker
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * The post-input inspector refresh policy (issue #3348), expressed as snapshot transitions so a
 * non-desktop daemon client can follow it. No timers: every instant is passed in.
 */
class PostInputRefreshTrackerTest {

  /**
   * [sourceSequence] is the client's own per-update counter; [captureSequence] is the daemon's
   * capture identity. They are deliberately independent here — the client bumps its counter for
   * every applied screenshot, including one that still belongs to the pre-input capture.
   */
  private fun snapshot(sourceSequence: Long, captureSequence: Long = sourceSequence) =
    DeviceFrameSnapshot(
      deviceId = "emulator-5554",
      sequence = sourceSequence,
      capturedAtMs = 1_000L + sourceSequence,
      source = DeviceFrameSource.Screenshot,
      frameWidth = 1080,
      frameHeight = 2340,
      deviceWidth = 1080,
      deviceHeight = 2340,
      screenshotData = null,
      hierarchy = null,
      captureSequence = captureSequence,
      screenshotSequence = sourceSequence,
      hierarchySequence = sourceSequence,
      liveFrameSequence = null,
    )

  @Test
  fun `starts idle`() {
    assertEquals(PostInputRefreshState.Idle, PostInputRefreshTracker().state)
  }

  @Test
  fun `a successful input waits for the first superseding snapshot`() {
    val tracker = PostInputRefreshTracker()
    tracker.onInputSucceeded(snapshot(10L), nowMs = 0L)
    assertEquals(PostInputRefreshState.AwaitingSnapshot, tracker.state)

    // The same snapshot still being republished by recomposition does not settle anything.
    assertFalse(tracker.onSnapshot(snapshot(10L), nowMs = 100L))
    assertEquals(PostInputRefreshState.AwaitingSnapshot, tracker.state)

    // The first snapshot from a strictly greater CAPTURE does. Because a snapshot exists only when
    // its screenshot and hierarchy share a capture identity, this means BOTH caught up.
    assertTrue(tracker.onSnapshot(snapshot(11L), nowMs = 200L))
    assertEquals(PostInputRefreshState.Settled, tracker.state)
  }

  @Test
  fun `a duplicate screenshot from the pre-input capture does not settle the wait`() {
    // The client bumps its own source sequence for EVERY applied screenshot, including a duplicate
    // or keepalive frame that still belongs to the capture the input was dispatched through.
    // Settling on that would claim the device caught up while the pre-input hierarchy is still
    // what a tap would map through — the opposite of what this policy promises.
    val tracker = PostInputRefreshTracker()
    tracker.onInputSucceeded(snapshot(sourceSequence = 10L, captureSequence = 7L), nowMs = 0L)

    assertFalse(
      tracker.onSnapshot(snapshot(sourceSequence = 11L, captureSequence = 7L), nowMs = 100L),
      "a newer source sequence within the same capture must not settle",
    )
    assertFalse(
      tracker.onSnapshot(snapshot(sourceSequence = 12L, captureSequence = 7L), nowMs = 200L),
      "nor does another one",
    )
    assertEquals(PostInputRefreshState.AwaitingSnapshot, tracker.state)

    // Only a genuinely newer capture settles it.
    assertTrue(
      tracker.onSnapshot(snapshot(sourceSequence = 13L, captureSequence = 8L), nowMs = 300L)
    )
    assertEquals(PostInputRefreshState.Settled, tracker.state)
  }

  @Test
  fun `a failed input settles immediately and never awaits a refresh`() {
    // A rejected input changed nothing on the device, so nothing on screen is stale: the client
    // clears no state and does not wait.
    val tracker = PostInputRefreshTracker()
    tracker.onInputFailed()
    assertEquals(PostInputRefreshState.Settled, tracker.state)
    assertFalse(tracker.onSnapshot(snapshot(1L), nowMs = 10L))
    assertFalse(tracker.onTick(nowMs = 1_000_000L))
  }

  @Test
  fun `a wait that outlives the timeout settles without a superseding snapshot`() {
    val tracker = PostInputRefreshTracker()
    tracker.onInputSucceeded(snapshot(10L), nowMs = 0L)
    assertFalse(tracker.onTick(nowMs = PostInputRefreshTracker.REFRESH_TIMEOUT_MS - 1))
    assertEquals(PostInputRefreshState.AwaitingSnapshot, tracker.state)
    assertTrue(tracker.onTick(nowMs = PostInputRefreshTracker.REFRESH_TIMEOUT_MS))
    assertEquals(PostInputRefreshState.Settled, tracker.state)
  }

  @Test
  fun `a stale snapshot settles the wait once the timeout has passed`() {
    // Degrade to settled rather than waiting forever; DeviceControlPolicy's freshness bound
    // independently drops control on the stale frame, so this cannot claim "current" falsely.
    val tracker = PostInputRefreshTracker()
    tracker.onInputSucceeded(snapshot(10L), nowMs = 0L)
    assertTrue(
      tracker.onSnapshot(snapshot(10L), nowMs = PostInputRefreshTracker.REFRESH_TIMEOUT_MS)
    )
    assertEquals(PostInputRefreshState.Settled, tracker.state)
  }

  @Test
  fun `a context change drops a pending wait`() {
    // A device switch, stream disconnect or mode change must not let an input dispatched in the
    // previous context settle a wait in the new one.
    val tracker = PostInputRefreshTracker()
    tracker.onInputSucceeded(snapshot(10L), nowMs = 0L)
    tracker.reset()
    assertEquals(PostInputRefreshState.Idle, tracker.state)
    assertFalse(tracker.onSnapshot(snapshot(99L), nowMs = 10L))
    assertEquals(PostInputRefreshState.Idle, tracker.state)
  }
}
