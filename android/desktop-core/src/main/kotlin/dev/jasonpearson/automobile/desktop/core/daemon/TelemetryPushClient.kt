package dev.jasonpearson.automobile.desktop.core.daemon

import dev.jasonpearson.automobile.desktop.core.connection.ConnectionState
import dev.jasonpearson.automobile.desktop.core.telemetry.TelemetryDisplayEvent
import kotlinx.coroutines.flow.SharedFlow

/** Client for receiving real-time telemetry events via Unix socket. */
interface TelemetryPushClient {
  /** Flow of parsed telemetry events. */
  val telemetryEvents: SharedFlow<TelemetryDisplayEvent>

  /** Flow of connection state changes. */
  val connectionState: SharedFlow<ConnectionState>

  /**
   * Connect to the telemetry push socket and subscribe to events.
   *
   * @param deviceId Optional device ID to filter server-side. Null receives all devices.
   * @param deviceSessionUuid The daemon-minted identity of the device's live session, when known.
   *   The daemon prefers it over [deviceId], which it must otherwise resolve itself.
   */
  fun connect(deviceId: String? = null, deviceSessionUuid: String? = null)

  /**
   * Re-establish a dropped connection with the device arguments of the last [connect], so a health
   * check never widens a per-device subscription to all devices. Defaults to [connect] for clients
   * that do not remember their arguments.
   */
  fun reconnect() = connect()

  /** Disconnect from the telemetry push socket. */
  fun disconnect()

  /** Whether the client is currently connected. */
  fun isConnected(): Boolean

  /** Disconnect and release all resources. Do not reuse after calling. */
  fun dispose()
}
