package dev.jasonpearson.automobile.desktop.core.daemon

import java.io.File
import java.io.IOException
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpHeaders
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.attribute.PosixFilePermissions
import java.util.Optional
import javax.net.ssl.SSLSession
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
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
  fun `shared HTTP endpoint vectors limit credentials and preserve caller authorization`() {
    val vectors =
      Json.parseToJsonElement(File("../../test/fixtures/daemon-http-endpoints.json").readText())
        .jsonArray
    for (vector in vectors) {
      val fields = vector.jsonObject
      val url = fields.getValue("url").jsonPrimitive.content
      val daemon = fields.getValue("daemon").jsonPrimitive.content.toBooleanStrict()
      val discoveredPort = fields.getValue("discoveredPort").jsonPrimitive.intOrNull
      val endpoint = URI.create(url)
      assertEquals(daemon, isDaemonHttpEndpoint(endpoint, discoveredPort), url)
      // HttpRequest rejects schemes and authorities it cannot represent before sending.
      if (endpoint.scheme !in setOf("http", "https") || endpoint.host == null) continue
      for (caller in listOf(false, true)) {
        assertEndpointAuthentication(url, daemon, caller, discoveredPort)
      }
    }
  }

  @Test
  fun `the credential follows the discovered port at request time`() {
    val url = "http://localhost:3161/auto-mobile/streamable"
    assertEndpointAuthentication(url, daemon = true, caller = false, discoveredPort = 3161)
    // The daemon restarted on a new port: the same URL is no longer the daemon.
    assertEndpointAuthentication(url, daemon = false, caller = false, discoveredPort = 4000)
    assertEndpointAuthentication(url, daemon = true, caller = false, discoveredPort = null)
  }

  @Test
  fun `port mismatch missing port and non daemon route withhold the credential`() {
    val streamable = URI.create("http://localhost:3161/auto-mobile/streamable")
    assertTrue(isDaemonHttpEndpoint(streamable, 3161))
    assertTrue(isDaemonHttpEndpoint(streamable, null))
    assertFalse(isDaemonHttpEndpoint(streamable, 3162))
    assertFalse(isDaemonHttpEndpoint(URI.create("http://localhost/auto-mobile/streamable"), 3161))
    assertFalse(isDaemonHttpEndpoint(URI.create("http://localhost/auto-mobile/streamable"), null))
    assertFalse(isDaemonHttpEndpoint(URI.create("http://localhost:3161/mcp"), 3161))
    assertFalse(isDaemonHttpEndpoint(URI.create("http://localhost:80/mcp"), null))
    assertTrue(isDaemonHttpEndpoint(URI.create("http://localhost:80/heartbeat"), 80))
  }

  @Test
  fun `the provider reads the port from the isolation aware PID file path on every call`() {
    assertEquals(3161, reader.discoveredPort())
    files.pidContent = """{"pid":1,"port":4000}"""
    assertEquals(4000, reader.discoveredPort())
    env["AUTOMOBILE_AUX_SOCKET_DIR"] = Path.of("lane", "aux").toAbsolutePath().toString()
    reader.discoveredPort()
    val suffix = AutoMobileSocketPaths.daemonIsolationSuffix(env::get)
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
  fun `startup 503 retries with a fresh token within the retry budget`() {
    val requests = mutableListOf<HttpRequest>()
    val delays = mutableListOf<Long>()
    files.content = null
    val options =
      McpHttpClientOptions(
          endpoint = "http://localhost:3161/auto-mobile/streamable",
          tokenProvider = reader,
          requestSender =
            HttpRequestSender { request ->
              requests.add(request)
              if (requests.size == 1) {
                files.content = "published"
                UnauthorizedResponse(request, 503, mapOf("Retry-After" to listOf("1")))
              } else UnauthorizedResponse(request, 200)
            },
        )
        .apply { startupRetryDelay = { delays.add(it) } }
    McpHttpTransport(options)
      .sendRequest(JsonRpcRequest(id = JsonPrimitive("test"), method = "ping"), false, true)
    assertEquals(
      listOf(null, "Bearer published"),
      requests.map { it.headers().firstValue("Authorization").orElse(null) },
    )
    assertEquals(listOf(1000L), delays)
  }

  @Test
  fun `startup 503 stops at the attempt limit and respects a short deadline`() {
    for (shortDeadline in listOf(false, true)) {
      var attempts = 0
      val delays = mutableListOf<Long>()
      val options =
        McpHttpClientOptions(
            endpoint = "http://localhost:3161/auto-mobile/streamable",
            tokenProvider = reader,
            requestSender =
              HttpRequestSender { request ->
                attempts++
                UnauthorizedResponse(request, 503, mapOf("Retry-After" to listOf("1")))
              },
          )
          .apply { startupRetryDelay = { delays.add(it) } }
      kotlin.test.assertFailsWith<McpConnectionException> {
        McpHttpTransport(options)
          .sendRequest(
            JsonRpcRequest(id = JsonPrimitive("test"), method = "ping"),
            false,
            true,
            deadline = if (shortDeadline) StatusRequestDeadline(500, nowNanos = { 0L }) else null,
          )
      }
      assertEquals(if (shortDeadline) 1 else 6, attempts)
      assertEquals(if (shortDeadline) 0 else 5, delays.size)
    }
  }

  private fun assertEndpointAuthentication(
    url: String,
    daemon: Boolean,
    caller: Boolean,
    discoveredPort: Int? = 3161,
  ) {
    var reads = 0
    val requests = mutableListOf<HttpRequest>()
    val transport =
      McpHttpTransport(
        McpHttpClientOptions(
            endpoint = url,
            mcpSessionKey = "test-session",
            tokenProvider =
              object : DaemonHttpTokenProvider {
                override fun read(): String {
                  reads++
                  return "local"
                }

                override fun discoveredPort() = discoveredPort
              },
            requestSender =
              HttpRequestSender { request ->
                requests.add(request)
                UnauthorizedResponse(request)
              },
          )
          .apply {
            requestHeaders = if (caller) mapOf("aUtHoRiZaTiOn" to "caller") else emptyMap()
          },
      )
    kotlin.test.assertFailsWith<McpConnectionException> {
      transport.sendRequest(
        JsonRpcRequest(id = JsonPrimitive("test"), method = "ping"),
        false,
        true,
      )
    }
    val expected = if (caller) "caller" else if (daemon) "Bearer local" else null
    assertTrue(
      requests.all { it.headers().firstValue("Authorization").orElse(null) == expected },
      url,
    )
    assertEquals(if (daemon && !caller) 2 else 1, requests.size, url)
    assertEquals(if (daemon && !caller) 2 else 0, reads, url)
  }

  private class UnauthorizedResponse(
    private val original: HttpRequest,
    private val status: Int = 401,
    private val responseHeaders: Map<String, List<String>> = emptyMap(),
  ) : HttpResponse<String> {
    override fun statusCode() = status

    override fun request() = original

    override fun previousResponse(): Optional<HttpResponse<String>> = Optional.empty()

    override fun headers(): HttpHeaders = HttpHeaders.of(responseHeaders) { _, _ -> true }

    override fun body() =
      if (status == 200) """{"jsonrpc":"2.0","id":"test","result":{}}""" else "Unavailable"

    override fun sslSession(): Optional<SSLSession> = Optional.empty()

    override fun uri(): URI = original.uri()

    override fun version(): HttpClient.Version = HttpClient.Version.HTTP_1_1
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
      // Initialize JDK request and serialization classes in setup, with a fake sender.
      DaemonHttpTokenProviderTest()
        .assertEndpointAuthentication(
          "http://localhost:3161/auto-mobile/streamable",
          daemon = true,
          caller = false,
        )
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
