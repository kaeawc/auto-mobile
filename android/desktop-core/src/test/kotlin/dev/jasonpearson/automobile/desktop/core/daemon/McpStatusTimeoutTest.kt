package dev.jasonpearson.automobile.desktop.core.daemon

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpHeaders
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.net.http.HttpTimeoutException
import java.time.Duration
import java.util.Optional
import javax.net.ssl.SSLSession
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Test

class McpStatusTimeoutTest {

  @Test
  fun `STDIO client reinitializes after a panel closes the shared client`() {
    var starts = 0
    var initializations = 0
    val client =
      McpStdioClient(
        command = "unused",
        processStarter = {
          starts++
          FakeProcess()
        },
        responseReader =
          StdioResponseReader { _, _ ->
            initializations++
            JsonRpcResponse(
              jsonrpc = "2.0",
              result = buildJsonObject { put("protocolVersion", "2025-11-25") },
            )
          },
      )
    try {
      client.ping()
      client.close()
      client.ping()
      assertEquals(2, starts)
      assertEquals(2, initializations)
    } finally {
      client.close()
    }
  }

  @Test
  fun `HTTP status probe shares one deadline across initialization and tools call`() {
    var nowNanos = 0L
    var requests = 0
    val client =
      McpHttpClient(
        endpoint = "http://localhost/mcp",
        retryPolicy = RetryPolicy(maxRetries = 3, initialDelayMs = 1),
        statusRequestTimeoutMs = 120,
        statusDeadlineFactory = { timeoutMs -> StatusRequestDeadline(timeoutMs) { nowNanos } },
        requestSender =
          HttpRequestSender { request ->
            when (requests++) {
              0 -> {
                assertEquals(Duration.ofMillis(120), request.timeout().orElseThrow())
                nowNanos += Duration.ofMillis(80).toNanos()
                FakeHttpResponse(request, initializeResponse)
              }
              1 -> {
                assertEquals(Duration.ofMillis(40), request.timeout().orElseThrow())
                FakeHttpResponse(request, "{}")
              }
              else -> {
                assertEquals(Duration.ofMillis(40), request.timeout().orElseThrow())
                throw HttpTimeoutException("status request timed out")
              }
            }
          },
      )

    assertFailsWith<HttpTimeoutException> { client.getDaemonStatus() }
    assertEquals(3, requests)
  }

  @Test
  fun `STDIO status probe releases the shared client for a later retry`() {
    var starts = 0
    val client =
      McpStdioClient(
        command = "unused",
        processStarter = {
          starts += 1
          FakeProcess()
        },
        responseReader =
          StdioResponseReader { _, _ -> throw java.util.concurrent.TimeoutException() },
      )
    try {
      fun assertStatusTimeout() {
        val error = assertFailsWith<McpConnectionException> { client.getDaemonStatus() }
        assertTrue(error.message.orEmpty().contains("initialize' timed out"))
      }

      assertStatusTimeout()
      assertStatusTimeout()
      assertEquals(2, starts)
    } finally {
      client.close()
    }
  }

  @Test
  fun `HTTP list tools without result names the method`() {
    val client = httpClientForResponse("""{"jsonrpc":"2.0"}""")
    val error = assertFailsWith<McpConnectionException> { client.listTools() }
    assertTrue(error.message.orEmpty().contains("tools/list response contained no result"))
  }

  @Test
  fun `HTTP observe tool error propagates connection exception`() {
    val client =
      httpClientForResponse(
        """{"jsonrpc":"2.0","result":{"content":[{"type":"text","text":"Error: no device"}],"isError":true}}""",
      )

    val error = assertFailsWith<McpConnectionException> { client.observe("android") }

    assertTrue(error.message.orEmpty().contains("no device"))
  }

  @Test
  fun `HTTP malformed observe payload becomes connection exception`() {
    val client =
      httpClientForResponse(
        """{"jsonrpc":"2.0","result":{"content":[{"type":"text","text":"not json"}]}}""",
      )

    val error = assertFailsWith<McpConnectionException> { client.observe("android") }

    assertTrue(error.message.orEmpty().contains("Failed to decode observe response"))
    assertTrue(error.cause is IllegalArgumentException)
  }

  @Test
  fun `HTTP omits missing session header and preserves negotiated protocol header`() {
    val client = httpClientForResponse("""{"jsonrpc":"2.0","result":{"tools":[]}}""")
    assertEquals(emptyList(), client.listTools())
  }

  @Test
  fun `HTTP missing negotiated protocol version fails during initialize`() {
    val client = httpClientForResponse("", """{"jsonrpc":"2.0","result":{}}""")
    val error = assertFailsWith<McpConnectionException> { client.ping() }
    assertTrue(error.message.orEmpty().contains("omitted protocolVersion"))
  }

