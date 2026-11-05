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
 * Storage is not carried; the Storage facet keeps its own stream.
 */
internal class MuxObservationChannel(private val mux: MultiplexedObservationSocketClient) :
  ObservationStream {
  val flows = MuxChannelFlows()

  override val hierarchyUpdates: SharedFlow<HierarchyStreamUpdate> = flows.hierarchy.asSharedFlow()
  override val screenshotUpdates: SharedFlow<ScreenshotStreamUpdate> =
    flows.screenshot.asSharedFlow()
  override val navigationUpdates: SharedFlow<NavigationGraphStreamUpdate> =
    flows.navigation.asSharedFlow()
  override val buildContextUpdates: SharedFlow<BuildContextStreamUpdate> =
    flows.buildContext.asSharedFlow()
  override val performanceUpdates: SharedFlow<PerformanceStreamUpdate> =
    flows.performance.asSharedFlow()
  override val deviceEvents: SharedFlow<DeviceStreamEvent> = flows.deviceEvents.asSharedFlow()

  override val storageUpdates: Flow<StorageStreamUpdate> = emptyFlow()
  override val storageSubscriptionResponses: Flow<StorageSubscriptionResponse> = emptyFlow()
  override val storageReconciliationRequests: Flow<StorageSubscriptionKey> = emptyFlow()

  val mutableState = MutableStateFlow<ConnectionState>(ConnectionState.Disconnected())
  override val connectionState: StateFlow<ConnectionState> = mutableState.asStateFlow()

  // Guarded by the owning mux table's lock.
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

  override fun resetLayoutReplayCache() = flows.resetLayout()

  override fun requestNavigationGraph(appId: String?) = mux.requestNavigationGraph(this, appId)

  override fun requestObservation(deviceId: String?) = mux.requestObservation(this, deviceId)

  override fun subscribeStorage(packageName: String, fileName: String) =
    throw UnsupportedOperationException("Storage keeps its own observation stream")

  override fun unsubscribeStorage(packageName: String, fileName: String) =
    throw UnsupportedOperationException("Storage keeps its own observation stream")
}

/**
 * The per-device flows behind a [MuxObservationChannel]. Every flow is fed with `tryEmit` into a
 * drop-oldest buffer: one reader serves every device, so no device's slow collector may hold back
 * another device's frames. Each flow keeps the latest frame as its replay, as the per-device
 * client's do.
 */
internal class MuxChannelFlows {
  val hierarchy = latestFlow<HierarchyStreamUpdate>()
  val screenshot = latestFlow<ScreenshotStreamUpdate>()
  val navigation = latestFlow<NavigationGraphStreamUpdate>()
  val buildContext = latestFlow<BuildContextStreamUpdate>()
  val performance = latestFlow<PerformanceStreamUpdate>()
  val deviceEvents = latestFlow<DeviceStreamEvent>()

  /** Deliver one frame routed to this device; false when the type is not a device data frame. */
  fun deliver(response: StreamResponse): Boolean {
    when (response.type) {
      "hierarchy_update" -> hierarchy.tryEmit(response.toHierarchyUpdate())
      "screenshot_update" -> screenshot.tryEmit(response.toScreenshotUpdate())
      "navigation_update" -> response.toNavigationUpdate()?.let(navigation::tryEmit)
      "performance_update" -> response.toPerformanceUpdate()?.let(performance::tryEmit)
      "device_build_context" -> response.toBuildContextUpdate()?.let(buildContext::tryEmit)
      "device_session_ended" -> response.toDeviceSessionEvent()?.let(deviceEvents::tryEmit)
      else -> return false
    }
    return true
  }

  /** The device's control connection dropped: stale frames must not re-arm the panes. */
  @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
  fun connectionLost(event: DeviceStreamEvent.DeviceConnectionLost) {
    resetLayout()
    performance.resetReplayCache()
    deviceEvents.tryEmit(event)
  }

  @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
  fun resetLayout() {
    screenshot.resetReplayCache()
    hierarchy.resetReplayCache()
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
