package dev.jasonpearson.automobile.desktop.core.workspace

import dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory
import dev.jasonpearson.automobile.desktop.core.navigation.DefaultNavigationScreenshotLoaderRegistry
import dev.jasonpearson.automobile.desktop.core.navigation.NavigationScreenshotLoaderRegistry
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

private val LOG = LoggerFactory.getLogger("WorkspaceViewModel")

/** UI state for the device-tab workspace. */
sealed interface WorkspaceUiState {
  /** No devices observed yet — the launch surface until the picker opens some. */
  data object Empty : WorkspaceUiState

  data class Content(
    val columns: List<DeviceColumn>,
    val focusedDeviceId: String?,
  ) : WorkspaceUiState
}

/** Actions the workspace can dispatch. Downstream behavior (streams, facets) lands in later PRs. */
sealed interface WorkspaceAction {
  data class ObserveDevice(val column: DeviceColumn) : WorkspaceAction

  data class CloseDevice(val deviceId: String) : WorkspaceAction

  data class FocusDevice(val deviceId: String) : WorkspaceAction

  data class SetMode(val deviceId: String, val mode: InteractionMode) : WorkspaceAction

  data class ToggleShrink(val deviceId: String) : WorkspaceAction

  data class SelectTool(val deviceId: String, val tool: Tool?) : WorkspaceAction

  /** Run an emulator control against a device pane (rotate, screenshot, snapshot, unlock). */
  data class RunControl(val deviceId: String, val control: EmulatorControl) : WorkspaceAction

  /** Press a device system button on a pane (the `more` overflow menu items). */
  data class PressDeviceButton(val deviceId: String, val button: DeviceButton) : WorkspaceAction

  /** Apply a locale to a pane's device (the `locale` picker selection). */
  data class SetLocale(val deviceId: String, val locale: String) : WorkspaceAction

  /**
   * Update panes' lock state from an observed snapshot (deviceId -> locked). A device absent from
   * [locked] keeps its current state, so a transient empty read never spuriously unlocks a pane.
   * Fed by the host's periodic lock-state poll; gates the contextual Unlock control.
   */
  data class SetLockStates(val locked: Map<String, Boolean>) : WorkspaceAction

  /**
   * Refresh daemon-minted device epochs for columns that are already open. A daemon restart
   * replaces every process-local epoch while preserving device IDs, so an open UUID-scoped stream
   * must be recreated with this new identity.
   */
  data class RefreshDeviceSessionUuids(val sessionUuids: Map<String, String>) : WorkspaceAction

  /** Open [tool] on every observed pane for like-for-like comparison (the facet ⧉ Diff control). */
  data class DiffTool(val tool: Tool) : WorkspaceAction
}

/** One-shot effects emitted by the workspace. */
sealed interface WorkspaceEffect {
  /** Open the device picker. Wired to a real screen in a later PR. */
  data object OpenPicker : WorkspaceEffect
}

/**
 * ViewModel for the device-tab workspace. Owns the set of observed device columns and which one is
 * focused, independent of Compose. Mirrors the repo's sealed [WorkspaceUiState]/[WorkspaceAction]/
 * [WorkspaceEffect] + [StateFlow]/[Channel] convention (cf. `NavigationViewModel`).
 *
 * [controlExecutor] runs emulator controls against the real device — injected like the picker's
 * `McpResourceClient`, so behavior is pinned here with a fake while the real socket call stays
 * untested (#4694).
 */
