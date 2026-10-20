package dev.jasonpearson.automobile.desktop.core.workspace

import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import dev.jasonpearson.automobile.desktop.core.connection.ConnectionState
import dev.jasonpearson.automobile.desktop.core.daemon.ObservationStream
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.isActive

internal suspend fun CoroutineScope.reconnectObservationStream(
  s: ObservationStream,
  options: ReconnectingObservationOptions,
  onConnected: () -> Unit,
) {
  var attempt = 0
  while (isActive) {
    when (s.connectionState.value) {
      is ConnectionState.Connected -> {
        // Healthy: reset the backoff and idle until the connection actually drops.
        attempt = 0
        s.connectionState.first { it !is ConnectionState.Connected }
      }
      is ConnectionState.Connecting,
      is ConnectionState.Reconnecting -> {
        // A connect is already in flight; wait for it to resolve rather than issuing another.
        s.connectionState.first {
          it !is ConnectionState.Connecting && it !is ConnectionState.Reconnecting
        }
      }
      is ConnectionState.Disconnected,
      is ConnectionState.Error -> {
        // Dropped or failed to connect: back off, then reconnect the same instance. While the
        // daemon socket is absent, keep backing off but skip the pointless connect so a
        // daemon-down window recovers on its own once the socket returns.
        attempt++
        options.backoffDelay(attempt)
        if (!isActive) break
        if (options.socketAvailable()) {
          s.connect(deviceId = options.deviceId, deviceSessionUuid = options.deviceSessionUuid)
          onConnected()
        }
      }
    }
  }
}
