package dev.jasonpearson.automobile.desktop

import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyShortcut
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.MenuBar
import androidx.compose.ui.window.Window
import androidx.compose.ui.window.WindowPosition
import androidx.compose.ui.window.application
import androidx.compose.ui.window.rememberWindowState
import dev.jasonpearson.automobile.desktop.core.daemon.McpConnectionException
import dev.jasonpearson.automobile.desktop.di.AutoMobileGraph
import dev.zacsweers.metro.createGraphFactory
import java.io.IOException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import java.io.RandomAccessFile
import java.nio.channels.FileLock
import java.nio.file.Path

/** Lock file ensuring only one instance of the desktop app runs at a time. */
private val LOCK_FILE: Path = Path.of(System.getProperty("java.io.tmpdir"), "automobile-desktop.lock")
private var lock: FileLock? = null

/**
 * Acquire an exclusive file lock. Returns true if this is the only instance;
 * returns false if another instance already holds the lock.
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

fun main() {
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

  application {
    var isWindowVisible by remember { mutableStateOf(true) }
    var isDaemonConnected by remember { mutableStateOf(false) }

    // Poll daemon connection state every 5 seconds using the DI graph's client.
    LaunchedEffect(Unit) {
      while (true) {
        isDaemonConnected = try {
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

    val windowState = rememberWindowState(
      size = DpSize(1440.dp, 900.dp),
      position = WindowPosition(Alignment.Center),
    )

    Window(
      onCloseRequest = { isWindowVisible = false },
      title = "AutoMobile",
      state = windowState,
      visible = isWindowVisible,
    ) {
      MenuBar {
        Menu("File", mnemonic = 'F') {
          Item(
            "Settings",
            onClick = { /* TODO: open settings dialog */ },
            shortcut = KeyShortcut(Key.Comma, meta = true),
          )
          Separator()
          Item(
            "Quit",
            onClick = { exitApplication() },
            shortcut = KeyShortcut(Key.Q, meta = true),
          )
        }
        Menu("View", mnemonic = 'V') {
          Item(
            "Toggle Left Pane",
            onClick = { /* TODO: toggle left pane visibility */ },
            shortcut = KeyShortcut(Key.Zero, meta = true),
          )
          Item(
            "Toggle Right Pane",
            onClick = { /* TODO: toggle right pane visibility */ },
            shortcut = KeyShortcut(Key.Zero, meta = true, shift = true),
          )
          Item(
            "Toggle Bottom Pane",
            onClick = { /* TODO: toggle bottom pane visibility */ },
            shortcut = KeyShortcut(Key.Y, meta = true, shift = true),
          )
        }
        Menu("Tools", mnemonic = 'T') {
          Item(
            "Command Palette",
            onClick = { /* TODO: open command palette */ },
            shortcut = KeyShortcut(Key.P, meta = true, shift = true),
          )
          Item(
            "Global Search",
            onClick = { /* TODO: open global search */ },
            shortcut = KeyShortcut(Key.F, meta = true, shift = true),
          )
          Item(
            "Quick Jump",
            onClick = { /* TODO: open quick jump dialog */ },
            shortcut = KeyShortcut(Key.K, meta = true),
          )
          Separator()
          Item(
            "Take Screenshot",
            onClick = { /* TODO: trigger screenshot capture */ },
            shortcut = KeyShortcut(Key.S, meta = true, shift = true),
          )
        }
        Menu("Help", mnemonic = 'H') {
          Item(
            "Keyboard Shortcuts",
            onClick = { /* TODO: show shortcut cheat sheet */ },
            shortcut = KeyShortcut(Key.Slash, meta = true),
          )
          Separator()
          Item("About AutoMobile", onClick = { /* TODO: show about dialog */ })
        }
      }
      AutoMobileDesktopApp()
    }
  }
}
