package dev.jasonpearson.automobile.sdk.noop

import dev.jasonpearson.automobile.protocol.SdkEvent
import dev.jasonpearson.automobile.sdk.persistence.EventPersistence
import dev.jasonpearson.automobile.sdk.persistence.PendingEventBatch

/** Silent [EventPersistence] that never persists anything. */
internal object NoOpEventPersistence : EventPersistence {
  override fun persist(events: List<SdkEvent>, deliveryId: String?): String? = null

  override fun loadPending(): List<PendingEventBatch> = emptyList()

  override fun removeBatch(batchId: String) = Unit

  override fun cleanup(maxAgeDays: Int) = Unit
}
