package dev.jasonpearson.automobile.desktop.core.daemon

import dev.jasonpearson.automobile.desktop.core.connection.ConnectionState
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
 * creates one device's connection (production: an [ObservationStreamClient]); [reconnect] revives
 * it after a drop, by default with [jitteredReconnectBackoffMs] drawn from [random] so devices that
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
)

/** A screenshot/hierarchy cadence request; a null interval leaves that stream's default. */
internal data class ObservationCadence(
  val screenshotIntervalMs: Long? = null,
  val hierarchyIntervalMs: Long? = null,
)

/**
 * The cadence of a shared stream held only by lifecycle leases: the longest interval the daemon
 * accepts for both streams, so a connection kept open to hear epoch lifecycle frames does not make
 * the daemon poll the device for screenshots and hierarchies nobody is showing.
 */
internal val LIFECYCLE_ONLY_CADENCE =
  ObservationCadence(
    screenshotIntervalMs = Int.MAX_VALUE.toLong(),
    hierarchyIntervalMs = Int.MAX_VALUE.toLong(),
  )

/**
 * The observation half of [SharedDaemonStreamHub]: one [ObservationStream] per [DeviceStreamKey],
 * shared by every lease on that device, opened by the first lease and disposed with the last. The
 * hub owns reconnection, and merges the leases' cadence requests by taking the fastest (smallest)
 * interval requested for each stream. A lifecycle lease ([Lease.lifecycleOnly]) asks for no
 * cadence: it is ignored by the merge, and a stream held only by lifecycle leases runs at
 * [LIFECYCLE_ONLY_CADENCE].
 */
internal class HubObservationStreams(
  private val config: ObservationHubConfig,
  private val scope: CoroutineScope,
) : ObservationStreamHub {
  /**
   * A held lease on [key]'s shared [stream]; [reconnects] counts the hub's reconnects of it. A
   * [lifecycleOnly] lease only listens for device events and never asks for frames.
   */
  class Lease(
    val key: DeviceStreamKey,
    val stream: ObservationStream,
    val reconnects: StateFlow<Int>,
    val lifecycleOnly: Boolean = false,
  ) {
    // Guarded by the owning hub's lock.
    var cadence = ObservationCadence()
  }

  private class Device(val stream: ObservationStream) {
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

  override fun lifecycleStream(key: DeviceStreamKey): HubManagedObservationStream =
    HubObservationStream(this, key, lifecycleOnly = true)

  /** Take a lease on [key]'s shared stream, opening and connecting it for the first lease. */
  fun acquire(key: DeviceStreamKey, lifecycleOnly: Boolean = false): Lease {
    var opened: Device? = null
    val lease =
      synchronized(lock) {
        check(!closed) { "DaemonStreamHub is closed" }
        val device = devices.getOrPut(key) { Device(config.streamFactory()).also { opened = it } }
        Lease(key, device.stream, device.reconnects.asStateFlow(), lifecycleOnly).also {
          leases.add(it)
          publishSubscriptions()
        }
      }
    // Connect outside the lock: the real client opens its socket synchronously. A lease joining an
    // open stream may end its lifecycle-only cadence.
    opened?.let { start(key, it) } ?: applyCadence(key)
    return lease
  }

  fun release(lease: Lease) {
    val key = lease.key
    val idle =
      synchronized(lock) {
        if (!leases.remove(lease)) return
        publishSubscriptions()
        if (leases.none { it.key == key }) devices.remove(key) else null
      }
    if (idle != null) shutDown(key, idle) else applyCadence(key)
  }

  fun setCadence(lease: Lease, cadence: ObservationCadence) {
    synchronized(lock) {
      if (lease !in leases || lease.lifecycleOnly) return
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
        leases.clear()
        publishSubscriptions()
        devices.toMap().also { devices.clear() }
      }
    open.forEach { (key, device) -> shutDown(key, device) }
  }

  private fun start(key: DeviceStreamKey, device: Device) {
    val stream = device.stream
    // Before connecting, so the subscribe request already carries a lifecycle-only cadence.
    applyCadence(key)
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
        val requested = leases.filter { it.key == key && !it.lifecycleOnly }.map { it.cadence }
        val merged =
          if (requested.isEmpty()) LIFECYCLE_ONLY_CADENCE
          else
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

  // Called under [lock].
  private fun publishSubscriptions() {
    _subscriptions.value = leases.groupingBy { it.key }.eachCount()
  }
}

// Called under the owning hub's lock.
private fun MutableMap<DeviceStreamKey, MutableStateFlow<ConnectionState>>.stateOf(
  key: DeviceStreamKey,
) = getOrPut(key) { MutableStateFlow(ConnectionState.Disconnected(null)) }
