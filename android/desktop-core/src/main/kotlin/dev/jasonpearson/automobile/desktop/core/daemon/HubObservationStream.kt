package dev.jasonpearson.automobile.desktop.core.daemon

import dev.jasonpearson.automobile.desktop.core.connection.ConnectionState
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.map

/**
 * An [ObservationStream] whose connection is owned and kept alive by a [DaemonStreamHub], so its
 * holder must not run its own reconnect loop: [ObservationStream.connect] only takes the lease, and
 * a dropped connection is revived by the hub.
 */
interface HubManagedObservationStream : ObservationStream {
  /**
   * How many times the hub has reconnected this stream since this holder took its lease: the signal
   * for a facet to refresh, as it would after reconnecting its own stream. Counted at the reconnect
   * itself, so a drop and recovery too quick to show in [connectionState] still counts.
   */
  val reconnects: Flow<Int>
}

/**
 * Call [onReconnected] each time the hub reconnects [stream], so a facet on a hub-managed stream
 * refreshes exactly as it would after reconnecting its own stream. The first connection is not a
 * reconnect.
 */
internal suspend fun countHubReconnects(
  stream: HubManagedObservationStream,
  onReconnected: () -> Unit,
) {
  var seen = 0
  stream.reconnects.collect { count ->
    if (count > seen) {
      seen = count
      onReconnected()
    }
  }
}

/**
 * A facet's view of the hub's shared observation stream for [key]. [connect] takes the lease (once)
 * and asks the hub to revive a dropped connection now; [disconnect]/[dispose] release it. The
 * update flows are the shared stream's, so they are valid once [connect] has been called: read them
 * after connecting, as the workspace's reconnecting helper does.
 *
 * Storage is not shared: its updates and acknowledgements are unicast per pane, so the Storage
 * facet keeps its own stream. This view carries no storage traffic and rejects storage
 * subscriptions.
 */
internal class HubObservationStream(
  private val streams: HubObservationStreams,
  private val key: DeviceStreamKey,
) : HubManagedObservationStream {
  private val lock = Any()
  private var lease: HubObservationStreams.Lease? = null
  private var shared: ObservationStream? = null
  private var reconnectBaseline = 0

  private fun current(): ObservationStream? = synchronized(lock) { shared }

  override val hierarchyUpdates: SharedFlow<HierarchyStreamUpdate>
    get() = current()?.hierarchyUpdates ?: idleFlow()

  override val screenshotUpdates: SharedFlow<ScreenshotStreamUpdate>
    get() = current()?.screenshotUpdates ?: idleFlow()

  override val navigationUpdates: SharedFlow<NavigationGraphStreamUpdate>
    get() = current()?.navigationUpdates ?: idleFlow()

  override val buildContextUpdates: SharedFlow<BuildContextStreamUpdate>
    get() = current()?.buildContextUpdates ?: idleFlow()

  override val performanceUpdates: SharedFlow<PerformanceStreamUpdate>
    get() = current()?.performanceUpdates ?: idleFlow()

  override val deviceEvents: SharedFlow<DeviceStreamEvent>
    get() = current()?.deviceEvents ?: idleFlow()

  override val storageUpdates: Flow<StorageStreamUpdate> = emptyFlow()
  override val storageSubscriptionResponses: Flow<StorageSubscriptionResponse> = emptyFlow()
  override val storageReconciliationRequests: Flow<StorageSubscriptionKey> = emptyFlow()

  override val connectionState: StateFlow<ConnectionState> = streams.observationConnectionState(key)

  override val reconnects: Flow<Int>
    get() =
      synchronized(lock) {
        val held = lease ?: return@synchronized emptyFlow()
        val baseline = reconnectBaseline
        held.reconnects.map { it - baseline }
      }

  override fun connect(deviceId: String?, deviceSessionUuid: String?) {
    val acquired =
      synchronized(lock) {
        if (lease != null) return@synchronized false
        val newLease = streams.acquire(key)
        lease = newLease
        shared = newLease.stream
        reconnectBaseline = newLease.reconnects.value
        true
      }
    // A repeated connect is a manual retry: revive a dropped shared connection without waiting.
    if (!acquired) streams.retry(key)
  }

  override fun disconnect() {
    val held =
      synchronized(lock) {
        val held = lease
        lease = null
        shared = null
        held
      }
    held?.let(streams::release)
  }

  override fun isConnected(): Boolean =
    synchronized(lock) { lease != null } && connectionState.value is ConnectionState.Connected

  override fun dispose() = disconnect()

  override fun setCadence(screenshotIntervalMs: Long?, hierarchyIntervalMs: Long?) {
    val held = synchronized(lock) { lease } ?: return
    streams.setCadence(held, ObservationCadence(screenshotIntervalMs, hierarchyIntervalMs))
  }

  override fun resetLayoutReplayCache() {
    current()?.resetLayoutReplayCache()
  }

  override fun requestNavigationGraph(appId: String?) {
    current()?.requestNavigationGraph(appId)
  }

  override fun requestObservation(deviceId: String?) {
    current()?.requestObservation(deviceId)
  }

  override fun subscribeStorage(packageName: String, fileName: String) =
    throw UnsupportedOperationException("Storage keeps its own observation stream")

  override fun unsubscribeStorage(packageName: String, fileName: String) =
    throw UnsupportedOperationException("Storage keeps its own observation stream")

  private companion object {
    // Never emits: the update flows before connect, or after the lease is released.
    private val IDLE = MutableSharedFlow<Nothing>()

    fun <T> idleFlow(): SharedFlow<T> = IDLE
  }
}
