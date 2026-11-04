package dev.jasonpearson.automobile.desktop.core.workspace

import androidx.compose.runtime.staticCompositionLocalOf
import dev.jasonpearson.automobile.desktop.core.daemon.DeviceStreamEvent

/**
 * Forwards a `device_session_ended` replacement as [WorkspaceAction.EndDeviceSession], only while
 * the workspace still observes the retired epoch.
 */
class DeviceSessionSupersededForwarder(
  private val columns: () -> List<DeviceColumn>,
  private val dispatch: (WorkspaceAction) -> Unit,
) {
  fun onSuperseded(event: DeviceStreamEvent.DeviceSessionSuperseded) {
    val column = columns().firstOrNull { it.deviceId == event.deviceId } ?: return
    if (column.deviceSessionUuid != event.retiredUuid) return
    dispatch(
      WorkspaceAction.EndDeviceSession(
        deviceId = event.deviceId,
        retiredUuid = event.retiredUuid,
        successorUuid = event.successorUuid,
      ),
    )
  }
}

val LocalDeviceSessionSupersededHandler =
  staticCompositionLocalOf<(DeviceStreamEvent.DeviceSessionSuperseded) -> Unit> { {} }
