package dev.jasonpearson.automobile.desktop.core.daemon

import dev.jasonpearson.automobile.desktop.core.connection.ConnectionState
import dev.jasonpearson.automobile.desktop.core.connection.isConnected

class FakeObservationStream(private val failConnect: Boolean = false) : FakeObservationState() {
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
}
