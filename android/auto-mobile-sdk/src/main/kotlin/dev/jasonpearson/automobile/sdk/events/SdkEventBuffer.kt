package dev.jasonpearson.automobile.sdk.events

import dev.jasonpearson.automobile.protocol.SdkEvent
import dev.jasonpearson.automobile.sdk.logging.DefaultSdkLogger
import dev.jasonpearson.automobile.sdk.persistence.EventPersistence
import java.util.concurrent.Executor
import java.util.concurrent.Executors
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/**
 * Thread-safe buffer for SDK events that flushes on capacity or timer.
 *
 * Events are collected and flushed as a batch to reduce Intent broadcast frequency. Flush occurs
 * when [maxBufferSize] is reached or every [flushIntervalMs] milliseconds, whichever comes first.
 *
 * @param maxBufferSize Maximum events before forced flush (default 50)
 * @param flushIntervalMs Periodic flush interval in milliseconds (default 500)
 * @param onFlush Callback invoked with the batch of events to send
 * @param persistence Optional disk persistence for failed deliveries
 * @param executor Optional executor for periodic flush scheduling (for testing)
 * @param processors Event processors invoked in order before buffering; returning null drops the
 *   event
 * @param maxPendingEvents Hard cap on buffered events; oldest events are evicted when exceeded
 * @param persistenceExecutor Background fallback for late retries; defaults to a lazy daemon pool
 *   whose sole worker expires after two idle seconds
 */
