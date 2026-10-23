package dev.jasonpearson.automobile.junit

import com.sun.net.httpserver.HttpServer
import java.io.IOException
import java.net.InetSocketAddress
import java.net.URL
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import org.junit.AfterClass
import org.junit.Before
import org.junit.BeforeClass
import org.junit.Test

class HeartbeatAuthenticationTest {
  private val files = RotatingTokenFiles()
  private val provider =
    FileDaemonHttpTokenProvider(
      envProvider = { null },
      userId = { "test" },
      files = files,
      tokenPlatform = DaemonTokenPlatform(windows = false),
    )

  @Before
  fun reset() {
    headers.clear()
    bodies.clear()
    status = { 200 }
  }

  @Test
  fun `heartbeats carry the current file token on each connection`() {
    beat()
    files.token = "rotated-token\n"
    beat()
    assertEquals(listOf<String?>("Bearer file-token", "Bearer rotated-token"), headers)
    assertEquals(2, files.reads)
  }

  @Test
  fun `no discovered token omits Authorization`() {
    files.token = null
    beat()
    assertEquals(listOf<String?>(null), headers)
  }

  @Test
  fun `401 retries the same heartbeat once with a re-read token`() {
    status = {
      if (headers.size == 1) {
        files.token = "rotated-token"
        401
      } else 200
    }
    beat()
    assertEquals(listOf<String?>("Bearer file-token", "Bearer rotated-token"), headers)
    assertEquals(bodies[0], bodies[1])
    assertEquals(2, files.reads)
  }

  @Test
  fun `a repeated 401 stops after one retry`() {
    status = { 401 }
    assertFailsWith<IOException> { beat() }
    assertEquals(2, headers.size)
    assertEquals(2, files.reads)
  }

  private fun beat() =
    HeartbeatTransport.sendHeartbeat(
      URL("http://127.0.0.1:${server.address.port}/heartbeat"),
      "session",
      "owner",
      provider,
    )

  private class RotatingTokenFiles : DaemonHttpTokenFiles {
    var token: String? = "file-token\n"
    var reads = 0

    override fun readPid(path: String) = """{"port":${server.address.port}}"""

    override fun read(path: String, windows: Boolean, userId: () -> String): String? {
      reads++
      return token
    }
  }

  companion object {
    private lateinit var server: HttpServer
    private val headers = mutableListOf<String?>()
    private val bodies = mutableListOf<String>()
    private var status: () -> Int = { 200 }

    @BeforeClass
    @JvmStatic
    fun startServer() {
      server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
      server.createContext("/heartbeat") { exchange ->
        headers.add(exchange.requestHeaders.getFirst("Authorization"))
        bodies.add(exchange.requestBody.bufferedReader().use { it.readText() })
        val body = """{"status":"ok"}""".toByteArray()
        exchange.responseHeaders.add("Connection", "close")
        exchange.sendResponseHeaders(status(), body.size.toLong())
        exchange.responseBody.use { it.write(body) }
        exchange.close()
      }
      server.start()
      HeartbeatTransport.sendHeartbeat(
        URL("http://127.0.0.1:${server.address.port}/heartbeat"),
        "warmup",
        "owner",
        DaemonHttpTokenProvider { null },
      )
      status = { 401 }
      assertFailsWith<IOException> {
        HeartbeatTransport.sendHeartbeat(
          URL("http://127.0.0.1:${server.address.port}/heartbeat"),
          "warmup",
          "owner",
          DaemonHttpTokenProvider { null },
        )
      }
      status = { 200 }
    }

    @AfterClass
    @JvmStatic
    fun stopServer() {
      server.stop(0)
    }
  }
}
