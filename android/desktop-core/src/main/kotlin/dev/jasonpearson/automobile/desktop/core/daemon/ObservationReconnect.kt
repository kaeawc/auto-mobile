package dev.jasonpearson.automobile.desktop.core.daemon

import dev.jasonpearson.automobile.desktop.core.connection.ConnectionState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.isActive

/**
 * How a dropped observation connection is revived: [backoffDelay] suspends for an attempt's backoff
 * (the timer seam), and [socketAvailable] reports whether the daemon's observation socket exists,
 * so a daemon-down window keeps backing off without pointless connect calls.
 */
class ObservationReconnectPolicy(
  val backoffDelay: suspend (attempt: Int) -> Unit,
  val socketAvailable: () -> Boolean,
)

/**
 * Keep [stream] connected until the calling coroutine is cancelled. Driven by the stream's
 * connection state: a healthy connection resets the backoff, an in-flight connect is awaited, and a
 * drop or failed connect backs off before calling [reconnect]. A connection revived during the
 * backoff (e.g. a manual retry) is left alone.
 */
internal suspend fun CoroutineScope.keepObservationConnected(
  stream: ObservationStream,
  policy: ObservationReconnectPolicy,
  reconnect: () -> Unit,
) {
  var attempt = 0
  while (isActive) {
    when (stream.connectionState.value) {
      is ConnectionState.Connected -> {
        attempt = 0
        stream.connectionState.first { it !is ConnectionState.Connected }
      }
      is ConnectionState.Connecting,
      is ConnectionState.Reconnecting -> {
        stream.connectionState.first {
          it !is ConnectionState.Connecting && it !is ConnectionState.Reconnecting
        }
      }
      is ConnectionState.Disconnected,
      is ConnectionState.Error -> {
        attempt++
        policy.backoffDelay(attempt)
        if (!isActive) break
        if (stream.connectionState.value.isDown() && policy.socketAvailable()) reconnect()
      }
    }
  }
}

private fun ConnectionState.isDown() =
  this is ConnectionState.Disconnected || this is ConnectionState.Error
