package dev.jasonpearson.automobile.desktop.core.workspace

import kotlinx.coroutines.flow.update

internal fun WorkspaceViewModel.setLockStates(locked: Map<String, Boolean>) {
  if (locked.isEmpty()) return
  _state.update { current ->
    val content = current as? WorkspaceUiState.Content ?: return@update current
    content.copy(
      columns =
        content.columns.map { column ->
          val next = locked[column.deviceId] ?: return@map column
          if (next == column.locked) column else column.copy(locked = next)
        },
    )
  }
}

internal fun WorkspaceViewModel.refreshDeviceSessionUuids(sessionUuids: Map<String, String>) {
  if (sessionUuids.isEmpty()) return
  _state.update { current ->
    val content = current as? WorkspaceUiState.Content ?: return@update current
    content.copy(
      columns =
        content.columns.map { column ->
          val refreshed = sessionUuids[column.deviceId] ?: return@map column
          if (refreshed == column.deviceSessionUuid) column
          else column.copy(deviceSessionUuid = refreshed, sessionEnded = false)
        },
    )
  }
}

/** Apply a device-epoch change: a refreshed epoch or one that ended with no successor. */
internal fun WorkspaceViewModel.applyEpochAction(action: WorkspaceAction) {
  when (action) {
    is WorkspaceAction.RefreshDeviceSessionUuids -> refreshDeviceSessionUuids(action.sessionUuids)
    is WorkspaceAction.EndDeviceSession -> endDeviceSession(action.deviceId, action.retiredUuid)
    else -> Unit
  }
}

/**
 * Mark [deviceId]'s column ended when it still observes [retiredUuid]: drop its epoch so no
 * UUID-scoped stream can re-attach to it. The pane then renders its disconnected state, which
 * disposes its stream and facets. The column stays open so the user sees why the device went away.
 */
internal fun WorkspaceViewModel.endDeviceSession(deviceId: String, retiredUuid: String) {
  mutate(deviceId) { column ->
    if (column.deviceSessionUuid != retiredUuid) column
    else column.copy(deviceSessionUuid = null, sessionEnded = true)
  }
}

internal fun WorkspaceViewModel.diffTool(tool: Tool) {
  _state.update { current ->
    val content = current as? WorkspaceUiState.Content ?: return@update current
    content.copy(columns = content.columns.map { it.copy(activeTool = tool) })
  }
}

internal fun WorkspaceViewModel.focus(deviceId: String) {
  _state.update { current ->
    (current as? WorkspaceUiState.Content)?.copy(focusedDeviceId = deviceId) ?: current
  }
}

internal fun WorkspaceViewModel.mutate(
  deviceId: String,
  transform: (DeviceColumn) -> DeviceColumn,
) {
  _state.update { current ->
    val content = current as? WorkspaceUiState.Content ?: return@update current
    content.copy(
      columns = content.columns.map { if (it.deviceId == deviceId) transform(it) else it },
    )
  }
}
