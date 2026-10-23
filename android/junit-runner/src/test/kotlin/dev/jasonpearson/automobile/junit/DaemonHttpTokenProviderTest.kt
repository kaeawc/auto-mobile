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
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.intOrNull
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
  fun `shared HTTP endpoint vectors limit heartbeat credentials`() {
    val vectors =
      Json.parseToJsonElement(File("../../test/fixtures/daemon-http-endpoints.json").readText())
        .jsonArray
    for (vector in vectors) {
      val fields = vector.jsonObject
      val url = fields.getValue("url").jsonPrimitive.content
      val daemon = fields.getValue("daemon").jsonPrimitive.content.toBooleanStrict()
      val discoveredPort = fields.getValue("discoveredPort").jsonPrimitive.intOrNull
      runCatching { URL(url) }
        .getOrNull()
        ?.let { assertEquals(daemon, isDaemonHttpEndpoint(it, discoveredPort), url) }
      assertEndpointAuthentication(url, daemon, discoveredPort)
    }
  }

  @Test
  fun `the credential follows the discovered port at request time`() {
    val url = "http://localhost:3161/heartbeat"
    assertEndpointAuthentication(url, daemon = true, discoveredPort = 3161)
    // The daemon restarted on a new port: the same URL is no longer the daemon.
    assertEndpointAuthentication(url, daemon = false, discoveredPort = 4000)
    assertEndpointAuthentication(url, daemon = true, discoveredPort = null)
  }

  @Test
  fun `port mismatch missing port and non daemon route withhold the credential`() {
    val heartbeat = URL("http://localhost:3161/heartbeat")
    assertTrue(isDaemonHttpEndpoint(heartbeat, 3161))
    assertTrue(isDaemonHttpEndpoint(heartbeat, null))
    assertFalse(isDaemonHttpEndpoint(heartbeat, 3162))
    assertFalse(isDaemonHttpEndpoint(URL("http://localhost/heartbeat"), 3161))
    assertFalse(isDaemonHttpEndpoint(URL("http://localhost/heartbeat"), null))
    assertFalse(isDaemonHttpEndpoint(URL("http://localhost:80/other"), null))
    assertFalse(isDaemonHttpEndpoint(URL("http://localhost:3161/mcp"), 3161))
    assertTrue(isDaemonHttpEndpoint(URL("http://localhost:80/heartbeat"), 80))
  }

  @Test
  fun `the provider reads the port from the isolation aware PID file path on every call`() {
    assertEquals(3161, reader.discoveredPort())
    files.pidContent = """{"pid":1,"port":4000}"""
    assertEquals(4000, reader.discoveredPort())
    env["AUTOMOBILE_AUX_SOCKET_DIR"] = Path.of("lane", "aux").toAbsolutePath().toString()
    reader.discoveredPort()
    val suffix = DaemonStatePaths.isolationSuffix(env::get, "/launch")
    assertEquals(
      listOf(
        "/tmp/auto-mobile-daemon-501.pid",
        "/tmp/auto-mobile-daemon-501.pid",
        "/tmp/auto-mobile-daemon-501$suffix.pid",
      ),
      files.pidPaths,
    )
  }

  @Test
  fun `an unreadable or invalid PID file leaves the port unverifiable without logging contents`() {
    fun port(text: String?, failure: Exception? = null) =
      readDaemonPidPort(
        pidPath = { "/pid" },
        readText = {
          failure?.let { throw it }
          text
        },
        logUnavailable = logs::add,
      )
    assertNull(port(null))
    assertNull(port("""{"pid":1}"""))
    assertNull(port("""{"port":"secret"}"""))
    assertNull(port("""{"port":0}"""))
    assertNull(port("""{"port":70000}"""))
    assertEquals(0, logs.size)
    assertNull(port("not json secret"))
    assertNull(port(null, IOException("secret")))
    assertEquals(List(2) { "Daemon PID file port unavailable" }, logs)
  }

  @Test
  fun `startup 503 retries with fresh discovery and stops after one replay`() {
    for (repeated in listOf(false, true)) {
      val connections = mutableListOf<HeartbeatConnection>()
      val captured = mutableListOf<String?>()
      val delays = mutableListOf<Long>()
      var nowNanos = 0L
      files.content = null
      val endpoint =
        URL(
          null,
          "http://localhost:3161/heartbeat",
          object : URLStreamHandler() {
            override fun openConnection(endpoint: URL): URLConnection =
              HeartbeatConnection(endpoint, if (connections.isEmpty() || repeated) 503 else 200)
                .also { connections.add(it) }
          },
        )
      val send = {
        HeartbeatTransport.sendHeartbeat(
          endpoint,
          "session",
          "owner",
          reader,
          retryClock =
            object : HeartbeatRetryClock {
              override fun nowNanos() = nowNanos

              override fun sleep(ms: Long) {
                delays.add(ms)
                nowNanos += ms * 1_000_000
                captured.add(connections.last().authorization)
                files.content = "published"
              }
            },
        )
      }
      if (repeated) kotlin.test.assertFailsWith<IOException> { send() } else send()
      captured.add(connections.last().authorization)
      assertEquals(listOf(null, "Bearer published"), captured)
      assertEquals(listOf(1000L), delays)
      assertEquals(2, connections.size)
      assertEquals(listOf(1000, 500), connections.map { it.connectTimeout })
      assertEquals(listOf(1000, 500), connections.map { it.readTimeout })
    }
  }

  @Test
  fun `startup retry does not extend the heartbeat deadline`() {
    var now = 0L
    var connections = 0
    val endpoint =
      URL(
        null,
        "http://localhost:3161/heartbeat",
        object : URLStreamHandler() {
          override fun openConnection(endpoint: URL): URLConnection {
            connections++
            return HeartbeatConnection(endpoint, 503) { now = 1_500_000_000L }
          }
        },
      )
    val clock =
      object : HeartbeatRetryClock {
        override fun nowNanos() = now

        override fun sleep(ms: Long) {
          error("No time remains for the requested delay")
        }
      }
    kotlin.test.assertFailsWith<IOException> {
      HeartbeatTransport.sendHeartbeat(endpoint, "session", "owner", reader, clock)
    }
    assertEquals(1, connections)
  }

  private fun assertEndpointAuthentication(url: String, daemon: Boolean, discoveredPort: Int?) {
    var reads = 0
    val connections = mutableListOf<HeartbeatConnection>()
    val endpoint =
      URL(
        null,
        url,
        object : URLStreamHandler() {
          override fun openConnection(endpoint: URL): URLConnection =
            HeartbeatConnection(endpoint).also {
              connections.add(it)
            }
        },
      )
    kotlin.test.assertFailsWith<IOException> {
      HeartbeatTransport.sendHeartbeat(
        endpoint,
        "session",
        "owner",
        object : DaemonHttpTokenProvider {
          override fun read(): String {
            reads++
            return "local"
          }

          override fun discoveredPort() = discoveredPort
        },
      )
    }
    val expected = if (daemon) "Bearer local" else null
    assertTrue(connections.all { it.authorization == expected }, url)
    assertEquals(if (daemon) 2 else 1, connections.size, url)
    assertEquals(if (daemon) 2 else 0, reads, url)
  }

  private class HeartbeatConnection(
    endpoint: URL,
    private val status: Int = 401,
    private val onResponse: () -> Unit = {},
  ) : HttpURLConnection(endpoint) {
    var authorization: String? = null
      private set

    override fun setRequestProperty(name: String, value: String) {
      if (name.equals("Authorization", ignoreCase = true)) authorization = value
      super.setRequestProperty(name, value)
    }

    override fun getRequestProperty(name: String): String? =
      if (name.equals("Authorization", ignoreCase = true)) null else super.getRequestProperty(name)

    override fun connect() = Unit

    override fun disconnect() = Unit

    override fun usingProxy() = false

    override fun getOutputStream() = ByteArrayOutputStream()

    override fun getErrorStream() = ByteArrayInputStream(byteArrayOf())

    override fun getResponseCode(): Int {
      onResponse()
      return status
    }

    override fun getHeaderField(name: String) = if (name == "Retry-After") "1" else null

    override fun getInputStream() = ByteArrayInputStream(byteArrayOf())
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
    val pidPaths = mutableListOf<String>()
    var pidContent: String? = """{"pid":1,"port":3161}"""
    var content: String? = "file-token"
    var failure: IOException? = null

    override fun readPid(path: String): String? {
      pidPaths.add(path)
      return pidContent
    }

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
