package dev.jasonpearson.automobile.desktop.core.daemon

import dev.jasonpearson.automobile.desktop.core.connection.ConnectionState
import dev.jasonpearson.automobile.desktop.core.telemetry.TelemetryDisplayEvent
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.buffer
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.launch

/**
 * [DaemonStreamHub] backed by a single all-devices telemetry connection. The daemon stamps every
 * telemetry envelope with `deviceId` and `deviceSessionUuid`, so one subscription serves every pane
 * and the hub routes each event to the leases whose [DeviceStreamKey] it matches.
 *
 * [telemetryClientFactory] creates the shared connection (production: a [TelemetryPushSocketClient]
 * with a dedicated reader thread); [scope] runs the routing collectors (production:
 * [Dispatchers.Default], since routing never blocks).
 */
class SharedDaemonStreamHub(
  private val telemetryClientFactory: () -> TelemetryPushClient,
  private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default),
) : DaemonStreamHub {
  private class Subscriber(val key: DeviceStreamKey, val sink: (TelemetryDisplayEvent) -> Unit)

  private class SharedTelemetry(val client: TelemetryPushClient, val routing: Job)

  private val lock = Any()
  private val subscribers = LinkedHashSet<Subscriber>()
  // Recently routed events, so a pane that mounts while the connection is already open still sees
  // its device's recent history (the daemon backfills only on subscribe). Guarded by [lock].
  private val recent = ArrayDeque<TelemetryDisplayEvent>()
  private var shared: SharedTelemetry? = null
  private var closed = false

  private val _telemetryConnectionState =
    MutableStateFlow<ConnectionState>(ConnectionState.Disconnected(null))
  override val telemetryConnectionState: StateFlow<ConnectionState> =
    _telemetryConnectionState.asStateFlow()

  private val _subscriptions = MutableStateFlow<Map<DeviceStreamKey, Int>>(emptyMap())
  override val subscriptions: StateFlow<Map<DeviceStreamKey, Int>> = _subscriptions.asStateFlow()

  override fun subscribeTelemetry(
    key: DeviceStreamKey,
    sink: (TelemetryDisplayEvent) -> Unit,
  ): StreamLease {
    val subscriber = Subscriber(key, sink)
    synchronized(lock) {
      check(!closed) { "DaemonStreamHub is closed" }
      if (shared == null) shared = openSharedTelemetry()
      // Backlog and registration share the lock with [route], so no event is lost or repeated.
      recent.filter { it.belongsTo(key) }.forEach(sink)
      subscribers.add(subscriber)
      publishSubscriptions()
    }
    val released = AtomicBoolean(false)
    return StreamLease { if (released.compareAndSet(false, true)) release(subscriber) }
  }

  override fun telemetry(key: DeviceStreamKey): Flow<TelemetryDisplayEvent> = callbackFlow {
    val lease = subscribeTelemetry(key) { trySend(it) }
    awaitClose { lease.close() }
  }
    .buffer(TELEMETRY_FLOW_BUFFER, BufferOverflow.DROP_OLDEST)

  override fun telemetryClient(key: DeviceStreamKey): TelemetryPushClient =
    HubTelemetryClient(this, key)

  override fun retry() {
    val client = synchronized(lock) { shared?.client } ?: return
    if (!client.isConnected()) client.reconnect()
  }

  override fun close() {
    val connection =
      synchronized(lock) {
        closed = true
        subscribers.clear()
        recent.clear()
        publishSubscriptions()
        shared.also { shared = null }
      }
    connection?.let(::shutDown)
    scope.cancel()
  }

  private fun release(subscriber: Subscriber) {
    val idle =
      synchronized(lock) {
        if (!subscribers.remove(subscriber)) return
        publishSubscriptions()
        if (subscribers.isEmpty()) {
          recent.clear()
          shared.also { shared = null }
        } else null
      }
    idle?.let(::shutDown)
  }

  // Called under [lock]. Subscribes to every device: per-device routing happens here, client-side.
  private fun openSharedTelemetry(): SharedTelemetry {
    val client = telemetryClientFactory()
    val routing = scope.launch {
      launch { client.connectionState.collect { publishState(client, it) } }
      client.telemetryEvents.collect { route(client, it) }
    }
    client.connect(deviceId = null, deviceSessionUuid = null)
    return SharedTelemetry(client, routing)
  }

  private fun shutDown(connection: SharedTelemetry) {
    connection.routing.cancel()
    connection.client.dispose()
    _telemetryConnectionState.value = ConnectionState.Disconnected(null)
  }

  private fun publishState(source: TelemetryPushClient, state: ConnectionState) {
    synchronized(lock) { if (shared?.client === source) _telemetryConnectionState.value = state }
  }

  private fun route(source: TelemetryPushClient, event: TelemetryDisplayEvent) {
    synchronized(lock) {
      // A connection being shut down may still deliver; only the live one routes.
      if (shared?.client !== source) return
      recent.addLast(event)
      if (recent.size > RECENT_EVENT_CAPACITY) recent.removeFirst()
      subscribers.forEach { if (event.belongsTo(it.key)) it.sink(event) }
    }
  }

  // Called under [lock].
  private fun publishSubscriptions() {
    _subscriptions.value = subscribers.groupingBy { it.key }.eachCount()
  }

  private companion object {
    const val TELEMETRY_FLOW_BUFFER = 500
    const val RECENT_EVENT_CAPACITY = 500
  }
}
