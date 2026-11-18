package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.*
import java.io.IOException
import java.net.InetAddress
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.*
import okhttp3.Dns
import okhttp3.MediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.Buffer
import okio.BufferedSource
import okio.buffer
import org.junit.Assert.*
import org.junit.BeforeClass
import org.junit.Test

/** Scripted application interceptors answer without sockets, DNS, or an Android runtime. */
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class PrototypeRemoteImageTransportTest {
  companion object {
    @JvmStatic
    @BeforeClass
    fun warm() = runBlocking {
      val client =
        OkHttpClient.Builder()
          .addInterceptor { chain ->
            Response.Builder()
              .request(chain.request())
              .protocol(Protocol.HTTP_1_1)
              .code(200)
              .message("ok")
              .body(synthesizedTransportPng().toResponseBody())
              .build()
          }
          .build()
      RetrofitPrototypeHttpClient(client, warn = { _, _ -> }, debug = {})
        .download("https://images.example/i")
      Unit
    }
  }

  private fun client(
    policy: PrototypeDestinationPolicy = PrototypeEgressPolicy(),
    allowLoopback: Boolean = false,
    reply: (Request) -> Response,
  ) =
    RetrofitPrototypeHttpClient(
      OkHttpClient.Builder()
        .dns(Dns { error("No DNS expected") })
        .addInterceptor { reply(it.request()) }
        .build(),
      policy = policy,
      allowLoopbackImages = allowLoopback,
      warn = { _, _ -> error("No per-image logs") },
      debug = { error("No per-image logs") },
    )

  private fun response(
    request: Request,
    code: Int = 200,
    location: String? = null,
    body: ResponseBody = synthesizedTransportPng().toResponseBody(),
  ): Response =
    Response.Builder()
      .request(request)
      .protocol(Protocol.HTTP_1_1)
      .code(code)
      .message("scripted")
      .body(body)
      .apply { location?.let { header("Location", it) } }
      .build()

  private suspend fun refused(block: suspend () -> Unit) {
    try {
      block()
      fail("Expected refusal")
    } catch (error: IOException) {
      assertNotNull(error.message)
    }
  }

  @Test
  fun `egress refusal precedes HTTP and emits no log`() = runBlocking {
    var calls = 0
    val transport =
      client(policy = { _, _, _ -> PrototypeEgressDecision.Blocked("blocked") }) {
        calls++
        response(it)
      }
    refused { transport.download("https://images.example/private") }
    assertEquals(0, calls)
  }

  @Test
  fun `redirects recheck egress and never send cookies or Referer`() = runBlocking {
    val sent = mutableListOf<Request>()
    val transport = client {
      sent += it
      response(it, 302, "https://169.254.169.254/private")
    }
    refused { transport.download("https://images.example/private") }
    assertEquals(1, sent.size)
    assertNull(sent.single().header("Cookie"))
    assertNull(sent.single().header("Referer"))
  }

  @Test
  fun `declared oversize is closed without reading`() = runBlocking {
    var read = false
    var closed = false
    val source =
      object : okio.Source {
          override fun read(sink: Buffer, byteCount: Long): Long {
            read = true
            error("Must not read oversize body")
          }

          override fun timeout() = okio.Timeout.NONE

          override fun close() {
            closed = true
          }
        }
        .buffer()
    val body =
      object : ResponseBody() {
        override fun contentType(): MediaType? = null

        override fun contentLength(): Long =
          PrototypeRemoteImages.MAX_PROTOTYPE_REMOTE_IMAGE_DOWNLOAD_BYTES.toLong() + 1

        override fun source(): BufferedSource = source
      }
    val transport = client { response(it, body = body) }
    refused { transport.download("https://images.example/i") }
    assertFalse(read)
    assertTrue(closed)
  }

  @Test
  fun `unknown length stream is capped before the loader can cache it`() = runBlocking {
    var readBytes = 0L
    var closed = false
    val chunk = ByteArray(8192)
    val source =
      object : okio.Source {
          override fun read(sink: Buffer, byteCount: Long): Long {
            val count = minOf(byteCount, chunk.size.toLong()).toInt()
            sink.write(chunk, 0, count)
            readBytes += count
            return count.toLong()
          }

          override fun timeout() = okio.Timeout.NONE

          override fun close() {
            closed = true
          }
        }
        .buffer()
    val body =
      object : ResponseBody() {
        override fun contentType(): MediaType? = null

        override fun contentLength() = -1L

        override fun source(): BufferedSource = source
      }
    val transport = client { response(it, body = body) }
    refused { transport.download("https://images.example/large") }
    val limit = PrototypeRemoteImages.MAX_PROTOTYPE_REMOTE_IMAGE_DOWNLOAD_BYTES
    assertTrue(readBytes > limit)
    assertTrue(readBytes <= limit + chunk.size)
    assertTrue(closed)
  }

  @Test
  fun `development loopback allowance preserves protected ports and resolved socket checks`() {
    val policy = PrototypeEgressPolicy(allowLoopback = true)
    val local = InetAddress.getByAddress(byteArrayOf(127, 0, 0, 1))
    val public = InetAddress.getByAddress(byteArrayOf(8, 8, 8, 8))
    assertEquals(PrototypeEgressDecision.Allow, policy.check("localhost", 8080, listOf(local)))
    assertTrue(policy.check("localhost", 8765, listOf(local)) is PrototypeEgressDecision.Blocked)
    assertTrue(policy.check("localhost", 8080, listOf(public)) is PrototypeEgressDecision.Blocked)
    assertTrue(
      PrototypeEgressPolicy().check("localhost", 8080, listOf(local))
        is PrototypeEgressDecision.Blocked,
    )
  }

  @Test
  fun `cleartext is loopback only and production refuses it even with permissive egress`() =
    runBlocking {
      var calls = 0
      val transport =
        client(policy = { _, _, _ -> PrototypeEgressDecision.Allow }) {
          calls++
          response(it)
        }
      refused { transport.download("http://localhost:8080/i") }
      refused { transport.download("http://images.example/i") }
      assertEquals(0, calls)
    }

  /** The actual renderer binding path feeds the actual HTTP transport through the loader. */
  @Test
  fun `bound and whole-field private URLs fail without sending a request`() = runTest {
    val cases =
      listOf(
        "https://{host}/a" to mapOf("host" to PrototypeScalar.Text("10.0.0.1")),
        "{photo}" to mapOf("photo" to PrototypeScalar.Text("https://10.0.0.1/")),
        "{photo}" to mapOf("photo" to PrototypeScalar.Text("http://169.254.169.254/")),
      )
    for ((url, state) in cases) {
      val spec =
        PrototypeSpecValidator.json
          .decodeFromString<PrototypeSpec>(
            """{"id":"private-image","window":{"placement":{"type":"fullscreen"}},"root":{"type":"image","url":"https://images.example/a"}}""",
          )
          .copy(state = state, root = PrototypeImageNode(url = url))
      val resolved = (mapPrototypeSpec(spec).root.source as PrototypeImageNode).url!!
      val sent = mutableListOf<Request>()
      val transport = client {
        sent += it
        response(it)
      }
      assertImageError(transport, resolved)
      assertTrue(sent.isEmpty())
    }
  }

  @Test
  fun `redirects to private hosts and HTTPS downgrade fail without contacting the target`() =
    runTest {
      for (location in listOf("https://10.0.0.1/", "http://public.example/a")) {
        val sent = mutableListOf<Request>()
        val transport = client {
          sent += it
          response(it, 302, location)
        }
        assertImageError(transport, "https://images.example/a")
        assertEquals(listOf("images.example"), sent.map { it.url.host })
      }
    }

  @Test
  fun `404 goes to image error without decoding or reading its response body`() = runTest {
    var read = false
    val body =
      object : ResponseBody() {
        override fun contentType(): MediaType? = null

        override fun contentLength() = Long.MAX_VALUE

        override fun source() =
          object : okio.Source {
              override fun read(sink: Buffer, byteCount: Long): Long {
                read = true
                error("No body read")
              }

              override fun timeout() = okio.Timeout.NONE

              override fun close() = Unit
            }
            .buffer()
      }
    assertImageError(client { response(it, 404, body = body) }, "https://images.example/a")
    assertFalse(read)
  }

  @Test
  fun `redirect loops stop at five hops`() = runBlocking {
    var requests = 0
    val transport = client {
      requests++
      response(it, 302, "/again")
    }
    refused { transport.download("https://images.example/a") }
    assertEquals(6, requests)
  }

  @Test
  fun `strict image DNS rejects private resolved snapshots and rebinding`() {
    val public = InetAddress.getByAddress(byteArrayOf(8, 8, 8, 8))
    val private = InetAddress.getByAddress(byteArrayOf(10, 0, 0, 1))
    var answers = listOf(public)
    var lookups = 0
    val dns =
      PrototypePolicyDns(
        Dns {
          lookups++
          answers
        },
        PrototypeEgressPolicy(blockPrivateNetworks = true),
        443,
      )
    assertEquals(listOf(public), dns.lookup("images.example"))
    answers = listOf(public, private)
    try {
      dns.lookup("images.example")
      fail("Rebound address must not reach a socket")
    } catch (error: PrototypeBlockedDestinationException) {
      assertEquals("Blocked destination address", error.message)
    }
    assertEquals(2, lookups)
  }

  @Test
  fun `strict image policy refuses every nonpublic family while request LAN policy is preserved`() {
    val policy = PrototypeEgressPolicy(blockPrivateNetworks = true)
    for (host in
      listOf(
        "10.0.0.1",
        "172.16.0.1",
        "192.168.0.1",
        "100.64.0.1",
        "169.254.169.254",
        "0.0.0.0",
        "127.0.0.1",
        "224.0.0.1",
        "255.255.255.255",
        "::",
        "::1",
        "fc00::1",
        "fe80::1",
        "ff02::1",
        "::ffff:10.0.0.1",
      )) {
      assertTrue(host, policy.check(host, 443, emptyList()) is PrototypeEgressDecision.Blocked)
    }
    assertEquals(
      PrototypeEgressDecision.Allow,
      PrototypeEgressPolicy().check("10.0.0.1", 443, emptyList()),
    )
  }

  @Test
  fun `debug allows only literal HTTP loopback including redirects and never HTTPS loopback`() =
    runBlocking {
      val sent = mutableListOf<Request>()
      val transport =
        client(allowLoopback = true) {
          sent += it
          if (it.url.isHttps) response(it, 302, "http://localhost:8080/a") else response(it)
        }
      assertArrayEquals(synthesizedTransportPng(), transport.download("https://images.example/a"))
      assertEquals(listOf("images.example", "localhost"), sent.map { it.url.host })
      refused { transport.download("https://localhost:8080/a") }
      refused { transport.download("http://127.1:8080/a") }
      assertEquals(2, sent.size)
    }

  private suspend fun kotlinx.coroutines.test.TestScope.assertImageError(
    transport: PrototypeRemoteImageTransport,
    url: String,
  ) {
    val store =
      object : PrototypeRemoteImageStore {
        override fun lookup(id: String): PrototypeAssetInfo? = null

        override fun read(id: String): ByteArray? = null

        override fun put(url: String, bytes: ByteArray) =
          error("Refused images cannot enter the cache")

        override fun setChangeListener(listener: PrototypeAssetChangeListener?) = Unit
      }
    val loader =
      CachedPrototypeRemoteImageLoader(
        transport,
        store,
        { _, _ -> error("Refused image cannot decode") },
        allowLoopback = true,
        dispatcher = UnconfinedTestDispatcher(testScheduler),
      )
    val activity = PrototypeRemoteImageActivity()
    val state = loader.load(url, PrototypeImageTarget(1, 1))
    activity.set("image", state)
    assertEquals(PrototypeImageState.Missing, state)
    assertEquals(PrototypeRemoteImageCounts(failed = 1), activity.counts())
  }
}

