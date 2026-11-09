package dev.jasonpearson.automobile.desktop.core.workspace.picker

import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import dev.jasonpearson.automobile.desktop.core.settings.SettingsProvider
import dev.jasonpearson.automobile.desktop.core.workspace.WorkspaceUiState

/**
 * Remembers, in [settings], that a device has been observed, for the checklist's last step.
 *
 * The live workspace state cannot carry that step: observing a device makes the workspace
 * non-empty, which replaces the picker (and its card) with the workspace, and closing the last pane
 * returns the workspace to Empty. The card is therefore almost never on screen while the workspace
 * is Content. The record latches on the first Content and stays set across restarts.
 */
class DeviceObservedRecord(private val settings: SettingsProvider) {
  var observed: Boolean by mutableStateOf(settings.hasObservedDevice)
    private set

  fun record(workspace: WorkspaceUiState) {
    if (observed || workspace !is WorkspaceUiState.Content) return
    settings.hasObservedDevice = true
    observed = true
  }
}

/**
 * Records [workspace] into [record] after each composition. Host it where the workspace state is
 * always composed, not under the picker, which leaves composition the moment a device is observed.
 */
@Composable
fun RecordDeviceObserved(record: DeviceObservedRecord, workspace: WorkspaceUiState) {
  SideEffect { record.record(workspace) }
}
