package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.protocol.NavigationSourceType
import dev.jasonpearson.automobile.protocol.SdkNavigationEvent
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class NavigationEventAccumulatorTest {

  @Test
  fun `SDK navigation event retains its original event data without updating latest value`() {
    val acc = NavigationEventAccumulator()
    val event =
      SdkNavigationEvent(
        timestamp = 1234L,
        applicationId = "com.example.app",
        destination = "profile",
        source = NavigationSourceType.COMPOSE_NAVIGATION,
        arguments = mapOf("userId" to "42"),
        metadata = mapOf("origin" to "deep-link"),
      )

    val timestampedEvent = acc.addSdkNavigationEvent(event)

    assertEquals(
      TimestampedNavigationEvent(
        destination = "profile",
        source = "COMPOSE_NAVIGATION",
        arguments = mapOf("userId" to "42"),
        metadata = mapOf("origin" to "deep-link"),
        timestamp = 1234L,
        sequenceNumber = 0L,
        applicationId = "com.example.app",
      ),
      timestampedEvent,
    )
    assertEquals(listOf(timestampedEvent), acc.getAllEvents())
    assertEquals(null, acc.latestEvent.value)
  }

  @Test
  fun `SDK navigation batch yields every event for sequential forwarding`() {
    val acc = NavigationEventAccumulator()
    val events =
      listOf(
        SdkNavigationEvent(
          timestamp = 100L,
          destination = "first",
          source = NavigationSourceType.COMPOSE_NAVIGATION,
        ),
        SdkNavigationEvent(
          timestamp = 200L,
          destination = "second",
          source = NavigationSourceType.NAVIGATION_COMPONENT,
        ),
      )

    val forwarded = events.map(acc::addSdkNavigationEvent)

    assertEquals(listOf("first", "second"), forwarded.map { it.destination })
    assertEquals(listOf(0L, 1L), forwarded.map { it.sequenceNumber })
    assertEquals(forwarded, acc.getAllEvents())
    assertEquals(null, acc.latestEvent.value)
  }

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

  @Test
  fun `buffer never grows past capacity and evicts oldest first`() {
    val acc = NavigationEventAccumulator()
    // Push well past capacity to exercise steady-state eviction, checking bounds
    // as we cross and stay past the 100-event ceiling.
    repeat(250) { i ->
      acc.addEvent("dest-$i", "src", emptyMap(), emptyMap())
      assertTrue("buffer exceeded capacity at i=$i", acc.getAllEvents().size <= 100)
    }

    val all = acc.getAllEvents()
    assertEquals(100, all.size)
    assertEquals(100, acc.eventCount.value)
    // Oldest-first eviction: only the last 100 destinations/sequences survive, in order.
    assertEquals((150..249).map { "dest-$it" }, all.map { it.destination })
    assertEquals((150L..249L).toList(), all.map { it.sequenceNumber })
    // The evicted head is gone; the retained window starts at sequence 150.
    assertEquals(150L, all.first().sequenceNumber)
    assertEquals(249L, all.last().sequenceNumber)
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
