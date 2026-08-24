package dev.jasonpearson.automobile.desktop.core.daemon

import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpHeaders
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.net.http.HttpTimeoutException
import java.time.Duration
import java.util.Optional
import javax.net.ssl.SSLSession
import kotlin.system.measureTimeMillis
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue
import org.junit.Test

class McpStatusTimeoutTest {

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
    val client = McpStdioClient("/bin/sh -c 'sleep 30'", statusRequestTimeoutMs = 25)
    try {
      fun assertStatusTimeout() {
        val error = assertFailsWith<McpConnectionException> { client.getDaemonStatus() }
        assertTrue(error.message.orEmpty().contains("timed out"))
      }

      val firstElapsedMs = measureTimeMillis(::assertStatusTimeout)
      val retryElapsedMs = measureTimeMillis(::assertStatusTimeout)

      assertTrue(firstElapsedMs < 250, "first status probe took ${firstElapsedMs}ms")
      assertTrue(retryElapsedMs < 250, "retry status probe took ${retryElapsedMs}ms")
    } finally {
      client.close()
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
