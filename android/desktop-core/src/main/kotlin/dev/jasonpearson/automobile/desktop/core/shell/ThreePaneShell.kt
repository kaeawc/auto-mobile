package dev.jasonpearson.automobile.desktop.core.shell

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.hoverable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsHoveredAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.focusTarget
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEvent
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.isMetaPressed
import androidx.compose.ui.input.key.isShiftPressed
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.input.pointer.PointerIcon
import androidx.compose.ui.input.pointer.pointerHoverIcon
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme
import kotlinx.coroutines.delay

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
@Composable
fun ThreePaneShell(
  // Pane visibility
  showLeftPane: Boolean,
  onToggleLeftPane: () -> Unit,
  showRightPane: Boolean,
  onToggleRightPane: () -> Unit,
  showBottomPane: Boolean,
  onToggleBottomPane: () -> Unit,
  // Device info (for status bar)
  deviceName: String?,
  foregroundApp: String?,
  // Status bar data
  crashCount: Int,
  anrCount: Int,
  nonFatalCount: Int,
  toolFailureCount: Int,
  currentFps: Float?,
  currentMemoryMb: Float?,
  isDaemonConnected: Boolean,
  // Optional enhanced status bar data
  networkReqPerSec: Float? = null,
  connectionStartTime: Long? = null,
  cpuUsagePercent: Float? = null,
  // Keyboard navigation callbacks
  onNavigateUp: (() -> Unit)? = null,
  onNavigateDown: (() -> Unit)? = null,
  onSelectEvent: (() -> Unit)? = null,
  onDeselectEvent: (() -> Unit)? = null,
  onJumpToTop: (() -> Unit)? = null,
  onJumpToBottom: (() -> Unit)? = null,
  onFocusSearch: (() -> Unit)? = null,
  onQuickJump: ((Long) -> Unit)? = null,
  // Menu bar bridge (optional — when provided, menu bar can trigger overlays)
  menuBarActions: MenuBarActions? = null,
  // Vim mode
  vimModeEnabled: Boolean = false,
  /**
   * Per-event predicate: will the device-control canvas actually claim this keystroke?
   * (issue #3351).
   *
   * This shell's navigation shortcuts live in a **preview** handler, which by design runs before
   * any focused descendant sees the event. That is right for shell navigation and fatal for
   * device-control keyboard forwarding: Tab, the arrows, Enter and Escape are exactly the keys a
   * mirrored device needs, and every one of them would be consumed here first — Escape being the
   * client's only device-button binding.
   *
   * It is a **per-event predicate**, not a mode flag, because Compose never reruns a preview
   * handler while an unconsumed event bubbles back up. A blanket "canvas is focused" stand-down
   * would send every un-chorded key past this handler, and any keystroke the forwarding policy then
   * *declines* (a printable character on a platform whose daemon cannot append, a shifted device
   * key) would reach **neither** the device **nor** the shell — a dead zone. The caller answers
   * with the same policy the canvas will apply, so the shell stands down exactly for the keystrokes
   * the device claims and keeps everything else, chords included.
   *
   * Defaults to never capturing, so an inspector-only embedder (the IDE plugin) is unchanged.
   */
  deviceControlCapturesKeys: (KeyEvent) -> Boolean = { false },
  // Pane content slots
  centerContent: @Composable (Modifier) -> Unit,
  leftPaneContent: @Composable () -> Unit,
  rightPaneContent: @Composable () -> Unit,
  bottomPaneContent: @Composable () -> Unit,
  modifier: Modifier = Modifier,
) {
  // Default pane widths / heights
  val defaultLeftWidth = 220.dp
  val defaultRightWidth = 300.dp
  val defaultBottomHeight = 120.dp

  // Auto-collapse thresholds (as fraction of total available width)
  // Not applicable to fixed-dp widths here but we use a minimum dp check instead
  val leftCollapseMinDp = 100.dp // below this -> auto-collapse
  val rightCollapseMinDp = 130.dp // below this -> auto-collapse

  // Resizable pane widths — animated with spring
  var leftPaneWidth by remember { mutableStateOf(defaultLeftWidth) }
  var rightPaneWidth by remember { mutableStateOf(defaultRightWidth) }
  var bottomPaneHeight by remember { mutableStateOf(defaultBottomHeight) }

  // Keyboard focus state
  var focusedPane by remember { mutableStateOf(FocusedPane.Center) }

  // Modal overlays
  var showCheatSheet by remember { mutableStateOf(false) }
  var showQuickJump by remember { mutableStateOf(false) }

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

  // Focus requesters for panes
  val leftFocusRequester = remember { FocusRequester() }
  val centerFocusRequester = remember { FocusRequester() }
  val rightFocusRequester = remember { FocusRequester() }

  Box(modifier.fillMaxSize()) {
    Column(
      Modifier.fillMaxSize().focusTarget().onPreviewKeyEvent { event ->
        if (event.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false

        // When modal overlays are open, only allow Escape to close them
        if (showCheatSheet) {
          if (event.key == Key.Escape) {
            showCheatSheet = false
            return@onPreviewKeyEvent true
          }
          return@onPreviewKeyEvent true
        }
        if (showQuickJump) return@onPreviewKeyEvent false

        // Device control owns exactly the keystrokes its policy will claim. Declining here
        // (rather than not registering the handler) keeps this one preview handler as the single
        // place shell navigation is decided, and lets the event fall through to the focused
        // device canvas. Modal overlays above still win, because they are checked first — and a
        // keystroke the canvas would DECLINE never stands the shell down, so it keeps its
        // binding instead of dying in the preview/bubbling gap.
        if (deviceControlCapturesKeys(event)) {
          return@onPreviewKeyEvent false
        }

        when {
          // Cmd+0 -> toggle left pane
          event.isMetaPressed && !event.isShiftPressed && event.key == Key.Zero -> {
            onToggleLeftPane()
            true
          }
          // Cmd+Shift+0 -> toggle right pane
          event.isMetaPressed && event.isShiftPressed && event.key == Key.Zero -> {
            onToggleRightPane()
            true
          }
          // Cmd+Shift+Y -> toggle bottom pane
          event.isMetaPressed && event.isShiftPressed && event.key == Key.Y -> {
            onToggleBottomPane()
            true
          }
          // Cmd+/ -> shortcut cheat sheet
          event.isMetaPressed && event.key == Key.Slash -> {
            showCheatSheet = true
            true
          }
          // Cmd+K -> quick jump
          event.isMetaPressed && event.key == Key.K -> {
            if (onQuickJump != null) {
              showQuickJump = true
            }
            true
          }
          // Tab -> focus next pane
          !event.isMetaPressed && !event.isShiftPressed && event.key == Key.Tab -> {
            focusedPane = cyclePane(focusedPane, showLeftPane, showRightPane, forward = true)
            requestFocusForPane(
              focusedPane,
              leftFocusRequester,
              centerFocusRequester,
              rightFocusRequester,
            )
            true
          }
          // Shift+Tab -> focus previous pane
          !event.isMetaPressed && event.isShiftPressed && event.key == Key.Tab -> {
            focusedPane = cyclePane(focusedPane, showLeftPane, showRightPane, forward = false)
            requestFocusForPane(
              focusedPane,
              leftFocusRequester,
              centerFocusRequester,
              rightFocusRequester,
            )
            true
          }
          // Arrow Up -> navigate up in event list
          event.key == Key.DirectionUp -> {
            onNavigateUp?.invoke()
            onNavigateUp != null
          }
          // Arrow Down -> navigate down in event list
          event.key == Key.DirectionDown -> {
            onNavigateDown?.invoke()
            onNavigateDown != null
          }
          // Enter -> select/inspect focused event
          event.key == Key.Enter -> {
            onSelectEvent?.invoke()
            onSelectEvent != null
          }
          // Escape -> deselect/close inspector
          event.key == Key.Escape -> {
            onDeselectEvent?.invoke()
            onDeselectEvent != null
          }
          // Vim-style keys (only when vim mode enabled and no modifier keys)
          vimModeEnabled && !event.isMetaPressed && !event.isShiftPressed -> {
            when (event.key) {
              Key.J -> {
                onNavigateDown?.invoke()
                onNavigateDown != null
              }
              Key.K -> {
                onNavigateUp?.invoke()
                onNavigateUp != null
              }
              Key.G -> {
                onJumpToTop?.invoke()
                onJumpToTop != null
              }
              // Vim / -> focus search (must be inside this branch to avoid
              // being shadowed by the catch-all else -> false above)
              Key.Slash -> {
                onFocusSearch?.invoke()
                onFocusSearch != null
              }
              else -> false
            }
          }
          // Vim G (Shift+g) -> jump to bottom
          vimModeEnabled && !event.isMetaPressed && event.isShiftPressed && event.key == Key.G -> {
            onJumpToBottom?.invoke()
            onJumpToBottom != null
          }
          else -> false
        }
      }
    ) {
      // macOS title bar spacer
      TitleBarSpacer()

      // Pane toggle toolbar
      PaneToggleToolbar(
        showLeftPane = showLeftPane,
        onToggleLeftPane = onToggleLeftPane,
        showRightPane = showRightPane,
        onToggleRightPane = onToggleRightPane,
        showBottomPane = showBottomPane,
        onToggleBottomPane = onToggleBottomPane,
      )

      // Main 3-pane area
      Row(Modifier.weight(1f)) {
        // Left sidebar (collapsible)
        if (showLeftPane) {
          Box(
            Modifier.width(leftPaneWidth)
              .fillMaxHeight()
              .focusRequester(leftFocusRequester)
              .focusTarget()
          ) {
            leftPaneContent()
          }
          VerticalDividerStub(
            onDrag = { delta ->
              leftPaneWidth = (leftPaneWidth + delta).coerceIn(150.dp, 400.dp)
            }
          )
        }

        // Center canvas (flex) + status bar
        Column(Modifier.weight(1f).focusRequester(centerFocusRequester).focusTarget()) {
          centerContent(Modifier.weight(1f))

          // Status bar
          StatusBarStub(
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
          )
        }

        // Right inspector (collapsible)
        if (showRightPane) {
          VerticalDividerStub(
            onDrag = { delta ->
              rightPaneWidth = (rightPaneWidth - delta).coerceIn(200.dp, 500.dp)
            }
          )
          Box(
            Modifier.width(rightPaneWidth)
              .fillMaxHeight()
              .focusRequester(rightFocusRequester)
              .focusTarget()
          ) {
            rightPaneContent()
          }
        }
      }

      // Bottom timeline (collapsible)
      if (showBottomPane) {
        HorizontalDividerStub(
          onDrag = { delta ->
            bottomPaneHeight = (bottomPaneHeight - delta).coerceIn(80.dp, 300.dp)
          }
        )
        Box(Modifier.fillMaxWidth().height(bottomPaneHeight)) {
          bottomPaneContent()
        }
      }
    }

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

/** Builds the ordered list of visible panes given current visibility. */
private fun visiblePanes(showLeft: Boolean, showRight: Boolean): List<FocusedPane> = buildList {
  if (showLeft) add(FocusedPane.Left)
  add(FocusedPane.Center)
  if (showRight) add(FocusedPane.Right)
}

/** Cycles to the next or previous pane, skipping hidden panes. */
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

/** Requests focus for the given pane. */
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

// ---------------------------------------------------------------------------
// Stub composables — replaced by real implementations when units 1-7 merge
// ---------------------------------------------------------------------------

/** Reserves space for the macOS native transparent title bar (28dp). */
@Composable
private fun TitleBarSpacer() {
  val isMacOS = remember {
    System.getProperty("os.name")?.lowercase()?.contains("mac") == true
  }
  if (isMacOS) {
    Spacer(Modifier.fillMaxWidth().height(28.dp))
  }
}

/** Thin vertical divider with horizontal drag-to-resize. Double-tap resets to default. */
@Composable
private fun VerticalDividerStub(onDrag: (Dp) -> Unit, onReset: () -> Unit = {}) {
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
      }
  )
}

/** Thin horizontal divider with vertical drag-to-resize. Double-tap resets to default. */
@Composable
private fun HorizontalDividerStub(onDrag: (Dp) -> Unit, onReset: () -> Unit = {}) {
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
      }
  )
}

