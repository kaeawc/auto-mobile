package dev.jasonpearson.automobile.desktop.core.daemon

import java.io.File
import java.nio.file.Files
import java.nio.file.Path

/**
 * Resolves the daemon's auxiliary socket paths, which all live in `~/.auto-mobile/`.
 *
 * This is the single place that knows that layout. The control socket is deliberately not here --
 * it lives under the temp dir with a uid suffix and its own Windows fallback, so it keeps its own
 * resolver in [DaemonSocketPaths].
 */
object AutoMobileSocketPaths {
  private const val SOCKET_DIR = ".auto-mobile"

  /** Absolute path of the named socket, e.g. `socketPath("device-snapshot.sock")`. */
  fun socketPath(fileName: String): String {
    // Falling back to "." keeps this a relative path rather than interpolating "null" into it on
    // the rare JVM where user.home is unset.
    val home = System.getProperty("user.home", "").ifBlank { "." }
    return File(home, "$SOCKET_DIR/$fileName").path
  }

  /** True when the daemon currently exposes this socket. False on daemons that predate it. */
  fun socketExists(fileName: String): Boolean = Files.exists(Path.of(socketPath(fileName)))
}
