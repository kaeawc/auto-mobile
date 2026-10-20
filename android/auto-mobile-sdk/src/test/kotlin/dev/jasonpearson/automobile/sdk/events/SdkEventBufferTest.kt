package dev.jasonpearson.automobile.sdk.events

import dev.jasonpearson.automobile.protocol.SdkEvent
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import org.junit.Test

internal class SdkEventBufferTest : SdkEventBufferFixture() {
  @Test
  fun `published nine-argument constructor flushes an event`() {
    val flushed = mutableListOf<List<SdkEvent>>()
    val buffer =
      SdkEventBuffer(
        50,
        500L,
        { flushed.add(it) },
        null,
        Executors.newSingleThreadScheduledExecutor(),
        null,
        emptyList(),
        500,
        BackPressureStrategy.DROP_OLDEST,
      )
    val event = makeEvent(1)

    try {
      buffer.add(event)
      buffer.flush()
      assertEquals(listOf(listOf(event)), flushed)
    } finally {
      buffer.shutdown()
    }
  }

  @Test
  fun `flush on capacity`() {
    val flushed = CopyOnWriteArrayList<List<SdkEvent>>()
    val executor = Executors.newSingleThreadScheduledExecutor()
    val buffer =
      SdkEventBuffer(
        maxBufferSize = 3,
        flushIntervalMs = 60_000, // Very long so timer won't fire
        onFlush = { flushed.add(it) },
        executor = executor,
      )

    buffer.add(makeEvent(1))
    buffer.add(makeEvent(2))
    assertEquals(0, flushed.size, "Should not flush before capacity")

    buffer.add(makeEvent(3))
    drainExecutor(executor) // capacity flush is async
    assertEquals(1, flushed.size, "Should flush at capacity")
    assertEquals(3, flushed[0].size)
  }

  @Test
  fun `capacity delivery runs on executor without blocking caller`() {
    val executorThreadName = "SdkEventBuffer-test-executor"
    val executor = Executors.newSingleThreadScheduledExecutor { runnable ->
      Thread(runnable, executorThreadName)
    }
    val deliveryStarted = CountDownLatch(1)
    val releaseDelivery = CountDownLatch(1)
    val addReturned = CountDownLatch(1)
    val flushThread = AtomicReference<String>()
    val buffer =
      SdkEventBuffer(
        maxBufferSize = 1,
        flushIntervalMs = 60_000,
        onFlush = {
          flushThread.set(Thread.currentThread().name)
          deliveryStarted.countDown()
          releaseDelivery.await()
        },
        executor = executor,
      )
    val caller =
      Thread(
        {
          buffer.add(makeEvent(1))
          addReturned.countDown()
        },
        "SDK host caller",
      )

    try {
      caller.start()
      assertTrue(deliveryStarted.await(1, TimeUnit.SECONDS), "Delivery should begin")
      assertTrue(
        addReturned.await(100, TimeUnit.MILLISECONDS),
        "add() should not wait for delivery",
      )
      assertEquals(executorThreadName, flushThread.get())
    } finally {
      releaseDelivery.countDown()
      caller.join(1_000)
      executor.shutdownNow()
    }
  }

  @Test
  fun `capacity and timer delivery retain event order and ownership`() {
    val executor = TimerGatedExecutor()
    val deliveries = CopyOnWriteArrayList<List<SdkEvent>>()
    val delivered = CountDownLatch(2)
    val buffer =
      SdkEventBuffer(
        maxBufferSize = 2,
        flushIntervalMs = 1,
        onFlush = {
          deliveries.add(ArrayList(it))
          delivered.countDown()
        },
        executor = executor,
      )

    try {
      buffer.start()
      assertTrue(executor.awaitTimerStart(), "Timer task should be pending")

      buffer.add(makeEvent(1))
      buffer.add(makeEvent(2))
      buffer.add(makeEvent(3))
      executor.releaseTimer()

      assertTrue(delivered.await(1, TimeUnit.SECONDS), "Both batches should be delivered")
      assertEquals(listOf(1L, 2L, 3L), deliveries.flatten().map { it.timestamp })
    } finally {
      executor.releaseTimer()
      buffer.shutdown()
      executor.shutdownNow()
    }
  }

  @Test
  fun `manual flush`() {
    val flushed = mutableListOf<List<SdkEvent>>()
    val buffer =
      SdkEventBuffer(
        maxBufferSize = 100,
        flushIntervalMs = 60_000,
        onFlush = { flushed.add(it) },
        executor = Executors.newSingleThreadScheduledExecutor(),
      )

    buffer.add(makeEvent(1))
    buffer.add(makeEvent(2))
    buffer.flush()

    assertEquals(1, flushed.size)
    assertEquals(2, flushed[0].size)
  }

  @Test
  fun `flush is no-op when empty`() {
    val flushed = mutableListOf<List<SdkEvent>>()
    val buffer =
      SdkEventBuffer(
        maxBufferSize = 100,
        flushIntervalMs = 60_000,
        onFlush = { flushed.add(it) },
        executor = Executors.newSingleThreadScheduledExecutor(),
      )

    buffer.flush()
    assertEquals(0, flushed.size)
  }