/** Format elapsed time in seconds as "Xm Ys". */
private fun formatElapsed(elapsedSeconds: Long): String {
  val minutes = elapsedSeconds / 60
  val seconds = elapsedSeconds % 60
  return if (minutes > 0) "${minutes}m ${seconds}s" else "${seconds}s"
}

/** Status bar showing failure counts, FPS, memory, and connection state. */
@Composable
private fun StatusBarStub(
  crashCount: Int,
  anrCount: Int,
  nonFatalCount: Int,
  toolFailureCount: Int,
  currentFps: Float?,
  currentMemoryMb: Float?,
  isDaemonConnected: Boolean,
  deviceName: String?,
  foregroundApp: String?,
  networkReqPerSec: Float? = null,
  connectionStartTime: Long? = null,
  cpuUsagePercent: Float? = null,
) {
  val colors = SharedTheme.globalColors
  val totalFailures = crashCount + anrCount + nonFatalCount + toolFailureCount

  // Elapsed session timer — ticks every second when connectionStartTime is set
  var elapsedSeconds by remember { mutableStateOf(0L) }
  LaunchedEffect(connectionStartTime) {
    if (connectionStartTime != null) {
      while (true) {
        elapsedSeconds = (System.currentTimeMillis() - connectionStartTime) / 1000L
        delay(1000L)
      }
    } else {
      elapsedSeconds = 0L
    }
  }

  Row(
    Modifier.fillMaxWidth()
      .height(24.dp)
      .background(colors.panelBackground)
      .padding(horizontal = 8.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    // Connection indicator — clickable segment
    val connColor =
      if (isDaemonConnected) Color(0xFF4CAF50) else colors.text.normal.copy(alpha = 0.3f)
    Text(
      text = if (isDaemonConnected) "Connected" else "Disconnected",
      fontSize = 10.sp,
      color = connColor,
    )

    // Session timer
    if (connectionStartTime != null && isDaemonConnected) {
      Spacer(Modifier.width(8.dp))
      Text(
        text = formatElapsed(elapsedSeconds),
        fontSize = 10.sp,
        color = colors.text.normal.copy(alpha = 0.5f),
      )
    }

    Spacer(Modifier.width(12.dp))

    // Device / app
    if (deviceName != null) {
      Text(
        text = deviceName + (foregroundApp?.let { " — $it" } ?: ""),
        fontSize = 10.sp,
        color = colors.text.normal.copy(alpha = 0.6f),
        maxLines = 1,
      )
    }

    Spacer(Modifier.weight(1f))

    // Network throughput
    networkReqPerSec?.let { rps ->
      Text(
        text = "${"%.0f".format(rps)} req/s",
        fontSize = 10.sp,
        color = colors.text.normal.copy(alpha = 0.6f),
      )
      Spacer(Modifier.width(12.dp))
    }

    // CPU usage — color-coded
    cpuUsagePercent?.let { cpu ->
      val cpuColor =
        when {
          cpu >= 80f -> colors.text.error
          cpu >= 50f -> colors.text.warning
          else -> Color(0xFF4CAF50)
        }
      Text(
        text = "CPU: ${"%.0f".format(cpu)}%",
        fontSize = 10.sp,
        color = cpuColor,
      )
      Spacer(Modifier.width(12.dp))
    }

    // Failure counts
    if (totalFailures > 0) {
      Text(
        text = "Failures: $totalFailures",
        fontSize = 10.sp,
        color = if (crashCount > 0) colors.text.error else colors.text.warning,
      )
      Spacer(Modifier.width(12.dp))
    }

    // FPS
    currentFps?.let { fps ->
      Text(
        text = "FPS: ${fps.toInt()}",
        fontSize = 10.sp,
        color =
          when {
            fps >= 55f -> Color(0xFF4CAF50)
            fps >= 30f -> colors.text.warning
            else -> colors.text.error
          },
      )
      Spacer(Modifier.width(12.dp))
    }

    // Memory
    currentMemoryMb?.let { mem ->
      Text(
        text = "Mem: ${mem.toInt()} MB",
        fontSize = 10.sp,
        color = colors.text.normal.copy(alpha = 0.6f),
      )
    }
  }
}

/** Toolbar row with pane toggle buttons (Xcode-style). */
@Composable
private fun PaneToggleToolbar(
  showLeftPane: Boolean,
  onToggleLeftPane: () -> Unit,
  showRightPane: Boolean,
  onToggleRightPane: () -> Unit,
  showBottomPane: Boolean,
  onToggleBottomPane: () -> Unit,
) {
  val colors = SharedTheme.globalColors
  Row(
    Modifier.fillMaxWidth()
      .height(28.dp)
      .background(colors.panelBackground)
      .padding(horizontal = 8.dp),
    horizontalArrangement = Arrangement.End,
    verticalAlignment = Alignment.CenterVertically,
  ) {
    PaneToggleIcon(
      label = "Left",
      isActive = showLeftPane,
      onClick = onToggleLeftPane,
    )
    Spacer(Modifier.width(4.dp))
    PaneToggleIcon(
      label = "Bottom",
      isActive = showBottomPane,
      onClick = onToggleBottomPane,
    )
    Spacer(Modifier.width(4.dp))
    PaneToggleIcon(
      label = "Right",
      isActive = showRightPane,
      onClick = onToggleRightPane,
    )
  }
}

@Composable
private fun PaneToggleIcon(
  label: String,
  isActive: Boolean,
  onClick: () -> Unit,
) {
  val colors = SharedTheme.globalColors
  val interactionSource = remember { MutableInteractionSource() }
  val isHovered by interactionSource.collectIsHoveredAsState()

  val targetAlpha =
    when {
      isActive -> 0.15f
      isHovered -> 0.10f
      else -> 0f
    }
  val bgColor by
    animateColorAsState(
      targetValue = colors.text.normal.copy(alpha = targetAlpha),
      animationSpec = tween(durationMillis = 100),
      label = "paneToggleBg",
    )

  Text(
    text = label,
    fontSize = 10.sp,
    color = if (isActive) colors.text.info else colors.text.normal.copy(alpha = 0.4f),
    modifier =
      Modifier.background(bgColor)
        .hoverable(interactionSource)
        .clickable(
          interactionSource = interactionSource,
          indication = null,
          onClick = onClick,
        )
        .padding(horizontal = 6.dp, vertical = 2.dp),
  )
}
