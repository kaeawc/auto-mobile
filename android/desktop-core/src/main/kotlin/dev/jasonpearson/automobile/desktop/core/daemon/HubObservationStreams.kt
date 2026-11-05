package dev.jasonpearson.automobile.desktop.core.daemon

import dev.jasonpearson.automobile.desktop.core.connection.ConnectionState
import java.util.UUID
import kotlin.random.Random
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * How [SharedDaemonStreamHub] opens and revives shared observation connections. [streamFactory]
 * creates one device's stream (production: an [ObservationMultiplexer] stream, so every device
 * shares one socket; the default is a per-device [ObservationStreamClient]); [reconnect] revives it
 * after a drop, by default with [jitteredReconnectBackoffMs] drawn from [random] so devices that
 * dropped together on a daemon restart do not reconnect in the same instant.
 */
class ObservationHubConfig(
  val streamFactory: () -> ObservationStream = { ObservationStreamClient() },
  val random: Random = Random.Default,
  val reconnect: ObservationReconnectPolicy =
    ObservationReconnectPolicy(
      backoffDelay = { attempt -> delay(jitteredReconnectBackoffMs(attempt, random)) },
      socketAvailable = { ObservationStreamClient.socketExists() },
    ),
  /** Request ids for the acknowledgements the hub gives a lease joining an observed file. */
  val newRequestId: () -> String = { UUID.randomUUID().toString() },
)

/** A screenshot/hierarchy cadence request; a null interval leaves that stream's default. */
internal data class ObservationCadence(
  val screenshotIntervalMs: Long? = null,
  val hierarchyIntervalMs: Long? = null,
)

/**
 * The observation half of [SharedDaemonStreamHub]: one [ObservationStream] per [DeviceStreamKey],
 * shared by every lease on that device, opened by the first lease and disposed with the last. The
 * hub owns reconnection, and merges the leases' cadence requests by taking the fastest (smallest)
 * interval requested for each stream.
 *
 * Storage intent is per lease, ref-counted per file on the device's shared stream by its
 * [HubDeviceStorage].
 */
