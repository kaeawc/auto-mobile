package dev.jasonpearson.automobile.sdk.events

import dev.jasonpearson.automobile.protocol.SdkEvent

/**
 * Processes an event before it is buffered for delivery.
 *
 * Implementations may modify the event (e.g. scrub PII) or return `null` to drop it. Processors are
 * invoked in order; if any returns null the event is discarded and a FILTERED drop is recorded.
 */
fun interface EventProcessor {
  /** Return the event (possibly modified) or null to drop it. */
  fun process(event: SdkEvent): SdkEvent?
}
