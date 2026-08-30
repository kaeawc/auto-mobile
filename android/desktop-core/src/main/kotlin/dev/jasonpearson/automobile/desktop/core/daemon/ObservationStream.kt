package dev.jasonpearson.automobile.desktop.core.daemon

import dev.jasonpearson.automobile.desktop.core.connection.ConnectionState
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * The observation-stream contract: per-device real-time updates (hierarchy, screenshot, navigation
 * graph, performance, storage, device events) plus subscription lifecycle. Extracted so consumers
 * (e.g. the workspace facets) can depend on the interface and be tested with
 * [FakeObservationStream] instead of the socket-backed [ObservationStreamClient].
 */
interface ObservationStream {
  val hierarchyUpdates: SharedFlow<HierarchyStreamUpdate>
  val screenshotUpdates: SharedFlow<ScreenshotStreamUpdate>
  val navigationUpdates: SharedFlow<NavigationGraphStreamUpdate>
  val performanceUpdates: SharedFlow<PerformanceStreamUpdate>
  val storageUpdates: SharedFlow<StorageStreamUpdate>
  val deviceEvents: SharedFlow<DeviceStreamEvent>
  val connectionState: StateFlow<ConnectionState>

  /** Subscribe to the stream, optionally scoped to a daemon device epoch and [deviceId]. */
  fun connect(deviceId: String? = null, deviceSessionUuid: String? = null)

  /** Unsubscribe and close the connection; the instance may be reconnected. */
  fun disconnect()

  fun isConnected(): Boolean

  /** Disconnect and release all resources; do not reuse after calling. */
  fun dispose()

  fun setCadence(screenshotIntervalMs: Long? = null, hierarchyIntervalMs: Long? = null)

  fun resetLayoutReplayCache()

  /** Request the navigation graph for the subscribed device (optionally scoped to [appId]). */
  fun requestNavigationGraph(appId: String? = null)

  /** Request a one-off observation for [deviceId] (or the subscribed device when null). */
  fun requestObservation(deviceId: String? = null)

  /**
   * Register a device-side content observer for [packageName]/[fileName] so external writes to that
   * key/value store emit `storage_update` frames on [storageUpdates]. Idempotent per (package,
   * file) and remembered so it is re-applied automatically across reconnects. No-op until
   * connected.
   */
  fun subscribeStorage(packageName: String, fileName: String)

  /** Release the content observer previously registered via [subscribeStorage]. */
  fun unsubscribeStorage(packageName: String, fileName: String)
}