/** Trivially synthesized valid one-pixel RGBA PNG, with zlib data and computed chunk CRCs. */
private fun synthesizedTransportPng(): ByteArray {
  val output = java.io.ByteArrayOutputStream()
  val writer = java.io.DataOutputStream(output)
  writer.write(byteArrayOf(137.toByte(), 80, 78, 71, 13, 10, 26, 10))
  fun chunk(name: String, bytes: ByteArray) {
    val type = name.toByteArray(Charsets.US_ASCII)
    writer.writeInt(bytes.size)
    writer.write(type)
    writer.write(bytes)
    val crc =
      java.util.zip.CRC32().apply {
        update(type)
        update(bytes)
      }
    writer.writeInt(crc.value.toInt())
  }
  val header = java.io.ByteArrayOutputStream()
  java.io.DataOutputStream(header).apply {
    writeInt(1)
    writeInt(1)
    write(byteArrayOf(8, 6, 0, 0, 0))
  }
  chunk("IHDR", header.toByteArray())
  val pixels = java.io.ByteArrayOutputStream()
  java.util.zip.DeflaterOutputStream(pixels).use { it.write(byteArrayOf(0, 0, 0, 0, 0)) }
  chunk("IDAT", pixels.toByteArray())
  chunk("IEND", ByteArray(0))
  return output.toByteArray()
}
