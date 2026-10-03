package dev.jasonpearson.automobile.video

import java.util.concurrent.CountDownLatch
import java.util.concurrent.Semaphore
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Unit-tests the rotation change-detection seam for issue #4785 without a real display or real
 * timers. [RotationMonitor.poll] is a pure, coalescing change detector; the listener and poll-loop
 * paths both funnel through it, so a fake [RotationReader] plus an injected sleeper exercises the
 * full detection contract deterministically.
 */
class RotationMonitorTest {

  @Test
  fun pollReturnsNewRotationOnlyOnChangeAndCoalescesRepeats() {
    val rotation = AtomicInteger(0)
    val monitor = RotationMonitor(reader = { rotation.get() })

    // First read establishes the baseline as a change from the ROTATION_UNSET sentinel.
    assertEquals(0, monitor.poll())
    // No movement -> no dispatch.
    assertNull(monitor.poll())

    rotation.set(1)
    assertEquals("a real rotation change is reported once", 1, monitor.poll())
    assertNull("the same rotation is not reported again (coalesced)", monitor.poll())

    // Rotating back is itself a change and must be reported.
    rotation.set(0)
    assertEquals("rotating back is a fresh change", 0, monitor.poll())
  }

  @Test
  fun listenerCallbackDispatchesRotationChangeWithNewValue() {
    val rotation = AtomicInteger(0)
    var listenerCallback: (() -> Unit)? = null
    val observed = AtomicInteger(NONE)
    // Park the poll loop indefinitely so this test isolates the framework-listener path; the latch
    // (not a wall-clock sleep) blocks the thread deterministically until teardown.
    val park = CountDownLatch(1)
    val monitor =
      RotationMonitor(
        reader = { rotation.get() },
        registrar = { onChanged ->
          listenerCallback = onChanged
          {}
        },
        sleeper = { park.await() },
      )

    monitor.start { observed.set(it) }
    // Simulate a framework display change after the device rotates to landscape.
    rotation.set(3)
    listenerCallback?.invoke()

    assertEquals("the listener path must dispatch the new rotation", 3, observed.get())

    park.countDown()
    monitor.stop()
  }

  @Test
  fun pollFallbackDetectsRotationWhenListenerRegistrationUnavailable() {
    val rotation = AtomicInteger(0)
    val dispatched = CountDownLatch(1)
    val observed = AtomicInteger(NONE)
    // registrar returns null -> no framework listener, so the poll loop is the only detector. Each
    // injected "sleep" advances the display one step to landscape; no real timer is involved.
    val monitor =
      RotationMonitor(
        reader = { rotation.get() },
        registrar = { null },
        sleeper = { rotation.set(1) },
      )

    monitor.start {
      observed.set(it)
      dispatched.countDown()
    }

    assertTrue(
      "the poll fallback must detect the rotation without a framework listener",
      dispatched.await(2, TimeUnit.SECONDS),
    )
    assertEquals(1, observed.get())

    monitor.stop()
  }

  @Test
  fun pollLoopSurvivesReaderExceptionAndStillDispatchesNewRotation() {
    val reads = AtomicInteger()
    val ticks = Semaphore(0)
    val failedRead = CountDownLatch(1)
    val dispatched = CountDownLatch(1)
    val observed = AtomicInteger(NONE)
    val pollThread = AtomicReference<Thread>()
    val monitor =
      RotationMonitor(
        reader = {
          when (reads.getAndIncrement()) {
            0 -> 0
            1 -> {
              failedRead.countDown()
              throw IllegalStateException("transient display read failure")
            }
            else -> 1
          }
        },
        sleeper = {
          pollThread.set(Thread.currentThread())
          ticks.acquire()
        },
      )

    try {
      monitor.start {
        observed.set(it)
        dispatched.countDown()
      }
      // Each permit advances exactly one poll tick: first a failed read, then a fresh rotation.
      ticks.release()
      assertTrue("the first poll tick must attempt a read", failedRead.await(2, TimeUnit.SECONDS))
      ticks.release()

      assertTrue(
        "a transient reader failure must not end the poll fallback",
        dispatched.await(2, TimeUnit.SECONDS),
      )
      assertEquals(1, observed.get())
    } finally {
      monitor.stop()
      pollThread.get()?.let {
        it.join(TimeUnit.SECONDS.toMillis(2))
        assertFalse("the interrupted poll thread must unwind", it.isAlive)
      }
    }
  }

  @Test
  fun listenerCallbackSwallowsReaderException() {
    val reads = AtomicInteger()
    val rotation = AtomicInteger(0)
    var listenerCallback: (() -> Unit)? = null
    val observed = AtomicInteger(NONE)
    val park = CountDownLatch(1)
    val monitor =
      RotationMonitor(
        reader = {
          if (reads.getAndIncrement() == 1) {
            throw IllegalStateException("transient display read failure")
          }
          rotation.get()
        },
        registrar = { onChanged ->
          listenerCallback = onChanged
          {}
        },
        sleeper = { park.await() },
      )

    try {
      monitor.start { observed.set(it) }
      val listener = requireNotNull(listenerCallback)
      listener()
      assertEquals("a failed read must not dispatch a rotation", NONE, observed.get())

      rotation.set(1)
      listener()
      assertEquals("the listener must retry after a failed read", 1, observed.get())
    } finally {
      monitor.stop()
      park.countDown()
    }
  }

  private companion object {
    const val NONE = -99
  }
}