  @Test
  fun `shutdown flushes remaining events`() {
    val flushed = mutableListOf<List<SdkEvent>>()
    val executorThreadName = "SdkEventBuffer-shutdown-executor"
    val executor = Executors.newSingleThreadScheduledExecutor { runnable ->
      Thread(runnable, executorThreadName)
    }
    val flushThread = AtomicReference<String>()
    val buffer =
      SdkEventBuffer(
        maxBufferSize = 100,
        flushIntervalMs = 60_000,
        onFlush = {
          flushThread.set(Thread.currentThread().name)
          flushed.add(it)
        },
        executor = executor,
      )

    buffer.add(makeEvent(1))
    buffer.add(makeEvent(2))
    buffer.shutdown()

    assertTrue(
      executor.awaitTermination(1, TimeUnit.SECONDS),
      "Shutdown should drain queued delivery",
    )
    assertEquals(1, flushed.size)
    assertEquals(2, flushed[0].size)
    assertEquals(executorThreadName, flushThread.get())
  }

  @Test
  fun `shutdown drains queued capacity and pending batches on executor`() {
    val executorThreadName = "SdkEventBuffer-shutdown-drain-executor"
    val executor = Executors.newSingleThreadScheduledExecutor { runnable ->
      Thread(runnable, executorThreadName)
    }
    val deliveryStarted = CountDownLatch(1)
    val releaseDelivery = CountDownLatch(1)
    val deliveries = CopyOnWriteArrayList<List<SdkEvent>>()
    val deliveryThreads = CopyOnWriteArrayList<String>()
    val buffer =
      SdkEventBuffer(
        maxBufferSize = 2,
        flushIntervalMs = 60_000,
        onFlush = { events ->
          deliveries.add(ArrayList(events))
          deliveryThreads.add(Thread.currentThread().name)
          if (events.first().timestamp == 1L) {
            deliveryStarted.countDown()
            releaseDelivery.await()
          }
        },
        executor = executor,
      )

    try {
      buffer.add(makeEvent(1))
      buffer.add(makeEvent(2))
      assertTrue(deliveryStarted.await(1, TimeUnit.SECONDS), "Capacity delivery should be queued")

      buffer.add(makeEvent(3))
      val shutdownReturned = CountDownLatch(1)
      val shutdownCaller =
        Thread(
          {
            buffer.shutdown()
            shutdownReturned.countDown()
          },
          "SDK host shutdown",
        )
      shutdownCaller.start()
      assertFalse(
        shutdownReturned.await(100, TimeUnit.MILLISECONDS),
        "Shutdown should wait for queued delivery",
      )
      releaseDelivery.countDown()

      assertTrue(
        shutdownReturned.await(1, TimeUnit.SECONDS),
        "Shutdown should complete after delivery",
      )
      shutdownCaller.join(1_000)
      assertTrue(
        executor.awaitTermination(1, TimeUnit.SECONDS),
        "Shutdown should drain both batches",
      )
      assertEquals(listOf(1L, 2L, 3L), deliveries.flatten().map { it.timestamp })
      assertEquals(listOf(executorThreadName, executorThreadName), deliveryThreads)
    } finally {
      releaseDelivery.countDown()
      executor.shutdownNow()
    }
  }

  @Test
  fun `add after shutdown is ignored`() {
    val flushed = mutableListOf<List<SdkEvent>>()
    val buffer =
      SdkEventBuffer(
        maxBufferSize = 100,
        flushIntervalMs = 60_000,
        onFlush = { flushed.add(it) },
        executor = Executors.newSingleThreadScheduledExecutor(),
      )

    buffer.shutdown()
    buffer.add(makeEvent(1))

    // Only the shutdown flush, which was empty
    assertEquals(0, flushed.size)
  }

  @Test
  fun `thread safety - concurrent adds`() {
    val flushed = CopyOnWriteArrayList<List<SdkEvent>>()
    val executor = Executors.newSingleThreadScheduledExecutor()
    val buffer =
      SdkEventBuffer(
        maxBufferSize = 50,
        flushIntervalMs = 60_000,
        onFlush = { flushed.add(ArrayList(it)) },
        executor = executor,
      )

    val latch = CountDownLatch(1)
    val threads =
      (1..10).map { threadNum ->
        Thread {
          latch.await()
          for (i in 1..10) {
            buffer.add(makeEvent(threadNum * 100 + i))
          }
        }
      }

    threads.forEach { it.start() }
    latch.countDown()
    threads.forEach { it.join(5000) }
    drainExecutor(executor) // wait for any capacity flushes
    buffer.flush()

    val totalEvents = flushed.sumOf { it.size }
    assertEquals(100, totalEvents, "All 100 events should be flushed")
  }

  @Test
  fun `add when disabled is ignored`() {
    val flushed = mutableListOf<List<SdkEvent>>()
    val buffer =
      SdkEventBuffer(
        maxBufferSize = 100,
        flushIntervalMs = 60_000,
        onFlush = { flushed.add(it) },
        executor = Executors.newSingleThreadScheduledExecutor(),
      )

    buffer.isEnabled = false
    buffer.add(makeEvent(1))
    buffer.add(makeEvent(2))
    buffer.flush()

    assertEquals(0, flushed.size, "No events should be buffered when disabled")
  }

  @Test
  fun `re-enabling allows events again`() {
    val flushed = mutableListOf<List<SdkEvent>>()
    val buffer =
      SdkEventBuffer(
        maxBufferSize = 100,
        flushIntervalMs = 60_000,
        onFlush = { flushed.add(it) },
        executor = Executors.newSingleThreadScheduledExecutor(),
      )

    buffer.isEnabled = false
    buffer.add(makeEvent(1))

    buffer.isEnabled = true
    buffer.add(makeEvent(2))
    buffer.flush()

    assertEquals(1, flushed.size, "Should flush after re-enabling")
    assertEquals(1, flushed[0].size, "Only the event added after re-enabling should be present")
  }
}
