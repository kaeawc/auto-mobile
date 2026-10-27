package dev.jasonpearson.automobile.desktop.core.shell

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEvent
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.isMetaPressed
import androidx.compose.ui.input.key.isShiftPressed
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.type
import androidx.compose.ui.unit.dp

private fun visiblePanes(showLeft: Boolean, showRight: Boolean): List<FocusedPane> = buildList {
  if (showLeft) add(FocusedPane.Left)
  add(FocusedPane.Center)
  if (showRight) add(FocusedPane.Right)
}

private fun cyclePane(
  current: FocusedPane,
  showLeft: Boolean,
  showRight: Boolean,
  forward: Boolean,
): FocusedPane {
  val order = visiblePanes(showLeft, showRight)
  val currentIndex = order.indexOf(current).coerceAtLeast(0)
  val delta = if (forward) 1 else order.size - 1
  return order[(currentIndex + delta) % order.size]
}

private fun requestFocusForPane(
  pane: FocusedPane,
  leftRequester: FocusRequester,
  centerRequester: FocusRequester,
  rightRequester: FocusRequester,
) {
  try {
    when (pane) {
      FocusedPane.Left -> leftRequester.requestFocus()
      FocusedPane.Center -> centerRequester.requestFocus()
      FocusedPane.Right -> rightRequester.requestFocus()
    }
  } catch (_: IllegalStateException) {
    // FocusRequester not attached yet - ignore
  }
}

internal fun handleShellKey(
  event: KeyEvent,
  options: ThreePaneShellOptions,
  state: ShellPaneState,
  focus: ShellFocusRequesters,
): Boolean {
  if (event.type != KeyEventType.KeyDown) return false
  if (state.showCheatSheet) {
    if (event.key == Key.Escape) state.showCheatSheet = false
    return true
  }
  if (state.showQuickJump) return false
  if (options.deviceControlCapturesKeys(event)) return false
  if (event.isMetaPressed && handleShellMetaKey(event, options, state)) return true
  if (!event.isMetaPressed && event.key == Key.Tab) {
    state.focusedPane =
      cyclePane(
        state.focusedPane,
        options.showLeftPane,
        options.showRightPane,
        forward = !event.isShiftPressed,
      )
    requestFocusForPane(state.focusedPane, focus.left, focus.center, focus.right)
    return true
  }
  return handleShellNavigation(event, options)
}

private fun handleShellMetaKey(
  event: KeyEvent,
  options: ThreePaneShellOptions,
  state: ShellPaneState,
): Boolean =
  when {
    event.key == Key.Zero -> {
      if (event.isShiftPressed) options.onToggleRightPane() else options.onToggleLeftPane()
      true
    }
    event.isShiftPressed && event.key == Key.Y -> {
      options.onToggleBottomPane()
      true
    }
    event.key == Key.Slash -> {
      state.showCheatSheet = true
      true
    }
    event.key == Key.K -> {
      if (options.onQuickJump != null) state.showQuickJump = true
      true
    }
    else -> false
  }

private fun handleShellNavigation(event: KeyEvent, options: ThreePaneShellOptions): Boolean =
  when (event.key) {
    Key.DirectionUp -> {
      options.onNavigateUp?.invoke()
      options.onNavigateUp != null
    }
    Key.DirectionDown -> {
      options.onNavigateDown?.invoke()
      options.onNavigateDown != null
    }
    Key.Enter -> {
      options.onSelectEvent?.invoke()
      options.onSelectEvent != null
    }
    Key.Escape -> {
      options.onDeselectEvent?.invoke()
      options.onDeselectEvent != null
    }
    else -> handleShellVimKey(event, options)
  }

private fun handleShellVimKey(event: KeyEvent, options: ThreePaneShellOptions): Boolean {
  if (!options.vimModeEnabled || event.isMetaPressed) return false
  if (event.isShiftPressed) {
    if (event.key != Key.G) return false
    options.onJumpToBottom?.invoke()
    return options.onJumpToBottom != null
  }
  return when (event.key) {
    Key.J -> {
      options.onNavigateDown?.invoke()
      options.onNavigateDown != null
    }
    Key.K -> {
      options.onNavigateUp?.invoke()
      options.onNavigateUp != null
    }
    Key.G -> {
      options.onJumpToTop?.invoke()
      options.onJumpToTop != null
    }
    Key.Slash -> {
      options.onFocusSearch?.invoke()
      options.onFocusSearch != null
    }
    else -> false
  }
}

internal class ShellPaneState {
  var leftPaneWidth by mutableStateOf(220.dp)
  var rightPaneWidth by mutableStateOf(300.dp)
  var bottomPaneHeight by mutableStateOf(120.dp)
  var focusedPane by mutableStateOf(FocusedPane.Center)
  var showCheatSheet by mutableStateOf(false)
  var showQuickJump by mutableStateOf(false)
}

internal data class ShellFocusRequesters(
  val left: FocusRequester,
  val center: FocusRequester,
  val right: FocusRequester,
)
