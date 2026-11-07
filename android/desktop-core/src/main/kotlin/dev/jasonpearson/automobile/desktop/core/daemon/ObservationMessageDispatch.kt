package dev.jasonpearson.automobile.desktop.core.daemon

import kotlinx.serialization.serializer

internal suspend fun ObservationStreamClient.handleMessage(message: String) {
  val response = json.decodeFromString(serializer<StreamResponse>(), message)
  log.info("Handling message type: ${response.type}")
  if (handleDataMessage(response)) return
  when (response.type) {
    "subscription_response" -> handleSubscriptionResponse(response)
    "storage_reconciliation_required" -> handleStorageReconciliationRequired(response)
    "device_session_ended" -> handleDeviceSessionEnded(response)
    "device_session_started" -> Unit
    "ping" -> handlePing(response)
    "error" -> handleError(response)
    else -> log.warn("Unknown message type: ${response.type}")
  }
}
