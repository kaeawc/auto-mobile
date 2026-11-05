package dev.jasonpearson.automobile.desktop.core.daemon

internal suspend fun ObservationStreamClient.handleSubscriptionResponse(response: StreamResponse) {

  log.info("Subscription response: success=${response.success}")
  val responseId = response.id
  if (
    responseId != null &&
      handleStorageSubscriptionResponse(responseId, response.success == true, response.error)
  ) {
    return
  }
  if (response.success != true) {
    if (!handleStreamSubscriptionFailure(responseId, response.error)) {
      log.warn("Subscription failed: ${response.error}")
    }
  } else if (response.subscriptionId != null) {
    streamSubscriptionRequestId = null
    subscriptionId = response.subscriptionId
    if (pendingCadenceUpdate) {
      pendingCadenceUpdate = !sendCadenceUpdate(response.subscriptionId)
    }
  }
}

internal suspend fun ObservationStreamClient.handleStorageReconciliationRequired(
  response: StreamResponse,
) {

  val packageName = response.packageName
  val fileName = response.fileName
  if (packageName == null || fileName == null) {
    log.warn("storage_reconciliation_required without packageName/fileName, ignoring")
  } else {
    storageReconciliationRequestChannel.send(StorageSubscriptionKey(packageName, fileName))
  }
}

internal suspend fun ObservationStreamClient.handleDeviceSessionEnded(response: StreamResponse) {

  val deviceId = response.deviceId
  val retiredUuid = response.deviceSessionUuid
  val successorUuid = response.successorSessionUuid
  if (deviceId.isNullOrBlank() || retiredUuid.isNullOrBlank()) return
  val timestamp = response.timestamp ?: System.currentTimeMillis()
  val event =
    when {
      // An absent successor means the device left for good; a present-but-blank one is malformed.
      successorUuid == null ->
        DeviceStreamEvent.DeviceSessionEnded(deviceId, retiredUuid, timestamp)
      successorUuid.isBlank() -> return
      else ->
        DeviceStreamEvent.DeviceSessionSuperseded(deviceId, retiredUuid, successorUuid, timestamp)
    }
  _deviceEvents.emit(event)
}

internal fun ObservationStreamClient.handlePing(response: StreamResponse) {

  log.info("Received ping, sending pong")
  sendPong()
}

internal suspend fun ObservationStreamClient.handleError(response: StreamResponse) {

  log.warn("Observation stream error: ${response.error}")
  val responseId = response.id
  if (responseId != null && handleStorageSubscriptionResponse(responseId, false, response.error)) {
    return
  }
  if (handleStreamSubscriptionFailure(responseId, response.error)) {
    return
  }
  emitDeviceEvent(response)
}
