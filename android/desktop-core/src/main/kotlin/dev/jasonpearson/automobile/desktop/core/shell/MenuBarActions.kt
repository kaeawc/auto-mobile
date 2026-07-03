package dev.jasonpearson.automobile.desktop.core.shell

import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

/**
 * Shared callback bridge between the native window [MenuBar] (defined in Main.kt) and the Compose
 * UI tree ([AutoMobileContent] / [ThreePaneShell]).
 *
 * Main.kt creates an instance and passes it to both the menu bar items and [AutoMobileContent].
 * AutoMobileContent populates the mutable state and callbacks so the menu items can trigger the
 * same actions as the keyboard shortcuts already handled inside the Compose tree.
 */
@Stable
class MenuBarActions {
  // ---- Pane visibility (read/write from both sides) ----
  var showLeftPane by mutableStateOf(true)
  var showRightPane by mutableStateOf(true)
  var showBottomPane by mutableStateOf(false)

  // ---- Overlay triggers ----
  var showSettings by mutableStateOf(false)
  var showCommandPalette by mutableStateOf(false)
  var showGlobalSearch by mutableStateOf(false)
  var showQuickJump by mutableStateOf(false)
  var showCheatSheet by mutableStateOf(false)

  // ---- Action callbacks (set by AutoMobileContent once wired) ----
  var onTakeScreenshot: (() -> Unit)? = null
}
