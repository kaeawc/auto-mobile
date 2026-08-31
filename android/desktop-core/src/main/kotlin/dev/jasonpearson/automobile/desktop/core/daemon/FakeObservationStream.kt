package dev.jasonpearson.automobile.desktop.core.daemon

import dev.jasonpearson.automobile.desktop.core.connection.ConnectionState
import dev.jasonpearson.automobile.desktop.core.connection.isConnected
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.receiveAsFlow

/**
 * In-memory [ObservationStream] for UI tests: records subscription lifecycle (connect/disconnect/
 * dispose, requested navigation graph) and lets tests emit updates onto each flow, with no socket.
 *
 * When [failConnect] is true, [connect] leaves the stream disconnected (mirroring the real client
 * swallowing a socket-unavailable failure) so tests can exercise the retryable connection-error
 * path.
 */
class FakeObservationStream(private val failConnect: Boolean = false) : ObservationStream {
  private fun <T> flow() =
    MutableSharedFlow<T>(
      replay = 1,
      extraBufferCapacity = 16,
      onBufferOverflow = BufferOverflow.DROP_OLDEST,
    )

  private val _hierarchyUpdates = flow<HierarchyStreamUpdate>()
  override val hierarchyUpdates: SharedFlow<HierarchyStreamUpdate> =
    _hierarchyUpdates.asSharedFlow()
  private val _screenshotUpdates = flow<ScreenshotStreamUpdate>()
  override val screenshotUpdates: SharedFlow<ScreenshotStreamUpdate> =
    _screenshotUpdates.asSharedFlow()
  private val _navigationUpdates = flow<NavigationGraphStreamUpdate>()
  override val navigationUpdates: SharedFlow<NavigationGraphStreamUpdate> =
    _navigationUpdates.asSharedFlow()
  private val _performanceUpdates = flow<PerformanceStreamUpdate>()
  override val performanceUpdates: SharedFlow<PerformanceStreamUpdate> =
    _performanceUpdates.asSharedFlow()
  private val storageUpdateChannel = Channel<StorageStreamUpdate>(Channel.UNLIMITED)
  override val storageUpdates: Flow<StorageStreamUpdate> = storageUpdateChannel.receiveAsFlow()
  private val storageSubscriptionResponseChannel =
    Channel<StorageSubscriptionResponse>(Channel.UNLIMITED)
  override val storageSubscriptionResponses: Flow<StorageSubscriptionResponse> =
    storageSubscriptionResponseChannel.receiveAsFlow()
  private val storageReconciliationRequestChannel =
    Channel<StorageSubscriptionKey>(Channel.BUFFERED)
  override val storageReconciliationRequests: Flow<StorageSubscriptionKey> =
    storageReconciliationRequestChannel.receiveAsFlow()
  private val _deviceEvents = flow<DeviceStreamEvent>()
  override val deviceEvents: SharedFlow<DeviceStreamEvent> = _deviceEvents.asSharedFlow()

  private val _connectionState = MutableStateFlow<ConnectionState>(ConnectionState.Disconnected())
  override val connectionState: StateFlow<ConnectionState> = _connectionState.asStateFlow()

  var connectCallCount = 0
    private set

  var disconnectCallCount = 0
    private set

  var lastConnectedDeviceId: String? = null
    private set

  var lastConnectedDeviceSessionUuid: String? = null
    private set

  var navigationRequestCount = 0
    private set

  var lastNavigationAppId: String? = null
    private set

  var observationRequestCount = 0
    private set

  var lastObservationDeviceId: String? = null
    private set

  override fun connect(deviceId: String?, deviceSessionUuid: String?) {
    connectCallCount++
    lastConnectedDeviceId = deviceId
    lastConnectedDeviceSessionUuid = deviceSessionUuid
    if (failConnect) {
      _connectionState.value = ConnectionState.Disconnected("Socket not found")
      return
    }
    _connectionState.value = ConnectionState.Connected()
  }

  /** Push a connection-state transition onto [connectionState] (e.g. a mid-session drop). */
  fun emitConnectionState(state: ConnectionState) {
    _connectionState.value = state
  }

