package dev.jasonpearson.automobile.desktop.core.workspace.picker

import dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory
import dev.jasonpearson.automobile.desktop.core.mcp.BootedDeviceInfo
import dev.jasonpearson.automobile.desktop.core.mcp.DeviceImageInfo
import dev.jasonpearson.automobile.desktop.core.mcp.DeviceResourceParser
import dev.jasonpearson.automobile.desktop.core.mcp.McpResourceClient
import dev.jasonpearson.automobile.desktop.core.mcp.ResourceReadResult
import dev.jasonpearson.automobile.desktop.core.workspace.DeviceColumn
import dev.jasonpearson.automobile.desktop.core.workspace.Platform
import kotlinx.coroutines.CancellationException
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

  // Active-boot state is authoritative here, NOT on the replaceable Content. load() swaps Content
  // out for Loading and back (e.g. a Refresh while the picker is reopened mid cold-boot); keeping
  // the guard on Content would discard it on that swap — re-arming a device for a second
  // startDevice and losing a completion that resolves while Loading. These fields survive load()
  // and are merged (pruned against the fresh device list) into every emitted Content.
  private var bootingIds: Set<String> = emptySet()
  private var bootErrors: Map<String, String> = emptyMap()

  // Monotonic load/emission generation. Every load() and reloadAfterBoot() claims the next value at
  // its start; an in-flight load that resumes after a newer one has begun drops its emission rather
  // than clobbering fresher post-boot state (a stale Refresh restoring the shut-down card and
  // dropping the just-booted selection).
  private var loadGeneration: Long = 0

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
    val generation = ++loadGeneration
    _state.value = DevicePickerUiState.Loading
    scope.launch {
      try {
        val devices = fetchDevices()
        if (generation != loadGeneration) return@launch // superseded by a newer load/reload
        LOG.info("Picker loaded ${devices.size} devices")
        emitContent(devices)
      } catch (c: CancellationException) {
        throw c // don't turn cancellation into a load error
      } catch (e: Exception) {
        LOG.warn("Failed to load picker devices: ${e.message}", e)
        if (generation == loadGeneration) {
          _state.value = DevicePickerUiState.Error(e.message ?: "Failed to load devices")
        }
      }
    }
  }

  // Resource reads hit the daemon (blocking) — keep them off the UI thread. A read that returns
  // ResourceReadResult.Error throws rather than degrading to an empty list: a partial read (booted
  // fails, images succeed) must NOT reconstruct a just-booted device as Shutdown, and a total
  // failure must not empty the picker and prune live boot state — callers retain the prior
  // snapshot.
  private suspend fun fetchDevices(): List<PickerDevice> =
    withContext(ioDispatcher) { buildPickerDevices(readBootedDevices(), readDeviceImages()) }

  private suspend fun readBootedDevices(): List<BootedDeviceInfo> =
    when (val result = resourceClient.readResource(BOOTED_URI)) {
      is ResourceReadResult.Success ->
        DeviceResourceParser.parseBootedDevices(result.content)?.devices ?: emptyList()
      is ResourceReadResult.Error ->
        throw IllegalStateException("Failed to read booted devices: ${result.message}")
    }

  private suspend fun readDeviceImages(): List<DeviceImageInfo> =
    when (val result = resourceClient.readResource(IMAGES_URI)) {
      is ResourceReadResult.Success ->
        DeviceResourceParser.parseDeviceImages(result.content)?.images ?: emptyList()
      is ResourceReadResult.Error ->
        throw IllegalStateException("Failed to read device images: ${result.message}")
    }

  /**
   * Emit a fresh [DevicePickerUiState.Content] from a reloaded device list, preserving the prior
   * filters/selection and merging the ViewModel-level boot guard — pruned against the new list so
   * ids that are now booted or gone are dropped. This is the single place Content is rebuilt, so a
   * mid-boot reload never drops the "Booting…"/error guard.
   */
  private fun emitContent(devices: List<PickerDevice>) {
    pruneBootState(devices)
    val bootedIds = devices.filter { it.state == DeviceState.Booted }.map { it.id }.toSet()
    _state.update { current ->
      val prev = current as? DevicePickerUiState.Content
      DevicePickerUiState.Content(
        devices = devices,
        filters = prev?.filters ?: PickerFilters(),
        selectedIds = (prev?.selectedIds ?: emptySet()) intersect bootedIds,
        bootingIds = bootingIds,
        bootErrors = bootErrors,
      )
    }
  }

  /** Drop boot guard/error entries for devices that are no longer shut down (booted or gone). */
  private fun pruneBootState(devices: List<PickerDevice>) {
    val shutdownIds = devices.filter { it.state == DeviceState.Shutdown }.map { it.id }.toSet()
    bootingIds = bootingIds intersect shutdownIds
    bootErrors = bootErrors.filterKeys { it in shutdownIds }
  }

  /** Reflect the current boot fields onto the live Content (no device reload). */
  private fun syncBootState() {
    updateContent { it.copy(bootingIds = bootingIds, bootErrors = bootErrors) }
  }

  private fun bootDevice(deviceId: String) {
    if (deviceId in bootingIds) return // already booting — no double-boot
    val content = _state.value as? DevicePickerUiState.Content ?: return
    val device = content.devices.firstOrNull { it.id == deviceId } ?: return
    if (device.state != DeviceState.Shutdown) return // only shut-down cards boot
    bootingIds = bootingIds + deviceId
    bootErrors = bootErrors - deviceId
    syncBootState()
    scope.launch {
      val result = bootController.boot(device)
      val runtimeDeviceId = result.getOrNull()
      if (runtimeDeviceId != null) {
        reloadAfterBoot(device, runtimeDeviceId)
      } else {
        val message = result.exceptionOrNull()?.message ?: "Failed to boot ${device.name}"
        bootingIds = bootingIds - deviceId
        bootErrors = bootErrors + (deviceId to message)
        syncBootState()
      }
    }
  }

  /**
   * Reload after a boot succeeded and auto-select the started device so Observe is usable. The
   * device is selected by [runtimeDeviceId] — the exact id the daemon assigned it — never by
   * display name, which is ambiguous when two identically-named devices boot concurrently. A read
   * failure retains the prior snapshot (see [fetchDevices]) rather than fabricating a shut-down
   * card.
   */
  private suspend fun reloadAfterBoot(bootedDevice: PickerDevice, runtimeDeviceId: String) {
    val generation = ++loadGeneration
    val devices =
      try {
        fetchDevices()
      } catch (c: CancellationException) {
        throw c // don't turn cancellation into a boot failure
      } catch (e: Exception) {
        LOG.warn("Reload after boot failed for ${bootedDevice.name}: ${e.message}", e)
        bootingIds = bootingIds - bootedDevice.id
        bootErrors = bootErrors + (bootedDevice.id to (e.message ?: "Reload after boot failed"))
        syncBootState()
        return
      }
    val nowBooted = devices.firstOrNull {
      it.id == runtimeDeviceId && it.state == DeviceState.Booted
    }
    bootingIds = bootingIds - bootedDevice.id
    bootErrors =
      if (nowBooted != null) bootErrors - bootedDevice.id
      else bootErrors + (bootedDevice.id to "Boot did not complete")
    if (generation != loadGeneration) return // a newer load/reload will emit fresher state
    emitContent(devices)
    if (nowBooted != null) {
      updateContent { it.copy(selectedIds = it.selectedIds + runtimeDeviceId) }
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
