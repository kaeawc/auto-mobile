package dev.jasonpearson.automobile.ctrlproxy

import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class NavigationEventAccumulatorTest {

  @Test
  fun `single-threaded add assigns monotonic sequences and bounds the buffer`() {
    val acc = NavigationEventAccumulator()
    repeat(150) { acc.addEvent("dest-$it", "src", emptyMap(), emptyMap()) }

    val all = acc.getAllEvents()
    assertEquals(100, all.size) // trimmed to maxEvents
    // Retained events keep their original increasing sequence numbers (50..149).
    assertEquals((50L..149L).toList(), all.map { it.sequenceNumber })
    assertEquals(150L, acc.getStats().currentSequence)
  }

  /**
   * Concurrent producers must not collide on sequence numbers, and a reader hammering
   * getRecentEvents/getAllEvents must never see an IndexOutOfBoundsException from a trim between
   * size and subList (#3604).
   */
  @Test
  fun `concurrent addEvent produces no lost sequences and no IOOBE`() {
    val acc = NavigationEventAccumulator()
    val threadCount = 6
    val perThread = 500
    val errors = CopyOnWriteArrayList<Throwable>()
    val latch = CountDownLatch(threadCount)

    val readerRunning = AtomicBoolean(true)
    val reader = Thread {
      while (readerRunning.get()) {
        try {
          acc.getRecentEvents(50)
          acc.getAllEvents()
        } catch (e: Throwable) {
          errors.add(e)
        }
      }
    }
    reader.start()

    for (t in 0 until threadCount) {
      Thread {
        try {
          repeat(perThread) { acc.addEvent("dest", "src", emptyMap(), emptyMap()) }
        } catch (e: Throwable) {
          errors.add(e)
        } finally {
          latch.countDown()
        }
      }
        .start()
    }

    assertTrue("producers timed out", latch.await(30, TimeUnit.SECONDS))
    readerRunning.set(false)
    reader.join(5_000)

    assertTrue("concurrent access threw: ${errors.firstOrNull()}", errors.isEmpty())
    // The counter advanced exactly once per event — no lost/duplicate increments
    // (a plain `var++` would lose some under contention, giving < total).
    assertEquals((threadCount * perThread).toLong(), acc.getStats().currentSequence)
    // Buffer stayed bounded and its retained sequence numbers are unique.
    val retained = acc.getAllEvents().map { it.sequenceNumber }
    assertTrue(retained.size <= 100)
    assertEquals(retained.size, retained.toSet().size)
  }
}
