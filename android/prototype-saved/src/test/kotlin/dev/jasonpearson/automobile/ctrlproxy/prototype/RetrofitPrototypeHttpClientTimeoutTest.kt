package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.PrototypeRequestResponse
import java.net.InetAddress
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.Dns
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test

/**
 * The request's `timeoutMs` is the whole-call budget of a device request (#13455): the underlying
 * OkHttp client's own connect, read and write timeouts (10 s by default) must not end a slower call
 * earlier. Kept apart from [RetrofitPrototypeHttpClientTest], which is at its class-size limit.
 */
class RetrofitPrototypeHttpClientTimeoutTest {
  private val server = MockWebServer()
  private val warnings = mutableListOf<String>()

  private val permissivePolicy = PrototypeDestinationPolicy { _, _, _ ->
    PrototypeEgressDecision.Allow
  }
  private val loopbackDns = Dns { listOf(InetAddress.getByAddress(byteArrayOf(127, 0, 0, 1))) }

  @Before
  fun start() {
    server.start()
  }

  @After
  fun stop() {
    server.close()
  }

  @Test
  fun `a response slower than the client's own read timeout succeeds within the request timeout`() {
    server.enqueue(
      MockResponse.Builder()
        .body("{}")
        .addHeader("Content-Type", "application/json")
        .headersDelay(400, TimeUnit.MILLISECONDS)
        .build(),
    )
    val shortReadTimeouts =
      RetrofitPrototypeHttpClient(
        OkHttpClient.Builder()
          .dns(loopbackDns)
          .connectTimeout(100, TimeUnit.MILLISECONDS)
          .readTimeout(100, TimeUnit.MILLISECONDS)
          .writeTimeout(100, TimeUnit.MILLISECONDS)
          .build(),
        policy = permissivePolicy,
        clock = { 0L },
        warn = { message, _ -> warnings += message },
      )
    val request =
      PrototypeHttpRequest(
        "r-1",
        "proto",
        "GET",
        server.url("/feed").toString(),
        emptyMap(),
        null,
        5_000,
      )

    val response = runBlocking { shortReadTimeouts.execute(request) }

    val received =
      response as? PrototypeRequestResponse.Received ?: error("Expected a response: $response")
    assertEquals(200, received.status)
  }
}
