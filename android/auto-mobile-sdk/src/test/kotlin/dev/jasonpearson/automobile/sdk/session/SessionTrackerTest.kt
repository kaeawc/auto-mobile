package dev.jasonpearson.automobile.sdk.session

import org.junit.Assert.*
import org.junit.Test

class SessionTrackerTest {

  private var uuidCounter = 0
  private val fakeUuidProvider: () -> String = { "session-${++uuidCounter}" }

  /** Captured timer: stores the delay and action so tests can fire it synchronously. */
  private class FakeTimer {
    var pendingAction: Runnable? = null
    var pendingDelayMs: Long? = null
    var cancelled = false

    val factory: (Long, Runnable) -> (() -> Unit) = { delayMs, action ->
      pendingDelayMs = delayMs
      pendingAction = action
      cancelled = false
      val cancel: () -> Unit = { cancelled = true }
      cancel
    }

    fun fire() {
      if (!cancelled) pendingAction?.run()
    }
  }

  @Test
  fun `new session on first foreground`() {
    val tracker =
        SessionTracker(uuidProvider = fakeUuidProvider, timerFactory = FakeTimer().factory)

    assertNull(tracker.currentSessionId())
    tracker.onForeground()
    assertEquals("session-1", tracker.currentSessionId())
  }

  @Test
  fun `same session on quick background then foreground`() {
    val timer = FakeTimer()
    val tracker = SessionTracker(uuidProvider = fakeUuidProvider, timerFactory = timer.factory)

    tracker.onForeground()
    assertEquals("session-1", tracker.currentSessionId())

    tracker.onBackground()
    // Timer not fired yet - come back quickly
    tracker.onForeground()
    assertEquals("session-1", tracker.currentSessionId())
    assertTrue(timer.cancelled)
  }

  @Test
  fun `new session after timeout expires`() {
    val timer = FakeTimer()
    val tracker =
        SessionTracker(
            timeoutMs = 30_000L,
            uuidProvider = fakeUuidProvider,
            timerFactory = timer.factory,
        )

    tracker.onForeground()
    assertEquals("session-1", tracker.currentSessionId())

    tracker.onBackground()
    timer.fire() // Simulate timeout expiring
    assertNull(tracker.currentSessionId())

    tracker.onForeground()
    assertEquals("session-2", tracker.currentSessionId())
  }

  @Test
  fun `timeout schedules with correct delay`() {
    val timer = FakeTimer()
    val tracker =
        SessionTracker(
            timeoutMs = 45_000L,
            uuidProvider = fakeUuidProvider,
            timerFactory = timer.factory,
        )

    tracker.onForeground()
    tracker.onBackground()
    assertEquals(45_000L, timer.pendingDelayMs)
  }

  @Test
  fun `shutdown clears session`() {
    val timer = FakeTimer()
    val tracker = SessionTracker(uuidProvider = fakeUuidProvider, timerFactory = timer.factory)

    tracker.onForeground()
    assertEquals("session-1", tracker.currentSessionId())

    tracker.shutdown()
    assertNull(tracker.currentSessionId())
  }

  @Test
  fun `shutdown cancels pending timeout`() {
    val timer = FakeTimer()
    val tracker = SessionTracker(uuidProvider = fakeUuidProvider, timerFactory = timer.factory)

    tracker.onForeground()
    tracker.onBackground()
    assertFalse(timer.cancelled)

    tracker.shutdown()
    assertTrue(timer.cancelled)
  }

  @Test
  fun `foreground after shutdown starts new session`() {
    val timer = FakeTimer()
    val tracker = SessionTracker(uuidProvider = fakeUuidProvider, timerFactory = timer.factory)

    tracker.onForeground()
    assertEquals("session-1", tracker.currentSessionId())

    tracker.shutdown()
    assertNull(tracker.currentSessionId())

    tracker.onForeground()
    assertEquals("session-2", tracker.currentSessionId())
  }

  @Test
  fun `duplicate foreground calls do not generate new session`() {
    val tracker =
        SessionTracker(uuidProvider = fakeUuidProvider, timerFactory = FakeTimer().factory)

    tracker.onForeground()
    assertEquals("session-1", tracker.currentSessionId())

    tracker.onForeground()
    assertEquals("session-1", tracker.currentSessionId())
  }

  @Test
  fun `background when not active is no-op`() {
    val timer = FakeTimer()
    val tracker = SessionTracker(uuidProvider = fakeUuidProvider, timerFactory = timer.factory)

    // Background before any foreground - should be no-op
    tracker.onBackground()
    assertNull(timer.pendingAction)
    assertNull(tracker.currentSessionId())
  }

  @Test
  fun `timeout does not clear session if already foregrounded`() {
    val timer = FakeTimer()
    val tracker = SessionTracker(uuidProvider = fakeUuidProvider, timerFactory = timer.factory)

    tracker.onForeground()
    tracker.onBackground()
    tracker.onForeground() // Come back before timeout
    timer.fire() // Timer fires late - should be no-op because state is ACTIVE

    assertEquals("session-1", tracker.currentSessionId())
  }

  @Test
  fun `shutdown is safe to call multiple times`() {
    val tracker =
        SessionTracker(uuidProvider = fakeUuidProvider, timerFactory = FakeTimer().factory)

    tracker.onForeground()
    tracker.shutdown()
    tracker.shutdown()
    assertNull(tracker.currentSessionId())
  }
}
