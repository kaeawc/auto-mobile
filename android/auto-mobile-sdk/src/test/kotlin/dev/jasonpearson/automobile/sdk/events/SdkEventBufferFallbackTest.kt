package dev.jasonpearson.automobile.sdk.events

import java.util.concurrent.Executor
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.atomic.AtomicReference
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue
import org.junit.Test

internal class SdkEventBufferFallbackTest : SdkEventBufferFixture() {
  @Test
  fun `throwing persistence after shutdown is contained and counts drops`() {
    val counter = DefaultDropCounter()
    val fallback = QueuedPersistenceExecutor()
    val buffer =
      SdkEventBuffer(
        onFlush = {},
        persistence = ThrowingPersistence(),
        dropCounter = counter,
        persistenceExecutor = fallback,
      )
    buffer.shutdown()
    buffer.persistUndelivered(listOf(makeEvent(1), makeEvent(2)))
    assertTrue(counter.snapshot().isEmpty())
    fallback.drain()
    assertEquals(2L, counter.snapshot()[DropReason.DELIVERY_FAILED])
  }

  @Test
  fun `undelivered batch after shutdown persists on fallback executor`() {
    val persistence = CountingPersistence()
    val counter = DefaultDropCounter()
    val fallback = QueuedPersistenceExecutor()
    val buffer =
      SdkEventBuffer(
        onFlush = {},
        persistence = persistence,
        dropCounter = counter,
        persistenceExecutor = fallback,
      )
    buffer.shutdown()
    val caller = Thread.currentThread()
    buffer.persistUndelivered(listOf(makeEvent(1)))
    assertEquals(0, persistence.persistCount.get(), "Shutdown callback must never persist inline")
    assertEquals(1, fallback.tasks.size)
    fallback.drain()
    assertEquals(1, persistence.persistCount.get())
    assertNotEquals(caller, persistence.persistThread.get())
    assertTrue(counter.snapshot().isEmpty())
  }

  @Test
  fun `fallback rejection counts terminal drops without inline persistence`() {
    val persistence = CountingPersistence()
    val counter = DefaultDropCounter()
    val buffer =
      SdkEventBuffer(
        onFlush = {},
        persistence = persistence,
        dropCounter = counter,
        persistenceExecutor = Executor { throw RejectedExecutionException("stopped") },
      )
    buffer.shutdown()
    buffer.persistUndelivered(listOf(makeEvent(1), makeEvent(2)))
    assertEquals(0, persistence.persistCount.get())
    assertEquals(2L, counter.snapshot()[DropReason.DELIVERY_FAILED])
  }

  @Test
  fun `executor rejection race queues persistence on fallback`() {
    val executor =
      object : ScheduledThreadPoolExecutor(1) {
        override fun execute(command: Runnable) {
          throw RejectedExecutionException("shutdown raced submission")
        }
      }
    val fallback = QueuedPersistenceExecutor()
    val persistence = CountingPersistence()
    val buffer =
      SdkEventBuffer(
        onFlush = {},
        persistence = persistence,
        executor = executor,
        persistenceExecutor = fallback,
      )
    try {
      buffer.persistUndelivered(listOf(makeEvent(1)))
      assertEquals(0, persistence.persistCount.get())
      assertEquals(1, fallback.tasks.size)
      fallback.drain()
      assertEquals(1, persistence.persistCount.get())
      assertNotEquals(Thread.currentThread(), persistence.persistThread.get())
    } finally {
      buffer.shutdown()
    }
  }

  @Test
  fun `fallback submission is outside buffer lock`() {
    val counter = DefaultDropCounter()
    lateinit var buffer: SdkEventBuffer
    val fallback = Executor { command ->
      val error = AtomicReference<Throwable>()
      val worker =
        Thread(
          {
            try {
              buffer.flush() // Acquires the buffer lock before doing any disk work.
              command.run()
            } catch (failure: Throwable) {
              error.set(failure)
            }
          },
          "fallback-lock-test",
        )
      worker.isDaemon = true
      worker.start()
      worker.join(1000)
      assertFalse(worker.isAlive, "Submission must not hold the buffer lock")
      error.get()?.let { throw it }
    }
    val persistence = CountingPersistence()
    buffer =
      SdkEventBuffer(
        onFlush = {},
        persistence = persistence,
        dropCounter = counter,
        persistenceExecutor = fallback,
      )
    buffer.shutdown()
    buffer.persistUndelivered(listOf(makeEvent(1)))
    assertEquals(1, persistence.persistCount.get())
    assertNotEquals(Thread.currentThread(), persistence.persistThread.get())
    assertTrue(counter.snapshot().isEmpty())
  }

  @Test
  fun `caller flush failure queues persistence and preserves FLUSH_ERROR accounting`() {
    val fallback = QueuedPersistenceExecutor()
    val executor = Executors.newSingleThreadScheduledExecutor()
    val counter = DefaultDropCounter()
    val persistence = CountingPersistence()
    val buffer =
      SdkEventBuffer(
        onFlush = { throw IllegalStateException("flush failed") },
        persistence = persistence,
        executor = executor,
        dropCounter = counter,
        persistenceExecutor = fallback,
      )
    buffer.add(makeEvent(1))
    buffer.add(makeEvent(2))
    // Force the fallback path without shutting down the still-populated buffer.
    executor.shutdown()
    buffer.flush()
    assertEquals(0, persistence.persistCount.get())
    assertEquals(mapOf(DropReason.FLUSH_ERROR to 2L), counter.snapshot())
    fallback.drain()
    assertEquals(1, persistence.persistCount.get())
    assertNotEquals(Thread.currentThread(), persistence.persistThread.get())
    assertEquals(mapOf(DropReason.FLUSH_ERROR to 2L), counter.snapshot())
    buffer.shutdown()
  }

  @Test
  fun `flush persistence rejection preserves FLUSH_ERROR without double counting`() {
    val executor = Executors.newSingleThreadScheduledExecutor()
    val counter = DefaultDropCounter()
    val persistence = CountingPersistence()
    val buffer =
      SdkEventBuffer(
        onFlush = { error("flush failed") },
        persistence = persistence,
        executor = executor,
        dropCounter = counter,
        persistenceExecutor = Executor { throw RejectedExecutionException() },
      )
    buffer.add(makeEvent(1))
    executor.shutdown()
    buffer.flush()
    assertEquals(0, persistence.persistCount.get())
    assertEquals(mapOf(DropReason.FLUSH_ERROR to 1L), counter.snapshot())
    buffer.shutdown()
  }

  @Test
  fun `replay execute after shutdown refuses work without running inline`() {
    val buffer = SdkEventBuffer(onFlush = {})
    buffer.shutdown()
    var ran = false
    buffer.execute { ran = true }
    assertFalse(ran)
  }

  @Test
  fun `replay execute after external executor shutdown refuses work without running inline`() {
    val executor = Executors.newSingleThreadScheduledExecutor()
    val buffer = SdkEventBuffer(onFlush = {}, executor = executor)
    try {
      executor.shutdown()
      var ran = false
      buffer.execute { ran = true }
      assertFalse(ran)
    } finally {
      buffer.shutdown()
    }
  }
}
