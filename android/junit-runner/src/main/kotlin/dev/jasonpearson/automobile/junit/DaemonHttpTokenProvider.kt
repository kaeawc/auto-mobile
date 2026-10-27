package dev.jasonpearson.automobile.junit

import java.io.File
import java.net.URL
import java.nio.channels.Channels
import java.nio.file.Files
import java.nio.file.LinkOption.NOFOLLOW_LINKS
import java.nio.file.Path
import java.nio.file.StandardOpenOption.READ
import java.nio.file.attribute.BasicFileAttributes
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

internal fun interface DaemonHttpTokenProvider {
  fun read(): String?

  /**
   * The daemon's discovered HTTP port (the PID file `port`), re-resolved per request because
   * daemons restart on new ports. `null` means unverifiable, so any explicit port is accepted.
   */
  fun discoveredPort(): Int? = null
}

private val DAEMON_HTTP_HOSTS = setOf("localhost", "127.0.0.1", "[::1]")
private val DAEMON_HTTP_ROUTES = setOf("/auto-mobile/streamable", "/heartbeat")

/**
 * The URL's explicit port when it has a daemon-shaped origin and route, else null. Exact loopback
 * names only (other 127/8 and IPv4-mapped IPv6 addresses are excluded) and no implicit 80/443.
 */
internal fun daemonHttpPort(endpoint: URL): Int? =
  endpoint.port.takeIf {
    it in 1..65535 &&
      endpoint.protocol.lowercase() in setOf("http", "https") &&
      endpoint.host.lowercase() in DAEMON_HTTP_HOSTS &&
      endpoint.path in DAEMON_HTTP_ROUTES
  }

/**
 * Whether the daemon credential may be sent: an explicit-port loopback daemon route whose port
 * matches [discoveredPort]. A null [discoveredPort] is unverifiable, so any explicit port passes.
 */
internal fun isDaemonHttpEndpoint(endpoint: URL, discoveredPort: Int?): Boolean {
  val port = daemonHttpPort(endpoint) ?: return false
  return discoveredPort == null || port == discoveredPort
}

/** Best-effort read of the `port` field of the daemon PID file; never throws. */
internal fun readDaemonPidPort(
  pidPath: () -> String,
  readText: (String) -> String?,
  logUnavailable: (String) -> Unit = { message -> System.err.println(message) },
): Int? =
  try {
    readText(pidPath())
      ?.let { Json.parseToJsonElement(it).jsonObject["port"]?.jsonPrimitive?.intOrNull }
      ?.takeIf { it in 1..65535 }
  } catch (_: Exception) {
    // A missing or invalid daemon port leaves the port unverifiable; discovery is best effort.
    logUnavailable("Daemon PID file port unavailable")
    null
  }

/**
 * Re-reads discovery state for every HTTP request to harden daemon HTTP ingress with a per-daemon
 * token.
 */
internal class FileDaemonHttpTokenProvider(
  private val envProvider: (String) -> String? = System::getenv,
  private val userId: () -> String = DaemonUserIdResolver().let { resolver -> { resolver.userId } },
  private val files: DaemonHttpTokenFiles = NioDaemonHttpTokenFiles,
  private val tokenPlatform: DaemonTokenPlatform = DaemonTokenPlatform(),
  private val userDir: String = System.getProperty("user.dir", "."),
  private val logUnavailable: (String) -> Unit = { message -> System.err.println(message) },
) : DaemonHttpTokenProvider {
  override fun discoveredPort(): Int? =
    readDaemonPidPort(
      pidPath = {
        DaemonStatePaths.resolve(DaemonStateFile.PID, userId, envProvider, userDir, tokenPlatform)
      },
      readText = files::readPid,
      logUnavailable = logUnavailable,
    )

  override fun read(): String? {
    return try {
      envProvider("AUTOMOBILE_DAEMON_HTTP_TOKEN")?.trim()?.takeIf { it.isNotEmpty() }
        ?: files
          .read(
            DaemonStatePaths.resolve(
              DaemonStateFile.TOKEN,
              userId,
              envProvider,
              userDir,
              tokenPlatform,
            ),
            tokenPlatform.windows,
            userId,
          )
          ?.trim()
          ?.takeIf { it.isNotEmpty() }
    } catch (_: Exception) {
      // Discovery is best effort before daemon startup and while state files rotate.
      logUnavailable("Daemon HTTP token file unavailable")
      null
    }
  }
}

internal fun interface DaemonHttpTokenFiles {
  fun read(path: String, windows: Boolean, userId: () -> String): String?

  /** The PID file's text, or null when it does not exist. The token is never read from it. */
  fun readPid(path: String): String? = File(path).takeIf { it.exists() }?.readText()
}

internal object NioDaemonHttpTokenFiles : DaemonHttpTokenFiles {
  override fun read(path: String, windows: Boolean, userId: () -> String): String? {
    val file = Path.of(path)
    check(!Files.isSymbolicLink(file))
    val before = attributes(file, windows, userId)
    return Files.newByteChannel(file, setOf(READ, NOFOLLOW_LINKS)).use { channel ->
      val token = Channels.newInputStream(channel).bufferedReader(Charsets.UTF_8).readText()
      val after = attributes(file, windows, userId)
      check(before.fileKey() == after.fileKey())
      token
    }
  }

  private fun attributes(path: Path, windows: Boolean, userId: () -> String): BasicFileAttributes {
    val attributes = Files.readAttributes(path, BasicFileAttributes::class.java, NOFOLLOW_LINKS)
    check(attributes.isRegularFile && !attributes.isSymbolicLink)
    if (!windows) {
      check(Files.getAttribute(path, "unix:uid", NOFOLLOW_LINKS).toString() == userId())
      val mode = Files.getAttribute(path, "unix:mode", NOFOLLOW_LINKS) as Int
      check(mode and 0xfff == 0x180) // 0600, with no additional permission bits.
    }
    return attributes
  }
}
