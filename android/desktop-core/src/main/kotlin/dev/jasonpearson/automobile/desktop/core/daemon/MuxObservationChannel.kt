package dev.jasonpearson.automobile.desktop.core.daemon

import dev.jasonpearson.automobile.desktop.core.connection.ConnectionState
import dev.jasonpearson.automobile.desktop.core.connection.isConnected
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.emptyFlow

/**
 * One device's subscription on a [MultiplexedObservationSocketClient], seen as an
 * [ObservationStream]: [connect] sends this device's own `subscribe` on the shared socket, and its
 * flows carry only frames routed to this subscription's `subscriptionId` (or replies to its own
 * requests).
 *
 * Every flow is fed with `tryEmit` into a drop-oldest buffer: one reader serves every device, so no
 * device's slow collector may hold back another device's frames. The layout and performance flows
 * keep the latest frame as their replay, as the per-device client's do.
 *
 * Storage is not carried; the Storage facet keeps its own stream.
 */
internal class MuxObservationChannel(private val mux: MultiplexedObservationSocketClient) :
  ObservationStream {
  private val _hierarchyUpdates = latestFlow<HierarchyStreamUpdate>()
  override val hierarchyUpdates: SharedFlow<HierarchyStreamUpdate> =
    _hierarchyUpdates.asSharedFlow()

  private val _screenshotUpdates = latestFlow<ScreenshotStreamUpdate>()
  override val screenshotUpdates: SharedFlow<ScreenshotStreamUpdate> =
    _screenshotUpdates.asSharedFlow()

  private val _navigationUpdates = latestFlow<NavigationGraphStreamUpdate>()
  override val navigationUpdates: SharedFlow<NavigationGraphStreamUpdate> =
    _navigationUpdates.asSharedFlow()

  private val _buildContextUpdates = latestFlow<BuildContextStreamUpdate>()
  override val buildContextUpdates: SharedFlow<BuildContextStreamUpdate> =
    _buildContextUpdates.asSharedFlow()

  private val _performanceUpdates = latestFlow<PerformanceStreamUpdate>()
  override val performanceUpdates: SharedFlow<PerformanceStreamUpdate> =
    _performanceUpdates.asSharedFlow()

  private val _deviceEvents = latestFlow<DeviceStreamEvent>()
  override val deviceEvents: SharedFlow<DeviceStreamEvent> = _deviceEvents.asSharedFlow()

  override val storageUpdates: Flow<StorageStreamUpdate> = emptyFlow()
  override val storageSubscriptionResponses: Flow<StorageSubscriptionResponse> = emptyFlow()
  override val storageReconciliationRequests: Flow<StorageSubscriptionKey> = emptyFlow()

  val mutableState = MutableStateFlow<ConnectionState>(ConnectionState.Disconnected())
  override val connectionState: StateFlow<ConnectionState> = mutableState.asStateFlow()

  // Guarded by the owning mux's lock.
  /** On the mux: [connect] was called and neither [disconnect] nor [dispose] since. */
  var live = false
  var disposed = false
  var deviceId: String? = null
  var deviceSessionUuid: String? = null
  var subscriptionId: String? = null
  /** The in-flight `subscribe` request, until the daemon acknowledges or refuses it. */
  var requestId: String? = null
  var cadence = ObservationCadence()
  /** The cadence changed while the `subscribe` carrying the older one was in flight. */
  var cadenceDirty = false

  override fun connect(deviceId: String?, deviceSessionUuid: String?) =
    mux.connect(this, deviceId, deviceSessionUuid)

  override fun disconnect() = mux.disconnect(this, dispose = false)

  override fun isConnected(): Boolean = connectionState.value.isConnected

  override fun dispose() = mux.disconnect(this, dispose = true)

  override fun setCadence(screenshotIntervalMs: Long?, hierarchyIntervalMs: Long?) =
    mux.setCadence(this, ObservationCadence(screenshotIntervalMs, hierarchyIntervalMs))

  @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
  override fun resetLayoutReplayCache() {
    _screenshotUpdates.resetReplayCache()
    _hierarchyUpdates.resetReplayCache()
  }

  override fun requestNavigationGraph(appId: String?) = mux.requestNavigationGraph(this, appId)

  override fun requestObservation(deviceId: String?) = mux.requestObservation(this, deviceId)

  override fun subscribeStorage(packageName: String, fileName: String) =
    throw UnsupportedOperationException("Storage keeps its own observation stream")

  override fun unsubscribeStorage(packageName: String, fileName: String) =
    throw UnsupportedOperationException("Storage keeps its own observation stream")

  /** Deliver one frame routed to this device; false when the type is not a device data frame. */
  fun deliver(response: StreamResponse): Boolean {
    when (response.type) {
      "hierarchy_update" -> _hierarchyUpdates.tryEmit(response.toHierarchyUpdate())
      "screenshot_update" -> _screenshotUpdates.tryEmit(response.toScreenshotUpdate())
      "navigation_update" -> response.toNavigationUpdate()?.let(_navigationUpdates::tryEmit)
      "performance_update" -> response.toPerformanceUpdate()?.let(_performanceUpdates::tryEmit)
      "device_build_context" -> response.toBuildContextUpdate()?.let(_buildContextUpdates::tryEmit)
      "device_session_ended" -> response.toSessionSuperseded()?.let(_deviceEvents::tryEmit)
      else -> return false
    }
    return true
  }

  /** The device's control connection dropped: stale frames must not re-arm the panes. */
  @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
  fun deviceConnectionLost(event: DeviceStreamEvent.DeviceConnectionLost) {
    _hierarchyUpdates.resetReplayCache()
    _screenshotUpdates.resetReplayCache()
    _performanceUpdates.resetReplayCache()
    _deviceEvents.tryEmit(event)
  }

  private companion object {
    const val FLOW_BUFFER = 16

    fun <T> latestFlow() =
      MutableSharedFlow<T>(
        replay = 1,
        extraBufferCapacity = FLOW_BUFFER,
        onBufferOverflow = BufferOverflow.DROP_OLDEST,
      )
  }
}
