package dev.jasonpearson.automobile.sdk.persistence

import dev.jasonpearson.automobile.protocol.SdkEvent

internal open class NoOpEventPersistence : EventPersistence {
  override fun persist(events: List<SdkEvent>, deliveryId: String?): String? = null

  override fun loadPending(): List<PendingEventBatch> = emptyList()

  override fun removeBatch(batchId: String) = Unit

  override fun cleanup(maxAgeDays: Int) = Unit
}
