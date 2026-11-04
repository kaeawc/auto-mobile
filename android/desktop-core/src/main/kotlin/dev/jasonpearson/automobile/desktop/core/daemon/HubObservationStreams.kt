package dev.jasonpearson.automobile.desktop.core.daemon

import dev.jasonpearson.automobile.desktop.core.connection.ConnectionState
import java.util.UUID
import kotlin.random.Random
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
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
 * Storage intent is per lease: the hub ref-counts each `(package, file)` across a device's leases,
 * subscribing the shared stream for the first lease that asks and unsubscribing it with the last.
 * Updates, acknowledgements and reconciliation requests for a file reach only the leases holding
 * it, losslessly. A lease that joins a file the device already observes is acknowledged at once, so
 * it reconciles its snapshot as it would after its own subscribe.
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
    val storageKeys = LinkedHashSet<StorageSubscriptionKey>()

    // Lossless and unicast, like a per-pane stream's storage flows.
    val storageUpdates = Channel<StorageStreamUpdate>(Channel.UNLIMITED)
    val storageResponses = Channel<StorageSubscriptionResponse>(Channel.UNLIMITED)
    val storageReconciliations = Channel<StorageSubscriptionKey>(Channel.UNLIMITED)

    fun closeStorage() {
      storageUpdates.close()
      storageResponses.close()
      storageReconciliations.close()
    }
  }

  private class Device(val stream: ObservationStream) {
    var supervision: Job? = null
    var appliedCadence = ObservationCadence()
    // Counted at the reconnect call itself, so a drop and recovery that a conflating StateFlow
    // collapses still reaches the facets.
    val reconnects = MutableStateFlow(0)
    // Guarded by the owning hub's lock: which leases hold each file, and which files the shared
    // stream has confirmed on its current connection.
    val storageHolders = HashMap<StorageSubscriptionKey, LinkedHashSet<Lease>>()
    val confirmedStorage = HashSet<StorageSubscriptionKey>()
    // Started by the device's first storage subscription; a device without one pays nothing.
    var storageRouting: Job? = null
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

  /** Take a lease on [key]'s shared stream, opening and connecting it for the first lease. */
  fun acquire(key: DeviceStreamKey): Lease {
    var opened: Device? = null
    val lease =
      synchronized(lock) {
        check(!closed) { "DaemonStreamHub is closed" }
        val device = devices.getOrPut(key) { Device(config.streamFactory()).also { opened = it } }
        Lease(key, device.stream, device.reconnects.asStateFlow()).also {
          leases.add(it)
          publishSubscriptions()
        }
      }
    // Connect outside the lock: the real client opens its socket synchronously.
    opened?.let { start(key, it) }
    return lease
  }

  fun release(lease: Lease) {
    val key = lease.key
    val (idle, live, unwanted) =
      synchronized(lock) {
        if (!leases.remove(lease)) return
        publishSubscriptions()
        val device = devices[key]
        val unwanted = device?.let { dropStorage(it, lease, lease.storageKeys.toList()) }.orEmpty()
        lease.storageKeys.clear()
        val idle = if (leases.none { it.key == key }) devices.remove(key) else null
        Triple(idle, device, unwanted)
      }
    lease.closeStorage()
    if (idle != null) {
      // Disposing the shared stream releases every observer it held.
      shutDown(key, idle)
      return
    }
    unwanted.forEach { live?.stream?.unsubscribeStorage(it.packageName, it.fileName) }
    applyCadence(key)
  }

  /** [lease] asks for [file]'s live updates on its device. */
  fun subscribeStorage(lease: Lease, file: StorageSubscriptionKey) {
    val (device, first, joined) =
      synchronized(lock) {
        val device = devices[lease.key]
        if (device == null || lease !in leases || !lease.storageKeys.add(file)) return
        val holders = device.storageHolders.getOrPut(file) { LinkedHashSet() }
        holders.add(lease)
        if (device.storageRouting == null)
          device.storageRouting = scope.launchStorageRouting(device)
        Triple(device, holders.size == 1, file in device.confirmedStorage)
      }
    when {
      first -> device.stream.subscribeStorage(file.packageName, file.fileName)
      // Already observed: acknowledge this lease's subscribe now, so it reconciles its snapshot.
      joined ->
        lease.storageResponses.trySend(
          StorageSubscriptionResponse(
            requestId = config.newRequestId(),
            key = file,
            subscribe = true,
            success = true,
          ),
        )
    // Otherwise the in-flight subscribe's acknowledgement reaches this lease too.
    }
  }

  /** [lease] no longer wants [file]'s live updates. */
  fun unsubscribeStorage(lease: Lease, file: StorageSubscriptionKey) {
    val device =
      synchronized(lock) {
        val device = devices[lease.key] ?: return
        if (lease !in leases || !lease.storageKeys.remove(file)) return
        if (dropStorage(device, lease, listOf(file)).isEmpty()) return
        device
      }
    device.stream.unsubscribeStorage(file.packageName, file.fileName)
  }

  // Called under [lock]: [lease] stops holding [files]; returns those no lease holds any more.
  private fun dropStorage(
    device: Device,
    lease: Lease,
    files: List<StorageSubscriptionKey>,
  ): List<StorageSubscriptionKey> = files.filter { file ->
    val holders = device.storageHolders[file] ?: return@filter false
    holders.remove(lease)
    holders.isEmpty().also { if (it) device.storageHolders.remove(file) }
  }

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
        leases.forEach { it.closeStorage() }
        leases.clear()
        publishSubscriptions()
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
            synchronized(lock) {
              if (devices[key] === device) states.stateOf(key).value = next
              // A dropped connection's observers are re-registered, and re-acknowledged, on
              // reconnect; until then nothing is confirmed.
              if (next !is ConnectionState.Connected) device.confirmedStorage.clear()
            }
          }
        }

        keepObservationConnected(stream, config.reconnect) { device.connect(key, reconnect = true) }
      }
      device
    } ?: return // The releasing lease already disposed the stream.
    applyCadence(key)
  }

  /** Fan [device]'s storage traffic out to the leases holding each file. */
  private fun CoroutineScope.launchStorageRouting(device: Device): Job = launch {
    val stream = device.stream
    launch {
      stream.storageUpdates.collect { update ->
        val file = StorageSubscriptionKey(update.packageName, update.fileName)
        holdersOf(device, file).forEach { it.storageUpdates.trySend(update) }
      }
    }
    launch {
      stream.storageSubscriptionResponses.collect { response ->
        val holders =
          synchronized(lock) {
            if (response.subscribe && response.success) {
              device.confirmedStorage.add(response.key)
            } else if (response.success || response.subscribe) {
              device.confirmedStorage.remove(response.key)
            }
            // An unsubscribe's acknowledgement answers a lease that has already let go.
            if (response.subscribe) device.storageHolders[response.key]?.toList() else null
          }
        holders?.forEach { it.storageResponses.trySend(response) }
      }
    }
    launch {
      stream.storageReconciliationRequests.collect { file ->
        holdersOf(device, file).forEach { it.storageReconciliations.trySend(file) }
      }
    }
  }

  private fun holdersOf(device: Device, file: StorageSubscriptionKey): List<Lease> =
    synchronized(lock) { device.storageHolders[file]?.toList().orEmpty() }

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
    synchronized(lock) { device.storageRouting }?.cancel()
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
