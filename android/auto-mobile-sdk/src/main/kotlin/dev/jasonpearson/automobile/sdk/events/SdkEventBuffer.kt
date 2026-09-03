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
  private val executor: ScheduledExecutorService = Executors.newSingleThreadScheduledExecutor { r ->
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
            // Backstop: any exception escaping the periodic task cancels all future
            // runs (the scheduleAtFixedRate contract). Per-batch errors are already
            // accounted inside deliverBatch; swallow here so the timer survives (#3605).
            { runCatching { enqueueFlush() } },
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

    lock.withLock {
      if (isShutdown) {
        dropCounter?.increment(DropReason.SHUTDOWN)
        return
      }

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
        val snapshot = ArrayList(buffer)
        buffer.clear()
        submitDelivery(snapshot)
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
      if (!isShutdown) {
        executor.execute(task)
      }
    }
  }

  /** Shutdown the buffer, flushing remaining events. */
  fun shutdown() {
    lock.withLock {
      if (isShutdown) return
      isShutdown = true
      flushTask?.cancel(false)
      if (buffer.isNotEmpty()) {
        val snapshot = ArrayList(buffer)
        buffer.clear()
        submitDelivery(snapshot)
      }
    }
    executor.shutdown()
  }

  /** Snapshot and queue pending events from the periodic executor. */
  private fun enqueueFlush() {
    lock.withLock {
      if (isShutdown || buffer.isEmpty()) return
      val snapshot = ArrayList(buffer)
      buffer.clear()
      submitDelivery(snapshot)
    }
  }

  /** Queue delivery while holding [lock] to preserve snapshot submission order. */
  private fun submitDelivery(events: List<SdkEvent>) {
    executor.execute { deliverBatch(events) }
  }

  private fun deliverBatch(events: List<SdkEvent>) {
    if (events.isEmpty()) return
    try {
      // Delivery (onFlush -> sendBroadcast) is a synchronous, fire-and-forget
      // in-process post whose success/failure is known immediately, so there is no
      // asynchronous sink whose failure would need a disk-backed retry. Persisting
      // before delivery meant a write-then-immediate-delete on every flush — pure
      // I/O churn — so only persist when delivery actually throws, for next-launch
      // replay (#3710, the twin of iOS #3636).
      onFlush(events)
    } catch (_: Exception) {
      // A throwing custom EventPersistence.persist() must NOT escape this task: it
      // runs inside scheduleAtFixedRate and an uncaught exception would silently
      // cancel all future periodic flushes (#3605), so guard the persist too.
      try {
        persistence?.persist(events)
      } catch (_: Exception) {
        // best-effort persistence for retry; delivery already failed
      }
      repeat(events.size) { dropCounter?.increment(DropReason.FLUSH_ERROR) }
    }
  }
}
