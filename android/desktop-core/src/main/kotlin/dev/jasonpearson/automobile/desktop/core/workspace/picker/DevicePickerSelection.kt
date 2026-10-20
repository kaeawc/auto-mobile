package dev.jasonpearson.automobile.desktop.core.workspace.picker

import dev.jasonpearson.automobile.desktop.core.workspace.DeviceColumn
import dev.jasonpearson.automobile.desktop.core.workspace.Platform
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

internal fun DevicePickerViewModel.toggleSelect(selector: String) {
  val content = _state.value as? DevicePickerUiState.Content ?: return
  // Booted-only: ignore selection of non-booted devices.
  val device =
    content.devices.singleOrNull { it.uiKey == selector }
      ?: content.devices.singleOrNull { it.id == selector }
      ?: return
  val deviceId = device.uiKey
  if (device.state != DeviceState.Booted) return
  selectedIds = selectedIds.toggle(deviceId)
  device.deviceSessionUuid?.let { trackedEpochs = trackedEpochs + (deviceId to it) }
  syncState()
}

internal fun DevicePickerViewModel.clearSelection() {
  selectedIds = emptySet()
  syncState()
}

internal fun DevicePickerViewModel.observeSelected() {
  val content = _state.value as? DevicePickerUiState.Content ?: return
  val columns =
    content.devices
      .filter { it.uiKey in selectedIds && it.state == DeviceState.Booted }
      .map(::columnOf)
  if (columns.isNotEmpty()) {
    // Observed devices leave the selection: otherwise reopening the grid shows them still
    // selected as a stale "Observe (N)" (#5220). Selection is a transient staging area for the
    // multi-select gesture, not a record of what's observed.
    selectedIds =
      selectedIds - columns.map { "${it.platform.name.lowercase()}:${it.deviceId}" }.toSet()
    syncState()
    scope.launch { _effect.send(DevicePickerEffect.Observe(columns)) }
  }
}

internal fun DevicePickerViewModel.observeDevice(selector: String) {
  val content = _state.value as? DevicePickerUiState.Content ?: return
  val device =
    content.devices.singleOrNull { it.uiKey == selector }
      ?: content.devices.singleOrNull { it.id == selector }
      ?: return
  val deviceId = device.uiKey
  if (device.state != DeviceState.Booted) return
  // A plain click doesn't select, but a modifier-selected device can also be plain-clicked; clear
  // it either way so an observed device never lingers selected (#5220).
  selectedIds = selectedIds - deviceId
  syncState()
  scope.launch { _effect.send(DevicePickerEffect.Observe(listOf(columnOf(device)))) }
}

internal fun DevicePickerViewModel.columnOf(device: PickerDevice): DeviceColumn =
  // Seed the pane's lock state from the booted snapshot; the host's poll keeps it fresh.
  DeviceColumn(
    deviceId = device.id,
    name = device.name,
    platform = device.platform,
    locked = device.locked,
    isVirtual = device.isVirtual,
    deviceSessionUuid = device.deviceSessionUuid,
  )

internal fun DevicePickerViewModel.clearFilter(dimension: FilterDimension) {
  updateFilters {
    when (dimension) {
      FilterDimension.State -> it.copy(states = emptySet())
      FilterDimension.Platform -> it.copy(platforms = emptySet(), osKeys = emptySet())
      FilterDimension.OsVersion -> it.copy(osKeys = emptySet())
      FilterDimension.Architecture -> it.copy(architectures = emptySet())
      FilterDimension.FormFactor -> it.copy(formFactors = emptySet())
    }
  }
}

internal fun DevicePickerViewModel.updateFilters(transform: (PickerFilters) -> PickerFilters) {
  filters = transform(filters)
  syncState()
}

internal fun DevicePickerViewModel.updateContent(
  transform: (DevicePickerUiState.Content) -> DevicePickerUiState.Content,
) {
  _state.update { current ->
    (current as? DevicePickerUiState.Content)?.let(transform) ?: current
  }
}

internal fun DevicePickerViewModel.syncState() {
  updateContent {
    it.copy(
      filters = filters,
      selectedIds = selectedIds,
      bootingIds = bootingIds,
      bootErrors = bootErrors,
      finishingPreviousSessionIds = finishingPreviousSessionIds,
    )
  }
}
