package dev.jasonpearson.automobile.desktop.core.daemon

import dev.jasonpearson.automobile.desktop.core.logging.Logger
import dev.jasonpearson.automobile.desktop.core.telemetry.TelemetryPushRequest
import kotlinx.serialization.serializer

/** Builds and writes the multiplexed telemetry socket's commands; writes are serialized. */
internal class TelemetryWire(
  private val log: Logger,
  private val newRequestId: () -> String,
  private val sessionUuidProvider: (() -> String?)?,
) {
  private val writeLock = Any()

  fun newId(): String = newRequestId()

  /** The desktop session UUID a `subscribe` is sent under now; null before it registers. */
  fun sessionUuid(): String? = sessionUuidProvider?.invoke()

  /** A device-scoped `subscribe`, so the daemon backfills that device's own history. */
  fun subscribe(key: DeviceStreamKey, requestId: String, sessionUuid: String?) =
    TelemetryPushRequest(
      id = requestId,
      command = "subscribe",
      sessionUuid = sessionUuid,
      deviceId = key.deviceId,
      deviceSessionUuid = key.deviceSessionUuid,
    )

  fun unsubscribe(subscriptionId: String) =
    TelemetryPushRequest(id = newId(), command = "unsubscribe", subscriptionId = subscriptionId)

  fun pong() = TelemetryPushRequest(id = newId(), command = "pong")

  fun write(open: TelemetrySocket, request: TelemetryPushRequest) {
    try {
      val line = DaemonJson.encodeToString(serializer<TelemetryPushRequest>(), request)
      synchronized(writeLock) { open.writeLine(line) }
    } catch (e: java.io.IOException) {
      // The reader sees the broken socket and reconnects, re-subscribing every device.
      log.warn("Failed to send telemetry push request: ${e.message}")
    }
  }

  fun closeQuietly(open: TelemetrySocket?) {
    try {
      open?.close()
    } catch (e: java.io.IOException) {
      log.debug("Could not close telemetry socket: ${e.message}")
    }
  }
}
