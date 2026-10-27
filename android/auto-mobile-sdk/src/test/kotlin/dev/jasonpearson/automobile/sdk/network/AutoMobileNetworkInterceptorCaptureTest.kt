package dev.jasonpearson.automobile.sdk.network

import dev.jasonpearson.automobile.protocol.SdkNetworkRequestEvent
import java.io.IOException
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okio.buffer
import org.junit.Test

internal class AutoMobileNetworkInterceptorCaptureTest : AutoMobileNetworkInterceptorFixture() {
  @Test
  fun `captureHeaders true captures request headers`() {
    val (buffer, flushed) = collectingBuffer()
    val interceptor = AutoMobileNetworkInterceptor(buffer, captureHeaders = true)
    val request =
      Request.Builder()
        .url("https://api.example.com/users")
        .header("Accept", "application/json")
        .header("Authorization", "Bearer token123")
        .build()

    interceptor.intercept(
      fakeChain {
        this.request = request
      },
    )
    drainDelivery()

    val event = flushed[0][0] as SdkNetworkRequestEvent
    assertNotNull(event.requestHeaders)
    assertEquals("application/json", event.requestHeaders!!["Accept"])
    assertEquals("Bearer token123", event.requestHeaders!!["Authorization"])
  }

  @Test
  fun `captureHeaders joins repeated request header values in encounter order`() {
    val (buffer, flushed) = collectingBuffer()
    val interceptor = AutoMobileNetworkInterceptor(buffer, captureHeaders = true)
    // addHeader appends rather than replacing, so this is the only way to produce a
    // Headers instance with a repeated name. Three values, not two: two would still pass
    // if the join order were reversed or the fold kept only the outermost pair.
    val request =
      Request.Builder()
        .url("https://api.example.com/users")
        .addHeader("X-Trace", "first")
        .addHeader("X-Trace", "second")
        .addHeader("X-Trace", "third")
        .build()

    interceptor.intercept(
      fakeChain {
        this.request = request
      },
    )
    drainDelivery()

    val event = flushed[0][0] as SdkNetworkRequestEvent
    assertEquals("first, second, third", event.requestHeaders!!["X-Trace"])
  }

  @Test
  fun `captureHeaders keeps repeated header names case sensitive`() {
    val (buffer, flushed) = collectingBuffer()
    val interceptor = AutoMobileNetworkInterceptor(buffer, captureHeaders = true)
    // Differently-cased names are distinct keys -- they must not be folded together, which
    // is why this cannot delegate to okhttp's Headers.toMultimap() (that lowercases names).
    val request =
      Request.Builder()
        .url("https://api.example.com/users")
        .addHeader("X-Case", "lower")
        .addHeader("X-CASE", "upper")
        .build()

    interceptor.intercept(
      fakeChain {
        this.request = request
      },
    )
    drainDelivery()

    val event = flushed[0][0] as SdkNetworkRequestEvent
    assertEquals("lower", event.requestHeaders!!["X-Case"])
    assertEquals("upper", event.requestHeaders!!["X-CASE"])
  }

  @Test
  fun `captureHeaders true captures response headers`() {
    val (buffer, flushed) = collectingBuffer()
    val interceptor = AutoMobileNetworkInterceptor(buffer, captureHeaders = true)

    interceptor.intercept(fakeChain())
    drainDelivery()

    val event = flushed[0][0] as SdkNetworkRequestEvent
    assertNotNull(event.responseHeaders)
    // Response has Content-Type from fakeChain body
    assertEquals("application/json", event.responseHeaders!!["Content-Type"])
  }

  @Test
  fun `captureHeaders false does not capture headers`() {
    val (buffer, flushed) = collectingBuffer()
    val interceptor = AutoMobileNetworkInterceptor(buffer, captureHeaders = false)

    interceptor.intercept(fakeChain())
    drainDelivery()

    val event = flushed[0][0] as SdkNetworkRequestEvent
    assertNull(event.requestHeaders)
    assertNull(event.responseHeaders)
  }

