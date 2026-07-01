package dev.jasonpearson.automobile.desktop.core.daemon

import java.net.ConnectException
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import org.junit.Test

class McpHttpClientCancellationTest {

  @Test
  fun connectExceptionIsRetryable() {
    assertTrue(McpHttpClient.isRetryableError(ConnectException("Connection refused")))
  }

  @Test
  fun httpTimeoutIsRetryable() {
    assertTrue(
        McpHttpClient.isRetryableError(java.net.http.HttpTimeoutException("request timed out"))
    )
  }

  @Test
  fun serverErrorIsRetryable() {
    assertTrue(McpHttpClient.isRetryableError(McpConnectionException("MCP HTTP server error 503")))
  }

  @Test
  fun clientErrorIsNotRetryable() {
    assertFalse(
        McpHttpClient.isRetryableError(McpConnectionException("MCP HTTP error 400: Bad Request"))
    )
  }

  @Test
  fun deserializationErrorIsNotRetryable() {
    assertFalse(
        McpHttpClient.isRetryableError(RuntimeException("kotlinx.serialization: unknown key"))
    )
  }

  @Test
  fun genericExceptionIsNotRetryable() {
    assertFalse(McpHttpClient.isRetryableError(IllegalStateException("something else")))
  }
}
