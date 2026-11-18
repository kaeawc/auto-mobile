package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.PrototypeRequestErrorCode
import dev.jasonpearson.automobile.protocol.PrototypeRequestResponse
import java.io.File
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * Upload bodies across 307/308 redirects (#14272): the whole body is sent again to the target, the
 * upload percent never goes backwards across hops, and the request timeout spans every hop. The
 * transport clock is fake, so no test waits on a real timer.
 */
class RetrofitPrototypeHttpClientUploadRedirectTest {
  private val server = MockWebServer()
  private lateinit var file: File
  private var now = 0L
  private val policy = PrototypeDestinationPolicy { _, _, _ -> PrototypeEgressDecision.Allow }

  /** [uploadTick] is how far the fake clock moves each time the upload body reads it. */
  private fun client(uploadTick: Long) =
    RetrofitPrototypeHttpClient(
        OkHttpClient(),
        clock = { now },
        policy = policy,
        warn = { _, _ -> },
        debug = {},
      )
      .apply {
        uploadBodies = PrototypeUploadRequestBodies({ now.also { now += uploadTick } }, { "b" })
      }

  private fun request(progress: (Int) -> Unit) =
    PrototypeHttpRequest(
      "upload",
      "proto",
      "POST",
      server.url("/upload").toString(),
      mapOf("Authorization" to "Bearer t"),
      null,
      5000,
      PrototypeUploadBody.FileBody(file, "application/octet-stream"),
      progress,
    )

  private fun redirect(code: Int) =
    MockResponse.Builder().code(code).addHeader("Location", "/next").build()

  @Before
  fun prepare() {
    server.start()
    file = File.createTempFile("prototype-upload", ".bin")
    file.writeBytes(byteArrayOf(0, 1, -1, 13, 10))
  }

  @After
  fun close() {
    file.delete()
    server.close()
  }

  private fun assertResendsBodyWithRisingProgress(code: Int) = runBlocking {
    server.enqueue(redirect(code))
    server.enqueue(MockResponse.Builder().body("ok").build())
    val updates = mutableListOf<Int>()
    val response = client(uploadTick = 100L).execute(request { updates += it })
    assertEquals(200, (response as PrototypeRequestResponse.Received).status)
    val first = checkNotNull(server.takeRequest(1, TimeUnit.SECONDS))
    val second = checkNotNull(server.takeRequest(1, TimeUnit.SECONDS))
    assertEquals("/next", second.url.encodedPath)
    assertEquals("POST", second.method)
    assertEquals("Bearer t", second.headers["Authorization"])
    assertArrayEquals(file.readBytes(), checkNotNull(first.body).toByteArray())
    assertArrayEquals(file.readBytes(), checkNotNull(second.body).toByteArray())
    assertEquals(listOf(0, 100), updates)
  }

  @Test
  fun `307 re-sends the same body and progress never goes backwards across hops`() =
    assertResendsBodyWithRisingProgress(307)

  @Test
  fun `308 re-sends the same body and progress never goes backwards across hops`() =
    assertResendsBodyWithRisingProgress(308)

  @Test
  fun `a redirect after the upload used the whole timeout fails as a timeout`() = runBlocking {
    server.enqueue(redirect(307))
    val response = client(uploadTick = 3_000L).execute(request {})
    assertEquals(
      PrototypeRequestErrorCode.TIMEOUT,
      (response as PrototypeRequestResponse.Failed).error.code,
    )
    assertEquals(1, server.requestCount)
  }

  @Test
  fun `non-decreasing progress forwards only percents above the highest so far`() {
    val forwarded = mutableListOf<Int>()
    val progress = nonDecreasing { forwarded += it }
    listOf(0, 40, 100, 0, 50, 100, 120, -5).forEach(progress)
    assertEquals(listOf(0, 40, 100), forwarded)
    assertTrue(forwarded.zipWithNext().all { (a, b) -> b > a })
  }
}
