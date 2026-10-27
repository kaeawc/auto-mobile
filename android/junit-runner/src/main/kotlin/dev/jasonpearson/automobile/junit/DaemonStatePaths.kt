package dev.jasonpearson.automobile.junit

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
  TOKEN("token", "AUTOMOBILE_DAEMON_TOKEN_FILE_PATH", "AUTOMOBILE_DAEMON_TOKEN_FILE_PATH"),
}

/** Platform settings for token discovery, shared by the path resolver and file reader. */
internal data class DaemonTokenPlatform(
  val windows: Boolean = System.getProperty("os.name", "").startsWith("Windows", ignoreCase = true),
  val tempDir: String = System.getProperty("java.io.tmpdir", "."),
)

/**
 * Port of `resolveDaemonStatePath` (`src/daemon/wire/constants.ts`): an explicit
 * `AUTOMOBILE_DAEMON_*_PATH` override (resolved against the daemon launch directory) first, then
 * `/tmp/auto-mobile-daemon-<uid><suffix>.<ext>`, where the suffix isolates an
 * `AUTOMOBILE_AUX_SOCKET_DIR` daemon (#10881). The runner launches `auto-mobile --daemon start`
 * with its own environment, so it must resolve the same paths the daemon it starts will use
 * (#10906). Tested against the shared vectors in `test/fixtures/daemon-isolation-paths.json`.
 */
internal object DaemonStatePaths {
  private const val AUX_SOCKET_DIR_ENV = "AUTOMOBILE_AUX_SOCKET_DIR"
  private const val DAEMON_LAUNCH_CWD_ENV = "AUTOMOBILE_DAEMON_LAUNCH_CWD"
  private const val ISOLATION_HASH_HEX_CHARS = 10

  /** [userId] is lazy so an explicit override never pays for the uid lookup. */
  fun resolve(
    file: DaemonStateFile,
    userId: () -> String,
    envProvider: (String) -> String? = System::getenv,
    userDir: String = System.getProperty("user.dir", "."),
    tokenPlatform: DaemonTokenPlatform = DaemonTokenPlatform(),
  ): String {
    val override =
      (envProvider(file.overrideEnv) ?: envProvider(file.legacyOverrideEnv))?.trim().orEmpty()
    if (override.isNotEmpty()) return resolveFromDaemonLaunchCwd(override, envProvider, userDir)
    if (file == DaemonStateFile.TOKEN && tokenPlatform.windows) {
      val base = envProvider("LOCALAPPDATA")?.takeIf { it.isNotBlank() } ?: tokenPlatform.tempDir
      val suffix = isolationSuffix(envProvider, userDir)
      return Path.of(base, "auto-mobile", "daemon$suffix.token").toString()
    }
    return "/tmp/auto-mobile-daemon-${userId()}${isolationSuffix(envProvider, userDir)}.${file.extension}"
  }

  /** `-<first 10 hex chars of sha256(resolved aux dir)>`, or "" without an aux dir. */
  fun isolationSuffix(
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
}
