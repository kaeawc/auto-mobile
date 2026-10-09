package dev.jasonpearson.automobile.desktop.core.daemon

import java.io.File
import java.nio.file.Files
import java.nio.file.Path
import java.security.MessageDigest
import java.util.Locale

/** A daemon state file under `/tmp`, with the env vars that override its path. */
internal enum class DaemonStateFile(
  val extension: String,
  val overrideEnv: String,
  val legacyOverrideEnv: String,
) {
  SOCKET("sock", "AUTOMOBILE_DAEMON_SOCKET_PATH", "AUTO_MOBILE_DAEMON_SOCKET_PATH"),
  PID("pid", "AUTOMOBILE_DAEMON_PID_FILE_PATH", "AUTO_MOBILE_DAEMON_PID_FILE_PATH"),
}

/**
 * Resolves the daemon's socket paths: the auxiliary sockets, which live in `~/.auto-mobile/` or
 * `AUTOMOBILE_AUX_SOCKET_DIR`, and the control socket / PID file under `/tmp`, which the same
 * `AUTOMOBILE_AUX_SOCKET_DIR` isolates. Keeping both here means the desktop app can never talk to
 * one daemon's aux sockets and another daemon's control socket (#10906).
 */
object AutoMobileSocketPaths {
  private const val SOCKET_DIR = ".auto-mobile"
  private const val AUX_SOCKET_DIR_ENV = "AUTOMOBILE_AUX_SOCKET_DIR"
  private const val DAEMON_LAUNCH_CWD_ENV = "AUTOMOBILE_DAEMON_LAUNCH_CWD"
  private const val ISOLATION_HASH_HEX_CHARS = 10

  /** Absolute path of the named socket, e.g. `socketPath("device-snapshot.sock")`. */
  fun socketPath(fileName: String): String =
    resolveSocketPath(
      fileName,
      envProvider = System::getenv,
      userHome = System.getProperty("user.home", ""),
      userDir = System.getProperty("user.dir", "."),
    )

  internal fun resolveSocketPath(
    fileName: String,
    envProvider: (String) -> String?,
    userHome: String = System.getProperty("user.home", ""),
    userDir: String = System.getProperty("user.dir", "."),
  ): String {
    return File(resolveSocketDir(envProvider, userHome, userDir), fileName).path
  }

  internal fun resolveSocketDir(
    envProvider: (String) -> String?,
    userHome: String = System.getProperty("user.home", ""),
    userDir: String = System.getProperty("user.dir", "."),
  ): String {
    val override = envProvider("AUTOMOBILE_AUX_SOCKET_DIR")?.trim()
    if (!override.isNullOrEmpty()) {
      val overridePath = Path.of(override)
      if (overridePath.isAbsolute) return override
      val launchCwd =
        envProvider("AUTOMOBILE_DAEMON_LAUNCH_CWD")?.trim().takeUnless { it.isNullOrEmpty() }
          ?: userDir
      return Path.of(launchCwd, override).toString()
    }

    // Falling back to "." keeps this a relative path rather than interpolating "null" into it on
    // the rare JVM where user.home is unset.
    val home = userHome.ifBlank { "." }
    return File(home, SOCKET_DIR).path
  }

  /**
   * Effective daemon state-file path, ported from `resolveDaemonStatePath` in
   * `src/daemon/constants.ts`: an explicit `AUTOMOBILE_DAEMON_*_PATH` override (resolved against
   * the daemon launch directory) first, then `/tmp/auto-mobile-daemon-<uid><suffix>.<ext>` where
   * the suffix isolates an `AUTOMOBILE_AUX_SOCKET_DIR` daemon. [userId] is lazy so an override
   * never pays for the uid lookup. Tested against `test/fixtures/daemon-isolation-paths.json`.
   */
  internal fun daemonStatePath(
    file: DaemonStateFile,
    userId: () -> String,
    envProvider: (String) -> String? = System::getenv,
    userDir: String = System.getProperty("user.dir", "."),
  ): String {
    val override =
      (envProvider(file.overrideEnv) ?: envProvider(file.legacyOverrideEnv))?.trim().orEmpty()
    if (override.isNotEmpty()) return resolveFromDaemonLaunchCwd(override, envProvider, userDir)
    val suffix = daemonIsolationSuffix(envProvider, userDir)
    return "/tmp/auto-mobile-daemon-${userId()}$suffix.${file.extension}"
  }

  /** `-<first 10 hex chars of sha256(resolved aux dir)>`, or "" without an aux dir. */
  internal fun daemonIsolationSuffix(
    envProvider: (String) -> String?,
    userDir: String = System.getProperty("user.dir", "."),
  ): String {
    val auxDir = envProvider(AUX_SOCKET_DIR_ENV)?.trim().orEmpty()
    if (auxDir.isEmpty()) return ""
    val resolved = resolveFromDaemonLaunchCwd(auxDir, envProvider, userDir)
    val digest = MessageDigest.getInstance("SHA-256").digest(resolved.toByteArray(Charsets.UTF_8))
    return "-" +
      digest.joinToString("") { "%02x".format(Locale.ROOT, it) }.take(ISOLATION_HASH_HEX_CHARS)
  }

  /**
   * Mirrors `resolvePathFromDaemonLaunchWorkingDirectory`: an absolute path is kept verbatim, a
   * relative one is resolved (and normalized) against an absolute `AUTOMOBILE_DAEMON_LAUNCH_CWD`,
   * else [userDir].
   */
  private fun resolveFromDaemonLaunchCwd(
    path: String,
    envProvider: (String) -> String?,
    userDir: String,
  ): String {
    if (Path.of(path).isAbsolute) return path
    val launchCwd =
      envProvider(DAEMON_LAUNCH_CWD_ENV)?.trim()?.takeIf {
        it.isNotEmpty() && Path.of(it).isAbsolute
      } ?: userDir
    return Path.of(launchCwd).resolve(path).normalize().toString()
  }

  /** True when the daemon currently exposes this socket. False on daemons that predate it. */
  fun socketExists(fileName: String): Boolean = Files.exists(Path.of(socketPath(fileName)))
}
