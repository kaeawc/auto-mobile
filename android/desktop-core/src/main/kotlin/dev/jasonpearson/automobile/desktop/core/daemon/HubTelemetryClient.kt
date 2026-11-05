package dev.jasonpearson.automobile.desktop.core.daemon

import dev.jasonpearson.automobile.desktop.core.connection.ConnectionState
import dev.jasonpearson.automobile.desktop.core.telemetry.TelemetryDisplayEvent
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow

/**
 * A pane's [TelemetryPushClient] that holds a lease on the [DaemonStreamHub]'s shared telemetry
 * connection for its device instead of opening its own socket. [connect] takes the lease (once) and
 * asks the hub to revive a failed shared connection, [disconnect]/[dispose] release it, and
 * [telemetryEvents] carry only [key]'s events. The device arguments of [connect] are ignored: the
 * view is bound to [key].
 */
internal class HubTelemetryClient(
  private val hub: DaemonStreamHub,
  private val key: DeviceStreamKey,
) : TelemetryPushClient {
  private val lock = Any()
  private var lease: StreamLease? = null

  private val _telemetryEvents =
    MutableSharedFlow<TelemetryDisplayEvent>(
      replay = EVENT_REPLAY,
      extraBufferCapacity = EVENT_EXTRA_BUFFER,
      onBufferOverflow = BufferOverflow.DROP_OLDEST,
    )
  override val telemetryEvents: SharedFlow<TelemetryDisplayEvent> = _telemetryEvents.asSharedFlow()

  override val connectionState: StateFlow<ConnectionState> = hub.telemetryConnectionState(key)

  override fun connect(deviceId: String?, deviceSessionUuid: String?) {
    synchronized(lock) {
      if (lease == null) lease = hub.subscribeTelemetry(key) { _telemetryEvents.tryEmit(it) }
    }
    // Also revives a shared connection that failed or never started (e.g. before the desktop
    // session registered); a no-op while it is connected or already connecting.
    hub.retry(key)
  }

  override fun reconnect() = connect()

  override fun disconnect() {
    val held = synchronized(lock) { lease.also { lease = null } }
    held?.close()
  }

  override fun isConnected(): Boolean =
    synchronized(lock) { lease != null } && connectionState.value is ConnectionState.Connected

  override fun dispose() = disconnect()

  private companion object {
    // Match TelemetryPushSocketClient's buffering so a pane's Logs history is unchanged.
    const val EVENT_REPLAY = 500
    const val EVENT_EXTRA_BUFFER = 200
  }
}
