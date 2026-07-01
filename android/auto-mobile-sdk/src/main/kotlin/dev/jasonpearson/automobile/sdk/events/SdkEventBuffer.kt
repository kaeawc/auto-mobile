package dev.jasonpearson.automobile.sdk.events

import dev.jasonpearson.automobile.protocol.SdkEvent
import dev.jasonpearson.automobile.sdk.persistence.EventPersistence
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
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
 * @param persistence Optional disk persistence — events are written before broadcast and removed on
 *   success
 * @param executor Optional executor for periodic flush scheduling (for testing)
 * @param processors Event processors invoked in order before buffering; returning null drops the
 *   event
 * @param maxPendingEvents Hard cap on buffered events; oldest events are evicted when exceeded
 */
internal class SdkEventBuffer(
    private val maxBufferSize: Int = 50,
    private val flushIntervalMs: Long = 500,
    private val onFlush: (List<SdkEvent>) -> Unit,
    private val persistence: EventPersistence? = null,
    private val executor: ScheduledExecutorService =
        Executors.newSingleThreadScheduledExecutor { r ->
          Thread(r, "SdkEventBuffer").apply { isDaemon = true }
        },
    private val dropCounter: DropCounter? = null,
    private val processors: List<EventProcessor> = emptyList(),
    private val maxPendingEvents: Int = 500,
    private val backPressureStrategy: BackPressureStrategy = BackPressureStrategy.DROP_OLDEST,
) {
  private val lock = ReentrantLock()
  private val buffer = mutableListOf<SdkEvent>()
  private var flushTask: ScheduledFuture<*>? = null
  @Volatile private var isShutdown = false
  @Volatile var isEnabled: Boolean = true

  /** Start the periodic flush timer. */
  fun start() {
    lock.withLock {
      if (flushTask == null && !isShutdown) {
        flushTask =
            executor.scheduleAtFixedRate(
                { flush() },
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
      } catch (_: Exception) {
        dropCounter?.increment(DropReason.PROCESSOR_ERROR)
        return
      }
    }

    val shouldFlush: Boolean
    val snapshot: List<SdkEvent>

    lock.withLock {
      if (buffer.size >= maxPendingEvents) {
        when (backPressureStrategy) {
          BackPressureStrategy.DROP_OLDEST -> {
            buffer.removeFirst()
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
        snapshot = ArrayList(buffer)
        buffer.clear()
        shouldFlush = true
      } else {
        snapshot = emptyList()
        shouldFlush = false
      }
    }

    if (shouldFlush) {
      deliverBatch(snapshot)
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
    if (!isShutdown) {
      executor.execute(task)
    }
  }

  /** Shutdown the buffer, flushing remaining events. */
  fun shutdown() {
    isShutdown = true
    flushTask?.cancel(false)
    flush()
    executor.shutdown()
  }

  private fun deliverBatch(events: List<SdkEvent>) {
    if (events.isEmpty()) return
    val batchId = persistence?.persist(events) // persist to disk first
    try {
      onFlush(events)
      batchId?.let { persistence?.removeBatch(it) } // remove on success
    } catch (_: Exception) {
      repeat(events.size) { dropCounter?.increment(DropReason.FLUSH_ERROR) }
      // Keep on disk for retry on next launch
    }
  }
}
