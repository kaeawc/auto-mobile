package dev.jasonpearson.automobile.desktop.core.shell

import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusTarget
import androidx.compose.ui.input.key.KeyEvent
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.pointer.PointerIcon
import androidx.compose.ui.input.pointer.pointerHoverIcon
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme

/** Represents which pane currently has keyboard focus. */
enum class FocusedPane {
  Left,
  Center,
  Right,
}

/**
 * Top-level three-pane shell that assembles the Xcode-style layout: left sidebar, center canvas +
 * status bar, and right inspector, with a collapsible bottom timeline pane.
 *
 * All pane contents are provided via composable lambdas so callers can inject real or stub
 * implementations.
 *
 * Keyboard shortcuts:
 * - Cmd+0: toggle left pane
 * - Cmd+Shift+0: toggle right pane
 * - Cmd+Shift+Y: toggle bottom pane
 * - Arrow Up/Down: navigate event list
 * - Enter: select/inspect focused event
 * - Escape: deselect/close inspector
 * - Tab/Shift+Tab: cycle focus between panes
 * - Cmd+/: show shortcut cheat sheet
 * - Cmd+K: quick jump to timestamp
 * - Vim keys (j/k/g/G//) when vim mode is enabled
 */
data class ThreePaneShellOptions(
  val showLeftPane: Boolean,
  val onToggleLeftPane: () -> Unit,
  val showRightPane: Boolean,
  val onToggleRightPane: () -> Unit,
  val showBottomPane: Boolean,
  val onToggleBottomPane: () -> Unit,
  val deviceName: String?,
  val foregroundApp: String?,
  val crashCount: Int,
  val anrCount: Int,
  val nonFatalCount: Int,
  val toolFailureCount: Int,
  val currentFps: Float?,
  val currentMemoryMb: Float?,
  val isDaemonConnected: Boolean,
  val networkReqPerSec: Float? = null,
  val connectionStartTime: Long? = null,
  val cpuUsagePercent: Float? = null,
  val onNavigateUp: (() -> Unit)? = null,
  val onNavigateDown: (() -> Unit)? = null,
  val onSelectEvent: (() -> Unit)? = null,
  val onDeselectEvent: (() -> Unit)? = null,
  val onJumpToTop: (() -> Unit)? = null,
  val onJumpToBottom: (() -> Unit)? = null,
  val onFocusSearch: (() -> Unit)? = null,
  val onQuickJump: ((Long) -> Unit)? = null,
  val menuBarActions: MenuBarActions? = null,
  val vimModeEnabled: Boolean = false,
  val deviceControlCapturesKeys: (KeyEvent) -> Boolean = { false },
  val centerContent: @Composable (Modifier) -> Unit,
  val leftPaneContent: @Composable () -> Unit,
  val rightPaneContent: @Composable () -> Unit,
  val bottomPaneContent: @Composable () -> Unit,
)

@Composable
fun ThreePaneShell(
  options: ThreePaneShellOptions,
  modifier: Modifier = Modifier,
) {
  val state = remember { ShellPaneState() }
  val focus = remember {
    ShellFocusRequesters(FocusRequester(), FocusRequester(), FocusRequester())
  }
  ObserveShellMenus(options, state)
  Box(modifier.fillMaxSize()) {
    Column(
      Modifier.fillMaxSize().focusTarget().onPreviewKeyEvent { event ->
        handleShellKey(event, options, state, focus)
      },
    ) {
      MacOSTitleBarSpacer(Modifier.fillMaxWidth())
      Row(
        Modifier.fillMaxWidth()
          .height(28.dp)
          .background(SharedTheme.globalColors.panelBackground)
          .padding(horizontal = 8.dp),
        horizontalArrangement = Arrangement.End,
        verticalAlignment = Alignment.CenterVertically,
      ) {
        PaneToggleToolbar(
          options =
            PaneToggles(
              showLeftPane = options.showLeftPane,
              onToggleLeft = options.onToggleLeftPane,
              showRightPane = options.showRightPane,
              onToggleRight = options.onToggleRightPane,
              showBottomPane = options.showBottomPane,
              onToggleBottom = options.onToggleBottomPane,
            ),
        )
      }
      ShellMainPanes(options, state, focus, Modifier.weight(1f))
      ShellBottomPane(options, state)
    }
    ShellOverlays(options, state)
  }
}

// ---------------------------------------------------------------------------
// Stub composables — replaced by real implementations when units 1-7 merge
// ---------------------------------------------------------------------------

/** Thin vertical divider with horizontal drag-to-resize. Double-tap resets to default. */
@Composable
internal fun VerticalDividerStub(onDrag: (Dp) -> Unit, onReset: () -> Unit = {}) {
  val density = LocalDensity.current
  Box(
    Modifier.width(5.dp)
      .fillMaxHeight()
      .background(SharedTheme.globalColors.text.normal.copy(alpha = 0.12f))
      .pointerHoverIcon(PointerIcon.Hand)
      .pointerInput(Unit) {
        detectDragGestures { _, dragAmount ->
          with(density) { onDrag(dragAmount.x.toDp()) }
        }
      }
      .pointerInput(Unit) {
        detectTapGestures(onDoubleTap = { onReset() })
      },
  )
}

/** Thin horizontal divider with vertical drag-to-resize. Double-tap resets to default. */
@Composable
internal fun HorizontalDividerStub(onDrag: (Dp) -> Unit, onReset: () -> Unit = {}) {
  val density = LocalDensity.current
  Box(
    Modifier.height(5.dp)
      .fillMaxWidth()
      .background(SharedTheme.globalColors.text.normal.copy(alpha = 0.12f))
      .pointerHoverIcon(PointerIcon.Hand)
      .pointerInput(Unit) {
        detectDragGestures { _, dragAmount ->
          with(density) { onDrag(dragAmount.y.toDp()) }
        }
      }
      .pointerInput(Unit) {
        detectTapGestures(onDoubleTap = { onReset() })
      },
  )
}

/** Format elapsed time in seconds as "Xm Ys". */
internal fun formatElapsed(elapsedSeconds: Long): String {
  val minutes = elapsedSeconds / 60
  val seconds = elapsedSeconds % 60
  return if (minutes > 0) "${minutes}m ${seconds}s" else "${seconds}s"
}
