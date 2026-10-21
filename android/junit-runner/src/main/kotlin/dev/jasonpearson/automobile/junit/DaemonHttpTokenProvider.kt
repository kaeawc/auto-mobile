package dev.jasonpearson.automobile.junit

import java.net.URL
import java.nio.channels.Channels
import java.nio.file.Files
import java.nio.file.LinkOption.NOFOLLOW_LINKS
import java.nio.file.Path
import java.nio.file.StandardOpenOption.READ
import java.nio.file.attribute.BasicFileAttributes

internal fun interface DaemonHttpTokenProvider {
  fun read(): String?
}

/** Exact loopback names only; other 127/8 and IPv4-mapped IPv6 addresses are excluded. */
internal fun isDaemonHttpEndpoint(endpoint: URL): Boolean =
  endpoint.protocol.lowercase() in setOf("http", "https") &&
    endpoint.host.lowercase() in setOf("localhost", "127.0.0.1", "::1", "[::1]")

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
