package dev.jasonpearson.automobile.desktop.core.daemon

import dev.jasonpearson.automobile.desktop.core.logging.Logger
import dev.jasonpearson.automobile.desktop.core.telemetry.TelemetryPushRequest
import java.util.UUID
import kotlinx.serialization.serializer

internal class TelemetrySocketWriter(
  private val log: Logger,
  private val options: TelemetryPushSocketOptions,
  private val currentSocketProvider: () -> TelemetrySocket?,
) {
  private val json = DaemonJson
  var subscribedDeviceId: String? = null
  var subscribedDeviceSessionUuid: String? = null

  fun subscribeRequest(): TelemetryPushRequest =
    TelemetryPushRequest(
      id = UUID.randomUUID().toString(),
      command = "subscribe",
      sessionUuid = options.sessionUuidProvider?.invoke(),
      category = null, // subscribe to all categories, filter client-side
      deviceId = subscribedDeviceId,
      deviceSessionUuid = subscribedDeviceSessionUuid,
    )

  fun subscribe(currentSocket: TelemetrySocket) {
    val request = subscribeRequest()

    if (!sendRequest(request, currentSocket)) {
      throw IllegalStateException("Failed to send telemetry subscription")
    }
  }

  fun sendRequest(
    request: TelemetryPushRequest,
    currentSocket: TelemetrySocket? = currentSocketProvider(),
  ): Boolean {
    currentSocket ?: return false

    return try {
      val message = json.encodeToString(serializer<TelemetryPushRequest>(), request)
      currentSocket.writeLine(message)
      true
    } catch (e: java.io.IOException) {
      log.warn("Failed to send telemetry push request: ${e.message}")
      false
    } catch (e: kotlinx.serialization.SerializationException) {
      log.warn("Failed to send telemetry push request: ${e.message}")
      false
    }
  }

  fun sendPong() {
    val request =
      TelemetryPushRequest(
        id = UUID.randomUUID().toString(),
        command = "pong",
      )
    sendRequest(request)
  }
}
