package dev.jasonpearson.automobile.desktop

import dev.jasonpearson.automobile.desktop.core.workspace.WorkspaceUiState

internal const val APP_WINDOW_TITLE = "AutoMobile"

/**
 * The desktop window's title: the app name, followed by the focused workspace device's name when
 * one is focused ("AutoMobile — Pixel 8 API 35"), so a window switcher shows which device the
 * window is driving.
 */
internal fun windowTitle(state: WorkspaceUiState): String {
  val content = state as? WorkspaceUiState.Content ?: return APP_WINDOW_TITLE
  val deviceName = content.columns.firstOrNull { it.deviceId == content.focusedDeviceId }?.name
  return if (deviceName.isNullOrBlank()) APP_WINDOW_TITLE else "$APP_WINDOW_TITLE — $deviceName"
}
