package dev.jasonpearson.automobile.sdk.network

import dev.jasonpearson.automobile.protocol.SdkNetworkRequestEvent
import java.io.IOException
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertTrue
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okio.buffer
import org.junit.Test

internal class AutoMobileNetworkInterceptorTest : AutoMobileNetworkInterceptorFixture() {
  @Test
  fun `records successful request metadata`() {
    val (buffer, flushed) = collectingBuffer()
    val interceptor = AutoMobileNetworkInterceptor(buffer, applicationId = "com.example")
    val request = Request.Builder().url("https://api.example.com/users?page=1").get().build()

    interceptor.intercept(
      fakeChain {
        this.request = request
        this.responseCode = 200
      },
    )
    drainDelivery()

    assertEquals(1, flushed.size)
    val event = flushed[0][0] as SdkNetworkRequestEvent
    assertEquals("https://api.example.com/users?page=1", event.url)
    assertEquals("GET", event.method)
    assertEquals(200, event.statusCode)
    assertEquals("api.example.com", event.host)
    assertEquals("/users", event.path)
    assertEquals("com.example", event.applicationId)
    assertNull(event.error)
  }

  @Test
  fun `records response body size`() {
    val (buffer, flushed) = collectingBuffer()
    val interceptor = AutoMobileNetworkInterceptor(buffer)
    val body = "x".repeat(1024)

    interceptor.intercept(
      fakeChain {
        this.responseBody = body
      },
    )
    drainDelivery()

    val event = flushed[0][0] as SdkNetworkRequestEvent
    assertEquals(1024L, event.responseBodySize)
  }

  @Test
  fun `records protocol`() {
    val (buffer, flushed) = collectingBuffer()
    val interceptor = AutoMobileNetworkInterceptor(buffer)

    interceptor.intercept(
      fakeChain {
        this.protocol = Protocol.HTTP_2
      },
    )
    drainDelivery()

    val event = flushed[0][0] as SdkNetworkRequestEvent
    assertEquals("h2", event.protocol)
  }

  @Test
  fun `records failed request with statusCode 0 and error message`() {
    val (buffer, flushed) = collectingBuffer()
    val interceptor = AutoMobileNetworkInterceptor(buffer)

    assertFailsWith<IOException> {
      interceptor.intercept(
        fakeChain {
          this.throwOnProceed = IOException("Connection refused")
        },
      )
    }
    drainDelivery()

    assertEquals(1, flushed.size)
    val event = flushed[0][0] as SdkNetworkRequestEvent
    assertEquals(0, event.statusCode)
    assertEquals(-1L, event.responseBodySize)
    assertEquals("Connection refused", event.error)
  }

  @Test
  fun `rethrows exception after recording`() {
    val (buffer, _) = collectingBuffer()
    val interceptor = AutoMobileNetworkInterceptor(buffer)

    assertFailsWith<IOException> {
      interceptor.intercept(
        fakeChain {
          this.throwOnProceed = IOException("timeout")
        },
      )
    }
  }

  @Test
  fun `records POST method`() {
    val (buffer, flushed) = collectingBuffer()
    val interceptor = AutoMobileNetworkInterceptor(buffer)
    val request =
      Request.Builder()
        .url("https://api.example.com/submit")
        .post("data".toRequestBody("text/plain".toMediaType()))
        .build()

    interceptor.intercept(
      fakeChain {
        this.request = request
        this.responseCode = 201
      },
    )
    drainDelivery()

    val event = flushed[0][0] as SdkNetworkRequestEvent
    assertEquals("POST", event.method)
    assertEquals(201, event.statusCode)
    assertEquals(4L, event.requestBodySize)
  }

  @Test
  fun `records duration greater than zero`() {
    val (buffer, flushed) = collectingBuffer()
    val interceptor = AutoMobileNetworkInterceptor(buffer)

    interceptor.intercept(fakeChain())
    drainDelivery()

    val event = flushed[0][0] as SdkNetworkRequestEvent
    assertTrue(event.durationMs >= 0, "Duration should be non-negative")
  }
}
