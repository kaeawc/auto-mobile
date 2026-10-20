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
  val deviceId = response.deviceId ?: return
  val error = response.error ?: return
  if (error != DEVICE_CONNECTION_LOST_ERROR) return

  _hierarchyUpdates.resetReplayCache()
  _screenshotUpdates.resetReplayCache()
  _performanceUpdates.resetReplayCache()
  _deviceEvents.emit(
    DeviceStreamEvent.DeviceConnectionLost(
      deviceId = deviceId,
      timestamp = response.timestamp ?: System.currentTimeMillis(),
      error = error,
    ),
  )
  log.info("Emitted device connection lost event for $deviceId")
}

internal fun ObservationStreamClient.driveStorageSubscription(key: StorageSubscriptionKey) {
  if (!_connectionState.value.isConnected) return

  val request =
    synchronized(ownershipLock) {
      if (pendingStorageSubscriptions.values.any { it.key == key }) return

      val desired = key in desiredStorageSubscriptions
      val confirmed = key in confirmedStorageSubscriptions
      val forceReconciliation = key in forcedStorageReconciliations
      val subscribe =
        when {
          forceReconciliation -> desired
          desired && !confirmed -> true
          !desired && confirmed -> false
          else -> return
        }
      val id = UUID.randomUUID().toString()
      PendingStorageSubscription(
          requestId = id,
          key = key,
          subscribe = subscribe,
          intentVersion = storageSubscriptionIntentVersions[key] ?: 0L,
          forcedReconciliation = forceReconciliation,
          connectionGeneration = connectionGeneration,
        )
        .also { pendingStorageSubscriptions[id] = it }
    }

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
  if (!sent) {
    synchronized(ownershipLock) {
      pendingStorageSubscriptions.remove(request.requestId)
    }
  } else if (request.forcedReconciliation) {
    synchronized(ownershipLock) {
      forcedStorageReconciliations.remove(key)
    }
  }
}

internal fun ObservationStreamClient.reapplyStorageSubscriptions() {
  val keys = synchronized(ownershipLock) { desiredStorageSubscriptions.toList() }
  for (key in keys) {
    driveStorageSubscription(key)
  }
}

internal suspend fun ObservationStreamClient.handleStorageSubscriptionResponse(
  requestId: String,
  success: Boolean,
  error: String?,
): Boolean {
  val pending =
    synchronized(ownershipLock) {
      pendingStorageSubscriptions.remove(requestId)
    } ?: return false

  val intentChanged =
    synchronized(ownershipLock) {
      if (success) {
        if (pending.subscribe) {
          confirmedStorageSubscriptions.add(pending.key)
        } else {
          confirmedStorageSubscriptions.remove(pending.key)
        }
      }
      (storageSubscriptionIntentVersions[pending.key] ?: 0L) != pending.intentVersion
    }
  storageSubscriptionResponseChannel.send(
    StorageSubscriptionResponse(
      requestId = requestId,
      key = pending.key,
      subscribe = pending.subscribe,
      success = success,
      error = error,
    ),
  )
  // A permanent rejection establishes no new daemon state. Redriving an unchanged intent creates
  // a request/error busy loop. But if the user changed their intent while the command's outcome
  // became ambiguous, force one compensating command for the latest state.
  if (success || intentChanged) {
    if (!success) {
      synchronized(ownershipLock) {
        forcedStorageReconciliations.add(pending.key)
      }
    }
    driveStorageSubscription(pending.key)
  }
  return true
}

internal fun ObservationStreamClient.incrementStorageSubscriptionIntentVersion(
  key: StorageSubscriptionKey,
) {
  storageSubscriptionIntentVersions[key] = (storageSubscriptionIntentVersions[key] ?: 0L) + 1L
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
