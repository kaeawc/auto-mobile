package dev.jasonpearson.automobile.desktop.core.shell

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.focusTarget
import androidx.compose.ui.unit.dp

@Composable
internal fun ObserveShellMenus(options: ThreePaneShellOptions, state: ShellPaneState) {
  with(options) {
    with(state) {
      // Observe menu bar triggers for overlays
      if (menuBarActions != null) {
        LaunchedEffect(menuBarActions.showQuickJump) {
          if (menuBarActions.showQuickJump) {
            showQuickJump = true
            menuBarActions.showQuickJump = false
          }
        }
        LaunchedEffect(menuBarActions.showCheatSheet) {
          if (menuBarActions.showCheatSheet) {
            showCheatSheet = true
            menuBarActions.showCheatSheet = false
          }
        }
      }
    }
  }
}

@Composable
internal fun ShellMainPanes(
  options: ThreePaneShellOptions,
  state: ShellPaneState,
  focus: ShellFocusRequesters,
  modifier: Modifier,
) {
  with(options) {
    with(state) {
      Row(modifier) {
        // Left sidebar (collapsible)
        if (showLeftPane) {
          Box(
            Modifier.width(leftPaneWidth).fillMaxHeight().focusRequester(focus.left).focusTarget(),
          ) {
            leftPaneContent()
          }
          VerticalDividerStub(
            onDrag = { delta ->
              leftPaneWidth = (leftPaneWidth + delta).coerceIn(150.dp, 400.dp)
            },
          )
        }

        // Center canvas (flex) + status bar
        ShellCenterPane(options, focus)

        // Right inspector (collapsible)
        if (showRightPane) {
          VerticalDividerStub(
            onDrag = { delta ->
              rightPaneWidth = (rightPaneWidth - delta).coerceIn(200.dp, 500.dp)
            },
          )
          Box(
            Modifier.width(rightPaneWidth)
              .fillMaxHeight()
              .focusRequester(focus.right)
              .focusTarget(),
          ) {
            rightPaneContent()
          }
        }
      }
    }
  }
}

@Composable
internal fun androidx.compose.foundation.layout.RowScope.ShellCenterPane(
  options: ThreePaneShellOptions,
  focus: ShellFocusRequesters,
) {
  with(options) {
    Column(Modifier.weight(1f).focusRequester(focus.center).focusTarget()) {
      centerContent(Modifier.weight(1f))

      // Status bar
      StatusBarStub(
        options =
          ShellStatusOptions(
            crashCount = crashCount,
            anrCount = anrCount,
            nonFatalCount = nonFatalCount,
            toolFailureCount = toolFailureCount,
            currentFps = currentFps,
            currentMemoryMb = currentMemoryMb,
            isDaemonConnected = isDaemonConnected,
            deviceName = deviceName,
            foregroundApp = foregroundApp,
            networkReqPerSec = networkReqPerSec,
            connectionStartTime = connectionStartTime,
            cpuUsagePercent = cpuUsagePercent,
          ),
      )
    }
  }
}

@Composable
internal fun ShellBottomPane(options: ThreePaneShellOptions, state: ShellPaneState) {
  with(options) {
    with(state) {
      if (showBottomPane) {
        HorizontalDividerStub(
          onDrag = { delta ->
            bottomPaneHeight = (bottomPaneHeight - delta).coerceIn(80.dp, 300.dp)
          },
        )
        Box(Modifier.fillMaxWidth().height(bottomPaneHeight)) {
          bottomPaneContent()
        }
      }
    }
  }
}

@Composable
internal fun ShellOverlays(options: ThreePaneShellOptions, state: ShellPaneState) {
  with(options) {
    with(state) {
      // Modal overlays
      if (showCheatSheet) {
        ShortcutCheatSheet(
          vimModeEnabled = vimModeEnabled,
          onDismiss = { showCheatSheet = false },
        )
      }

      if (showQuickJump && onQuickJump != null) {
        QuickJumpDialog(
          onJump = onQuickJump,
          onDismiss = { showQuickJump = false },
        )
      }
    }
  }
}
