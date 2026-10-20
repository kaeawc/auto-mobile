package dev.jasonpearson.automobile.sdk.network

import dev.jasonpearson.automobile.protocol.SdkNetworkRequestEvent
import java.io.IOException
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertSame
import kotlin.test.assertTrue
import okio.buffer
import org.junit.Test

internal class AutoMobileNetworkInterceptorResponseBodyTest :
  AutoMobileNetworkInterceptorFixture() {
  @Test
  fun `server-sent-event response is returned without reading the body and is not captured`() {
    val (buffer, flushed) = collectingBuffer()
    val interceptor = AutoMobileNetworkInterceptor(buffer, captureBodies = true)
    val source = OneChunkSource(twentyBytes)

    val response =
      interceptor.intercept(
        fakeChain {
          this.responseContentType = "text/event-stream"
          this.responseBodyOverride = streamingBody(source, "text/event-stream")
        },
      )
    drainDelivery()

    assertEquals(0, source.reads)
    val event = flushed.single().single() as SdkNetworkRequestEvent
    assertEquals(200, event.statusCode)
    assertNull(event.responseBody)
    assertEquals("data: hello\n\nabcdefg", response.body.source().readUtf8(20))
    assertEquals(1, source.reads)
  }

  @Test
  fun `streaming json response is returned without a read and reported when the app closes it`() {
    val (buffer, flushed) = collectingBuffer()
    val interceptor = AutoMobileNetworkInterceptor(buffer, captureBodies = true)
    val source = OneChunkSource(twentyBytes)

    val response =
      interceptor.intercept(
        fakeChain {
          this.responseBodyOverride = streamingBody(source, "application/json")
        },
      )
    drainDelivery()
    assertEquals(0, source.reads)
    assertTrue(flushed.isEmpty())

    assertEquals("data: hello\n\nabcdefg", response.body.source().readUtf8(20))
    drainDelivery()
    assertTrue(flushed.isEmpty())

    response.close()
    drainDelivery()
    assertTrue(source.closed)
    assertEquals(
      "data: hello\n\nabcdefg",
      (flushed.single().single() as SdkNetworkRequestEvent).responseBody,
    )
  }

  @Test
  fun `large response is delivered whole while only the cap is captured`() {
    val (buffer, flushed) = collectingBuffer()
    val interceptor = AutoMobileNetworkInterceptor(buffer, captureBodies = true)
    val big = "a".repeat(100 * 1024)

    val response =
      interceptor.intercept(
        fakeChain {
          this.responseBody = big
        },
      )
    drainDelivery()
    assertTrue(flushed.isEmpty())

    assertEquals(big, response.body.string())
    drainDelivery()

    val captured = (flushed.single().single() as SdkNetworkRequestEvent).responseBody
    assertEquals("a".repeat(AutoMobileNetworkInterceptor.MAX_BODY_BYTES.toInt()), captured)
  }

  @Test
  fun `response read failure reports what was captured and rethrows`() {
    val (buffer, flushed) = collectingBuffer()
    val interceptor = AutoMobileNetworkInterceptor(buffer, captureBodies = true)
    val failure = IOException("connection reset")
    val source = OneChunkSource("partial".toByteArray(), failWith = failure)

    val response =
      interceptor.intercept(
        fakeChain {
          this.responseBodyOverride = streamingBody(source, "application/json")
        },
      )
    val thrown = assertFailsWith<IOException> { response.body.string() }
    drainDelivery()

    assertSame(failure, thrown)
    assertEquals("partial", (flushed.single().single() as SdkNetworkRequestEvent).responseBody)
  }

  @Test
  fun `abandoned response body is reported at the deadline exactly once`() {
    val (buffer, flushed) = collectingBuffer()
    val deadlines = mutableListOf<Pair<Runnable, Long>>()
    var cancelled = 0
    val interceptor =
      AutoMobileNetworkInterceptor(buffer, captureBodies = true).apply {
        scheduleCaptureDeadline = { task, delayMs ->
          deadlines.add(task to delayMs)
          val cancel: () -> Unit = { cancelled++ }
          cancel
        }
      }
    val source = OneChunkSource(twentyBytes)

    val response =
      interceptor.intercept(
        fakeChain {
          this.responseBodyOverride = streamingBody(source, "application/json")
        },
      )
    response.body.source().require(1)
    drainDelivery()
    assertTrue(flushed.isEmpty())
    assertEquals(NetworkBodyCapture.RESPONSE_CAPTURE_DEADLINE_MS, deadlines.single().second)

    deadlines.single().first.run()
    response.close()
    drainDelivery()

    assertEquals(
      "data: hello\n\nabcdefg",
      (flushed.single().single() as SdkNetworkRequestEvent).responseBody,
    )
    assertEquals(1, cancelled) // the late close does not re-emit
  }

  @Test
  fun `completing the body cancels its deadline`() {
    val (buffer, _) = collectingBuffer()
    var cancelled = 0
    val interceptor =
      AutoMobileNetworkInterceptor(buffer, captureBodies = true).apply {
        scheduleCaptureDeadline = { _, _ -> { cancelled++ } }
      }

    interceptor
      .intercept(
        fakeChain {
          this.responseBody = """{"ok":true}"""
        },
      )
      .body
      .string()

    assertEquals(1, cancelled)
  }

  @Test
  fun `empty response body is reported immediately`() {
    val (buffer, flushed) = collectingBuffer()
    val interceptor = AutoMobileNetworkInterceptor(buffer, captureBodies = true)

    interceptor.intercept(
      fakeChain {
        this.responseBody = ""
      },
    )
    drainDelivery()

    assertEquals("", (flushed.single().single() as SdkNetworkRequestEvent).responseBody)
  }
}
