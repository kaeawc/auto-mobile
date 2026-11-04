package dev.jasonpearson.automobile.desktop.core.daemon

import dev.jasonpearson.automobile.desktop.core.connection.ConnectionState
import dev.jasonpearson.automobile.desktop.core.logging.Logger
import dev.jasonpearson.automobile.desktop.core.telemetry.TelemetryPushResponse
import dev.jasonpearson.automobile.desktop.core.telemetry.parseTelemetryEvent
import kotlinx.serialization.SerializationException
import kotlinx.serialization.serializer

/**
 * Handles one frame from the multiplexed telemetry socket: routes pushes by `subscriptionId`,
 * records acknowledgements, and confines a refused or daemon-ended subscription to its own device
 * ([onRejected]) unless the daemon refused the desktop session itself, which fails every device.
 */
internal class TelemetryFrameHandler(
  private val table: TelemetrySubscriptionTable,
  private val wire: TelemetryWire,
  private val log: Logger,
  private val onRejected: (MuxSubscription) -> Unit,
) {
  fun handle(open: TelemetrySocket, line: String, onHealthy: () -> Unit) {
    val response =
      try {
        DaemonJson.decodeFromString(serializer<TelemetryPushResponse>(), line)
      } catch (e: SerializationException) {
        log.warn("Malformed telemetry push message; skipped: ${e.message}")
        return
      } catch (e: IllegalArgumentException) {
        log.warn("Malformed telemetry push message; skipped: ${e.message}")
        return
      }
    when (response.type) {
      "telemetry_push" -> deliver(response)
      "subscription_response" ->
        if (response.success == true) acknowledge(open, response, onHealthy) else reject(response)
      "error" -> reject(response)
      "ping" -> wire.write(open, wire.pong())
      else -> log.warn("Unknown telemetry push message type: ${response.type}")
    }
  }

  private fun deliver(response: TelemetryPushResponse) {
    val entry = synchronized(table.lock) { table.target(response.subscriptionId) } ?: return
    val envelope = response.data ?: return
    val event =
      try {
        parseTelemetryEvent(envelope)
      } catch (e: IllegalArgumentException) {
        log.warn("Malformed telemetry push event; skipped: ${e.message}")
        null
      } ?: return
    // Outside the table lock: the sink takes the hub's routing lock.
    entry.sink(event)
  }

  private fun acknowledge(
    open: TelemetrySocket,
    response: TelemetryPushResponse,
    onHealthy: () -> Unit,
  ) {
    // Acknowledgements of unsubscribes carry no subscriptionId or pending request; ignore them.
    val subscriptionId = response.subscriptionId ?: return
    val entry =
      synchronized(table.lock) { table.acknowledge(response.id, subscriptionId) } ?: return
    if (entry.released) {
      // Released while its subscribe was in flight: drop the daemon-side subscription too.
      wire.write(open, wire.unsubscribe(subscriptionId))
      return
    }
    onHealthy()
    entry.mutableState.value = ConnectionState.Connected(subscribed = true)
  }

  private fun reject(response: TelemetryPushResponse) {
    val error = response.error
    if (isStreamSessionRejection(error)) {
      log.warn("Telemetry subscription refused for this session: $error")
      val all =
        synchronized(table.lock) {
          table.sessionRejected = true
          table.snapshot()
        }
      all.publish(ConnectionState.Error(error ?: "Session registration required"))
      return
    }
    // A refused subscribe names its request id; a subscription the daemon later ends on its own
    // (a backfill overflow) names only its subscriptionId, and the socket stays open for the rest.
    val entry =
      synchronized(table.lock) { table.reject(response.id) ?: table.end(response.subscriptionId) }
    if (entry == null) {
      log.warn("Telemetry push error: $error")
      return
    }
    log.info("Telemetry subscription for ${entry.key.deviceId} ended; will retry: $error")
    val deviceNotLive = error?.contains(DEVICE_NOT_LIVE_MARKER) == true
    entry.mutableState.value =
      ConnectionState.Error(
        if (deviceNotLive) TelemetryPushSocketClient.DEVICE_NOT_LIVE_MESSAGE
        else error ?: "Telemetry subscription refused",
      )
    onRejected(entry)
  }

  private companion object {
    const val DEVICE_NOT_LIVE_MARKER = "does not identify a live device session"
  }
}