  @Test
  fun `STDIO list tools without result names the method`() {
    val client = stdioClientForResult(null)
    try {
      val error = assertFailsWith<McpConnectionException> { client.listTools() }
      assertTrue(error.message.orEmpty().contains("tools/list response contained no result"))
    } finally {
      client.close()
    }
  }

  @Test
  fun `STDIO observe tool error propagates connection exception`() {
    val client =
      stdioClientForResult(
        """{"content":[{"type":"text","text":"Error: no device"}],"isError":true}""",
      )
    try {
      val error = assertFailsWith<McpConnectionException> { client.observe("android") }
      assertTrue(error.message.orEmpty().contains("no device"))
    } finally {
      client.close()
    }
  }

  @Test
  fun `STDIO malformed observe payload becomes connection exception`() {
    val client = stdioClientForResult("""{"content":[{"type":"text","text":"not json"}]}""")
    try {
      val error = assertFailsWith<McpConnectionException> { client.observe("android") }
      assertTrue(error.message.orEmpty().contains("Failed to decode observe response"))
      assertTrue(error.cause is IllegalArgumentException)
    } finally {
      client.close()
    }
  }

  @Test
  fun `STDIO well formed list tools response still decodes`() {
    val client = stdioClientForResult("""{"tools":[]}""")
    try {
      assertEquals(emptyList(), client.listTools())
    } finally {
      client.close()
    }
  }

  @Test
  fun `STDIO missing negotiated protocol version fails during initialize`() {
    val client = stdioClientForResult(null, "{}")
    try {
      val error = assertFailsWith<McpConnectionException> { client.ping() }
      assertTrue(error.message.orEmpty().contains("omitted protocolVersion"))
    } finally {
      client.close()
    }
  }

  private fun httpClientForResponse(
    responseBody: String,
    initialization: String = initializeResponse,
  ): McpHttpClient {
    var requests = 0
    return McpHttpClient(
      endpoint = "http://localhost/mcp",
      requestSender =
        HttpRequestSender { request ->
          assertTrue(request.headers().firstValue("mcp-session-id").isEmpty)
          if (requests > 0) {
            assertEquals(
              "2025-11-25",
              request.headers().firstValue("mcp-protocol-version").orElseThrow(),
            )
          } else {
            assertTrue(request.headers().firstValue("mcp-protocol-version").isEmpty)
          }
          FakeHttpResponse(
            request,
            when (requests++) {
              0 -> initialization
              1 -> "{}" // The initialized notification has no response result.
              else -> responseBody
            },
          )
        },
    )
  }

  private fun stdioClientForResult(
    result: String?,
    initialization: String = """{"protocolVersion":"2025-11-25"}""",
  ): McpStdioClient {
    var responses = 0
    return McpStdioClient(
      command = "unused",
      processStarter = { FakeProcess() },
      responseReader =
        StdioResponseReader { _, _ ->
          JsonRpcResponse(
            jsonrpc = "2.0",
            result =
              (if (responses++ == 0) initialization else result)?.let(
                DaemonJson::parseToJsonElement,
              ),
          )
        },
    )
  }

  private class FakeProcess : Process() {
    private val output = ByteArrayOutputStream()
    private var alive = true

    override fun getOutputStream(): OutputStream = output

    override fun getInputStream(): InputStream = ByteArrayInputStream(ByteArray(0))

    override fun getErrorStream(): InputStream = ByteArrayInputStream(ByteArray(0))

    override fun waitFor(): Int = 0

    override fun exitValue(): Int = 0

    override fun destroy() {
      alive = false
    }

    override fun isAlive(): Boolean = alive

    override fun destroyForcibly(): Process {
      alive = false
      return this
    }
  }

  private class FakeHttpResponse(
    private val requestValue: HttpRequest,
    private val responseBody: String,
  ) : HttpResponse<String> {
    override fun statusCode(): Int = 200

    override fun request(): HttpRequest = requestValue

    override fun previousResponse(): Optional<HttpResponse<String>> = Optional.empty()

    override fun headers(): HttpHeaders = HttpHeaders.of(emptyMap()) { _, _ -> true }

    override fun body(): String = responseBody

    override fun sslSession(): Optional<SSLSession> = Optional.empty()

    override fun uri(): URI = requestValue.uri()

    override fun version(): HttpClient.Version = HttpClient.Version.HTTP_1_1
  }

  private companion object {
    const val initializeResponse =
      """{"jsonrpc":"2.0","id":"initialize","result":{"protocolVersion":"2025-11-25","capabilities":{},"serverInfo":{"name":"test","version":"1"}}}"""
  }
}
