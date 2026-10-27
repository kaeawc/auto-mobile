package dev.jasonpearson.automobile.desktop.core.snapshot

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import dev.jasonpearson.automobile.desktop.core.daemon.DeviceSnapshotActions
import dev.jasonpearson.automobile.desktop.core.daemon.DeviceSnapshotConfig
import dev.jasonpearson.automobile.desktop.core.daemon.DeviceSnapshotConfigClient
import dev.jasonpearson.automobile.desktop.core.daemon.DeviceSnapshotMetadata
import dev.jasonpearson.automobile.desktop.core.daemon.McpConnectionException
import dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

@Composable
internal fun rememberSnapshotMemory(): SnapshotMemory {
  val snapshotsState = remember { mutableStateOf<List<DeviceSnapshotMetadata>>(emptyList()) }
  val configState = remember { mutableStateOf<DeviceSnapshotConfig?>(null) }
  val isLoadingState = remember { mutableStateOf(true) }
  val errorState = remember { mutableStateOf<String?>(null) }
  val busyMessageState = remember { mutableStateOf<String?>(null) }
  val noticeState = remember { mutableStateOf<String?>(null) }
  val reloadTokenState = remember { mutableStateOf(0) }
  return SnapshotMemory(
    snapshotsState,
    configState,
    isLoadingState,
    errorState,
    busyMessageState,
    noticeState,
    reloadTokenState,
  )
}

@Composable
internal fun SnapshotMemory.LoadSnapshots(
  actions: DeviceSnapshotActions?,
  configClient: DeviceSnapshotConfigClient?,
  ioDispatcher: kotlinx.coroutines.CoroutineDispatcher,
) {
  LaunchedEffect(actions, configClient, reloadToken) {
    isLoading = true
    error = null
    withContext(ioDispatcher) {
      snapshots =
        try {
          actions?.listSnapshots().orEmpty()
        } catch (e: java.io.IOException) {
          LOG.warn("Failed to list snapshots: ${e.message}", e)
          error = e.message ?: "Failed to list snapshots"
          emptyList()
        } catch (e: McpConnectionException) {
          LOG.warn("Failed to list snapshots: ${e.message}", e)
          error = e.message ?: "Failed to list snapshots"
          emptyList()
        } catch (e: IllegalArgumentException) {
          LOG.warn("Failed to list snapshots: ${e.message}", e)
          error = e.message ?: "Failed to list snapshots"
          emptyList()
        }

      // Retention config is optional: a daemon predating device-snapshot.sock still lists and
      // captures, so a failure here must not blank the dashboard.
      config =
        try {
          if (configClient?.isAvailable() == true) configClient.getConfig().config else null
        } catch (e: java.io.IOException) {
          LOG.warn("Snapshot config unavailable: ${e.message}", e)
          null
        } catch (e: McpConnectionException) {
          LOG.warn("Snapshot config unavailable: ${e.message}", e)
          null
        } catch (e: IllegalArgumentException) {
          LOG.warn("Snapshot config unavailable: ${e.message}", e)
          null
        }
    }
    isLoading = false
  }
}

internal fun SnapshotMemory.runSnapshotAction(
  scope: kotlinx.coroutines.CoroutineScope,
  ioDispatcher: kotlinx.coroutines.CoroutineDispatcher,
  label: String,
  block: suspend () -> String?,
) {

  busyMessage = label
  notice = null
  error = null
  scope.launch {
    try {
      val message = withContext(ioDispatcher) { block() }
      notice = message
      reloadToken += 1
    } catch (e: java.io.IOException) {
      LOG.warn("$label failed: ${e.message}", e)
      error = e.message ?: "$label failed"
    } catch (e: McpConnectionException) {
      LOG.warn("$label failed: ${e.message}", e)
      error = e.message ?: "$label failed"
    } catch (e: IllegalArgumentException) {
      LOG.warn("$label failed: ${e.message}", e)
      error = e.message ?: "$label failed"
    } finally {
      busyMessage = null
    }
  }
}

internal data class SnapshotMemory(
  private val snapshotsState: androidx.compose.runtime.MutableState<List<DeviceSnapshotMetadata>>,
  private val configState: androidx.compose.runtime.MutableState<DeviceSnapshotConfig?>,
  private val isLoadingState: androidx.compose.runtime.MutableState<Boolean>,
  private val errorState: androidx.compose.runtime.MutableState<String?>,
  private val busyMessageState: androidx.compose.runtime.MutableState<String?>,
  private val noticeState: androidx.compose.runtime.MutableState<String?>,
  private val reloadTokenState: androidx.compose.runtime.MutableState<Int>,
) {
  var snapshots by snapshotsState
  var config by configState
  var isLoading by isLoadingState
  var error by errorState
  var busyMessage by busyMessageState
  var notice by noticeState
  var reloadToken by reloadTokenState
}

private val LOG = LoggerFactory.getLogger("SnapshotsDashboard")
