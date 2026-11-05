package dev.jasonpearson.automobile.desktop.core.workspace

import dev.jasonpearson.automobile.desktop.core.daemon.DeviceStreamEvent

/** Forwards a replacement epoch only while the workspace still observes the retired epoch. */
class DeviceSessionSupersededForwarder(
  private val columns: () -> List<DeviceColumn>,
  private val dispatch: (WorkspaceAction) -> Unit,
) {
  fun onSuperseded(event: DeviceStreamEvent.DeviceSessionSuperseded) {
    val column = columns().firstOrNull { it.deviceId == event.deviceId } ?: return
    if (column.deviceSessionUuid != event.retiredUuid) return
    dispatch(
      WorkspaceAction.RefreshDeviceSessionUuids(mapOf(event.deviceId to event.successorUuid)),
    )
  }

  /** Forwards a no-successor end only while the workspace still observes the retired epoch. */
  fun onEnded(event: DeviceStreamEvent.DeviceSessionEnded) {
    val column = columns().firstOrNull { it.deviceId == event.deviceId } ?: return
    if (column.deviceSessionUuid != event.retiredUuid) return
    dispatch(WorkspaceAction.EndDeviceSession(event.deviceId, event.retiredUuid))
  }
}
