package dev.jasonpearson.automobile.desktop

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.KeyShortcut
import androidx.compose.ui.input.key.isCtrlPressed
import androidx.compose.ui.input.key.isMetaPressed
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.type
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.LocalWindowExceptionHandlerFactory
import androidx.compose.ui.window.MenuBar
import androidx.compose.ui.window.Window
import androidx.compose.ui.window.WindowExceptionHandler
import androidx.compose.ui.window.WindowExceptionHandlerFactory
import androidx.compose.ui.window.WindowPosition
import androidx.compose.ui.window.application
import androidx.compose.ui.window.rememberWindowState
import dev.jasonpearson.automobile.desktop.core.connection.ConnectionState
import dev.jasonpearson.automobile.desktop.core.connection.DaemonConnectionMonitor
import dev.jasonpearson.automobile.desktop.core.di.LocalAutoMobileGraph
import dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory
import dev.jasonpearson.automobile.desktop.core.platform.uncaughtUiErrorMessage
import dev.jasonpearson.automobile.desktop.core.shell.MenuBarActions
import dev.jasonpearson.automobile.desktop.core.workspace.isCommandPaletteShortcut
import dev.jasonpearson.automobile.desktop.di.AutoMobileGraph
import dev.zacsweers.metro.createGraphFactory
import java.io.RandomAccessFile
import java.nio.channels.FileLock
import java.nio.file.Path
import javax.swing.JOptionPane
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

private val LOG = LoggerFactory.getLogger("Main")

/** True when running on macOS; used to pick Meta (Cmd) vs Ctrl for accelerators. */
private val IS_MACOS: Boolean = System.getProperty("os.name")?.lowercase()?.contains("mac") == true

/**
 * Creates a [KeyShortcut] that uses Meta (Cmd) on macOS and Ctrl on other platforms, matching the
 * convention already used in [AutoMobileContent] keyboard handlers.
 */
private fun platformShortcut(
  key: Key,
  shift: Boolean = false,
): KeyShortcut = KeyShortcut(key, meta = IS_MACOS, ctrl = !IS_MACOS, shift = shift)

/** Lock file ensuring only one instance of the desktop app runs at a time. */
private val LOCK_FILE: Path =
  Path.of(System.getProperty("java.io.tmpdir"), "automobile-desktop.lock")
private var lock: FileLock? = null

/**
 * Acquire an exclusive file lock. Returns true if this is the only instance; returns false if
 * another instance already holds the lock.
 */
private fun acquireSingleInstanceLock(): Boolean {
  return try {
    val raf = RandomAccessFile(LOCK_FILE.toFile(), "rw")
    val channel = raf.channel
    lock = channel.tryLock()
    lock != null
  } catch (_: Exception) {
    // If locking fails (e.g., permissions), allow the app to run anyway
    true
  }
}

