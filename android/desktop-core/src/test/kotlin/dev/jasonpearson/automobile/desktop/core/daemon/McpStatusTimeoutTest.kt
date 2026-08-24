package dev.jasonpearson.automobile.desktop.core.daemon

import com.sun.net.httpserver.HttpServer
import java.net.InetSocketAddress
import java.net.http.HttpTimeoutException
import kotlin.system.measureTimeMillis
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue
import org.junit.Test

class McpStatusTimeoutTest {

  @Test
  fun `HTTP status probe times out without retrying`() {
    val server =
      HttpServer.create(InetSocketAddress(0), 0).apply {
        createContext("/") { exchange ->
          try {
            Thread.sleep(1_000)
          } finally {
            exchange.close()
          }
        }
        start()
      }
    try {
      val client =
        McpHttpClient(
          endpoint = "http://localhost:${server.address.port}/mcp",
          retryPolicy = RetryPolicy(maxRetries = 3, initialDelayMs = 1),
          statusRequestTimeoutMs = 50,
        )

      val elapsedMs = measureTimeMillis {
        assertFailsWith<HttpTimeoutException> { client.getDaemonStatus() }
      }

      assertTrue(elapsedMs < 500, "status probe took ${elapsedMs}ms")
    } finally {
      server.stop(0)
    }
  }

  @Test
  fun `STDIO status probe closes only the timed-out process`() {
    val client = McpStdioClient("/bin/sh -c 'sleep 30'", statusRequestTimeoutMs = 50)
    try {
      val elapsedMs = measureTimeMillis {
        val error = assertFailsWith<McpConnectionException> { client.getDaemonStatus() }
        assertTrue(error.message.orEmpty().contains("timed out"))
      }

      assertTrue(elapsedMs < 500, "status probe took ${elapsedMs}ms")
    } finally {
      client.close()
    }
  }
}
