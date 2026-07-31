package dev.jasonpearson.automobile.desktop.core.workspace.picker

import dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory
import dev.jasonpearson.automobile.desktop.core.mcp.DeviceResourceParser
import dev.jasonpearson.automobile.desktop.core.mcp.McpResourceClient
import dev.jasonpearson.automobile.desktop.core.mcp.ResourceReadResult
import dev.jasonpearson.automobile.desktop.core.workspace.DeviceColumn
import dev.jasonpearson.automobile.desktop.core.workspace.Platform
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

private val LOG = LoggerFactory.getLogger("DevicePickerViewModel")
private const val BOOTED_URI = "automobile:devices/booted"
private const val IMAGES_URI = "automobile:devices/images"

sealed interface DevicePickerUiState {
  data object Loading : DevicePickerUiState

  data class Content(
    val devices: List<PickerDevice>,
    val filters: PickerFilters = PickerFilters(),
    val selectedIds: Set<String> = emptySet(),
    /**
     * Ids of devices whose boot is currently in flight (UI-only transient, not a [DeviceState]).
     */
    val bootingIds: Set<String> = emptySet(),
    /** Per-device boot failure message; presence marks a card as retryable. */
    val bootErrors: Map<String, String> = emptyMap(),
  ) : DevicePickerUiState

  data class Error(val message: String) : DevicePickerUiState
}

sealed interface DevicePickerAction {
  data class ToggleState(val state: DeviceState) : DevicePickerAction

  data class TogglePlatform(val platform: Platform) : DevicePickerAction

  data class ToggleOs(val osKey: String) : DevicePickerAction

  data class ToggleArch(val arch: String) : DevicePickerAction

  data class SetQuery(val query: String) : DevicePickerAction

  data class ClearFilter(val dimension: FilterDimension) : DevicePickerAction

  data class ToggleSelect(val deviceId: String) : DevicePickerAction

  /** Boot a shut-down device (its card was clicked). Ignored for already-booted/booting devices. */
  data class BootDevice(val deviceId: String) : DevicePickerAction

  data object ClearSelection : DevicePickerAction

  data object ObserveSelected : DevicePickerAction

  data object Refresh : DevicePickerAction
}

sealed interface DevicePickerEffect {
  /** Observe the selected (booted) devices — the workspace turns these into columns. */
  data class Observe(val columns: List<DeviceColumn>) : DevicePickerEffect
}

/**
 * ViewModel for the device picker. Reads the booted-devices + device-images MCP resources through
 * the shared [McpResourceClient], unifies them into [PickerDevice]s, and owns the filter/selection
 * state. Only **booted** devices can be observed (a non-booted selection is ignored).
 */
