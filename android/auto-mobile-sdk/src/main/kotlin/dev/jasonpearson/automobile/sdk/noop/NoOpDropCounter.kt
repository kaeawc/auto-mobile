package dev.jasonpearson.automobile.sdk.noop

import dev.jasonpearson.automobile.sdk.events.DropCounter
import dev.jasonpearson.automobile.sdk.events.DropReason

/** Silent [DropCounter] that discards all increments. */
internal object NoOpDropCounter : DropCounter {
  override fun increment(reason: DropReason, count: Int) = Unit

  override fun snapshot(): Map<DropReason, Long> = emptyMap()

  override fun reset() = Unit
}
