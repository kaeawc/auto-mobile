package dev.jasonpearson.automobile.desktop.core.daemon

import dev.jasonpearson.automobile.desktop.core.connection.ConnectionState
import dev.jasonpearson.automobile.desktop.core.logging.Logger
import dev.jasonpearson.automobile.desktop.core.telemetry.TelemetryDisplayEvent
import dev.jasonpearson.automobile.desktop.core.telemetry.TelemetryPushResponse
import dev.jasonpearson.automobile.desktop.core.telemetry.parseTelemetryEvent
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.serialization.serializer

internal class TelemetryMessageHandler(
  private val log: Logger,
  private val _state: MutableStateFlow<ConnectionState>,
  private val _telemetryEvents: MutableSharedFlow<TelemetryDisplayEvent>,
  private val sendPong: () -> Unit,
) {
  private val json = DaemonJson
  @Volatile var sessionRejected = false
  @Volatile var deviceNotLive = false
  private val loggedFieldMismatches = mutableSetOf<String>()

  fun warnFieldMismatch(category: String, field: String) {
    val key = "$category:$field"
    synchronized(loggedFieldMismatches) {
      if (loggedFieldMismatches.add(key)) {
        log.warn("Recovered telemetry field shape mismatch: category=$category field=$field")
      }
    }
  }

  fun handleMessage(message: String): Boolean {
    val response = json.decodeFromString(serializer<TelemetryPushResponse>(), message)

    return when (response.type) {
      "subscription_response" -> handleSubscription(response)
      "telemetry_push" -> handleTelemetryEvent(response)
      "ping" -> {
        log.debug("Received telemetry ping, sending pong")
        sendPong.invoke()
        false
      }
      "error" -> {
        noteDeviceNotLive(response.error)
        rejectSession(response.error)
        if (!sessionRejected && !deviceNotLive) {
          log.warn("Telemetry push error: ${response.error}")
        }
        false
      }
      else -> {
        log.warn("Unknown telemetry push message type: ${response.type}")
        false
      }
    }
  }

  fun noteDeviceNotLive(error: String?) {
    if (error?.contains(DEVICE_NOT_LIVE_MARKER) == true) {
      deviceNotLive = true
      log.info("Telemetry device not live yet; will retry: $error")
    }
  }

  fun rejectSession(error: String?) {
    if (!sessionRejected && isStreamSessionRejection(error)) {
      sessionRejected = true
      _state.value = ConnectionState.Error(error ?: "Session registration required")
      log.warn("Subscription failed: $error")
    }
  }

  private fun handleTelemetryEvent(response: TelemetryPushResponse): Boolean {
    return run {
      val envelope = response.data
      if (envelope != null && envelope.category.isNotBlank()) {
        try {
          val event =
            parseTelemetryEvent(envelope) { field ->
              warnFieldMismatch(envelope.category, field)
            }
          if (event != null) {
            _telemetryEvents.tryEmit(event)
          }
          event != null
        } catch (e: IllegalArgumentException) {
          log.warn("Malformed telemetry push event; skipped: ${e.message}")
          false
        }
      } else {
        log.warn("Malformed telemetry push event; missing data or category; skipped")
        false
      }
    }
  }

  private fun handleSubscription(response: TelemetryPushResponse): Boolean {
    return run {
      log.info("Telemetry push subscription response: success=${response.success}")
      if (response.success != true) {
        noteDeviceNotLive(response.error)
        rejectSession(response.error)
        if (!sessionRejected && !deviceNotLive) {
          log.warn("Telemetry subscription failed: ${response.error}")
        }
      }
      response.success == true
    }
  }

  private companion object {
    const val DEVICE_NOT_LIVE_MARKER = "does not identify a live device session"
  }
}
