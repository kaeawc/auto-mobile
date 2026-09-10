package dev.jasonpearson.automobile.desktop.core.workspace.picker

import dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory
import dev.jasonpearson.automobile.desktop.core.mcp.BootedDevicesResponse
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

private fun discoverySource(platform: Platform, isVirtual: Boolean): String =
  when {
    platform == Platform.Android -> "android"
    isVirtual -> "ios-simulator"
    else -> "ios-physical"
  }

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
    /** Last discovery failed: these rows are the previous snapshot, not shutdown evidence. */
    val inventoryError: String? = null,
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

  /**
   * Observe a single already-booted device immediately (a plain click on its card). Emits the
   * Observe effect for just that device; ignored for non-booted devices.
   */
  data class ObserveOne(val deviceId: String) : DevicePickerAction

  /** Boot a shut-down device (its card was clicked). Ignored for already-booted/booting devices. */
  data class BootDevice(val deviceId: String) : DevicePickerAction

  data object ClearSelection : DevicePickerAction

  data object ObserveSelected : DevicePickerAction

  data object Refresh : DevicePickerAction

  /**
   * Reload the device list WITHOUT flashing the Loading state — for a background poll while the
   * grid stays open, so a poll doesn't blank the grid to "Loading…" every interval. The current
   * content stays on screen and is replaced only when the fresh list resolves.
   */
  data object SilentRefresh : DevicePickerAction
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
  private var bootedImageRuntimeIds: Map<Platform, Map<String, String>> = emptyMap()

  // Source ids whose boot coroutine is still running (bootController.boot has not returned). The
  // serialization guard in bootingIds must survive against THIS set, not only the live device list:
  // once the daemon exposes the started device under its runtime serial but before boot() returns,
  // a concurrent Refresh's buildPickerDevices hides the source image by name, so it is neither
  // Shutdown nor Booted in the list and pruneState would otherwise drop the guard and permit a
  // second startDevice (#4881).
  private var inFlightBootIds: Set<String> = emptySet()

  // Monotonic load/emission generation, claimed at the start of every load()/reloadAfterBoot(). It
  // guards ONLY the stale device-LIST emission: a fetch that resumes after a newer one began does
  // not overwrite the fresher list. It never gates the persistent state above (recorded before the
  // guard), nor the rule that the newest generation ends terminal (Content or Error) — a failure is
  // never dropped into a stranded Loading.
  private var loadGeneration: Long = 0
  private var lastInventory: List<PickerDevice> = emptyList()

  // Count of load() coroutines currently in flight — ALL of them, not just the newest: overlapping
  // explicit Refreshes are not cancelled, so a newer one can finish while an older read is still
  // blocked. A background SilentRefresh coalesces while any load remains active, instead of
  // stacking
  // a fresh generation on top. Decremented in each load's finally.
  private var activeLoads: Int = 0

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
      is DevicePickerAction.ObserveOne -> observeDevice(action.deviceId)
      is DevicePickerAction.BootDevice -> bootDevice(action.deviceId)
      is DevicePickerAction.ClearSelection -> clearSelection()
      is DevicePickerAction.ObserveSelected -> observeSelected()
      is DevicePickerAction.Refresh -> load()
      is DevicePickerAction.SilentRefresh -> load(silent = true)
    }
  }

  private fun load(silent: Boolean = false) {
    // Coalesce background polls: while a load — or a boot's reload — is already in flight, a silent
    // refresh is a no-op, because the running read already produces fresh data. Without this, a
    // fixed-rate 5s poll slower than the daemon reads would stack up generations, each
    // SilentRefresh
    // invalidating the previous in-flight read (emitIfCurrent accepts only the newest generation),
    // leaving the grid stale or stuck Loading while reads accumulate. Effectively this serializes
    // polls to at most one read at a time. An explicit Refresh is never coalesced — it supersedes.
    if (silent && (activeLoads > 0 || bootingIds.isNotEmpty())) return
    val generation = ++loadGeneration
    // A silent (background-poll) reload keeps the current Content on screen and swaps the list in
    // on
    // success, so the grid doesn't blank to "Loading…" every poll interval; an explicit refresh
    // (Retry / open) still shows Loading. A first load (state not yet Content) always shows
    // Loading.
    if (!silent || _state.value !is DevicePickerUiState.Content) {
      _state.value = DevicePickerUiState.Loading
    }
    activeLoads++
    scope.launch {
      try {
        val devices = fetchDevices()
        emitIfCurrent(generation, devices)
      } catch (c: CancellationException) {
        throw c // don't turn cancellation into a load error
      } catch (e: Exception) {
        LOG.warn("Failed to load picker devices: ${e.message}", e)
        resolveFetchFailure(generation, e)
      } finally {
        activeLoads--
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
      val observation = readBootedDevices()
      val booted = observation.devices
      val completeSources =
        mapOf(
            "android" to Platform.Android,
            "ios-simulator" to Platform.Ios,
            "ios-physical" to Platform.Ios,
          )
          .filter { (source, platform) ->
            observation.sourceObservations[source]?.observationComplete
              ?: observation.platformObservations[platform.name.lowercase()]?.observationComplete
              ?: observation.observationComplete
          }
          .keys
      // Simulator definitions depend only on simctl, not the independent devicectl sweep.
      // Older daemons fall back to their platform-level completeness contract.
      val images =
        readDeviceImages().filter {
          discoverySource(platformOf(it.platform), isVirtual = true) in completeSources
        }
      // Separate resource reads can straddle a boot. Absence from the earlier booted snapshot
      // cannot turn an image explicitly observed as Booting/Booted into a bootable Shutdown row.
      check(
        images.none { image ->
          image.platform.equals("ios", ignoreCase = true) &&
            image.state != null &&
            !image.state.equals("Shutdown", ignoreCase = true) &&
            booted.none {
              it.platform.equals(image.platform, ignoreCase = true) && it.deviceId == image.deviceId
            }
        }
      ) {
        "Device inventory changed during discovery; refresh to get its current state"
      }
      val devices =
        Platform.entries
          .flatMap { platform ->
            buildPickerDevices(
              booted.filter { platformOf(it.platform) == platform },
              images.filter { platformOf(it.platform) == platform },
              bootedImageRuntimeIds[platform].orEmpty(),
            )
          }
          .map {
            it.copy(
              inventoryUncertain = discoverySource(it.platform, it.isVirtual) !in completeSources
            )
          }
      // A runtime whose AVD name probe failed may be one of these saved images. Neither
      // row order nor an unknown name proves which image is shut down; preserve the previous
      // snapshot until discovery resolves the identity or a successful boot supplies attribution.
      check(
        devices.none { it.platform == Platform.Android && it.state == DeviceState.Shutdown } ||
          booted.none {
            it.platform.equals("android", ignoreCase = true) &&
              it.isVirtual &&
              it.knownSourceImageId() == null &&
              (it.name == it.deviceId || it.name == "Unknown (${it.deviceId})") &&
              it.deviceId !in bootedImageRuntimeIds[Platform.Android].orEmpty().values
          }
      ) {
        "Android emulator identity is unavailable; refresh after its AVD name can be discovered"
      }
      val present = devices.map { it.platform to it.id }.toSet()
      val sourceIds =
        booted
          .mapNotNull { device ->
            device.knownSourceImageId()?.let { platformOf(device.platform) to it }
          }
          .toSet()
      val retained =
        lastInventory
          .filter {
            discoverySource(it.platform, it.isVirtual) !in completeSources &&
              (it.platform to it.id) !in present &&
              (it.platform to it.id) !in sourceIds
          }
          .map { it.copy(inventoryUncertain = true) }
      check(devices.isNotEmpty() || retained.isNotEmpty() || completeSources.isNotEmpty()) {
        "Device discovery is incomplete; no authoritative inventory is available"
      }
      devices + retained
    }

  private suspend fun readBootedDevices(): BootedDevicesResponse =
    when (val result = resourceClient.readResource(BOOTED_URI)) {
      is ResourceReadResult.Success ->
        (DeviceResourceParser.parseBootedDevices(result.content)
            ?: throw IllegalStateException("Malformed booted-devices payload"))
          .also {
            check(
              it.observationComplete ||
                it.platformObservations.isNotEmpty() ||
                it.sourceObservations.isNotEmpty()
            ) {
              "Device discovery is incomplete; retaining the previous inventory"
            }
          }
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
    lastInventory = devices
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
            devices = current.devices.map { it.copy(inventoryUncertain = true) },
            filters = filters,
            selectedIds = selectedIds,
            bootingIds = bootingIds,
            bootErrors = bootErrors,
            inventoryError = error.message ?: "Device discovery is unavailable",
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
        inventoryError =
          if (devices.any { it.inventoryUncertain })
            "Some device discovery is incomplete; retained devices cannot be booted"
          else null,
      )
  }

  /**
   * Prune the persistent state against the live list: boot guard/error entries survive only while
   * their device is still shut down (drop once booted or gone); a selection survives only while its
   * device is still present and booted.
   */
  private fun pruneState(devices: List<PickerDevice>) {
    val shutdownIds = devices.filter { it.state == DeviceState.Shutdown }.map { it.uiKey }.toSet()
    val bootedIds = devices.filter { it.state == DeviceState.Booted }.map { it.uiKey }.toSet()
    // A boot guard survives while its boot coroutine is still in flight even when the live list no
    // longer shows the source as Shutdown: once the daemon exposes the started runtime device its
    // same-named card hides the source image, so the guard must not be dropped mid-boot (#4881).
    bootingIds = bootingIds.filter { it in shutdownIds || it in inFlightBootIds }.toSet()
    bootErrors = bootErrors.filterKeys { it in shutdownIds }
    selectedIds = selectedIds intersect bootedIds
    // Keep only attributions whose runtime device is still booted (drop killed/replaced ids).
    bootedImageRuntimeIds = bootedImageRuntimeIds.mapValues { (platform, mappings) ->
      mappings.filterValues { "${platform.name.lowercase()}:$it" in bootedIds }
    }
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

  private fun bootDevice(selector: String) {
    // Boots are serialized: at most one in flight. A click on any shut-down card while a boot is
    // running is a no-op. This structurally removes overlapping reloads (and their generation
    // reordering hazards); the next card can boot once this one finishes. A failed boot leaves
    // bootingIds empty, so retrying (clicking the same card again) is still allowed.
    if (bootingIds.isNotEmpty()) return
    val content = _state.value as? DevicePickerUiState.Content ?: return
    val device =
      content.devices.singleOrNull { it.uiKey == selector }
        ?: content.devices.singleOrNull { it.id == selector }
        ?: return
    val deviceId = device.uiKey
    if (device.state != DeviceState.Shutdown || device.inventoryUncertain)
      return // only confirmed shut-down cards boot
    bootingIds = bootingIds + deviceId
    bootErrors = bootErrors - deviceId
    // Guard against a concurrent Refresh pruning the boot guard while the boot is still running.
    inFlightBootIds = inFlightBootIds + deviceId
    syncState()
    scope.launch {
      try {
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
      } finally {
        inFlightBootIds = inFlightBootIds - deviceId
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
    bootedImageRuntimeIds =
      bootedImageRuntimeIds +
        (bootedDevice.platform to
          (bootedImageRuntimeIds[bootedDevice.platform].orEmpty() +
            (bootedDevice.id to runtimeDeviceId)))
    val generation = ++loadGeneration
    val devices =
      try {
        fetchDevices()
      } catch (c: CancellationException) {
        throw c // don't turn cancellation into a boot failure
      } catch (e: Exception) {
        LOG.warn("Reload after boot failed for ${bootedDevice.name}: ${e.message}", e)
        bootingIds = bootingIds - bootedDevice.uiKey
        bootErrors = bootErrors + (bootedDevice.uiKey to (e.message ?: "Reload after boot failed"))
        resolveFetchFailure(generation, e)
        return
      }
    val bootedRuntime = devices.firstOrNull {
      it.id == runtimeDeviceId &&
        it.platform == bootedDevice.platform &&
        it.state == DeviceState.Booted
    }
    bootingIds = bootingIds - bootedDevice.uiKey
    if (bootedRuntime != null) {
      // A completed boot AUTO-OBSERVES the device (below); it deliberately does NOT auto-select it.
      // The runtime id is daemon-assigned on boot and can't have been selected earlier (you can't
      // select a shut-down card), so there is nothing to retain, and leaving it selected would show
      // a stale "Observe (1)" when the grid reopens (#5220). Both the observed and the
      // superseded/killed branches therefore leave the selection untouched.
      bootErrors = bootErrors - bootedDevice.uiKey
    } else {
      bootErrors = bootErrors + (bootedDevice.uiKey to "Boot did not complete")
    }
    // Persistent state is reflected onto the CURRENT Content unconditionally, so it never diverges
    // from what observeSelected() reads — even when this reload's device-LIST emission is dropped
    // as
    // stale below.
    syncState()
    emitIfCurrent(generation, devices)
    // Boot then auto-observe — but observe from the CURRENT (winning) state, not this reload's own
    // (possibly stale) list. If a newer refresh superseded this stalled reload, emitIfCurrent
    // dropped
    // its list; sending straight from `bootedRuntime` could open a pane — and start
    // binding/streaming
    // — for a device the newer refresh has since removed (e.g. killed by another client while this
    // reload was stalled). Re-checking the live Content re-observes only a device that is still
    // present-and-booted, with its fresh lock/virtual state (Codex).
    val stillBooted =
      (_state.value as? DevicePickerUiState.Content)?.devices?.firstOrNull {
        it.id == runtimeDeviceId &&
          it.platform == bootedDevice.platform &&
          it.state == DeviceState.Booted
      }
    if (stillBooted != null) {
      _effect.send(DevicePickerEffect.Observe(listOf(columnOf(stillBooted))))
    }
  }

  private fun toggleSelect(selector: String) {
    val content = _state.value as? DevicePickerUiState.Content ?: return
    // Booted-only: ignore selection of non-booted devices.
    val device =
      content.devices.singleOrNull { it.uiKey == selector }
        ?: content.devices.singleOrNull { it.id == selector }
        ?: return
    val deviceId = device.uiKey
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

  /**
   * Observe a single booted device immediately — the plain-click path. A non-booted or unknown id
   * is a no-op (shut-down cards boot instead, and a boot auto-observes on completion).
   */
  private fun observeDevice(selector: String) {
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

  /**
   * Build the observed [DeviceColumn] for a booted picker device, seeding its lock/virtual state.
   */
  private fun columnOf(device: PickerDevice): DeviceColumn =
    // Seed the pane's lock state from the booted snapshot; the host's poll keeps it fresh.
    DeviceColumn(
      deviceId = device.id,
      name = device.name,
      platform = device.platform,
      locked = device.locked,
      isVirtual = device.isVirtual,
      deviceSessionUuid = device.deviceSessionUuid,
    )

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
