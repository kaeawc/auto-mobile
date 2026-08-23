package dev.jasonpearson.automobile.desktop.core.daemon

import dev.jasonpearson.automobile.desktop.core.connection.ConnectionState
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow

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
  private val _storageUpdates = flow<StorageStreamUpdate>()
  override val storageUpdates: SharedFlow<StorageStreamUpdate> = _storageUpdates.asSharedFlow()
  private val _deviceEvents = flow<DeviceStreamEvent>()
  override val deviceEvents: SharedFlow<DeviceStreamEvent> = _deviceEvents.asSharedFlow()

  private val _connectionState = MutableStateFlow<ConnectionState>(ConnectionState.Disconnected())
  override val connectionState: StateFlow<ConnectionState> = _connectionState.asStateFlow()

  private var connected = false

  var connectCallCount = 0
    private set

  var disconnectCallCount = 0
    private set

  var lastConnectedDeviceId: String? = null
    private set

  var navigationRequestCount = 0
    private set

  var lastNavigationAppId: String? = null
    private set

  var observationRequestCount = 0
    private set

  var lastObservationDeviceId: String? = null
    private set

  override fun connect(deviceId: String?) {
    connectCallCount++
    lastConnectedDeviceId = deviceId
    if (failConnect) {
      connected = false
      _connectionState.value = ConnectionState.Disconnected("Socket not found")
      return
    }
    connected = true
    _connectionState.value = ConnectionState.Connected()
  }

  /** Push a connection-state transition onto [connectionState] (e.g. a mid-session drop). */
  fun emitConnectionState(state: ConnectionState) {
    _connectionState.value = state
  }

  override fun disconnect() {
    disconnectCallCount++
    connected = false
    _connectionState.value = ConnectionState.Disconnected()
  }

  override fun isConnected(): Boolean = connected

  override fun dispose() {
    disconnect()
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
    // The real ObservationStreamClient no-ops unless connected; guard the fake likewise so a
    // disconnected test cannot get a false positive that a graph was requested.
    if (!connected) return
    navigationRequestCount++
    lastNavigationAppId = appId
  }

  override fun requestObservation(deviceId: String?) {
    observationRequestCount++
    lastObservationDeviceId = deviceId
  }

  // -- Test helpers: push updates onto the flows --
  fun emitScreenshot(update: ScreenshotStreamUpdate): Boolean = _screenshotUpdates.tryEmit(update)

  fun emitNavigation(update: NavigationGraphStreamUpdate): Boolean =
    _navigationUpdates.tryEmit(update)

  fun emitPerformance(update: PerformanceStreamUpdate): Boolean =
    _performanceUpdates.tryEmit(update)

  fun emitStorage(update: StorageStreamUpdate): Boolean = _storageUpdates.tryEmit(update)

  fun emitHierarchy(update: HierarchyStreamUpdate): Boolean = _hierarchyUpdates.tryEmit(update)

  fun emitDeviceEvent(event: DeviceStreamEvent): Boolean = _deviceEvents.tryEmit(event)
}
