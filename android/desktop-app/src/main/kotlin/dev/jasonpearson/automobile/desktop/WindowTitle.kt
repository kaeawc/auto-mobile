package dev.jasonpearson.automobile.desktop

import dev.jasonpearson.automobile.desktop.core.workspace.WorkspaceUiState
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

internal const val APP_WINDOW_TITLE = "AutoMobile"

private const val TITLE_SEPARATOR = " — "

/**
 * The desktop window's title: the app name, then the focused workspace device's name, then that
 * device's foreground app when one is known ("AutoMobile — Pixel 8 API 35 — com.example.app"), so a
 * window switcher shows which device and app the window is driving. [foregroundApps] maps a device
 * id to its last reported foreground package; only the focused device's entry is read.
 */
internal fun windowTitle(
  state: WorkspaceUiState,
  foregroundApps: Map<String, String> = emptyMap(),
): String {
  val content = state as? WorkspaceUiState.Content ?: return APP_WINDOW_TITLE
  val focused = content.columns.firstOrNull { it.deviceId == content.focusedDeviceId }
  val parts = listOf(APP_WINDOW_TITLE, focused?.name, focused?.let { foregroundApps[it.deviceId] })
  return parts.filterNot { it.isNullOrBlank() }.joinToString(TITLE_SEPARATOR)
}

/**
 * The last foreground app each workspace device's control stream reported. The focused pane's
 * device-control observation stream feeds it, so the title opens no observation of its own.
 */
internal class ForegroundAppsByDevice {
  private val state = MutableStateFlow<Map<String, String>>(emptyMap())
  val apps: StateFlow<Map<String, String>> = state.asStateFlow()

  /** Record [packageName] as [deviceId]'s foreground app; a blank package is ignored. */
  fun report(deviceId: String, packageName: String) {
    if (packageName.isBlank()) return
    state.update { apps ->
      if (apps[deviceId] == packageName) apps else apps + (deviceId to packageName)
    }
  }
}