class DevicePickerViewModel(
  private val resourceClient: McpResourceClient,
  private val bootController: DeviceBootController,
  private val scope: CoroutineScope,
  private val ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
) {
  private val _state = MutableStateFlow<DevicePickerUiState>(DevicePickerUiState.Loading)
  val state: StateFlow<DevicePickerUiState> = _state.asStateFlow()

  private val _effect = Channel<DevicePickerEffect>(Channel.BUFFERED)
  val effect = _effect.receiveAsFlow()

  init {
    load()
  }

  fun onAction(action: DevicePickerAction) {
    when (action) {
      is DevicePickerAction.ToggleState ->
        updateFilters { it.copy(states = it.states.toggle(action.state)) }
      is DevicePickerAction.TogglePlatform ->
        updateFilters { it.copy(platforms = it.platforms.toggle(action.platform)) }
      is DevicePickerAction.ToggleOs ->
        updateFilters { it.copy(osKeys = it.osKeys.toggle(action.osKey)) }
      is DevicePickerAction.ToggleArch ->
        updateFilters { it.copy(architectures = it.architectures.toggle(action.arch)) }
      is DevicePickerAction.SetQuery -> updateFilters { it.copy(query = action.query) }
      is DevicePickerAction.ClearFilter -> clearFilter(action.dimension)
      is DevicePickerAction.ToggleSelect -> toggleSelect(action.deviceId)
      is DevicePickerAction.BootDevice -> bootDevice(action.deviceId)
      is DevicePickerAction.ClearSelection -> updateContent { it.copy(selectedIds = emptySet()) }
      is DevicePickerAction.ObserveSelected -> observeSelected()
      is DevicePickerAction.Refresh -> load()
    }
  }

  private fun load() {
    _state.value = DevicePickerUiState.Loading
    scope.launch {
      try {
        val devices = fetchDevices()
        LOG.info("Picker loaded ${devices.size} devices")
        _state.value = DevicePickerUiState.Content(devices)
      } catch (e: Exception) {
        LOG.warn("Failed to load picker devices: ${e.message}", e)
        _state.value = DevicePickerUiState.Error(e.message ?: "Failed to load devices")
      }
    }
  }

  // Resource reads hit the daemon (blocking) — keep them off the UI thread.
  private suspend fun fetchDevices(): List<PickerDevice> =
    withContext(ioDispatcher) {
      val booted =
        (resourceClient.readResource(BOOTED_URI) as? ResourceReadResult.Success)?.let {
          DeviceResourceParser.parseBootedDevices(it.content)?.devices
        } ?: emptyList()
      val images =
        (resourceClient.readResource(IMAGES_URI) as? ResourceReadResult.Success)?.let {
          DeviceResourceParser.parseDeviceImages(it.content)?.images
        } ?: emptyList()
      buildPickerDevices(booted, images)
    }

  private fun bootDevice(deviceId: String) {
    val content = _state.value as? DevicePickerUiState.Content ?: return
    if (deviceId in content.bootingIds) return // already booting — no double-boot
    val device = content.devices.firstOrNull { it.id == deviceId } ?: return
    if (device.state != DeviceState.Shutdown) return // only shut-down cards boot
    updateContent {
      it.copy(bootingIds = it.bootingIds + deviceId, bootErrors = it.bootErrors - deviceId)
    }
    scope.launch {
      val result = bootController.boot(device)
      if (result.isSuccess) {
        reloadAfterBoot(device)
      } else {
        val message = result.exceptionOrNull()?.message ?: "Failed to boot ${device.name}"
        updateContent {
          it.copy(
            bootingIds = it.bootingIds - deviceId,
            bootErrors = it.bootErrors + (deviceId to message),
          )
        }
      }
    }
  }

  /**
   * Reload after a boot succeeded and auto-select the now-booted device so Observe is usable. A
   * booted device is re-keyed by the daemon (its id becomes a runtime serial), so it is matched
   * back by name, not by the shut-down id.
   */
  private suspend fun reloadAfterBoot(bootedDevice: PickerDevice) {
    val devices =
      try {
        fetchDevices()
      } catch (e: Exception) {
        LOG.warn("Reload after boot failed for ${bootedDevice.name}: ${e.message}", e)
        updateContent {
          it.copy(
            bootingIds = it.bootingIds - bootedDevice.id,
            bootErrors =
              it.bootErrors + (bootedDevice.id to (e.message ?: "Reload after boot failed")),
          )
        }
        return
      }
    val nowBooted = devices.firstOrNull {
      it.name == bootedDevice.name && it.state == DeviceState.Booted
    }
    updateContent { content ->
      content.copy(
        devices = devices,
        bootingIds = prunedBootingIds(content.bootingIds - bootedDevice.id, devices),
        selectedIds =
          if (nowBooted != null) content.selectedIds + nowBooted.id else content.selectedIds,
        bootErrors =
          if (nowBooted != null) content.bootErrors - bootedDevice.id
          else content.bootErrors + (bootedDevice.id to "Boot did not complete"),
      )
    }
  }

  private fun toggleSelect(deviceId: String) {
    updateContent { content ->
      // Booted-only: ignore selection of non-booted devices.
      val device = content.devices.firstOrNull { it.id == deviceId } ?: return@updateContent content
      if (device.state != DeviceState.Booted) return@updateContent content
      content.copy(selectedIds = content.selectedIds.toggle(deviceId))
    }
  }

  private fun observeSelected() {
    val content = _state.value as? DevicePickerUiState.Content ?: return
    val columns =
      content.devices
        .filter { it.id in content.selectedIds && it.state == DeviceState.Booted }
        .map { DeviceColumn(deviceId = it.id, name = it.name, platform = it.platform) }
    if (columns.isNotEmpty()) {
      scope.launch { _effect.send(DevicePickerEffect.Observe(columns)) }
    }
  }

  private fun clearFilter(dimension: FilterDimension) {
    updateFilters {
      when (dimension) {
        FilterDimension.State -> it.copy(states = emptySet())
        FilterDimension.Platform -> it.copy(platforms = emptySet(), osKeys = emptySet())
        FilterDimension.OsVersion -> it.copy(osKeys = emptySet())
        FilterDimension.Architecture -> it.copy(architectures = emptySet())
      }
    }
  }

  private fun updateFilters(transform: (PickerFilters) -> PickerFilters) {
    updateContent { it.copy(filters = transform(it.filters)) }
  }

  private fun updateContent(
    transform: (DevicePickerUiState.Content) -> DevicePickerUiState.Content
  ) {
    _state.update { current ->
      (current as? DevicePickerUiState.Content)?.let(transform) ?: current
    }
  }
}

private fun <T> Set<T>.toggle(value: T): Set<T> = if (value in this) this - value else this + value

/** Drop any in-flight boot ids that a reload now reports as booted. */
private fun prunedBootingIds(bootingIds: Set<String>, devices: List<PickerDevice>): Set<String> {
  val bootedIds = devices.filter { it.state == DeviceState.Booted }.map { it.id }.toSet()
  return bootingIds - bootedIds
}
