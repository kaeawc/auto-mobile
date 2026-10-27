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
          else column.copy(deviceSessionUuid = refreshed)
        },
    )
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
