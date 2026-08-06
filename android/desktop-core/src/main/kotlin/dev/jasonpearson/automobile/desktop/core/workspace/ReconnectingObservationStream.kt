package dev.jasonpearson.automobile.desktop.core.workspace

import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import dev.jasonpearson.automobile.desktop.core.connection.ConnectionState
import dev.jasonpearson.automobile.desktop.core.daemon.ObservationStream
import dev.jasonpearson.automobile.desktop.core.daemon.ObservationStreamClient
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.isActive

/**
 * Owns a per-device [ObservationStream] with an automatic reconnect lifecycle, shared by the
 * workspace surfaces (Layout facet, two-device compare sides) that each drive their own stream.
 *
 * The stream is created via [streamFactory] and connected to [deviceId] while the caller is in
 * composition, then disposed when it leaves composition or [deviceId] changes — the same
 * connect/dispose lifecycle the facets had before, but with recovery added: when the stream drops
 * (a socket-unavailable failure at mount, an EOF, or a daemon restart while the surface stays open)
 * it reconnects the same instance with exponential backoff instead of staying dead until the user
 * exits and re-enters. Reconnection stops when the surface leaves composition (the reconnect
 * coroutine is cancelled).
 *
 * Both time and daemon-availability are injected so the retry/backoff/stop-on-dispose behavior can
 * be verified with virtual time and a `FakeObservationStream`, per repo convention (mirroring the
 * `resolveTimeout` seam on the navigation facet):
 * - [backoffDelay] is the timer seam: it suspends for the backoff of the given attempt (default
 *   [reconnectBackoffMs] via [delay]); a test supplies a gate it releases per attempt.
 * - [socketAvailable] reports whether the daemon's observation socket exists; while it is false the
 *   loop keeps backing off but skips the pointless [ObservationStream.connect] call, so a
 *   daemon-down window recovers on its own once the socket returns without hammering.
 */
@Composable
fun rememberReconnectingObservationStream(
  deviceId: String,
  streamFactory: () -> ObservationStream,
  backoffDelay: suspend (attempt: Int) -> Unit = { attempt -> delay(reconnectBackoffMs(attempt)) },
  socketAvailable: () -> Boolean = { ObservationStreamClient.socketExists() },
): ObservationStream? {
  var stream by remember(deviceId) { mutableStateOf<ObservationStream?>(null) }
  DisposableEffect(deviceId) {
    val connected = streamFactory().also { it.connect(deviceId = deviceId) }
    stream = connected
    onDispose {
      connected.dispose()
      stream = null
    }
  }

  val active = stream
  // Reconnect loop, keyed on the live stream so it restarts for a new device and is cancelled on
  // dispose (which ends reconnection). Driven by the stream's connection state — the single source
  // of truth the real client updates on connect success/failure and on EOF ("Stream ended").
  LaunchedEffect(active, deviceId) {
    val s = active ?: return@LaunchedEffect
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
          backoffDelay(attempt)
          if (!isActive) break
          if (socketAvailable()) {
            s.connect(deviceId = deviceId)
          }
        }
      }
    }
  }
  return stream
}

/** Initial reconnect backoff; doubles per attempt up to [RECONNECT_MAX_DELAY_MS]. */
internal const val RECONNECT_INITIAL_DELAY_MS = 500L

/** Ceiling for the reconnect backoff so a long daemon outage still polls at a steady cadence. */
internal const val RECONNECT_MAX_DELAY_MS = 15_000L

/**
 * Exponential backoff (base [initialMs], doubling per attempt, capped at [maxMs]) for reconnect
 * attempt [attempt] (1-based). Pure and overflow-safe so the delay is deterministic and the timer
 * stays injectable — no jitter, since the timing is driven by the injected seam in tests.
 */
internal fun reconnectBackoffMs(
  attempt: Int,
  initialMs: Long = RECONNECT_INITIAL_DELAY_MS,
  maxMs: Long = RECONNECT_MAX_DELAY_MS,
): Long {
  val n = attempt.coerceAtLeast(1)
  val factor = 1L shl minOf(n - 1, 20)
  // Guard the multiply against overflow before comparing to the cap.
  val exp = if (factor > maxMs / initialMs) maxMs else initialMs * factor
  return minOf(exp, maxMs)
}
