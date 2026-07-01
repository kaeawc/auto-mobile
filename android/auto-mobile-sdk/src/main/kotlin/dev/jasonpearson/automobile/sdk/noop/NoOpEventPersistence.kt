package dev.jasonpearson.automobile.sdk.noop

import dev.jasonpearson.automobile.protocol.SdkEvent
import dev.jasonpearson.automobile.sdk.persistence.EventPersistence

/** Silent [EventPersistence] that never persists anything. */
internal object NoOpEventPersistence : EventPersistence {
  override fun persist(events: List<SdkEvent>): String? = null

  override fun loadPending(): List<Pair<String, List<SdkEvent>>> = emptyList()

  override fun removeBatch(batchId: String) = Unit

  override fun cleanup(maxAgeDays: Int) = Unit
}
