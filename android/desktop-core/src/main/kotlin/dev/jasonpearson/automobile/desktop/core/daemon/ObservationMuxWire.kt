package dev.jasonpearson.automobile.desktop.core.daemon

import dev.jasonpearson.automobile.desktop.core.logging.Logger
import kotlinx.serialization.serializer

/** Builds and writes the multiplexed observation socket's commands; writes are serialized. */
internal class ObservationMuxWire(
  private val log: Logger,
  private val newRequestId: () -> String,
  private val sessionUuidProvider: (() -> String?)?,
) {
  private val writeLock = Any()

  fun newId(): String = newRequestId()

  /** [channel]'s device-scoped `subscribe`, carrying its cadence. */
  fun subscribe(channel: MuxObservationChannel, requestId: String) =
    StreamRequest(
      id = requestId,
      command = "subscribe",
      sessionUuid = sessionUuidProvider?.invoke(),
      deviceId = channel.deviceId,
      deviceSessionUuid = channel.deviceSessionUuid,
      screenshotIntervalMs = channel.cadence.screenshotIntervalMs,
      hierarchyIntervalMs = channel.cadence.hierarchyIntervalMs,
    )

  fun unsubscribe(subscriptionId: String) =
    StreamRequest(id = newId(), command = "unsubscribe", subscriptionId = subscriptionId)

  /** [channel]'s cadence, applied in place on its [subscriptionId]. */
  fun cadence(channel: MuxObservationChannel, subscriptionId: String) =
    StreamRequest(
      id = newId(),
      command = "update_cadence",
      subscriptionId = subscriptionId,
      deviceId = channel.deviceId,
      deviceSessionUuid = channel.deviceSessionUuid,
      screenshotIntervalMs = channel.cadence.screenshotIntervalMs,
      hierarchyIntervalMs = channel.cadence.hierarchyIntervalMs,
    )

  /** Names [channel]'s device epoch, so the reply is attributed to it. */
  fun navigationGraph(channel: MuxObservationChannel, requestId: String, appId: String?) =
    StreamRequest(
      id = requestId,
      command = "request_navigation_graph",
      appId = appId,
      deviceSessionUuid = channel.deviceSessionUuid,
      sessionUuid = sessionUuidProvider?.invoke(),
    )

  fun observation(channel: MuxObservationChannel, requestId: String, deviceId: String?) =
    StreamRequest(
      id = requestId,
      command = "request_observation",
      deviceId = deviceId,
      deviceSessionUuid = channel.deviceSessionUuid,
      sessionUuid = sessionUuidProvider?.invoke(),
    )

  fun pong() = StreamRequest(id = newId(), command = "pong")

  /** Write [request]; false when the socket is broken (the reader then reports every device down). */
  fun write(open: TelemetrySocket, request: StreamRequest): Boolean =
    try {
      val line = DaemonJson.encodeToString(serializer<StreamRequest>(), request)
      synchronized(writeLock) { open.writeLine(line) }
      true
    } catch (e: java.io.IOException) {
      log.warn("Failed to send observation stream request: ${e.message}")
      false
    }

  fun closeQuietly(open: TelemetrySocket?) {
    try {
      open?.close()
    } catch (e: java.io.IOException) {
      log.debug("Could not close observation socket: ${e.message}")
    }
  }
}
