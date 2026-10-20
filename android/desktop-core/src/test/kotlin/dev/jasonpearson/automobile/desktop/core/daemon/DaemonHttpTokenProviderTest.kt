package dev.jasonpearson.automobile.desktop.core.daemon

import java.io.IOException
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.attribute.PosixFilePermissions
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import org.junit.After
import org.junit.Assume.assumeTrue
import org.junit.BeforeClass
import org.junit.Test

class DaemonHttpTokenProviderTest {
  private val files = FakeTokenFiles()
  private val env = mutableMapOf<String, String>()
  private val logs = mutableListOf<String>()
  private val reader =
    FileDaemonHttpTokenProvider(
      envProvider = env::get,
      userId = { "501" },
      files = files,
      tokenPlatform = DaemonTokenPlatform(windows = false),
      userDir = "/launch",
      logUnavailable = logs::add,
    )
  private var directory: Path? = null

  @After
  fun cleanup() {
    directory?.let { root ->
      Files.walk(root).use { paths ->
        paths.sorted(Comparator.reverseOrder()).forEach(Files::delete)
      }
    }
  }

  @Test
  fun `trimmed environment token takes precedence without opening a file`() {
    env["AUTOMOBILE_DAEMON_HTTP_TOKEN"] = "  environment-token\n"
    assertEquals("environment-token", reader.read())
    assertTrue(files.paths.isEmpty())
  }

  @Test
  fun `blank environment falls back to file and reads every time`() {
    env["AUTOMOBILE_DAEMON_HTTP_TOKEN"] = " \n"
    files.content = "  first-token\n"
    assertEquals("first-token", reader.read())
    files.content = "second-token\n"
    assertEquals("second-token", reader.read())
    assertEquals(List(2) { "/tmp/auto-mobile-daemon-501.token" }, files.paths)
    files.content = " \n"
    assertNull(reader.read())
  }

  @Test
  fun `relative override resolves against launch cwd and skips uid for discovery`() {
    env["AUTOMOBILE_DAEMON_TOKEN_FILE_PATH"] = "state/../private.token"
    val launchCwd = Path.of("lane").toAbsolutePath()
    env["AUTOMOBILE_DAEMON_LAUNCH_CWD"] = launchCwd.toString()
    val provider =
      FileDaemonHttpTokenProvider(
        envProvider = env::get,
        files = files,
        userId = { error("uid not needed by fake files") },
        tokenPlatform = DaemonTokenPlatform(windows = false),
      )
    assertEquals("file-token", provider.read())
    assertEquals(listOf(launchCwd.resolve("private.token").toString()), files.paths)
  }

  @Test
  fun `read failures and invalid paths return no token without logging values`() {
    files.failure = IOException("file-token")
    assertNull(reader.read())
    env["AUTOMOBILE_DAEMON_TOKEN_FILE_PATH"] = "bad\u0000file-token"
    assertNull(reader.read())
    assertEquals(List(2) { "Daemon HTTP token file unavailable" }, logs)
  }

  @Test
  fun `Windows uses local app data or temporary directory and includes isolation`() {
    env["LOCALAPPDATA"] = "C:/Users/test/AppData/Local"
    env["AUTOMOBILE_AUX_SOCKET_DIR"] = Path.of("lane", "aux").toAbsolutePath().toString()
    val suffix = AutoMobileSocketPaths.daemonIsolationSuffix(env::get)
    val provider =
      FileDaemonHttpTokenProvider(
        envProvider = env::get,
        files = files,
        tokenPlatform = DaemonTokenPlatform(windows = true, tempDir = "C:/Temp"),
        userId = { error("Windows does not need uid") },
      )
    provider.read()
    env.remove("LOCALAPPDATA")
    provider.read()
    env.remove("AUTOMOBILE_AUX_SOCKET_DIR")
    provider.read()
    assertEquals(
      listOf(
        Path.of("C:/Users/test/AppData/Local", "auto-mobile", "daemon$suffix.token").toString(),
        Path.of("C:/Temp", "auto-mobile", "daemon$suffix.token").toString(),
        Path.of("C:/Temp", "auto-mobile", "daemon.token").toString(),
      ),
      files.paths,
    )
  }

