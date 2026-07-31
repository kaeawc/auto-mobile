package dev.jasonpearson.automobile.desktop

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.KeyShortcut
import androidx.compose.ui.input.key.isCtrlPressed
import androidx.compose.ui.input.key.isMetaPressed
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.type
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.MenuBar
import androidx.compose.ui.window.Window
import androidx.compose.ui.window.WindowPosition
import androidx.compose.ui.window.application
import androidx.compose.ui.window.rememberWindowState
import dev.jasonpearson.automobile.desktop.core.daemon.McpConnectionException
import dev.jasonpearson.automobile.desktop.core.di.LocalAutoMobileGraph
import dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory
import dev.jasonpearson.automobile.desktop.core.shell.MenuBarActions
import dev.jasonpearson.automobile.desktop.core.workspace.isCommandPaletteShortcut
import dev.jasonpearson.automobile.desktop.di.AutoMobileGraph
import dev.zacsweers.metro.createGraphFactory
import java.io.IOException
import java.io.RandomAccessFile
import java.nio.channels.FileLock
import java.nio.file.Path
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext

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

/** Logger for main-entrypoint diagnostics (Dock icon setup, etc.). */
private val LOG = LoggerFactory.getLogger("Main")

/**
 * Sets the macOS Dock icon from the bundled PNG. Guarded so non-macOS / unsupported platforms are a
 * no-op and never throw.
 *
 * Ordering constraint: [java.awt.Taskbar.getTaskbar] initializes the AWT toolkit, so this must run
 * only after `apple.awt.application.name` has been set.
 */
private fun setDockIcon() {
  if (!java.awt.Taskbar.isTaskbarSupported()) return
  val taskbar = java.awt.Taskbar.getTaskbar()
  if (!taskbar.isSupported(java.awt.Taskbar.Feature.ICON_IMAGE)) return
  val stream = Main::class.java.getResourceAsStream("/icons/app-icon.png") ?: return
  val image = stream.use { javax.imageio.ImageIO.read(it) } ?: return
  try {
    taskbar.iconImage = image
  } catch (e: UnsupportedOperationException) {
    // Some platforms report ICON_IMAGE support but still throw here; ignore but leave a trace.
    LOG.warn("Setting the Dock icon is unsupported on this platform", e)
  }
}

/** Marker class used to resolve bundled resources from the classpath. */
private class Main

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
    var isDaemonConnected by remember { mutableStateOf(false) }

    // Poll daemon connection state every 5 seconds using the DI graph's client.
    LaunchedEffect(Unit) {
      while (true) {
        isDaemonConnected =
          try {
            withContext(Dispatchers.IO) {
              graph.autoMobileClient.getDaemonStatus()
            }
            true
          } catch (_: IOException) {
            false
          } catch (_: McpConnectionException) {
            false
          }
        delay(5_000L)
      }
    }

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
              // ⌘K/Ctrl+K is handled by the window-level onPreviewKeyEvent below (opens the command
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
        )
      }
    }
  }
}
