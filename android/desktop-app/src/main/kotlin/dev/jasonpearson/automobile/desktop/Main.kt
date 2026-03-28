package dev.jasonpearson.automobile.desktop

import androidx.compose.ui.Alignment
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Window
import androidx.compose.ui.window.WindowPosition
import androidx.compose.ui.window.application
import androidx.compose.ui.window.rememberWindowState
import dev.jasonpearson.automobile.desktop.core.settings.FileWindowStateManager
import java.io.RandomAccessFile
import java.nio.channels.FileLock
import java.nio.file.Path

/**
 * Returns true if the given window position (in dp, which at 96 dpi equals pixels on most systems)
 * falls within the bounds of at least one currently attached screen. Falls back to true on error
 * so a bad screen-device query never prevents the app from opening.
 */
private fun isPositionOnScreen(xDp: Float, yDp: Float): Boolean {
    return try {
        val screens = java.awt.GraphicsEnvironment.getLocalGraphicsEnvironment().screenDevices
        screens.any { device ->
            val bounds = device.defaultConfiguration.bounds
            bounds.contains(xDp.toInt(), yDp.toInt())
        }
    } catch (_: Exception) {
        true
    }
}

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

  // Force dark window decorations on macOS
  System.setProperty("apple.awt.application.appearance", "NSAppearanceNameDarkAqua")

  // Enable macOS native transparent title bar
  if (System.getProperty("os.name")?.lowercase()?.contains("mac") == true) {
      System.setProperty("apple.awt.fullWindowContent", "true")
      System.setProperty("apple.awt.transparentTitleBar", "true")
  }

  // Load persisted window geometry (size + position)
  val wsm = FileWindowStateManager()
  val saved = wsm.load()

  application {
    val savedX = saved.windowXDp
    val savedY = saved.windowYDp
    val windowState = rememberWindowState(
      size = DpSize(saved.windowWidthDp.dp, saved.windowHeightDp.dp),
      position = if (savedX != null && savedY != null && isPositionOnScreen(savedX, savedY)) {
          WindowPosition(savedX.dp, savedY.dp)
      } else {
          WindowPosition(Alignment.Center)
      },
    )

    Window(
      onCloseRequest = {
          // Save window geometry before exiting
          val current = wsm.load()
          val pos = windowState.position
          val posX = if (pos.isSpecified) pos.x.value else null
          val posY = if (pos.isSpecified) pos.y.value else null
          wsm.save(
              current.copy(
                  windowWidthDp = windowState.size.width.value,
                  windowHeightDp = windowState.size.height.value,
                  windowXDp = posX,
                  windowYDp = posY,
              )
          )
          exitApplication()
      },
      title = "AutoMobile",
      state = windowState,
    ) {
      AutoMobileDesktopApp()
    }
  }
}
