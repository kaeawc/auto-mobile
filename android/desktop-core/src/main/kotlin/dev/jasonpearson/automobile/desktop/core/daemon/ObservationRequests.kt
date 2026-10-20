package dev.jasonpearson.automobile.desktop.core.daemon

import dev.jasonpearson.automobile.desktop.core.connection.ConnectionState
import java.io.BufferedWriter
import java.util.UUID
import kotlinx.coroutines.flow.update
import kotlinx.serialization.serializer

internal fun ObservationStreamClient.subscribe(deviceId: String?, deviceSessionUuid: String?) {
  val request =
    StreamRequest(
      id = UUID.randomUUID().toString(),
      command = "subscribe",
      sessionUuid = authenticatedSessionUuid(),
      deviceId = deviceId,
      deviceSessionUuid = deviceSessionUuid,
      screenshotIntervalMs = requestedScreenshotIntervalMs,
      hierarchyIntervalMs = requestedHierarchyIntervalMs,
    )

  // The read loop runs concurrently and may receive the acknowledgement as soon as flush
  // returns, so register its id before writing the request.
  streamSubscriptionRequestId = request.id
  if (sendRequest(request)) {
    _connectionState.update { current ->
      if (current is ConnectionState.Connected) {
        current.copy(subscribed = true)
      } else {
        current
      }
    }
    log.info("Subscribed to observation stream (device: ${deviceId ?: "all"})")
    // Re-register any remembered per-file storage observers so live updates survive a reconnect.
    reapplyStorageSubscriptions()
  } else {
    streamSubscriptionRequestId = null
  }
}

internal fun ObservationStreamClient.sendCadenceUpdate(currentSubscriptionId: String): Boolean {
  val request =
    StreamRequest(
      id = UUID.randomUUID().toString(),
      command = "update_cadence",
      subscriptionId = currentSubscriptionId,
      deviceId = subscribedDeviceId,
      deviceSessionUuid = subscribedDeviceSessionUuid,
      screenshotIntervalMs = requestedScreenshotIntervalMs,
      hierarchyIntervalMs = requestedHierarchyIntervalMs,
    )
  if (sendRequest(request)) {
    log.info(
      "Requested observation cadence update (screenshot=$requestedScreenshotIntervalMs, hierarchy=$requestedHierarchyIntervalMs)",
    )
    return true
  }
  return false
}

internal fun ObservationStreamClient.sendRequest(
  request: StreamRequest,
  expectedConnectionGeneration: Long? = null,
): Boolean {
  if (sessionRejected || (sessionUuidProvider != null && authenticatedSessionUuid() == null))
    return false
  val message = json.encodeToString(serializer<StreamRequest>(), request)
  return synchronized(writerLock) {
    if (expectedConnectionGeneration == null) {
      val currentWriter = synchronized(ownershipLock) { transport?.writer }
      if (currentWriter == null) false else writeRequest(currentWriter, message)
    } else {
      synchronized(ownershipLock) {
        val currentWriter = transport?.writer
        if (connectionGeneration != expectedConnectionGeneration || currentWriter == null) {
          false
        } else {
          writeRequest(currentWriter, message)
        }
      }
    }
  }
}

internal fun ObservationStreamClient.writeRequest(
  writer: BufferedWriter,
  message: String,
): Boolean =
  try {
    writer.write(message)
    writer.newLine()
    writer.flush()
    true
  } catch (e: java.io.IOException) {
    log.warn("Failed to send request: ${e.message}")
    false
  }

internal fun ObservationStreamClient.observationRequest(deviceId: String?) =
  StreamRequest(
    id = UUID.randomUUID().toString(),
    command = "request_observation",
    deviceId = deviceId,
    deviceSessionUuid = subscribedDeviceSessionUuid,
    sessionUuid = authenticatedSessionUuid(),
  )

internal fun ObservationStreamClient.sendPong() {
  val request =
    StreamRequest(
      id = UUID.randomUUID().toString(),
      command = "pong",
    )
  sendRequest(request)
}