@OptIn(ExperimentalComposeUiApi::class)
fun main() {
  // Must run before any AWT toolkit initialization so the app name is picked up.
  System.setProperty("apple.awt.application.name", "AutoMobile")

  if (!acquireSingleInstanceLock()) {
    System.err.println("AutoMobile Desktop is already running. Exiting.")
    return
  }

  // Create the dependency graph via Metro-generated factory.
  val graph = createGraphFactory<AutoMobileGraph.Factory>().create()

  // Force dark window decorations on macOS
  System.setProperty("apple.awt.application.appearance", "NSAppearanceNameDarkAqua")

  // Enable macOS native transparent title bar
  if (System.getProperty("os.name")?.lowercase()?.contains("mac") == true) {
    System.setProperty("apple.awt.fullWindowContent", "true")
    System.setProperty("apple.awt.transparentTitleBar", "true")
  }

  // Set the macOS Dock icon. Runs after apple.awt.application.name is set above, since
  // Taskbar.getTaskbar() initializes the AWT toolkit.
  setDockIcon()

  application {
    var isWindowVisible by remember { mutableStateOf(true) }

    // Poll daemon connectivity through the same injectable, timeout-bounded seam that backs the
    // in-window status dot (#4858), so the tray and the dot share one daemon-health source rather
    // than running two overlapping 5s loops.
    val daemonMonitor = remember {
      DaemonConnectionMonitor(
        probe = { withContext(Dispatchers.IO) { graph.autoMobileClient.getDaemonStatus() } },
        // A failed status call means the daemon socket is unreachable; the dot/tray go red via the
        // returned Disconnected state, and this keeps a trace behind them.
        onProbeFailure = { error ->
          LOG.warn("Daemon status poll failed: ${error.message}", error)
        },
      )
    }
    val daemonState by
      daemonMonitor.connectionStates.collectAsState(initial = ConnectionState.Connecting)
    val isDaemonConnected = daemonState is ConnectionState.Connected

    AutoMobileSystemTray(
      isConnected = isDaemonConnected,
      isWindowVisible = isWindowVisible,
      onToggleWindow = { isWindowVisible = !isWindowVisible },
      onQuit = ::exitApplication,
    )

    val windowState =
      rememberWindowState(
        size = DpSize(1440.dp, 900.dp),
        position = WindowPosition(Alignment.Center),
      )

    // Shared callback bridge between the native MenuBar and the Compose UI tree.
    // AutoMobileContent wires pane-visibility state and action callbacks into this
    // object, so the menu items below toggle real UI state.
    val menuBarActions = remember { MenuBarActions() }

    // Global ⌘K/Ctrl+K opens the command palette. The window key handler only decides *whether* the
    // shortcut fired (via the pure, tested isCommandPaletteShortcut) and bumps this counter; the
    // workspace observes the bump and opens the palette (guarding onboarding/picker). A counter,
    // not a Boolean, so repeat presses each register even while the palette is already open.
    var openPaletteRequest by remember { mutableStateOf(0) }

    // Last-resort handler for uncaught exceptions on the UI thread. Compose Desktop's default
    // shows a bare Swing dialog containing only the throwable's toString() (a NoClassDefFoundError
    // renders as an unreadable slash-form class path) and logs nothing. Ours logs the full stack
    // and shows a readable message with a restart hint for the rebuilt-jar case. The dialog stays
    // native (JOptionPane) on purpose: this surface exists precisely for "composition is broken",
    // so it must not depend on Compose rendering. See uncaughtUiErrorMessage.
    val uiExceptionHandlerFactory = remember {
      WindowExceptionHandlerFactory { window ->
        WindowExceptionHandler { throwable ->
          LOG.error("Uncaught UI exception: ${throwable.message}", throwable)
          JOptionPane.showMessageDialog(
            window,
            uncaughtUiErrorMessage(throwable),
            "AutoMobile",
            JOptionPane.ERROR_MESSAGE,
          )
        }
      }
    }

    CompositionLocalProvider(
      LocalWindowExceptionHandlerFactory provides uiExceptionHandlerFactory
    ) {
      Window(
        onCloseRequest = { isWindowVisible = false },
        title = "AutoMobile",
        state = windowState,
        visible = isWindowVisible,
        onPreviewKeyEvent = { event ->
          if (
            event.type == KeyEventType.KeyDown &&
              isCommandPaletteShortcut(event.key, event.isMetaPressed, event.isCtrlPressed)
          ) {
            openPaletteRequest++
            true
          } else {
            false
          }
        },
      ) {
        CompositionLocalProvider(LocalAutoMobileGraph provides graph) {
          MenuBar {
            Menu("File", mnemonic = 'F') {
              Item(
                "Settings",
                onClick = { menuBarActions.showSettings = true },
                shortcut = platformShortcut(Key.Comma),
              )
              Separator()
              Item(
                "Quit",
                onClick = { exitApplication() },
                shortcut = platformShortcut(Key.Q),
              )
            }
            Menu("View", mnemonic = 'V') {
              Item(
                "Toggle Left Pane",
                onClick = { menuBarActions.showLeftPane = !menuBarActions.showLeftPane },
                shortcut = platformShortcut(Key.Zero),
              )
              Item(
                "Toggle Right Pane",
                onClick = { menuBarActions.showRightPane = !menuBarActions.showRightPane },
                shortcut = platformShortcut(Key.Zero, shift = true),
              )
              Item(
                "Toggle Bottom Pane",
                onClick = { menuBarActions.showBottomPane = !menuBarActions.showBottomPane },
                shortcut = platformShortcut(Key.Y, shift = true),
              )
            }
            Menu("Tools", mnemonic = 'T') {
              Item(
                "Command Palette",
                onClick = { menuBarActions.showCommandPalette = true },
                shortcut = platformShortcut(Key.P, shift = true),
              )
              Item(
                "Global Search",
                onClick = { menuBarActions.showGlobalSearch = true },
                shortcut = platformShortcut(Key.F, shift = true),
              )
              Item(
                // ⌘K/Ctrl+K is handled by the window-level onPreviewKeyEvent below (opens the
                // command
                // palette). No shortcut here — a duplicate Key.K accelerator on this (currently
                // inert)
                // item would race the window handler. Re-wiring this menu item + restoring its
                // shortcut is tracked in #4670.
                "Quick Jump",
                onClick = { menuBarActions.showQuickJump = true },
              )
              Separator()
              Item(
                "Take Screenshot",
                onClick = { menuBarActions.onTakeScreenshot?.invoke() },
                shortcut = platformShortcut(Key.S, shift = true),
              )
            }
            Menu("Help", mnemonic = 'H') {
              Item(
                "Keyboard Shortcuts",
                onClick = { menuBarActions.showCheatSheet = true },
                shortcut = platformShortcut(Key.Slash),
              )
              Separator()
              Item("About AutoMobile", onClick = { /* TODO: show about dialog */ })
            }
          }
          AutoMobileDesktopApp(
            menuBarActions = menuBarActions,
            openPaletteRequest = openPaletteRequest,
            daemonConnectionState = daemonState,
          )
        }
      }
    }
  }
}
