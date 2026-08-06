package dev.jasonpearson.automobile.sdk.network

import dev.jasonpearson.automobile.protocol.SdkEvent
import dev.jasonpearson.automobile.protocol.SdkNetworkRequestEvent
import dev.jasonpearson.automobile.sdk.events.SdkEventBuffer
import dev.jasonpearson.automobile.sdk.capabilities.SdkCapturePolicy
import java.util.concurrent.Executors
import kotlin.test.assertEquals
import kotlin.test.assertNull
import org.junit.After
import org.junit.Test

class AutoMobileNetworkTest {

  @After
  fun tearDown() {
    AutoMobileNetwork.reset()
  }

  private fun collectingBuffer(): Pair<SdkEventBuffer, MutableList<List<SdkEvent>>> {
    val flushed = mutableListOf<List<SdkEvent>>()
    val buffer =
      SdkEventBuffer(
        maxBufferSize = 1,
        flushIntervalMs = 60_000,
        onFlush = { flushed.add(it) },
        executor = Executors.newSingleThreadScheduledExecutor(),
      )
    return buffer to flushed
  }

  @Test
  fun `recordRequest records event with all fields`() {
    val (buffer, flushed) = collectingBuffer()
    AutoMobileNetwork.initialize("com.example", buffer)

    AutoMobileNetwork.recordRequest(
      NetworkRequestRecord(
        url = "https://api.example.com/users?page=1",
        method = "GET",
        statusCode = 200,
        durationMs = 42,
        responseBodySize = 1024,
        host = "api.example.com",
        path = "/users",
      )
    )
    buffer.flush()

    assertEquals(1, flushed.size)
    val event = flushed[0][0] as SdkNetworkRequestEvent
    assertEquals("https://api.example.com/users?page=1", event.url)
    assertEquals("GET", event.method)
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
    buffer.flush()

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
    buffer.flush()

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
    buffer.flush()

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
    buffer.flush()

    val event = flushed[0][0] as SdkNetworkRequestEvent
    assertNull(event.requestHeaders)
    assertNull(event.requestBody)
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
}
