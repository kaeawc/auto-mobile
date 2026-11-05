package dev.jasonpearson.automobile.desktop.core.workspace

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.rememberUpdatedState
import dev.jasonpearson.automobile.desktop.core.daemon.DeviceStreamEvent
import dev.jasonpearson.automobile.desktop.core.daemon.DeviceStreamKey
import dev.jasonpearson.automobile.desktop.core.daemon.ObservationStream

/** Where the workspace sends an observed column's device epoch lifecycle events. */
data class WorkspaceDeviceLifecycleHandlers(
  val onSuperseded: (DeviceStreamEvent.DeviceSessionSuperseded) -> Unit = {},
  val onEnded: (DeviceStreamEvent.DeviceSessionEnded) -> Unit = {},
)

/**
 * Hears device epoch lifecycle frames for every observed column at workspace scope (#17061), so
 * whether they arrive no longer depends on which facets are open or which pane has focus.
 *
 * Each column observing a live epoch holds one stream from [lifecycleStreamFor] (in the desktop
 * app, a lifecycle-only lease on the hub's shared stream for that epoch, which asks the daemon for
 * no frames) while it is in the workspace. The daemon sends an epoch's `device_session_ended` to
 * that epoch's subscribers, so each event reaches exactly one column's stream and is dispatched
 * once. A column whose epoch ended, or that has no epoch yet, holds none; a new epoch takes a new
 * stream.
 */
@Composable
internal fun WorkspaceDeviceLifecycle(
  columns: List<DeviceColumn>,
  lifecycleStreamFor: (DeviceColumn) -> ObservationStream,
  handlers: WorkspaceDeviceLifecycleHandlers,
) {
  val latestHandlers by rememberUpdatedState(handlers)
  columns
    .filter { it.deviceSessionUuid != null && !it.sessionEnded }
    .forEach { column ->
      key(column.deviceId, column.deviceSessionUuid) {
        val stream =
          rememberReconnectingObservationStream(
            ReconnectingObservationOptions(
              deviceId = column.deviceId,
              deviceSessionUuid = column.deviceSessionUuid,
              streamFactory = { lifecycleStreamFor(column) },
            ),
          )
        LaunchedEffect(stream) {
          stream?.deviceEvents?.collect { event ->
            when {
              event is DeviceStreamEvent.DeviceSessionSuperseded &&
                event.deviceId == column.deviceId -> latestHandlers.onSuperseded(event)
              event is DeviceStreamEvent.DeviceSessionEnded && event.deviceId == column.deviceId ->
                latestHandlers.onEnded(event)
            }
          }
        }
      }
    }
}

/**
 * Holds the workspace-scope device lifecycle streams on the app's [LocalDaemonStreamHub]. Without a
 * hub (the IDE plugin) no lifecycle events are forwarded, as before.
 */
@Composable
internal fun WorkspaceHubDeviceLifecycle(state: WorkspaceUiState, options: WorkspaceShellOptions) {
  val streamHub = LocalDaemonStreamHub.current ?: return
  val content = state as? WorkspaceUiState.Content ?: return
  WorkspaceDeviceLifecycle(
    columns = content.columns,
    lifecycleStreamFor = { column ->
      streamHub.observationStream(
        DeviceStreamKey(column.deviceId, column.deviceSessionUuid),
        lifecycleOnly = true,
      )
    },
    handlers =
      WorkspaceDeviceLifecycleHandlers(
        onSuperseded = options.onDeviceSessionSuperseded,
        onEnded = options.onDeviceSessionEnded,
      ),
  )
}
