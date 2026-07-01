package dev.jasonpearson.automobile.sdk.events

import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong

/** Reason an event was dropped by [SdkEventBuffer]. */
enum class DropReason {
  DISABLED,
  SHUTDOWN,
  FLUSH_ERROR,
  BUFFER_OVERFLOW,
  FILTERED,
  DELIVERY_FAILED,
  PROCESSOR_ERROR,
}

/** Tracks counts of dropped events by reason. */
internal interface DropCounter {
  fun increment(reason: DropReason, count: Int = 1)

  fun snapshot(): Map<DropReason, Long>

  fun reset()
}

/** Thread-safe [DropCounter] backed by [ConcurrentHashMap] and [AtomicLong]. */
internal class DefaultDropCounter : DropCounter {

  private val counts = ConcurrentHashMap<DropReason, AtomicLong>()

  override fun increment(reason: DropReason, count: Int) {
    counts.computeIfAbsent(reason) { AtomicLong(0) }.addAndGet(count.toLong())
  }

  override fun snapshot(): Map<DropReason, Long> =
      counts.mapValues { (_, v) -> v.get() }.filterValues { it > 0 }

  override fun reset() {
    counts.values.forEach { it.set(0) }
  }
}
