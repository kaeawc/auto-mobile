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

  // Persistent, accumulating UI state that is authoritative HERE, not on the replaceable Content.
  // load() swaps Content out for Loading and back (e.g. a Refresh while the picker is reopened mid
  // cold-boot); keeping these on Content would discard them on that swap — re-arming a device for a
  // second startDevice, or dropping selections made across earlier boots. They survive every load()
  // and are merged, pruned against the fresh device list, into every emitted Content. Loads replace
  // only the device LIST, never these.
  private var bootingIds: Set<String> = emptySet()
  private var bootErrors: Map<String, String> = emptyMap()
  private var selectedIds: Set<String> = emptySet()
  private var filters: PickerFilters = PickerFilters()

  // In-session boot attribution: source image id -> the runtime id the daemon assigned it on boot.
  // Lets the merge hide a re-keyed booted device's EXACT source image (not a positional same-named
  // guess). Pruned to devices still booted; devices booted outside this session fall back to the
  // name heuristic in buildPickerDevices.
  private var bootedImageRuntimeIds: Map<String, String> = emptyMap()

  // Monotonic load/emission generation, claimed at the start of every load()/reloadAfterBoot(). It
  // guards ONLY the stale device-LIST emission: a fetch that resumes after a newer one began does
  // not overwrite the fresher list. It never gates the persistent state above (recorded before the
  // guard), nor the rule that the newest generation ends terminal (Content or Error) — a failure is
  // never dropped into a stranded Loading.
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
      is DevicePickerAction.ClearSelection -> clearSelection()
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
        emitIfCurrent(generation, devices)
      } catch (c: CancellationException) {
        throw c // don't turn cancellation into a load error
      } catch (e: Exception) {
        LOG.warn("Failed to load picker devices: ${e.message}", e)
        resolveFetchFailure(generation, e)
      }
    }
  }

  // Resource reads hit the daemon (blocking) — keep them off the UI thread. A read that returns
  // ResourceReadResult.Error, or a Success whose payload fails to parse (malformed/truncated JSON),
  // throws rather than degrading to an empty list: a partial/garbled read must NOT reconstruct a
  // just-booted device as Shutdown (which would permit a duplicate start), and a total failure must
  // not empty the picker and prune live boot state — callers retain the prior snapshot.
  private suspend fun fetchDevices(): List<PickerDevice> =
    withContext(ioDispatcher) {
      buildPickerDevices(readBootedDevices(), readDeviceImages(), bootedImageRuntimeIds)
    }

  private suspend fun readBootedDevices(): List<BootedDeviceInfo> =
    when (val result = resourceClient.readResource(BOOTED_URI)) {
      is ResourceReadResult.Success ->
        DeviceResourceParser.parseBootedDevices(result.content)?.devices
          ?: throw IllegalStateException("Malformed booted-devices payload")
      is ResourceReadResult.Error ->
        throw IllegalStateException("Failed to read booted devices: ${result.message}")
    }

  private suspend fun readDeviceImages(): List<DeviceImageInfo> =
    when (val result = resourceClient.readResource(IMAGES_URI)) {
      is ResourceReadResult.Success ->
        DeviceResourceParser.parseDeviceImages(result.content)?.images
          ?: throw IllegalStateException("Malformed device-images payload")
      is ResourceReadResult.Error ->
        throw IllegalStateException("Failed to read device images: ${result.message}")
    }

  /**
   * Emit the reloaded device list as [DevicePickerUiState.Content] — but ONLY if [generation] is
   * still the newest. A stale success is dropped: its persistent selection/boot state was already
   * recorded and a newer emission carries it, so dropping the stale LIST cannot lose it.
   */
  private fun emitIfCurrent(generation: Long, devices: List<PickerDevice>) {
    if (generation != loadGeneration) return
    LOG.info("Picker loaded ${devices.size} devices")
    emitContent(devices)
  }

  /**
   * Resolve a failed fetch to a TERMINAL state for the newest generation so a failure is never left
   * stranded as [DevicePickerUiState.Loading]: retain the previous [DevicePickerUiState.Content]
   * snapshot (merging the updated persistent state, e.g. a boot marked failed) when one exists,
   * else a retryable [DevicePickerUiState.Error]. A stale-generation failure is dropped — the newer
   * generation will resolve terminally.
   */
  private fun resolveFetchFailure(generation: Long, error: Throwable) {
    if (generation != loadGeneration) return
    _state.value =
      when (val current = _state.value) {
        is DevicePickerUiState.Content ->
          current.copy(
            filters = filters,
            selectedIds = selectedIds,
            bootingIds = bootingIds,
            bootErrors = bootErrors,
          )
        else -> DevicePickerUiState.Error(error.message ?: "Failed to load devices")
      }
  }

  /** Rebuild Content from a device list, merging the pruned persistent state. */
  private fun emitContent(devices: List<PickerDevice>) {
    pruneState(devices)
    _state.value =
      DevicePickerUiState.Content(
        devices = devices,
        filters = filters,
        selectedIds = selectedIds,
        bootingIds = bootingIds,
        bootErrors = bootErrors,
      )
  }

  /**
   * Prune the persistent state against the live list: boot guard/error entries survive only while
   * their device is still shut down (drop once booted or gone); a selection survives only while its
   * device is still present and booted.
   */
  private fun pruneState(devices: List<PickerDevice>) {
    val shutdownIds = devices.filter { it.state == DeviceState.Shutdown }.map { it.id }.toSet()
    val bootedIds = devices.filter { it.state == DeviceState.Booted }.map { it.id }.toSet()
    bootingIds = bootingIds intersect shutdownIds
    bootErrors = bootErrors.filterKeys { it in shutdownIds }
    selectedIds = selectedIds intersect bootedIds
    // Keep only attributions whose runtime device is still booted (drop killed/replaced ids).
    bootedImageRuntimeIds = bootedImageRuntimeIds.filterValues { it in bootedIds }
  }

  /** Reflect the persistent state onto the live Content (no device reload). */
  private fun syncState() {
    updateContent {
      it.copy(
        filters = filters,
        selectedIds = selectedIds,
        bootingIds = bootingIds,
        bootErrors = bootErrors,
      )
    }
  }

  private fun bootDevice(deviceId: String) {
    // Boots are serialized: at most one in flight. A click on any shut-down card while a boot is
    // running is a no-op. This structurally removes overlapping reloads (and their generation
    // reordering hazards); the next card can boot once this one finishes. A failed boot leaves
    // bootingIds empty, so retrying (clicking the same card again) is still allowed.
    if (bootingIds.isNotEmpty()) return
    val content = _state.value as? DevicePickerUiState.Content ?: return
    val device = content.devices.firstOrNull { it.id == deviceId } ?: return
    if (device.state != DeviceState.Shutdown) return // only shut-down cards boot
    bootingIds = bootingIds + deviceId
    bootErrors = bootErrors - deviceId
    syncState()
    scope.launch {
      val result = bootController.boot(device)
      val runtimeDeviceId = result.getOrNull()
      if (runtimeDeviceId != null) {
        reloadAfterBoot(device, runtimeDeviceId)
      } else {
        val message = result.exceptionOrNull()?.message ?: "Failed to boot ${device.name}"
        bootingIds = bootingIds - deviceId
        bootErrors = bootErrors + (deviceId to message)
        syncState()
      }
    }
  }

  /**
   * Reload after a boot succeeded and auto-select the started device so Observe is usable.
   * Selection keys on [runtimeDeviceId] — the exact id the daemon assigned — never the display name
   * (ambiguous for identically-named devices). The selection is recorded in the persistent state
   * BEFORE the generation guard, so a concurrent Refresh that supersedes this reload's list
   * emission still carries the selection (boots themselves are serialized, so reloads never
   * overlap). A read failure resolves to a terminal state (retained snapshot or Error), never a
   * stranded Loading, and never fabricates a shut-down card from a partial read (see
   * [fetchDevices]).
   */
  private suspend fun reloadAfterBoot(bootedDevice: PickerDevice, runtimeDeviceId: String) {
    // Record the exact source-image -> runtime-id attribution BEFORE the reload, so this very fetch
    // hides the started device's own source image by id (not a positional same-name guess).
    bootedImageRuntimeIds = bootedImageRuntimeIds + (bootedDevice.id to runtimeDeviceId)
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
        resolveFetchFailure(generation, e)
        return
      }
    val nowBooted = devices.any { it.id == runtimeDeviceId && it.state == DeviceState.Booted }
    bootingIds = bootingIds - bootedDevice.id
    if (nowBooted) {
      selectedIds = selectedIds + runtimeDeviceId // recorded before the guard — never lost
      bootErrors = bootErrors - bootedDevice.id
    } else {
      bootErrors = bootErrors + (bootedDevice.id to "Boot did not complete")
    }
    // Persistent state (esp. the selection) is reflected onto the CURRENT Content unconditionally,
    // so it never diverges from what observeSelected() reads — even when this reload's device-LIST
    // emission is dropped as stale below. Selection is persistent state, not tied to which list
    // wins.
    syncState()
    emitIfCurrent(generation, devices)
  }

  private fun toggleSelect(deviceId: String) {
    val content = _state.value as? DevicePickerUiState.Content ?: return
    // Booted-only: ignore selection of non-booted devices.
    val device = content.devices.firstOrNull { it.id == deviceId } ?: return
    if (device.state != DeviceState.Booted) return
    selectedIds = selectedIds.toggle(deviceId)
    syncState()
  }

  private fun clearSelection() {
    selectedIds = emptySet()
    syncState()
  }

  private fun observeSelected() {
    val content = _state.value as? DevicePickerUiState.Content ?: return
    val columns =
      content.devices
        .filter { it.id in selectedIds && it.state == DeviceState.Booted }
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
    filters = transform(filters)
    syncState()
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
