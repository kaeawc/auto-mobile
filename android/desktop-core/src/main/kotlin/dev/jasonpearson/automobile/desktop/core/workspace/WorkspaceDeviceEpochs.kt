package dev.jasonpearson.automobile.desktop.core.workspace

import kotlinx.coroutines.flow.update

/** Actions that reflect what the device or daemon reported, rather than a user's choice. */
internal fun WorkspaceViewModel.applyDeviceState(action: WorkspaceAction) {
  when (action) {
    is WorkspaceAction.SetLockStates -> setLockStates(action.locked)
    is WorkspaceAction.RefreshDeviceSessionUuids -> refreshDeviceSessionUuids(action.sessionUuids)
    is WorkspaceAction.EndDeviceSession -> endDeviceSession(action)
    else -> Unit
  }
}

/** Replace the column observing [action]'s retired epoch with a fresh column for its successor. */
internal fun WorkspaceViewModel.endDeviceSession(action: WorkspaceAction.EndDeviceSession) {
  val existing = columnFor(action.deviceId) ?: return
  if (existing.deviceSessionUuid != action.retiredUuid) return
  val successor =
    DeviceColumn(
      deviceId = existing.deviceId,
      name = existing.name,
      platform = existing.platform,
      isVirtual = existing.isVirtual,
      deviceSessionUuid = action.successorUuid,
    )
  replaceEpoch(existing, existing.nextEpoch(successor))
}

/**
 * Swap [retired]'s column for [next] (a new epoch of the same device) and drop the retired epoch's
 * per-device caches: the navigation screenshot loader and any locale request still in flight.
 */
internal fun WorkspaceViewModel.replaceEpoch(retired: DeviceColumn, next: DeviceColumn) {
  screenshotLoaderRegistry.forget(retired.deviceId)
  localeJobs.remove(retired.deviceId)?.cancel()
  _state.update { current ->
    val content = current as? WorkspaceUiState.Content ?: return@update current
    content.copy(
      columns =
        content.columns.map {
          if (it.deviceId == retired.deviceId && it.deviceSessionUuid == retired.deviceSessionUuid)
            next
          else it
        },
    )
  }
}