  @Test
  fun `NIO accepts private regular files and rejects other modes and owners`() {
    assumeTrue(java.io.File.separatorChar == '/')
    val path = privateFile()
    val provider = nioReader(path)
    assertEquals("private-token", provider.read())
    Files.setPosixFilePermissions(path, PosixFilePermissions.fromString("rw-r-----"))
    assertNull(provider.read())
    Files.setPosixFilePermissions(path, PosixFilePermissions.fromString("rw----r--"))
    assertNull(provider.read())
    Files.setPosixFilePermissions(path, PosixFilePermissions.fromString("r--------"))
    assertNull(provider.read())
    Files.setPosixFilePermissions(path, PosixFilePermissions.fromString("rw-------"))
    assertNull(nioReader(path, "not-the-owner").read())
  }

  @Test
  fun `NIO rejects symlinks directories and missing files`() {
    assumeTrue(java.io.File.separatorChar == '/')
    val target = privateFile()
    val link = target.resolveSibling("link.token")
    Files.createSymbolicLink(link, target.toAbsolutePath())
    assertNull(nioReader(link).read())
    assertNull(nioReader(target.parent).read())
    assertNull(nioReader(target.resolveSibling("missing.token")).read())
  }

  @Test
  fun `Windows NIO accepts a regular file without Unix attributes`() {
    val path = privateFile()
    assertEquals(
      "private-token",
      FileDaemonHttpTokenProvider(
          envProvider =
            mapOf("AUTOMOBILE_DAEMON_TOKEN_FILE_PATH" to path.toAbsolutePath().toString())::get,
          userId = { error("Windows does not check Unix uid") },
          tokenPlatform = DaemonTokenPlatform(windows = true),
        )
        .read(),
    )
  }

  private fun privateFile(): Path {
    val build = Files.createDirectories(Path.of("build"))
    val root = Files.createTempDirectory(build, "http-token-test-")
    directory = root
    val file = Files.writeString(root.resolve("daemon.token"), " private-token\n")
    if (java.io.File.separatorChar == '/') {
      Files.setPosixFilePermissions(file, PosixFilePermissions.fromString("rw-------"))
    }
    return file
  }

  private fun nioReader(path: Path, uid: String? = null): FileDaemonHttpTokenProvider =
    FileDaemonHttpTokenProvider(
      envProvider =
        mapOf("AUTOMOBILE_DAEMON_TOKEN_FILE_PATH" to path.toAbsolutePath().toString())::get,
      userId = { uid ?: Files.getAttribute(path, "unix:uid").toString() },
      tokenPlatform = DaemonTokenPlatform(windows = false),
      logUnavailable = logs::add,
    )

  private class FakeTokenFiles : DaemonHttpTokenFiles {
    val paths = mutableListOf<String>()
    var content: String? = "file-token"
    var failure: IOException? = null

    override fun read(path: String, windows: Boolean, userId: () -> String): String? {
      paths.add(path)
      failure?.let { throw it }
      return content
    }
  }

  companion object {
    @BeforeClass
    @JvmStatic
    fun warmReader() {
      val directory =
        Files.createTempDirectory(Files.createDirectories(Path.of("build")), "token-warmup-")
      val path = directory.resolve("daemon.token")
      try {
        Files.writeString(path, "warmup\n")
        val windows = java.io.File.separatorChar != '/'
        if (!windows)
          Files.setPosixFilePermissions(path, PosixFilePermissions.fromString("rw-------"))
        val reader =
          FileDaemonHttpTokenProvider(
            envProvider =
              mapOf("AUTOMOBILE_DAEMON_TOKEN_FILE_PATH" to path.toAbsolutePath().toString())::get,
            userId = { Files.getAttribute(path, "unix:uid").toString() },
            tokenPlatform = DaemonTokenPlatform(windows = windows),
          )
        assertEquals("warmup", reader.read())
      } finally {
        Files.deleteIfExists(path)
        Files.delete(directory)
      }
    }
  }
}
