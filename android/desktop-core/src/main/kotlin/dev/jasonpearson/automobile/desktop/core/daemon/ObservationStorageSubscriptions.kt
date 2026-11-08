package dev.jasonpearson.automobile.desktop.core.daemon

import dev.jasonpearson.automobile.desktop.core.connection.ConnectionState
import dev.jasonpearson.automobile.desktop.core.connection.isConnected
import java.util.UUID
import kotlinx.coroutines.flow.update

internal fun ObservationStreamClient.enqueueStorageUpdate(update: StorageStreamUpdate): Boolean {
  storageUpdateQueue.add(update)
  return storageUpdateSignal.trySend(Unit).isSuccess
}

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
internal suspend fun ObservationStreamClient.emitDeviceEvent(response: StreamResponse) {
  val event = response.toConnectionLost() ?: return

  _hierarchyUpdates.resetReplayCache()
  _screenshotUpdates.resetReplayCache()
  _performanceUpdates.resetReplayCache()
  _deviceEvents.emit(event)
  log.info("Emitted device connection lost event for ${event.deviceId}")
}

internal fun ObservationStreamClient.driveStorageSubscription(key: StorageSubscriptionKey) {
  if (!_connectionState.value.isConnected) return

  val request =
    synchronized(ownershipLock) {
      storageLedger.next(key, { UUID.randomUUID().toString() }, connectionGeneration)
    } ?: return

  beforeStorageRequestSend()
  val sent =
    sendRequest(
      StreamRequest(
        id = request.requestId,
        command = if (request.subscribe) "subscribe_storage" else "unsubscribe_storage",
        deviceId = subscribedDeviceId,
        deviceSessionUuid = subscribedDeviceSessionUuid,
        sessionUuid = authenticatedSessionUuid(),
        packageName = key.packageName,
        fileName = key.fileName,
      ),
      expectedConnectionGeneration = request.connectionGeneration,
    )
  synchronized(ownershipLock) { storageLedger.sent(request, sent) }
}

internal fun ObservationStreamClient.reapplyStorageSubscriptions() {
  val keys = synchronized(ownershipLock) { storageLedger.desiredKeys }
  for (key in keys) {
    driveStorageSubscription(key)
  }
}

internal suspend fun ObservationStreamClient.handleStorageSubscriptionResponse(
  requestId: String,
  success: Boolean,
  error: String?,
): Boolean {
  val resolution =
    synchronized(ownershipLock) { storageLedger.resolve(requestId, success) } ?: return false
  val pending = resolution.command
  storageSubscriptionResponseChannel.send(
    StorageSubscriptionResponse(
      requestId = requestId,
      key = pending.key,
      subscribe = pending.subscribe,
      success = success,
      error = error,
    ),
  )
  if (resolution.redrive) driveStorageSubscription(pending.key)
  return true
}

internal fun ObservationStreamClient.handleStreamSubscriptionFailure(
  requestId: String?,
  error: String?,
): Boolean {
  if (requestId == null || requestId != streamSubscriptionRequestId) return false
  streamSubscriptionRequestId = null
  subscriptionId = null
  pendingCadenceUpdate = false
  sessionRejected = isStreamSessionRejection(error)
  _connectionState.update {
    if (sessionRejected) ConnectionState.Error(error ?: "Session registration required")
    else ConnectionState.Disconnected(error ?: "Subscription failed")
  }
  if (sessionRejected) releaseActiveTransport()
  log.warn("Subscription failed: ${error ?: "unknown error"}")
  return true
}
