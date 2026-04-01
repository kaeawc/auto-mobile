package dev.jasonpearson.automobile.desktop

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Window
import androidx.compose.ui.window.WindowPosition
import androidx.compose.ui.window.application
import androidx.compose.ui.window.rememberWindowState
import dev.jasonpearson.automobile.desktop.di.AutoMobileGraph
import dev.zacsweers.metro.createGraphFactory
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
  // TODO: Pass graph dependencies to AutoMobileDesktopApp once UI is wired to DI.
  @Suppress("UNUSED_VARIABLE")
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
    // TODO: Wire isDaemonConnected to real daemon connection state from the DI graph.
    var isDaemonConnected by remember { mutableStateOf(false) }

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
      AutoMobileDesktopApp()
    }
  }
}
