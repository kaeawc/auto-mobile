package dev.jasonpearson.automobile.sdk.noop

import dev.jasonpearson.automobile.protocol.SdkEvent
import dev.jasonpearson.automobile.sdk.events.EventProcessor

/** Pass-through [EventProcessor] that returns the event unchanged. */
object NoOpEventProcessor : EventProcessor {
  override fun process(event: SdkEvent): SdkEvent = event
}