  @Test
  fun `captureBodies true captures request body for text content type`() {
    val (buffer, flushed) = collectingBuffer()
    val interceptor = AutoMobileNetworkInterceptor(buffer, captureBodies = true)
    val request =
      Request.Builder()
        .url("https://api.example.com/submit")
        .post("""{"name":"test"}""".toRequestBody("application/json".toMediaType()))
        .build()

    interceptor
      .intercept(
        fakeChain {
          this.request = request
          this.responseCode = 201
        },
      )
      .close()
    drainDelivery()

    val event = flushed[0][0] as SdkNetworkRequestEvent
    assertEquals("""{"name":"test"}""", event.requestBody)
  }

  @Test
  fun `captureBodies true captures response body for JSON`() {
    val (buffer, flushed) = collectingBuffer()
    val interceptor = AutoMobileNetworkInterceptor(buffer, captureBodies = true)

    val response =
      interceptor.intercept(
        fakeChain {
          this.responseBody = """{"ok":true}"""
        },
      )
    assertEquals("""{"ok":true}""", response.body.string())
    drainDelivery()

    val event = flushed[0][0] as SdkNetworkRequestEvent
    assertEquals("""{"ok":true}""", event.responseBody)
  }

  @Test
  fun `captureBodies false does not capture bodies`() {
    val (buffer, flushed) = collectingBuffer()
    val interceptor = AutoMobileNetworkInterceptor(buffer, captureBodies = false)
    val request =
      Request.Builder()
        .url("https://api.example.com/submit")
        .post("data".toRequestBody("text/plain".toMediaType()))
        .build()

    interceptor.intercept(
      fakeChain {
        this.request = request
      },
    )
    drainDelivery()

    val event = flushed[0][0] as SdkNetworkRequestEvent
    assertNull(event.requestBody)
    assertNull(event.responseBody)
  }

  @Test
  fun `captureBodies does not capture binary content types`() {
    val (buffer, flushed) = collectingBuffer()
    val interceptor = AutoMobileNetworkInterceptor(buffer, captureBodies = true)
    val request =
      Request.Builder()
        .url("https://api.example.com/image")
        .post("binary".toRequestBody("image/png".toMediaType()))
        .build()

    interceptor
      .intercept(
        fakeChain {
          this.request = request
        },
      )
      .close()
    drainDelivery()

    val event = flushed[0][0] as SdkNetworkRequestEvent
    assertNull(event.requestBody) // image/png is not a text type
  }

  @Test
  fun `contentType field is populated from response`() {
    val (buffer, flushed) = collectingBuffer()
    val interceptor = AutoMobileNetworkInterceptor(buffer)

    interceptor.intercept(fakeChain())
    drainDelivery()

    val event = flushed[0][0] as SdkNetworkRequestEvent
    assertEquals("application/json", event.contentType)
  }

  @Test
  fun `failed request with captureHeaders still captures request headers`() {
    val (buffer, flushed) = collectingBuffer()
    val interceptor = AutoMobileNetworkInterceptor(buffer, captureHeaders = true)
    val request =
      Request.Builder().url("https://api.example.com/fail").header("X-Custom", "value").build()

    assertFailsWith<IOException> {
      interceptor.intercept(
        fakeChain {
          this.request = request
          this.throwOnProceed = IOException("timeout")
        },
      )
    }
    drainDelivery()

    val event = flushed[0][0] as SdkNetworkRequestEvent
    assertNotNull(event.requestHeaders)
    assertEquals("value", event.requestHeaders!!["X-Custom"])
    assertNull(event.responseHeaders) // no response
  }

  @Test
  fun `default captureHeaders and captureBodies are false`() {
    val (buffer, flushed) = collectingBuffer()
    val interceptor = AutoMobileNetworkInterceptor(buffer)

    interceptor.intercept(fakeChain())
    drainDelivery()

    val event = flushed[0][0] as SdkNetworkRequestEvent
    assertNull(event.requestHeaders)
    assertNull(event.responseHeaders)
    assertNull(event.requestBody)
    assertNull(event.responseBody)
  }
}
