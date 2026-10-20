package dev.jasonpearson.automobile.sdk.events

import dev.jasonpearson.automobile.protocol.SdkEvent
import dev.jasonpearson.automobile.protocol.SdkLifecycleEvent
import dev.jasonpearson.automobile.sdk.TestFailureException
import dev.jasonpearson.automobile.sdk.persistence.NoOpEventPersistence
import dev.jasonpearson.automobile.sdk.persistence.PendingEventBatch
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executor
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import kotlin.test.assertFalse

internal abstract class SdkEventBufferFixture {

  protected fun makeEvent(i: Int): SdkEvent =
    SdkLifecycleEvent(
      timestamp = i.toLong(),
      kind = "event-$i",
    )

  /** Wait for any pending tasks on the executor to complete. */
  protected fun drainExecutor(executor: ScheduledExecutorService) {
    executor.submit {}.get(1, TimeUnit.SECONDS)
  }

  protected class TimerGatedExecutor : ScheduledThreadPoolExecutor(1) {
    private val timerStarted = CountDownLatch(1)
    private val allowTimer = CountDownLatch(1)

    override fun scheduleAtFixedRate(
      command: Runnable,
      initialDelay: Long,
      period: Long,
      unit: TimeUnit,
    ): ScheduledFuture<*> =
      super.scheduleAtFixedRate(
        {
          timerStarted.countDown()
          allowTimer.await()
          command.run()
        },
        initialDelay,
        period,
        unit,
      )

    fun awaitTimerStart(): Boolean = timerStarted.await(1, TimeUnit.SECONDS)

    fun releaseTimer() {
      allowTimer.countDown()
    }
  }

  // ============ Delivery-failure persistence + churn (#3605, #3710) =========

  /** Always throws from persist() — persist is best-effort on the failure path. */
  protected class ThrowingPersistence : NoOpEventPersistence() {
    override fun persist(events: List<SdkEvent>, deliveryId: String?): String? =
      throw TestFailureException("boom")

    override fun loadPending(): List<PendingEventBatch> = emptyList()
  }

  /** Counts persist() calls so we can assert the happy path never writes to disk. */
  protected class CountingPersistence : NoOpEventPersistence() {
    val persistCount = AtomicInteger(0)
    val persistThread = AtomicReference<Thread>()

    override fun persist(events: List<SdkEvent>, deliveryId: String?): String? {
      persistThread.set(Thread.currentThread())
      persistCount.incrementAndGet()
      return "batch-id"
    }

    override fun loadPending(): List<PendingEventBatch> = emptyList()
  }

  /** Explicitly queued tasks prove callbacks do not persist inline; draining uses a worker. */
  protected class QueuedPersistenceExecutor : Executor {
    val tasks = ArrayDeque<Runnable>()

    override fun execute(command: Runnable) {
      tasks.addLast(command)
    }

    fun drain() {
      while (tasks.isNotEmpty()) {
        val task = tasks.removeFirst()
        val error = AtomicReference<Throwable>()
        val worker =
          Thread(
            {
              try {
                task.run()
              } catch (failure: Throwable) {
                error.set(failure)
              }
            },
            "fallback-test-background",
          )
        worker.isDaemon = true
        worker.start()
        worker.join(1000)
        assertFalse(worker.isAlive, "Persistence must not block on the buffer lock")
        error.get()?.let { throw it }
      }
    }
  }
}