internal class SdkEventBuffer(
  private val maxBufferSize: Int = 50,
  private val flushIntervalMs: Long = 500,
  private val onFlush: (List<SdkEvent>) -> Unit,
  private val persistence: EventPersistence? = null,
  private val executor: ScheduledExecutorService = Executors.newSingleThreadScheduledExecutor { r ->
    Thread(r, "SdkEventBuffer").apply { isDaemon = true }
  },
  private val dropCounter: DropCounter? = null,
  private val processors: List<EventProcessor> = emptyList(),
  private val maxPendingEvents: Int = 500,
  private val backPressureStrategy: BackPressureStrategy = BackPressureStrategy.DROP_OLDEST,
  persistenceExecutor: Executor? = null,
) {
  // Preserve binary compatibility with the published nine-argument JVM constructor.
  // No defaults here: omitted arguments select the primary without overload ambiguity.
  constructor(
    maxBufferSize: Int,
    flushIntervalMs: Long,
    onFlush: (List<SdkEvent>) -> Unit,
    persistence: EventPersistence?,
    executor: ScheduledExecutorService,
    dropCounter: DropCounter?,
    processors: List<EventProcessor>,
    maxPendingEvents: Int,
    backPressureStrategy: BackPressureStrategy,
  ) : this(
    maxBufferSize = maxBufferSize,
    flushIntervalMs = flushIntervalMs,
    onFlush = onFlush,
    persistence = persistence,
    executor = executor,
    dropCounter = dropCounter,
    processors = processors,
    maxPendingEvents = maxPendingEvents,
    backPressureStrategy = backPressureStrategy,
    persistenceExecutor = null,
  )

  private val fallbackPersistenceExecutor: Executor by lazy {
    persistenceExecutor
      ?: ThreadPoolExecutor(
        0,
        1,
        2,
        TimeUnit.SECONDS,
        LinkedBlockingQueue<Runnable>(),
      ) { runnable ->
        Thread(runnable, "SdkEventPersistence").apply { isDaemon = true }
      }
  }
  private val logger = DefaultSdkLogger()

  private class DeliveryTask(val runnable: Runnable) {
    var future: ScheduledFuture<*>? = null
  }

  private val deliveryTasks = mutableSetOf<DeliveryTask>()
  // Only tasks already running on our executor may persist inline while shutdown drains.
  private val deliveryWorker = ThreadLocal<Boolean>()
  private val lock = ReentrantLock()
  private val buffer = mutableListOf<SdkEvent>()
  private val pendingBatches = ArrayDeque<MutableList<SdkEvent>>()
  private var flushTask: ScheduledFuture<*>? = null
  private var isDeliveryScheduled = false
  @Volatile private var isShutdown = false
  @Volatile var isEnabled: Boolean = true

  /** Start the periodic flush timer. */
  fun start() {
    lock.withLock {
      if (flushTask == null && !isShutdown) {
        flushTask =
          executor.scheduleAtFixedRate(
            // Backstop: any exception escaping the periodic task cancels all future
            // runs (the scheduleAtFixedRate contract). Per-batch errors are already
            // accounted inside deliverBatch; swallow here so the timer survives (#3605).
            {
              runCatching { enqueueFlush() }
                .onFailure { error ->
                  logger.w("SdkEventBuffer", error) { "Could not enqueue periodic flush" }
                }
            },
            flushIntervalMs,
            flushIntervalMs,
            TimeUnit.MILLISECONDS,
          )
      }
    }
  }

  /** Add an event to the buffer. Flushes immediately if buffer is full. */
  fun add(event: SdkEvent) {
    if (isShutdown) {
      dropCounter?.increment(DropReason.SHUTDOWN)
      return
    }
    if (!isEnabled) {
      dropCounter?.increment(DropReason.DISABLED)
      return
    }

    var current: SdkEvent = event
    for (processor in processors) {
      try {
        current =
          processor.process(current)
            ?: run {
              dropCounter?.increment(DropReason.FILTERED)
              return
            }
      } catch (error: Exception) {
        logger.w("SdkEventBuffer", error) { "Event processor failed" }
        dropCounter?.increment(DropReason.PROCESSOR_ERROR)
        return
      }
    }

    lock.withLock {
      if (isShutdown) {
        dropCounter?.increment(DropReason.SHUTDOWN)
        return
      }

      while (pendingEventCount() >= maxPendingEvents) {
        when (backPressureStrategy) {
          BackPressureStrategy.DROP_OLDEST -> {
            dropOldestPendingEvent()
            dropCounter?.increment(DropReason.BUFFER_OVERFLOW)
          }
          BackPressureStrategy.IGNORE_NEWEST -> {
            dropCounter?.increment(DropReason.BUFFER_OVERFLOW)
            return
          }
        }
      }

      buffer.add(current)
      if (buffer.size >= maxBufferSize) {
        val snapshot = ArrayList(buffer)
        buffer.clear()
        enqueueDelivery(snapshot)
      }
    }
  }

  /** Flush any buffered events immediately. */
  fun flush() {
    val snapshot: List<SdkEvent>

    lock.withLock {
      if (buffer.isEmpty()) return
      snapshot = ArrayList(buffer)
      buffer.clear()
    }

    deliverBatch(snapshot)
  }

  /** Submit a task to run on the buffer's background executor. */
  fun execute(task: Runnable) {
    lock.withLock {
      if (isShutdown) return
      try {
        executor.execute(task)
      } catch (error: RejectedExecutionException) {
        // Shutdown can refuse optional replay work; its file remains on disk.
        logger.d("SdkEventBuffer") { "Replay submission refused: ${error.message}" }
        // Refused work is simply not run; replay leaves its file on disk for the next launch.
      }
    }
  }

  /** Share the existing scheduler with delivery timeouts; no extra worker is created. */
  internal fun scheduleDelivery(task: Runnable, delayMs: Long): (() -> Unit)? = lock.withLock {
    if (isShutdown || executor.isShutdown) return null
    val delivery = DeliveryTask(task)
    delivery.future =
      executor.schedule(
        {
          lock.withLock { deliveryTasks.remove(delivery) }
          runOnDeliveryWorker(task)
        },
        delayMs,
        TimeUnit.MILLISECONDS,
      )
    deliveryTasks.add(delivery)
    return {
      lock.withLock {
        deliveryTasks.remove(delivery)
        delivery.future?.cancel(false)
      }
    }
  }

  /** Dispatch result processing with the same late-completion fallback as persistence. */
  internal fun executeDelivery(task: Runnable) {
    persistInBackground(Runnable { runOnDeliveryWorker(task) })
  }

  /** Shutdown the buffer, flushing remaining events. */
  fun shutdown() {
    lock.withLock {
      if (isShutdown) return
      isShutdown = true
      flushTask?.cancel(false)
      val deliveries = deliveryTasks.toList()
      deliveryTasks.clear()
      deliveries.forEach { it.future?.cancel(false) }
      if (deliveries.isNotEmpty()) {
        // Resolve existing timeouts/retries on the same worker, before shutdown can terminate.
        executor.execute {
          runOnDeliveryWorker(
            Runnable {
              deliveries.forEach {
                try {
                  it.runnable.run()
                } catch (error: Exception) {
                  logger.w("SdkEventBuffer", error) { "Could not resolve shutdown delivery" }
                }
              }
            }
          )
        }
      }
      if (buffer.isNotEmpty()) {
        val snapshot = ArrayList(buffer)
        buffer.clear()
        enqueueDelivery(snapshot)
      }
    }
    executor.shutdown()
    awaitExecutorTermination()
  }

  /** Snapshot and queue pending events from the periodic executor. */
  private fun enqueueFlush() {
    lock.withLock {
      if (isShutdown || buffer.isEmpty()) return
      val snapshot = ArrayList(buffer)
      buffer.clear()
      enqueueDelivery(snapshot)
    }
  }

  /** Queue delivery while holding [lock] to preserve snapshot submission order and backpressure. */
  private fun enqueueDelivery(events: MutableList<SdkEvent>) {
    pendingBatches.addLast(events)
    if (!isDeliveryScheduled) {
      isDeliveryScheduled = true
      executor.execute { runOnDeliveryWorker(Runnable { drainDeliveries() }) }
    }
  }

  private fun drainDeliveries() {
    while (true) {
      val events = lock.withLock {
        if (pendingBatches.isEmpty()) {
          isDeliveryScheduled = false
          return
        }
        pendingBatches.removeFirst()
      }
      deliverBatch(events)
    }
  }

  /** Must be called while holding [lock]. Delivery in progress is no longer pending. */
  private fun pendingEventCount(): Int = buffer.size + pendingBatches.sumOf { it.size }

  /** Must be called while holding [lock]. */
  private fun dropOldestPendingEvent() {
    val oldestBatch = pendingBatches.firstOrNull()
    if (oldestBatch == null) {
      buffer.removeAt(0)
      return
    }

    oldestBatch.removeAt(0)
    if (oldestBatch.isEmpty()) {
      pendingBatches.removeFirst()
    }
  }

  /** Preserve shutdown delivery completion without running delivery on the caller thread. */
  private fun awaitExecutorTermination() {
    var wasInterrupted = false
    while (true) {
      try {
        if (executor.awaitTermination(Long.MAX_VALUE, TimeUnit.NANOSECONDS)) break
      } catch (error: InterruptedException) {
        // Preserve the established drain-and-restore-interrupt shutdown contract.
        logger.d("SdkEventBuffer") { "Interrupted while draining shutdown: ${error.message}" }
        wasInterrupted = true
      }
    }
    if (wasInterrupted) {
      Thread.currentThread().interrupt()
    }
  }

  /** Retry callbacks may arrive on the main looper; persist on our executor while active. */
  internal fun persistUndelivered(events: List<SdkEvent>) {
    val task = Runnable {
      val persisted =
        try {
          persistence?.persist(events) != null
        } catch (error: Exception) {
          logger.w("SdkEventBuffer", error) { "Could not persist undelivered batch" }
          // Persistence is best-effort; contain custom failures to protect the host and executor.
          false
        }
      // Only events that could not be retained on disk are delivery drops.
      if (!persisted) countDeliveryFailure(events.size)
    }
    persistInBackground(task) { countDeliveryFailure(events.size) }
  }

  private fun runOnDeliveryWorker(task: Runnable) {
    val previous = deliveryWorker.get()
    deliveryWorker.set(true)
    try {
      task.run()
    } finally {
      if (previous == null) deliveryWorker.remove() else deliveryWorker.set(previous)
    }
  }

  /** Shutdown may persist inline only on our existing worker, never the host caller. */
  private fun persistInBackground(task: Runnable, onRejected: () -> Unit = {}) {
    if (isShutdown && deliveryWorker.get() == true) {
      task.run()
      return
    }
    val accepting = lock.withLock { !isShutdown && !executor.isShutdown }
    if (accepting) {
      try {
        executor.execute(task)
        return
      } catch (error: Exception) {
        logger.w("SdkEventBuffer", error) { "Could not submit background persistence" }
        // Shutdown may race submission; the fallback also drains late retry callbacks.
      }
    }
    try {
      fallbackPersistenceExecutor.execute(task)
    } catch (error: Exception) {
      logger.w("SdkEventBuffer", error) { "Could not submit fallback persistence" }
      // Refused work cannot be retained; never fall back to caller-thread disk I/O.
      onRejected()
    }
  }

  private fun countDeliveryFailure(count: Int) {
    try {
      dropCounter?.increment(DropReason.DELIVERY_FAILED, count)
    } catch (error: Exception) {
      logger.w("SdkEventBuffer", error) { "Could not count delivery failure" }
      // Custom counters must not crash a host retry callback.
    }
  }

  private fun deliverBatch(events: List<SdkEvent>) {
    if (events.isEmpty()) return
    try {
      onFlush(events)
    } catch (error: Exception) {
      logger.w("SdkEventBuffer", error) { "Could not flush event batch" }
      // A throwing custom EventPersistence.persist() must NOT escape this task: it
      // runs inside scheduleAtFixedRate and an uncaught exception would silently
      // cancel all future periodic flushes (#3605), so guard the persist too.
      persistInBackground(
        Runnable {
          try {
            persistence?.persist(events)
          } catch (error: Exception) {
            logger.w("SdkEventBuffer", error) { "Could not persist failed flush" }
            // Best-effort retry; FLUSH_ERROR already accounts for this failed delivery.
          }
        }
      )
      repeat(events.size) { dropCounter?.increment(DropReason.FLUSH_ERROR) }
    }
  }
}