  override fun disconnect() {
    disconnectCallCount++
    _connectionState.value = ConnectionState.Disconnected()
  }

  // Derive from the published state (like the real client) so a mid-session drop injected via
  // [emitConnectionState] is reflected here and by the [requestNavigationGraph] guard.
  override fun isConnected(): Boolean = _connectionState.value.isConnected

  override fun dispose() {
    disconnect()
    storageUpdateChannel.close()
    storageSubscriptionResponseChannel.close()
    storageReconciliationRequestChannel.close()
  }

  override fun setCadence(screenshotIntervalMs: Long?, hierarchyIntervalMs: Long?) = Unit

  // Mirror the real client: drop the buffered layout replay so a resubscribing collector does not
  // immediately receive the last pre-reset screenshot/hierarchy frame (issue #3347).
  @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
  override fun resetLayoutReplayCache() {
    _screenshotUpdates.resetReplayCache()
    _hierarchyUpdates.resetReplayCache()
  }

  override fun requestNavigationGraph(appId: String?) {
    // The real ObservationStreamClient no-ops unless connected; gate on the published state (not a
    // separate flag) so a mid-session drop injected via emitConnectionState is honored too, and a
    // disconnected test cannot get a false positive that a graph was requested.
    if (!_connectionState.value.isConnected) return
    navigationRequestCount++
    lastNavigationAppId = appId
  }

  override fun requestObservation(deviceId: String?) {
    observationRequestCount++
    lastObservationDeviceId = deviceId
  }

  /** Storage files currently subscribed (by [subscribeStorage], minus [unsubscribeStorage]). */
  val storageSubscriptions: Set<StorageSubscriptionKey>
    get() = _storageSubscriptions.toSet()

  private val _storageSubscriptions = LinkedHashSet<StorageSubscriptionKey>()

  /**
   * All storage subscribe/unsubscribe calls in order, for asserting lifecycle (subscribe→release).
   */
  val storageSubscriptionCalls: List<Pair<String, StorageSubscriptionKey>>
    get() = _storageSubscriptionCalls.toList()

  private val _storageSubscriptionCalls = mutableListOf<Pair<String, StorageSubscriptionKey>>()

  override fun subscribeStorage(packageName: String, fileName: String) {
    val key = StorageSubscriptionKey(packageName, fileName)
    // Mirror the real client's dedup: a repeated subscribe for the same file is a no-op.
    if (!_storageSubscriptions.add(key)) return
    _storageSubscriptionCalls.add("subscribe_storage" to key)
  }

  override fun unsubscribeStorage(packageName: String, fileName: String) {
    val key = StorageSubscriptionKey(packageName, fileName)
    if (!_storageSubscriptions.remove(key)) return
    _storageSubscriptionCalls.add("unsubscribe_storage" to key)
  }

  // -- Test helpers: push updates onto the flows --
  fun emitScreenshot(update: ScreenshotStreamUpdate): Boolean = _screenshotUpdates.tryEmit(update)

  fun emitNavigation(update: NavigationGraphStreamUpdate): Boolean =
    _navigationUpdates.tryEmit(update)

  fun emitPerformance(update: PerformanceStreamUpdate): Boolean =
    _performanceUpdates.tryEmit(update)

  fun emitStorage(update: StorageStreamUpdate): Boolean =
    storageUpdateChannel.trySend(update).isSuccess

  fun emitStorageSubscriptionResponse(response: StorageSubscriptionResponse): Boolean =
    storageSubscriptionResponseChannel.trySend(response).isSuccess

  fun emitStorageReconciliationRequest(key: StorageSubscriptionKey): Boolean =
    storageReconciliationRequestChannel.trySend(key).isSuccess

  fun emitHierarchy(update: HierarchyStreamUpdate): Boolean = _hierarchyUpdates.tryEmit(update)

  fun emitDeviceEvent(event: DeviceStreamEvent): Boolean = _deviceEvents.tryEmit(event)
}
