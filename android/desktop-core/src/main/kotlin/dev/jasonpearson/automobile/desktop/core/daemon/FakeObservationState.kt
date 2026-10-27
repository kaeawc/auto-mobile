package dev.jasonpearson.automobile.desktop.core.daemon

import dev.jasonpearson.automobile.desktop.core.connection.ConnectionState
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

private fun <T> observationTestFlow() =
  MutableSharedFlow<T>(
    replay = 1,
    extraBufferCapacity = 16,
    onBufferOverflow = BufferOverflow.DROP_OLDEST,
  )

abstract class FakeObservationState : ObservationStream {
  protected val _hierarchyUpdates = observationTestFlow<HierarchyStreamUpdate>()
  override val hierarchyUpdates: SharedFlow<HierarchyStreamUpdate> =
    _hierarchyUpdates.asSharedFlow()
  protected val _screenshotUpdates = observationTestFlow<ScreenshotStreamUpdate>()
  override val screenshotUpdates: SharedFlow<ScreenshotStreamUpdate> =
    _screenshotUpdates.asSharedFlow()
  protected val _navigationUpdates = observationTestFlow<NavigationGraphStreamUpdate>()
  override val navigationUpdates: SharedFlow<NavigationGraphStreamUpdate> =
    _navigationUpdates.asSharedFlow()
  protected val _buildContextUpdates = observationTestFlow<BuildContextStreamUpdate>()
  override val buildContextUpdates: SharedFlow<BuildContextStreamUpdate> =
    _buildContextUpdates.asSharedFlow()
  protected val _performanceUpdates = observationTestFlow<PerformanceStreamUpdate>()
  override val performanceUpdates: SharedFlow<PerformanceStreamUpdate> =
    _performanceUpdates.asSharedFlow()
  protected val storageUpdateChannel = Channel<StorageStreamUpdate>(Channel.UNLIMITED)
  override val storageUpdates: Flow<StorageStreamUpdate> = storageUpdateChannel.receiveAsFlow()
  protected val storageSubscriptionResponseChannel =
    Channel<StorageSubscriptionResponse>(Channel.UNLIMITED)
  override val storageSubscriptionResponses: Flow<StorageSubscriptionResponse> =
    storageSubscriptionResponseChannel.receiveAsFlow()
  protected val storageReconciliationRequestChannel =
    Channel<StorageSubscriptionKey>(Channel.BUFFERED)
  override val storageReconciliationRequests: Flow<StorageSubscriptionKey> =
    storageReconciliationRequestChannel.receiveAsFlow()
  protected val _deviceEvents = observationTestFlow<DeviceStreamEvent>()
  override val deviceEvents: SharedFlow<DeviceStreamEvent> = _deviceEvents.asSharedFlow()

  protected val _connectionState = MutableStateFlow<ConnectionState>(ConnectionState.Disconnected())
  override val connectionState: StateFlow<ConnectionState> = _connectionState.asStateFlow()

  var connectCallCount = 0
    protected set

  var disconnectCallCount = 0
    protected set

  var lastConnectedDeviceId: String? = null
    protected set

  var lastConnectedDeviceSessionUuid: String? = null
    protected set

  var navigationRequestCount = 0
    protected set

  var lastNavigationAppId: String? = null
    protected set

  var observationRequestCount = 0
    protected set

  var lastObservationDeviceId: String? = null
    protected set

  fun emitConnectionState(state: ConnectionState) {
    _connectionState.value = state
  }

  /** Storage files currently subscribed (by [subscribeStorage], minus [unsubscribeStorage]). */
  val storageSubscriptions: Set<StorageSubscriptionKey>
    get() = _storageSubscriptions.toSet()

  protected val _storageSubscriptions = LinkedHashSet<StorageSubscriptionKey>()

  /**
   * All storage subscribe/unsubscribe calls in order, for asserting lifecycle (subscribe→release).
   */
  val storageSubscriptionCalls: List<Pair<String, StorageSubscriptionKey>>
    get() = _storageSubscriptionCalls.toList()

  protected val _storageSubscriptionCalls = mutableListOf<Pair<String, StorageSubscriptionKey>>()

  // -- Test helpers: push updates onto the flows --
  fun emitScreenshot(update: ScreenshotStreamUpdate): Boolean = _screenshotUpdates.tryEmit(update)

  fun emitNavigation(update: NavigationGraphStreamUpdate): Boolean =
    _navigationUpdates.tryEmit(update)

  fun emitBuildContext(update: BuildContextStreamUpdate): Boolean =
    _buildContextUpdates.tryEmit(update)

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
