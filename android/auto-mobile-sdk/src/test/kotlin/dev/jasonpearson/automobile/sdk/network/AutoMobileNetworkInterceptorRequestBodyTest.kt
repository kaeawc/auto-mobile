package dev.jasonpearson.automobile.sdk.network

import dev.jasonpearson.automobile.protocol.SdkNetworkRequestEvent
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import okio.Buffer
import okio.buffer
import org.junit.Test

internal class AutoMobileNetworkInterceptorRequestBodyTest : AutoMobileNetworkInterceptorFixture() {
  @Test
  fun `one-shot request body is not written by capture and reaches the chain intact`() {
    val (buffer, flushed) = collectingBuffer()
    val interceptor = AutoMobileNetworkInterceptor(buffer, captureBodies = true)
    val payload = """{"stream":"from input stream"}""".toByteArray()
    val body = RecordingRequestBody("application/json", payload.size.toLong(), payload, 1, true)
    val request = postRequest(body)
    var sent = ""

    interceptor
      .intercept(
        FakeInterceptorChain(
          ChainOptions().apply {
            this.request = request
            this.onProceed = {
              val wire = Buffer()
              request.body!!.writeTo(wire)
              sent = wire.readUtf8()
            }
          },
        ),
      )
      .close()
    drainDelivery()

    assertEquals(1, body.writeToCalls)
    assertEquals("""{"stream":"from input stream"}""", sent)
    assertNull((flushed.single().single() as SdkNetworkRequestEvent).requestBody)
  }

  @Test
  fun `duplex request body is never written by capture`() {
    val (buffer, flushed) = collectingBuffer()
    val interceptor = AutoMobileNetworkInterceptor(buffer, captureBodies = true)
    val body = RecordingRequestBody("text/plain", -1, "x".toByteArray(), 1, duplex = true)

    interceptor
      .intercept(
        fakeChain {
          this.request = postRequest(body)
        },
      )
      .close()
    drainDelivery()

    assertEquals(0, body.writeToCalls)
    assertNull((flushed.single().single() as SdkNetworkRequestEvent).requestBody)
  }

  @Test
  fun `known-length 50 MB request body is skipped without being written`() {
    val (buffer, flushed) = collectingBuffer()
    val interceptor = AutoMobileNetworkInterceptor(buffer, captureBodies = true)
    val fiftyMb = 50L * 1024 * 1024
    val body =
      RecordingRequestBody("text/csv", fiftyMb, ByteArray(1024) { 'a'.code.toByte() }, 51_200)

    interceptor
      .intercept(
        fakeChain {
          this.request = postRequest(body)
        },
      )
      .close()
    drainDelivery()

    assertEquals(0, body.writeToCalls)
    assertEquals(0L, body.bytesWritten)
    val event = flushed.single().single() as SdkNetworkRequestEvent
    assertNull(event.requestBody)
    assertEquals(fiftyMb, event.requestBodySize)
  }

  @Test
  fun `unknown-length request body stops being pulled at the capture cap`() {
    val (buffer, flushed) = collectingBuffer()
    val interceptor = AutoMobileNetworkInterceptor(buffer, captureBodies = true)
    val chunk = ByteArray(1024) { 'a'.code.toByte() }
    val body = RecordingRequestBody("text/plain", -1, chunk, 10 * 1024) // 10 MB if fully written

    interceptor
      .intercept(
        fakeChain {
          this.request = postRequest(body)
        },
      )
      .close()
    drainDelivery()

    assertEquals(1, body.writeToCalls)
    assertTrue(
      body.bytesWritten < 4 * AutoMobileNetworkInterceptor.MAX_BODY_BYTES,
      "capture pulled ${body.bytesWritten} bytes",
    )
    val captured = (flushed.single().single() as SdkNetworkRequestEvent).requestBody
    assertEquals(AutoMobileNetworkInterceptor.MAX_BODY_BYTES.toInt(), captured?.length)
  }

  @Test
  fun `small known-length request body is still captured whole`() {
    val (buffer, flushed) = collectingBuffer()
    val interceptor = AutoMobileNetworkInterceptor(buffer, captureBodies = true)
    val chunk = "hello".toByteArray()
    val body = RecordingRequestBody("text/plain", 10, chunk, 2)

    interceptor
      .intercept(
        fakeChain {
          this.request = postRequest(body)
        },
      )
      .close()
    drainDelivery()

    assertEquals("hellohello", (flushed.single().single() as SdkNetworkRequestEvent).requestBody)
  }
}
