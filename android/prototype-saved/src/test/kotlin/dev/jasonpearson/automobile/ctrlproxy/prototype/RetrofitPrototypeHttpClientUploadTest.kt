package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.PrototypeRequestErrorCode
import dev.jasonpearson.automobile.protocol.PrototypeRequestResponse
import dev.jasonpearson.automobile.protocol.PrototypeSpecValidator
import java.io.File
import java.io.RandomAccessFile
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.Call
import okhttp3.EventListener
import okhttp3.OkHttpClient
import okio.Buffer
import okio.ForwardingSink
import okio.buffer
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

class RetrofitPrototypeHttpClientUploadTest {
  private val server = MockWebServer()
  private lateinit var file: File
  private var now = 0L
  private val policy = PrototypeDestinationPolicy { _, _, _ -> PrototypeEgressDecision.Allow }

  private fun client(http: OkHttpClient = OkHttpClient()) =
    RetrofitPrototypeHttpClient(
        http,
        clock = { now },
        policy = policy,
        warn = { _, _ -> },
        debug = {},
      )
      .apply { uploadBodies = PrototypeUploadRequestBodies({ now }, { "pinned-boundary" }) }

  private fun request(upload: PrototypeUploadBody, progress: ((Int) -> Unit)? = null) =
    PrototypeHttpRequest(
      "upload",
      "proto",
      "POST",
      server.url("/upload").toString(),
      mapOf("Content-Type" to "text/plain"),
      null,
      5000,
      upload,
      progress,
    )

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

  @Test
  fun `received multipart has pinned boundary part headers and identical binary bytes`() =
    runBlocking {
      server.enqueue(MockResponse.Builder().body("ok").build())
      val upload =
        PrototypeUploadBody.Multipart(
          listOf(
            PrototypeUploadBody.Part("caption", value = "hello & world"),
            PrototypeUploadBody.Part(
              "photo",
              file = PrototypeUploadBody.FileBody(file, "image/png"),
              filename = "photo.png",
            ),
          ),
        )
      assertTrue(client().execute(request(upload)) is PrototypeRequestResponse.Received)
      val sent = checkNotNull(server.takeRequest(1, TimeUnit.SECONDS))
      assertEquals("multipart/form-data; boundary=pinned-boundary", sent.headers["Content-Type"])
      val wire = Buffer().write(checkNotNull(sent.body))
      fun partHeaders(): List<String> = buildList {
        while (true) {
          val line = wire.readUtf8LineStrict()
          if (line.isEmpty()) break
          add(line)
        }
      }
      assertEquals("--pinned-boundary", wire.readUtf8LineStrict())
      assertTrue(partHeaders().contains("Content-Disposition: form-data; name=\"caption\""))
      assertEquals("hello & world", wire.readUtf8LineStrict())
      assertEquals("--pinned-boundary", wire.readUtf8LineStrict())
      val headers = partHeaders()
      assertTrue(
        headers.contains("Content-Disposition: form-data; name=\"photo\"; filename=\"photo.png\""),
      )
      assertTrue(headers.contains("Content-Type: image/png"))
      assertArrayEquals(file.readBytes(), wire.readByteArray(file.length()))
      assertEquals("\r\n--pinned-boundary--\r\n", wire.readUtf8())
    }

  @Test
  fun `received form is URL encoded with its own content type`() = runBlocking {
    server.enqueue(MockResponse.Builder().body("ok").build())
    client()
      .execute(request(PrototypeUploadBody.Form(linkedMapOf("q" to "a b&é", "flag" to "true"))))
    val sent = checkNotNull(server.takeRequest(1, TimeUnit.SECONDS))
    assertEquals("application/x-www-form-urlencoded", sent.headers["Content-Type"])
    assertEquals("q=a+b%26%C3%A9&flag=true", checkNotNull(sent.body).utf8())
  }

  @Test
  fun `received raw file preserves bytes and authored body content type`() = runBlocking {
    server.enqueue(MockResponse.Builder().body("ok").build())
    client().execute(request(PrototypeUploadBody.FileBody(file, "application/custom")))
    val sent = checkNotNull(server.takeRequest(1, TimeUnit.SECONDS))
    assertEquals("application/custom", sent.headers["Content-Type"])
    assertArrayEquals(file.readBytes(), checkNotNull(sent.body).toByteArray())
  }

  @Test
  fun `aggregate file bytes over the cap fail before a network call`() = runBlocking {
    RandomAccessFile(file, "rw").use {
      it.setLength(PrototypeSpecValidator.MAX_PROTOTYPE_UPLOAD_BYTES / 2L + 1)
    }
    val part =
      PrototypeUploadBody.Part(
        "file",
        file = PrototypeUploadBody.FileBody(file, "image/png"),
        filename = "f.png",
      )
    val response = client().execute(request(PrototypeUploadBody.Multipart(listOf(part, part))))
    assertEquals(
      PrototypeRequestErrorCode.INVALID_REQUEST,
      (response as PrototypeRequestResponse.Failed).error.code,
    )
    assertEquals(0, server.requestCount)
  }

  @Test
  fun `missing file fails as invalid request before a network call`() = runBlocking {
    file.delete()
    val response = client().execute(request(PrototypeUploadBody.FileBody(file, "image/png")))
    assertEquals(
      PrototypeRequestErrorCode.INVALID_REQUEST,
      (response as PrototypeRequestResponse.Failed).error.code,
    )
    assertEquals(0, server.requestCount)
  }

  @Test
  fun `progress uses fake milliseconds and emits no faster than ten hertz`() {
    file.writeBytes(ByteArray(8192 * 8))
    val updates = mutableListOf<Pair<Long, Int>>()
    val body =
      client()
        .uploadRequestBody(
          request(PrototypeUploadBody.FileBody(file, "image/png")) {
            updates += now to it
          },
        )
    val destination = Buffer()
    val sink =
      object : ForwardingSink(destination) {
          override fun write(source: Buffer, byteCount: Long) {
            now += 25L
            super.write(source, byteCount)
          }
        }
        .buffer()
    body.writeTo(sink)
    sink.flush()
    assertEquals(file.length(), destination.size)
    assertEquals(0L to 0, updates.first())
    assertTrue(updates.size >= 2)
    assertTrue(updates.zipWithNext().all { (a, b) -> b.first - a.first >= 100L })
    assertTrue(updates.all { it.second in 0..100 })
  }

  @Test
  fun `cancelling during file writes cancels the OkHttp call`() = runBlocking {
    file.writeBytes(ByteArray(8192 * 16))
    val cancelled = AtomicBoolean(false)
    val http =
      OkHttpClient.Builder()
        .eventListener(
          object : EventListener() {
            override fun canceled(call: Call) {
              cancelled.set(true)
            }
          },
        )
        .build()
    val transport =
      RetrofitPrototypeHttpClient(
        http,
        policy = policy,
        clock = { now.also { now += 100L } },
        warn = { _, _ -> },
        debug = {},
      )
    lateinit var job: Job
    job =
      launch(start = CoroutineStart.LAZY) {
        transport.execute(
          request(PrototypeUploadBody.FileBody(file, "image/png")) { percent ->
            if (percent in 1..99) job.cancel()
          },
        )
      }
    job.start()
    job.join()
    assertTrue(job.isCancelled)
    assertTrue(cancelled.get())
  }
}