internal class HubObservationStreams(
  private val config: ObservationHubConfig,
  private val scope: CoroutineScope,
) : ObservationStreamHub {
  /** A held lease on [key]'s shared [stream]; [reconnects] counts the hub's reconnects of it. */
  class Lease(
    val key: DeviceStreamKey,
    val stream: ObservationStream,
    val reconnects: StateFlow<Int>,
  ) {
    // Guarded by the owning hub's lock.
    var cadence = ObservationCadence()
    val storage = LeaseStorage()
  }

  private class Device(val stream: ObservationStream, val storage: HubDeviceStorage) {
    var supervision: Job? = null
    var appliedCadence = ObservationCadence()
    // Counted at the reconnect call itself, so a drop and recovery that a conflating StateFlow
    // collapses still reaches the facets.
    val reconnects = MutableStateFlow(0)
    // Serializes connect calls with disposal: the client opens its socket synchronously, so a
    // dispose racing an in-flight background connect would otherwise leave that socket unowned.
    private val connectLock = Any()
    private var retired = false

    fun connect(key: DeviceStreamKey, reconnect: Boolean) =
      synchronized(connectLock) {
        if (retired) return@synchronized
        if (reconnect) {
          // A racing reconnect (the supervisor's and a manual retry both saw the drop) already
          // revived the stream; resetting now would drop its fresh confirmations for good.
          if (stream.isConnected()) return@synchronized
          // The drop may never be collected (StateFlow conflates): forget confirmations here too.
          storage.connectionReset()
        }
        stream.connect(deviceId = key.deviceId, deviceSessionUuid = key.deviceSessionUuid)
        if (reconnect) reconnects.update { it + 1 }
      }

    fun retire() =
      synchronized(connectLock) {
        retired = true
        stream.dispose()
      }
  }

  // Every field below is guarded by [lock].
  private val lock = Any()
  private val leases = LinkedHashSet<Lease>()
  private val devices = HashMap<DeviceStreamKey, Device>()
  // Kept after a device's last lease is released so a view created earlier keeps observing it.
  private val states = HashMap<DeviceStreamKey, MutableStateFlow<ConnectionState>>()
  private var closed = false

  private val _subscriptions = MutableStateFlow<Map<DeviceStreamKey, Int>>(emptyMap())
  override val observationSubscriptions: StateFlow<Map<DeviceStreamKey, Int>> =
    _subscriptions.asStateFlow()

  override fun observationStream(key: DeviceStreamKey): HubManagedObservationStream =
    HubObservationStream(this, key)

  /** Take a lease on [key]'s shared stream, opening and connecting it for the first lease. */
  fun acquire(key: DeviceStreamKey): Lease {
    var opened: Device? = null
    val lease =
      synchronized(lock) {
        check(!closed) { "DaemonStreamHub is closed" }
        val device =
          devices.getOrPut(key) {
            val stream = config.streamFactory()
            Device(stream, HubDeviceStorage(stream, scope, config.newRequestId)).also {
              opened = it
            }
          }
        Lease(key, device.stream, device.reconnects.asStateFlow()).also {
          leases.add(it)
          _subscriptions.value = leases.countByKey()
        }
      }
    // Connect outside the lock: the real client opens its socket synchronously.
    opened?.let { start(key, it) }
    return lease
  }

  fun release(lease: Lease) {
    val key = lease.key
    val (device, idle) =
      synchronized(lock) {
        if (!leases.remove(lease)) return
        _subscriptions.value = leases.countByKey()
        val device = devices[key]
        device to if (leases.none { it.key == key }) devices.remove(key) else null
      }
    // Disposing the shared stream releases every observer it held.
    device?.storage?.release(lease.storage, streamDisposed = idle != null)
    if (idle != null) shutDown(key, idle) else applyCadence(key)
  }

  /** [lease]'s device storage, while [lease] is held. */
  fun storageFor(lease: Lease): HubDeviceStorage? =
    synchronized(lock) { if (lease in leases) devices[lease.key]?.storage else null }

  fun setCadence(lease: Lease, cadence: ObservationCadence) {
    synchronized(lock) {
      if (lease !in leases) return
      lease.cadence = cadence
    }
    applyCadence(lease.key)
  }

  override fun observationConnectionState(key: DeviceStreamKey): StateFlow<ConnectionState> =
    synchronized(lock) { states.stateOf(key).asStateFlow() }

  /** Reconnect [key]'s dropped shared stream now instead of after its backoff. */
  fun retry(key: DeviceStreamKey) {
    val device = synchronized(lock) { devices[key] } ?: return
    val stream = device.stream
    if (!stream.isConnected() && stream.connectionState.value !is ConnectionState.Connecting) {
      device.connect(key, reconnect = true)
    }
  }

  fun close() {
    val open =
      synchronized(lock) {
        closed = true
        leases.forEach { it.storage.close() }
        leases.clear()
        _subscriptions.value = leases.countByKey()
        devices.toMap().also { devices.clear() }
      }
    open.forEach { (key, device) -> shutDown(key, device) }
  }

  private fun start(key: DeviceStreamKey, device: Device) {
    val stream = device.stream
    device.connect(key, reconnect = false)
    synchronized(lock) {
      // The last lease may have been released while the socket was opening.
      if (devices[key] !== device) return@synchronized null
      states.stateOf(key).value = stream.connectionState.value
      device.supervision = scope.launch {
        launch {
          stream.connectionState.collect { next ->
            // A stream being shut down may still report; only the live one publishes.
            synchronized(lock) { if (devices[key] === device) states.stateOf(key).value = next }
            device.storage.connectionChanged(next)
          }
        }

        keepObservationConnected(stream, config.reconnect) { device.connect(key, reconnect = true) }
      }
      device
    } ?: return // The releasing lease already disposed the stream.
    applyCadence(key)
  }

  private fun applyCadence(key: DeviceStreamKey) {
    val (device, merged) =
      synchronized(lock) {
        val device = devices[key] ?: return
        val requested = leases.filter { it.key == key }.map { it.cadence }
        val merged =
          ObservationCadence(
            screenshotIntervalMs = requested.mapNotNull { it.screenshotIntervalMs }.minOrNull(),
            hierarchyIntervalMs = requested.mapNotNull { it.hierarchyIntervalMs }.minOrNull(),
          )
        if (merged == device.appliedCadence) return
        device.appliedCadence = merged
        device to merged
      }
    device.stream.setCadence(merged.screenshotIntervalMs, merged.hierarchyIntervalMs)
  }

  private fun shutDown(key: DeviceStreamKey, device: Device) {
    device.supervision?.cancel()
    device.retire()
    // A lease taken since the release may already have opened a new stream for this key.
    synchronized(lock) {
      if (key !in devices) states[key]?.value = ConnectionState.Disconnected(null)
    }
  }
}

// Called under the owning hub's lock.
private fun Collection<HubObservationStreams.Lease>.countByKey() = groupingBy { it.key }.eachCount()

// Called under the owning hub's lock.
private fun MutableMap<DeviceStreamKey, MutableStateFlow<ConnectionState>>.stateOf(
  key: DeviceStreamKey,
) = getOrPut(key) { MutableStateFlow(ConnectionState.Disconnected(null)) }
