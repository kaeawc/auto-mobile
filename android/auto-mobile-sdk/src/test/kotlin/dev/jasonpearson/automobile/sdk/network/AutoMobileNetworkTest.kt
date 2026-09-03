package dev.jasonpearson.automobile.sdk.network

import dev.jasonpearson.automobile.protocol.SdkEvent
import dev.jasonpearson.automobile.protocol.SdkNetworkRequestEvent
import dev.jasonpearson.automobile.sdk.capabilities.SdkCapturePolicy
import dev.jasonpearson.automobile.sdk.events.SdkEventBuffer
import java.util.concurrent.CancellationException
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertSame
import kotlin.test.assertTrue
import okhttp3.Request
import okhttp3.WebSocket
import okio.ByteString
import org.junit.After
import org.junit.Test

class AutoMobileNetworkTest {
  private var bufferExecutor: ScheduledExecutorService? = null

  @After
  fun tearDown() {
    AutoMobileNetwork.reset()
    bufferExecutor?.shutdownNow()
  }

  private fun collectingBuffer(): Pair<SdkEventBuffer, MutableList<List<SdkEvent>>> {
    val flushed = mutableListOf<List<SdkEvent>>()
    val executor = Executors.newSingleThreadScheduledExecutor()
    val buffer =
      SdkEventBuffer(
        maxBufferSize = 1,
        flushIntervalMs = 60_000,
        onFlush = { flushed.add(it) },
        executor = executor,
      )
    bufferExecutor = executor
    return buffer to flushed
  }

  private fun drainDelivery() {
    bufferExecutor!!.submit {}.get(1, TimeUnit.SECONDS)
  }

  @Test
  fun `recordRequest records event with all fields`() {
    val (buffer, flushed) = collectingBuffer()
    AutoMobileNetwork.initialize("com.example", buffer)

    AutoMobileNetwork.recordRequest(
      NetworkRequestRecord(
        url = "https://api.example.com/users?page=1",
        method = "GET",
        protocol = "cronet",
        statusCode = 200,
        durationMs = 42,
        responseBodySize = 1024,
        host = "api.example.com",
        path = "/users",
      )
    )
    drainDelivery()

    assertEquals(1, flushed.size)
    val event = flushed[0][0] as SdkNetworkRequestEvent
    assertEquals("https://api.example.com/users?page=1", event.url)
    assertEquals("GET", event.method)
    assertEquals("cronet", event.protocol)
    assertEquals(200, event.statusCode)
    assertEquals(42L, event.durationMs)
    assertEquals(1024L, event.responseBodySize)
    assertEquals("api.example.com", event.host)
    assertEquals("/users", event.path)
    assertEquals("com.example", event.applicationId)
    assertNull(event.error)
  }

  @Test
  fun `recordRequest extracts host and path from URL when not provided`() {
    val (buffer, flushed) = collectingBuffer()
    AutoMobileNetwork.initialize("com.example", buffer)

    AutoMobileNetwork.recordRequest(
      NetworkRequestRecord(
        url = "https://api.example.com/v2/items",
        method = "POST",
      )
    )
    drainDelivery()

    val event = flushed[0][0] as SdkNetworkRequestEvent
    assertEquals("api.example.com", event.host)
    assertEquals("/v2/items", event.path)
  }

  @Test
  fun `recordRequest is no-op when not initialized`() {
    // buffer is null — should not throw
    AutoMobileNetwork.recordRequest(
      NetworkRequestRecord(
        url = "https://example.com",
        method = "GET",
      )
    )
  }

  @Test
  fun `recordRequest gates headers and bodies behind capture flags`() {
    val (buffer, flushed) = collectingBuffer()
    AutoMobileNetwork.initialize("com.example", buffer)

    val record =
      NetworkRequestRecord(
        url = "https://api.example.com/users",
        method = "POST",
        requestHeaders = mapOf("Authorization" to "Bearer token"),
        responseHeaders = mapOf("X-Request-Id" to "abc"),
        requestBody = "{\"name\":\"test\"}",
        responseBody = "{\"id\":1}",
      )

    // Without capture flags, headers and bodies should be null
    AutoMobileNetwork.recordRequest(record)
    drainDelivery()

    val event = flushed[0][0] as SdkNetworkRequestEvent
    assertNull(event.requestHeaders)
    assertNull(event.responseHeaders)
    assertNull(event.requestBody)
    assertNull(event.responseBody)
  }

  @Test
  fun `recordRequest includes headers and bodies when capture flags enabled`() {
    val (buffer, flushed) = collectingBuffer()
    AutoMobileNetwork.initialize("com.example", buffer)

    val record =
      NetworkRequestRecord(
        url = "https://api.example.com/users",
        method = "POST",
        requestHeaders = mapOf("Authorization" to "Bearer token"),
        responseHeaders = mapOf("X-Request-Id" to "abc"),
        requestBody = "{\"name\":\"test\"}",
        responseBody = "{\"id\":1}",
      )

    AutoMobileNetwork.recordRequest(record, captureHeaders = true, captureBodies = true)
    drainDelivery()

    val event = flushed[0][0] as SdkNetworkRequestEvent
    assertEquals(mapOf("Authorization" to "Bearer token"), event.requestHeaders)
    assertEquals(mapOf("X-Request-Id" to "abc"), event.responseHeaders)
    assertEquals("{\"name\":\"test\"}", event.requestBody)
    assertEquals("{\"id\":1}", event.responseBody)
  }

