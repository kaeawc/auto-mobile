package dev.jasonpearson.automobile.video

import java.util.concurrent.CopyOnWriteArrayList
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

  @Test
  fun pollLoopBoundsLogsAcrossFiftyConsecutiveReaderFailures() {
    val reads = AtomicInteger()
    val failures = AtomicInteger()
    val ticks = Semaphore(0)
    val parked = Semaphore(0)
    val pollThread = AtomicReference<Thread>()
    val logs = CopyOnWriteArrayList<String>()
    val loggedFailures = CopyOnWriteArrayList<Int>()
    val monitor =
      RotationMonitor(
        reader = {
          if (reads.getAndIncrement() == 0) {
            0
          } else {
            failures.incrementAndGet()
            throw IllegalStateException("display unavailable")
          }
        },
        sleeper = {
          pollThread.set(Thread.currentThread())
          parked.release()
          ticks.acquire()
        },
        log = {
          logs.add(it)
          loggedFailures.add(failures.get())
        },
      )

    try {
      monitor.start { throw AssertionError("failed reads must not dispatch") }
      assertTrue(parked.tryAcquire(2, TimeUnit.SECONDS))
      repeat(50) {
        ticks.release()
        // Parking after each tick proves that its read and logging have both completed.
        assertTrue(parked.tryAcquire(2, TimeUnit.SECONDS))
      }
      assertEquals(50, failures.get())
      assertEquals(listOf(1, 11, 21, 31, 41), loggedFailures.toList())
      assertEquals(5, logs.size)
      assertEquals("RotationMonitor reader failed: display unavailable", logs.first())
      logs.drop(1).forEach {
        assertEquals(
          "RotationMonitor reader failed: display unavailable (9 failures suppressed)",
          it,
        )
      }
    } finally {
      monitor.stop()
      pollThread.get()?.let {
        it.join(TimeUnit.SECONDS.toMillis(2))
        assertFalse("the interrupted poll thread must unwind", it.isAlive)
      }
    }
  }

  @Test
  fun recoveryDispatchesNewRotationAndNextFailureRunLogsImmediately() {
    var failing = false
    var rotation = 0
    var listenerCallback: (() -> Unit)? = null
    val park = CountDownLatch(1)
    val logs = CopyOnWriteArrayList<String>()
    val observed = CopyOnWriteArrayList<Int>()
    val monitor =
      RotationMonitor(
        reader = {
          if (failing) throw IllegalStateException("display unavailable")
          rotation
        },
        registrar = { onChanged ->
          listenerCallback = onChanged
          {}
        },
        sleeper = { park.await() },
        log = { logs.add(it) },
      )

    try {
      monitor.start { observed.add(it) }
      val listener = requireNotNull(listenerCallback)
      failing = true
      repeat(3) { listener() }
      assertEquals(listOf("RotationMonitor reader failed: display unavailable"), logs.toList())

      failing = false
      rotation = 1
      listener()
      listener()
      assertEquals(listOf(1), observed.toList())
      assertEquals(
        "RotationMonitor reader recovered after 3 consecutive failures",
        logs.last(),
      )
      assertEquals(2, logs.size)

      failing = true
      listener()
      assertEquals(3, logs.size)
      assertEquals("RotationMonitor reader failed: display unavailable", logs.last())
    } finally {
      monitor.stop()
    }
  }

  @Test
  fun singleFailureLogsOnceAndUnchangedReadLogsOneRecovery() {
    var failing = false
    var listenerCallback: (() -> Unit)? = null
    val park = CountDownLatch(1)
    val logs = CopyOnWriteArrayList<String>()
    val monitor =
      RotationMonitor(
        reader = {
          if (failing) throw IllegalStateException("display unavailable")
          0
        },
        registrar = { onChanged ->
          listenerCallback = onChanged
          {}
        },
        sleeper = { park.await() },
        log = { logs.add(it) },
      )

    try {
      monitor.start { throw AssertionError("unchanged rotation must not dispatch") }
      val listener = requireNotNull(listenerCallback)
      listener()
      assertTrue("success without a prior failure must not log recovery", logs.isEmpty())
      failing = true
      listener()
      assertEquals(listOf("RotationMonitor reader failed: display unavailable"), logs.toList())
      failing = false
      listener()
      listener()
      assertEquals(
        listOf(
          "RotationMonitor reader failed: display unavailable",
          "RotationMonitor reader recovered after 1 consecutive failures",
        ),
        logs.toList(),
      )
    } finally {
      monitor.stop()
    }
  }

  @Test
  fun throwingCallbackDoesNotRetryRotationOrResetNestedReaderFailures() {
    var failing = false
    var rotation = 0
    var listenerCallback: (() -> Unit)? = null
    val ticks = Semaphore(0)
    val parked = Semaphore(0)
    val pollThread = AtomicReference<Thread>()
    val logs = CopyOnWriteArrayList<String>()
    val observed = CopyOnWriteArrayList<Int>()
    val monitor =
      RotationMonitor(
        reader = {
          if (failing) throw IllegalStateException("display unavailable")
          rotation
        },
        registrar = { onChanged ->
          listenerCallback = onChanged
          {}
        },
        sleeper = {
          pollThread.set(Thread.currentThread())
          parked.release()
          ticks.acquire()
        },
        log = { logs.add(it) },
      )

    try {
      monitor.start {
        observed.add(it)
        if (it == 1) {
          // A framework notification during the callback begins a new reader-failure run.
          failing = true
          requireNotNull(listenerCallback).invoke()
          throw IllegalStateException("capture swap failed")
        }
      }
      assertTrue(parked.tryAcquire(2, TimeUnit.SECONDS))
      rotation = 1
      ticks.release()
      assertTrue(parked.tryAcquire(2, TimeUnit.SECONDS))
      assertEquals(
        listOf(
          "RotationMonitor reader failed: display unavailable",
          "RotationMonitor callback failed: capture swap failed",
        ),
        logs.toList(),
      )

      ticks.release()
      assertTrue(parked.tryAcquire(2, TimeUnit.SECONDS))
      assertEquals("callback failure must not reset the reader-failure run", 2, logs.size)
      failing = false
      ticks.release()
      assertTrue(parked.tryAcquire(2, TimeUnit.SECONDS))
      assertEquals(listOf(1), observed.toList())
      assertEquals("RotationMonitor reader recovered after 2 consecutive failures", logs.last())

      rotation = 2
      ticks.release()
      assertTrue(parked.tryAcquire(2, TimeUnit.SECONDS))
      assertEquals(
        "the poll loop must still dispatch distinct changes",
        listOf(1, 2),
        observed.toList(),
      )
      assertEquals(3, logs.size)
    } finally {
      monitor.stop()
      pollThread.get()?.let {
        it.join(TimeUnit.SECONDS.toMillis(2))
        assertFalse("the interrupted poll thread must unwind", it.isAlive)
      }
    }
  }

  private companion object {
    const val NONE = -99
  }
}
