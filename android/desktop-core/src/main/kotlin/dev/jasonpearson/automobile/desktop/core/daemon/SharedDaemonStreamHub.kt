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
 * [DaemonStreamHub] that keeps one device-scoped telemetry connection per observed device, shared
 * by every facet showing that device. Each connection subscribes with the device's
 * `deviceSessionUuid`, so the daemon backfills that device's own recent history; an all-devices
 * subscription would backfill only the newest rows across every device and starve a quiet one.
 *
 * [telemetryClientFactory] creates each connection (production: a [TelemetryPushSocketClient] with
 * a dedicated reader thread); [scope] runs the routing collectors (production:
 * [Dispatchers.Default], since routing never blocks). Observation streams are shared the same way,
 * one per device, opened and revived as [observation] describes.
 */
class SharedDaemonStreamHub
private constructor(
  private val telemetryClientFactory: () -> TelemetryPushClient,
  private val scope: CoroutineScope,
  private val observations: HubObservationStreams,
) : DaemonStreamHub, ObservationStreamHub by observations {
  constructor(
    telemetryClientFactory: () -> TelemetryPushClient,
    scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default),
    observation: ObservationHubConfig = ObservationHubConfig(),
  ) : this(telemetryClientFactory, scope, HubObservationStreams(observation, scope))

  private class Subscriber(val key: DeviceStreamKey, val sink: (TelemetryDisplayEvent) -> Unit)

  private class DeviceTelemetry(val client: TelemetryPushClient, val routing: Job) {
    // Recently routed events, so a pane that mounts while the connection is already open still
    // sees its device's recent history (the daemon backfills only on subscribe).
    val recent = ArrayDeque<TelemetryDisplayEvent>()
  }

  // Every field below is guarded by [lock].
  private val lock = Any()
  private val subscribers = LinkedHashSet<Subscriber>()
  private val devices = HashMap<DeviceStreamKey, DeviceTelemetry>()
  // Kept after a device's last lease is released so a view created earlier keeps observing it.
  private val states = HashMap<DeviceStreamKey, MutableStateFlow<ConnectionState>>()
  private var closed = false

  private val _subscriptions = MutableStateFlow<Map<DeviceStreamKey, Int>>(emptyMap())
  override val subscriptions: StateFlow<Map<DeviceStreamKey, Int>> = _subscriptions.asStateFlow()

  override fun subscribeTelemetry(
    key: DeviceStreamKey,
    sink: (TelemetryDisplayEvent) -> Unit,
  ): StreamLease {
    val subscriber = Subscriber(key, sink)
    synchronized(lock) {
      check(!closed) { "DaemonStreamHub is closed" }
      val device = devices.getOrPut(key) { open(key) }
      // Backlog and registration share the lock with [route], so no event is lost or repeated.
      device.recent.forEach(sink)
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

  override fun telemetryConnectionState(key: DeviceStreamKey): StateFlow<ConnectionState> =
    synchronized(lock) {
      states.getOrPut(key) { MutableStateFlow(ConnectionState.Disconnected(null)) }.asStateFlow()
    }

  override fun retry(key: DeviceStreamKey) {
    val client = synchronized(lock) { devices[key]?.client } ?: return
    if (!client.isConnected()) client.reconnect()
  }

  override fun close() {
    observations.close()
    val open =
      synchronized(lock) {
        closed = true
        subscribers.clear()
        publishSubscriptions()
        devices.toMap().also { devices.clear() }
      }
    open.forEach { (key, device) -> shutDown(key, device) }
    scope.cancel()
  }

  private fun release(subscriber: Subscriber) {
    val key = subscriber.key
    val idle =
      synchronized(lock) {
        if (!subscribers.remove(subscriber)) return
        publishSubscriptions()
        if (subscribers.none { it.key == key }) devices.remove(key) else null
      }
    idle?.let { shutDown(key, it) }
  }

  // Called under [lock].
  private fun open(key: DeviceStreamKey): DeviceTelemetry {
    val client = telemetryClientFactory()
    val state = states.getOrPut(key) { MutableStateFlow(ConnectionState.Disconnected(null)) }
    val routing = scope.launch {
      launch {
        client.connectionState.collect { next ->
          // A connection being shut down may still report; only the live one publishes.
          synchronized(lock) { if (devices[key]?.client === client) state.value = next }
        }
      }
      client.telemetryEvents.collect { route(key, client, it) }
    }
    client.connect(deviceId = key.deviceId, deviceSessionUuid = key.deviceSessionUuid)
    return DeviceTelemetry(client, routing)
  }

  private fun shutDown(key: DeviceStreamKey, device: DeviceTelemetry) {
    device.routing.cancel()
    device.client.dispose()
    // A lease taken since the release may already have opened a new connection for this key.
    synchronized(lock) {
      if (key !in devices) states[key]?.value = ConnectionState.Disconnected(null)
    }
  }

  private fun route(
    key: DeviceStreamKey,
    source: TelemetryPushClient,
    event: TelemetryDisplayEvent,
  ) {
    synchronized(lock) {
      val device = devices[key]
      // Only the live connection routes, and only events stamped with this device's epoch.
      if (device?.client !== source || !event.belongsTo(key)) return
      device.recent.addLast(event)
      if (device.recent.size > RECENT_EVENT_CAPACITY) device.recent.removeFirst()
      subscribers.forEach { if (it.key == key) it.sink(event) }
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
