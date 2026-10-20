package dev.jasonpearson.automobile.junit

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLConnection
import java.net.URLStreamHandler
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.attribute.PosixFilePermissions
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
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

  @Test
  fun `shared HTTP endpoint vectors limit heartbeat credentials and preserve caller authorization`() {
    val vectors =
      Json.parseToJsonElement(File("../../test/fixtures/daemon-http-endpoints.json").readText())
        .jsonArray
    for (vector in vectors) {
      val fields = vector.jsonObject
      val url = fields.getValue("url").jsonPrimitive.content
      val daemon = fields.getValue("daemon").jsonPrimitive.content.toBooleanStrict()
      for (caller in listOf(false, true)) {
        assertEndpointAuthentication(url, daemon, caller)
      }
    }
  }

  private fun assertEndpointAuthentication(url: String, daemon: Boolean, caller: Boolean) {
    var reads = 0
    val connections = mutableListOf<HeartbeatConnection>()
    val endpoint =
      URL(
        null,
        url,
        object : URLStreamHandler() {
          override fun openConnection(endpoint: URL): URLConnection =
            HeartbeatConnection(endpoint).also {
              if (caller) it.setRequestProperty("Authorization", "caller")
              connections.add(it)
            }
        },
      )
    kotlin.test.assertFailsWith<IOException> {
      HeartbeatTransport.sendHeartbeat(
        endpoint,
        "session",
        "owner",
        DaemonHttpTokenProvider {
          reads++
          "local"
        },
      )
    }
    val expected = if (caller) "caller" else if (daemon) "Bearer local" else null
    assertTrue(connections.all { it.getRequestProperty("Authorization") == expected }, url)
    assertEquals(if (daemon && !caller) 2 else 1, connections.size, url)
    assertEquals(if (daemon && !caller) 2 else 0, reads, url)
  }

  private class HeartbeatConnection(endpoint: URL) : HttpURLConnection(endpoint) {
    override fun connect() = Unit

    override fun disconnect() = Unit

    override fun usingProxy() = false

    override fun getOutputStream() = ByteArrayOutputStream()

    override fun getErrorStream() = ByteArrayInputStream(byteArrayOf())

    override fun getResponseCode() = 401
  }

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
    val suffix = DaemonStatePaths.isolationSuffix(env::get)
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
