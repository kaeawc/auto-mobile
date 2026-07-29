package dev.jasonpearson.automobile.desktop.core.workspace

import dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory
import kotlinx.coroutines.CoroutineScope
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
 */
class WorkspaceViewModel(private val scope: CoroutineScope) {
  private val _state = MutableStateFlow<WorkspaceUiState>(WorkspaceUiState.Empty)
  val state: StateFlow<WorkspaceUiState> = _state.asStateFlow()

  private val _effect = Channel<WorkspaceEffect>(Channel.BUFFERED)
  val effect = _effect.receiveAsFlow()

  fun onAction(action: WorkspaceAction) {
    when (action) {
      is WorkspaceAction.ObserveDevice -> observe(action.column)
      is WorkspaceAction.CloseDevice -> close(action.deviceId)
      is WorkspaceAction.FocusDevice -> focus(action.deviceId)
      is WorkspaceAction.SetMode -> mutate(action.deviceId) { it.copy(mode = action.mode) }
      is WorkspaceAction.ToggleShrink -> mutate(action.deviceId) { it.copy(shrunk = !it.shrunk) }
      is WorkspaceAction.SelectTool -> mutate(action.deviceId) { it.copy(activeTool = action.tool) }
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
        LOG.debug("Device ${column.deviceId} already observed; refocusing")
        WorkspaceUiState.Content(columns, focusedDeviceId = column.deviceId)
      } else {
        WorkspaceUiState.Content(columns + column, focusedDeviceId = column.deviceId)
      }
    }
  }

  private fun close(deviceId: String) {
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
