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

  private fun snapshot(sequence: Long) =
    DeviceFrameSnapshot(
      deviceId = "emulator-5554",
      sequence = sequence,
      capturedAtMs = 1_000L + sequence,
      source = DeviceFrameSource.Screenshot,
      frameWidth = 1080,
      frameHeight = 2340,
      deviceWidth = 1080,
      deviceHeight = 2340,
      hierarchy = null,
      screenshotSequence = sequence,
      hierarchySequence = sequence,
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

    // The first snapshot with a strictly greater sequence does. Because a snapshot exists only
    // when its screenshot and hierarchy are paired, this means BOTH caught up.
    assertTrue(tracker.onSnapshot(snapshot(11L), nowMs = 200L))
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