  @Test
  fun `registered capture policy overrides per-call capture flags`() {
    val (buffer, flushed) = collectingBuffer()
    AutoMobileNetwork.initialize("com.example", buffer)
    AutoMobileNetwork.setCapturePolicyProvider { SdkCapturePolicy() }

    AutoMobileNetwork.recordRequest(
      NetworkRequestRecord(
        url = "https://api.example.com/users",
        method = "POST",
        requestHeaders = mapOf("Authorization" to "Bearer token"),
        requestBody = "{\"name\":\"test\"}",
      ),
      captureHeaders = true,
      captureBodies = true,
    )
    drainDelivery()

    val event = flushed[0][0] as SdkNetworkRequestEvent
    assertNull(event.requestHeaders)
    assertNull(event.requestBody)
  }

  @Test
  fun `recordRequest swallows capture policy failures`() {
    val (buffer, flushed) = collectingBuffer()
    AutoMobileNetwork.initialize("com.example", buffer)
    AutoMobileNetwork.setCapturePolicyProvider { throw IllegalStateException("policy failed") }

    AutoMobileNetwork.recordRequest(
      NetworkRequestRecord(
        url = "https://api.example.com/users",
        method = "GET",
      )
    )

    assertEquals(emptyList(), flushed)
  }

  @Test
  fun `WebSocket controller requires an enabled network control policy`() {
    val (buffer, _) = collectingBuffer()
    var sends = 0
    val delegate =
      object : WebSocket {
        override fun request(): Request = Request.Builder().url("https://example.com").build()

        override fun queueSize(): Long = 0

        override fun send(text: String): Boolean {
          sends++
          return true
        }

        override fun send(bytes: ByteString): Boolean {
          sends++
          return true
        }

        override fun close(code: Int, reason: String?): Boolean = true

        override fun cancel() = Unit
      }
    val controller = WebSocketSendController { _, _ -> false }
    AutoMobileNetwork.initialize("com.example", buffer)
    AutoMobileNetwork.setCapturePolicyProvider { SdkCapturePolicy() }
    AutoMobileNetwork.setNetworkControlProvider { true }

    assertTrue(
      AutoMobileNetwork.wrapWebSocket(delegate, "wss://example.com", controller).send("one")
    )
    assertEquals(1, sends)

    AutoMobileNetwork.setCapturePolicyProvider { SdkCapturePolicy(allowMutations = true) }

    assertFalse(
      AutoMobileNetwork.wrapWebSocket(delegate, "wss://example.com", controller).send("two")
    )
    assertEquals(1, sends)

    val cancellation = CancellationException("controller cancelled")
    val thrown =
      assertFailsWith<CancellationException> {
        AutoMobileNetwork.wrapWebSocket(
            delegate,
            "wss://example.com",
            WebSocketSendController { _, _ -> throw cancellation },
          )
          .send("three")
      }

    assertSame(cancellation, thrown)
    assertEquals(1, sends)
  }

  @Test
  fun `NetworkRequestRecord defaults`() {
    val record = NetworkRequestRecord(url = "https://example.com", method = "GET")
    assertNull(record.requestHeaders)
    assertEquals(-1L, record.requestBodySize)
    assertEquals(0, record.statusCode)
    assertNull(record.responseHeaders)
    assertEquals(-1L, record.responseBodySize)
    assertEquals(0L, record.durationMs)
    assertNull(record.error)
    assertNull(record.host)
    assertNull(record.path)
    assertNull(record.requestBody)
    assertNull(record.responseBody)
    assertNull(record.contentType)
  }

  @Test
  fun `startCapture emits exactly one terminal event across racing callbacks`() {
    val (buffer, flushed) = collectingBuffer()
    AutoMobileNetwork.initialize("com.example", buffer)

    val session =
      AutoMobileNetwork.startCapture(
        url = "https://api.example.com/items",
        method = "GET",
        protocol = "httpurlconnection",
      )!!

    session.complete(statusCode = 200, durationMs = 12)
    session.fail(IllegalStateException("late failure"))
    session.cancel()
    drainDelivery()

    assertEquals(1, flushed.size)
    val event = flushed[0][0] as SdkNetworkRequestEvent
    assertEquals(200, event.statusCode)
    assertEquals("httpurlconnection", event.protocol)
    assertNull(event.error)
  }

  @Test
  fun `startCapture preserves opt in payload policy`() {
    val (buffer, flushed) = collectingBuffer()
    AutoMobileNetwork.initialize("com.example", buffer)
    val session =
      AutoMobileNetwork.startCapture(
        url = "https://api.example.com/items",
        method = "POST",
        requestHeaders = mapOf("Authorization" to "secret"),
        captureHeaders = true,
        captureBodies = true,
      )!!

    session.complete(
      statusCode = 201,
      responseHeaders = mapOf("X-Request-Id" to "abc"),
      responseBody = "{\"ok\":true}",
    )
    drainDelivery()

    val event = flushed[0][0] as SdkNetworkRequestEvent
    assertEquals(mapOf("Authorization" to "secret"), event.requestHeaders)
    assertEquals(mapOf("X-Request-Id" to "abc"), event.responseHeaders)
    assertEquals("{\"ok\":true}", event.responseBody)
  }
}