class WorkspaceViewModel(
  private val scope: CoroutineScope,
  private val controlExecutor: EmulatorControlExecutor = NoOpEmulatorControlExecutor,
  private val screenshotLoaderRegistry: NavigationScreenshotLoaderRegistry =
    DefaultNavigationScreenshotLoaderRegistry,
) {
  private val _state = MutableStateFlow<WorkspaceUiState>(WorkspaceUiState.Empty)
  val state: StateFlow<WorkspaceUiState> = _state.asStateFlow()

  private val _effect = Channel<WorkspaceEffect>(Channel.BUFFERED)
  val effect = _effect.receiveAsFlow()

  // The in-flight locale request per device, so a newer selection can supersede an older one that
  // is still resolving the foreground app (see [setLocale]).
  private val localeJobs = mutableMapOf<String, Job>()

  fun onAction(action: WorkspaceAction) {
    when (action) {
      is WorkspaceAction.ObserveDevice -> observe(action.column)
      is WorkspaceAction.CloseDevice -> close(action.deviceId)
      is WorkspaceAction.FocusDevice -> focus(action.deviceId)
      is WorkspaceAction.SetMode -> mutate(action.deviceId) { it.copy(mode = action.mode) }
      is WorkspaceAction.ToggleShrink -> mutate(action.deviceId) { it.copy(shrunk = !it.shrunk) }
      is WorkspaceAction.SelectTool -> mutate(action.deviceId) { it.copy(activeTool = action.tool) }
      is WorkspaceAction.RunControl -> runControl(action.deviceId, action.control)
      is WorkspaceAction.PressDeviceButton -> pressDeviceButton(action.deviceId, action.button)
      is WorkspaceAction.SetLocale -> setLocale(action.deviceId, action.locale)
      is WorkspaceAction.SetLockStates -> setLockStates(action.locked)
      is WorkspaceAction.RefreshDeviceSessionUuids -> refreshDeviceSessionUuids(action.sessionUuids)
      is WorkspaceAction.DiffTool -> diffTool(action.tool)
    }
  }

  /**
   * Press a device system [button] on the targeted column off the UI thread; failures are logged.
   */
  private fun pressDeviceButton(deviceId: String, button: DeviceButton) {
    val column = columnFor(deviceId) ?: return
    scope.launch {
      try {
        controlExecutor.pressButton(deviceId, column.platform, button)
      } catch (cancellation: CancellationException) {
        throw cancellation
      } catch (error: Exception) {
        LOG.warn("Device button $button failed for $deviceId: ${error.message}", error)
      }
    }
  }

  /** Apply [locale] to the targeted column's device off the UI thread; failures are logged. */
  private fun setLocale(deviceId: String, locale: String) {
    val column = columnFor(deviceId) ?: return
    // A newer pick supersedes any still-resolving one for this device: resolving the foreground app
    // can take seconds, and without cancelling, an earlier request could invoke changeLocalization
    // AFTER a later one and leave the device in a locale the user did not pick last.
    localeJobs[deviceId]?.cancel()
    localeJobs[deviceId] = scope.launch {
      try {
        controlExecutor.setLocale(deviceId, column.platform, locale)
      } catch (cancellation: CancellationException) {
        throw cancellation
      } catch (error: Exception) {
        LOG.warn("Set locale $locale failed for $deviceId: ${error.message}", error)
      }
    }
  }

  private fun columnFor(deviceId: String): DeviceColumn? =
    (_state.value as? WorkspaceUiState.Content)?.columns?.firstOrNull { it.deviceId == deviceId }

  /** Reflect an observed lock-state snapshot onto the columns; absent devices keep their state. */
  private fun setLockStates(locked: Map<String, Boolean>) {
    if (locked.isEmpty()) return
    _state.update { current ->
      val content = current as? WorkspaceUiState.Content ?: return@update current
      content.copy(
        columns =
          content.columns.map { column ->
            val next = locked[column.deviceId] ?: return@map column
            if (next == column.locked) column else column.copy(locked = next)
          }
      )
    }
  }

  /**
   * Replace only non-null UUIDs from a fresh booted-devices snapshot. A missing UUID means an
   * older daemon did not expose epoch identity; preserving the known UUID makes a transient or
   * downgraded response unable to silently widen an existing UUID-scoped stream.
   */
  private fun refreshDeviceSessionUuids(sessionUuids: Map<String, String>) {
    if (sessionUuids.isEmpty()) return
    _state.update { current ->
      val content = current as? WorkspaceUiState.Content ?: return@update current
      content.copy(
        columns =
          content.columns.map { column ->
            val refreshed = sessionUuids[column.deviceId] ?: return@map column
            if (refreshed == column.deviceSessionUuid) column
            else column.copy(deviceSessionUuid = refreshed)
          }
      )
    }
  }

  /** Open [tool] on every observed column so all panes show the same facet side by side. */
  private fun diffTool(tool: Tool) {
    _state.update { current ->
      val content = current as? WorkspaceUiState.Content ?: return@update current
      content.copy(columns = content.columns.map { it.copy(activeTool = tool) })
    }
  }

  /** Emit [WorkspaceEffect.OpenPicker]; the picker screen itself arrives in a later PR. */
  fun openPicker() {
    scope.launch { _effect.send(WorkspaceEffect.OpenPicker) }
  }

  private fun observe(column: DeviceColumn) {
    _state.update { current ->
      val columns = (current as? WorkspaceUiState.Content)?.columns ?: emptyList()
      if (columns.any { it.deviceId == column.deviceId }) {
        // A restarted emulator can keep its serial while receiving a fresh daemon-minted epoch.
        // Preserve the pane's UI state but replace identity/device metadata so its facets dispose
        // stale streams and reconnect with the current session UUID.
        LOG.debug("Device ${column.deviceId} already observed; refreshing and refocusing")
        WorkspaceUiState.Content(
          columns.map { existing ->
            if (existing.deviceId != column.deviceId) {
              existing
            } else {
              column.copy(
                mode = existing.mode,
                activeTool = existing.activeTool,
                shrunk = existing.shrunk,
                orientation = existing.orientation,
              )
            }
          },
          focusedDeviceId = column.deviceId,
        )
      } else {
        WorkspaceUiState.Content(columns + column, focusedDeviceId = column.deviceId)
      }
    }
  }

  private fun close(deviceId: String) {
    // The device is leaving the workspace: release its navigation screenshot loader so the
    // session-scoped registry doesn't retain a per-device thumbnail cache for every device ever
    // shown (#5087).
    screenshotLoaderRegistry.forget(deviceId)
    _state.update { current ->
      val content = current as? WorkspaceUiState.Content ?: return@update current
      val remaining = content.columns.filterNot { it.deviceId == deviceId }
      if (remaining.isEmpty()) {
        WorkspaceUiState.Empty
      } else {
        val focus =
          if (content.focusedDeviceId == deviceId) remaining.first().deviceId
          else content.focusedDeviceId
        WorkspaceUiState.Content(remaining, focusedDeviceId = focus)
      }
    }
  }

  /**
   * Run an emulator [control] against the targeted column off the UI thread; unknown ids are a
   * no-op. Rotate first toggles the tracked per-column orientation and drives the tool with the new
   * value. Failures are logged, not swallowed — a device call that throws must not crash the
   * workspace or leave the effect path wedged (repo error-handling convention: log-and-continue for
   * best-effort UI actions).
   */
  private fun runControl(deviceId: String, control: EmulatorControl) {
    val content = _state.value as? WorkspaceUiState.Content ?: return
    val column = content.columns.firstOrNull { it.deviceId == deviceId } ?: return
    val orientation =
      if (control == EmulatorControl.Rotate) column.orientation.toggled() else column.orientation
    if (control == EmulatorControl.Rotate) {
      mutate(deviceId) { it.copy(orientation = orientation) }
    }
    scope.launch {
      try {
        controlExecutor.run(deviceId, column.platform, control, orientation)
      } catch (cancellation: CancellationException) {
        throw cancellation
      } catch (error: Exception) {
        LOG.warn("Emulator control $control failed for $deviceId: ${error.message}", error)
      }
    }
  }

  private fun focus(deviceId: String) {
    _state.update { current ->
      (current as? WorkspaceUiState.Content)?.copy(focusedDeviceId = deviceId) ?: current
    }
  }

  private fun mutate(deviceId: String, transform: (DeviceColumn) -> DeviceColumn) {
    _state.update { current ->
      val content = current as? WorkspaceUiState.Content ?: return@update current
      content.copy(
        columns = content.columns.map { if (it.deviceId == deviceId) transform(it) else it }
      )
    }
  }
}
