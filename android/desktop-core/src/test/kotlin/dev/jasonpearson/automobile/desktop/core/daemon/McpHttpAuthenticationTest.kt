package dev.jasonpearson.automobile.desktop.core.daemon

import com.sun.net.httpserver.HttpServer
import java.net.InetSocketAddress
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlinx.serialization.json.JsonPrimitive
import org.junit.AfterClass
import org.junit.Before
import org.junit.BeforeClass
import org.junit.Test

class McpHttpAuthenticationTest {
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
  fun `MCP requests and notifications carry the current file token`() {
    val transport = transport()
    transport.sendRequest(request(), includeSession = false, expectResponse = true)
    files.token = "rotated-token\n"
    transport.sendRequest(request(), includeSession = false, expectResponse = false)
    assertEquals(listOf<String?>("Bearer file-token", "Bearer rotated-token"), headers)
    assertEquals(2, files.reads)
  }

  @Test
  fun `no discovered token omits Authorization`() {
    files.token = null
    transport().sendRequest(request(), includeSession = false, expectResponse = true)
    assertEquals(listOf<String?>(null), headers)
  }

  @Test
  fun `401 retries the same MCP request once with a re-read token`() {
    status = {
      if (headers.size == 1) {
        files.token = "rotated-token"
        401
      } else 200
    }
    transport().sendRequest(request(), includeSession = false, expectResponse = true)
    assertEquals(listOf<String?>("Bearer file-token", "Bearer rotated-token"), headers)
    assertEquals(bodies[0], bodies[1])
    assertEquals(2, files.reads)
  }

  @Test
  fun `a repeated 401 stops after one retry including notifications`() {
    status = { 401 }
    assertFailsWith<McpConnectionException> {
      transport().sendRequest(request(), includeSession = false, expectResponse = false)
    }
    assertEquals(2, headers.size)
    assertEquals(2, files.reads)
  }

  private fun transport() =
    McpHttpTransport(
      McpHttpClientOptions(
        endpoint = "http://127.0.0.1:${server.address.port}/auto-mobile/streamable",
        tokenProvider = provider,
      ),
    )

  private fun request() = JsonRpcRequest(id = JsonPrimitive("test"), method = "ping")

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
      server.createContext("/auto-mobile/streamable") { exchange ->
        headers.add(exchange.requestHeaders.getFirst("Authorization"))
        bodies.add(exchange.requestBody.bufferedReader().use { it.readText() })
        val body = """{"jsonrpc":"2.0","id":"test","result":{}}""".toByteArray()
        exchange.responseHeaders.add("Connection", "close")
        exchange.sendResponseHeaders(status(), body.size.toLong())
        exchange.responseBody.use { it.write(body) }
        exchange.close()
      }
      server.start()
      val request =
        HttpRequest.newBuilder(
            URI("http://127.0.0.1:${server.address.port}/auto-mobile/streamable"),
          )
          .POST(HttpRequest.BodyPublishers.ofString("{}"))
          .build()
      HttpClient.newHttpClient().use { client ->
        client.send(request, HttpResponse.BodyHandlers.discarding())
      }
    }

    @AfterClass
    @JvmStatic
    fun stopServer() {
      server.stop(0)
    }
  }
}
