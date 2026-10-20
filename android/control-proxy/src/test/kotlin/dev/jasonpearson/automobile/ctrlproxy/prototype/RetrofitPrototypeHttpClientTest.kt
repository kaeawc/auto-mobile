package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.PrototypeRequestErrorCode
import dev.jasonpearson.automobile.protocol.PrototypeRequestResponse
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.net.InetAddress
import java.net.Socket
import java.net.SocketAddress
import java.util.concurrent.TimeUnit
import javax.net.SocketFactory
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import mockwebserver3.SocketEffect
import okhttp3.Dns
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * The Retrofit device client (`via: "device"`, #12528) against a real [MockWebServer]: a dynamic
 * URL and headers, JSON and text bodies, every method, the response size cap, and the typed
 * failures. No Android runtime is involved.
 */
class RetrofitPrototypeHttpClientTest {
  private val server = MockWebServer()
  private val warnings = mutableListOf<String>()
  private val debug = mutableListOf<String>()
  private var time = 0L

  private val permissivePolicy = PrototypeDestinationPolicy { _, _, _ ->
    PrototypeEgressDecision.Allow
  }
  private val loopbackDns = Dns { listOf(InetAddress.getByAddress(byteArrayOf(127, 0, 0, 1))) }

  private fun client(maxResponseBytes: Int = 1024) =
    RetrofitPrototypeHttpClient(
      OkHttpClient.Builder().dns(loopbackDns).build(),
      policy = permissivePolicy,
      maxResponseBytes = maxResponseBytes,
      clock = { time },
      warn = { message, _ -> warnings += message },
      debug = { debug += it },
    )

  @Before
  fun start() {
    server.start()
  }

  @After
  fun stop() {
    server.close()
  }

  private fun request(
    method: String = "GET",
    path: String = "/feed",
    headers: Map<String, String> = emptyMap(),
    body: JsonElement? = null,
    timeoutMs: Int = 5_000,
    url: String = server.url(path).toString(),
  ) = PrototypeHttpRequest("r-1", "proto", method, url, headers, body, timeoutMs)

  private fun execute(request: PrototypeHttpRequest, maxResponseBytes: Int = 1024) = runBlocking {
    client(maxResponseBytes).execute(request)
  }

  private fun json(text: String) = Json.parseToJsonElement(text)

  private fun reply(body: String = "", code: Int = 200, vararg headers: Pair<String, String>) {
    server.enqueue(
      MockResponse.Builder()
        .code(code)
        .apply { headers.forEach { (name, value) -> addHeader(name, value) } }
        .body(body)
        .build(),
    )
  }

  private fun taken(): RecordedRequest = checkNotNull(server.takeRequest(2, TimeUnit.SECONDS))

  private fun received(response: PrototypeRequestResponse) =
    response as? PrototypeRequestResponse.Received ?: error("Expected a response: $response")

  private fun failure(response: PrototypeRequestResponse) =
    (response as? PrototypeRequestResponse.Failed ?: error("Expected a failure: $response")).error

  @Test
  fun `a dynamic url with a query reaches the server and a JSON body is parsed`() {
    reply("""{"items":[1,2]}""", 200, "Content-Type" to "application/json", "X-Trace" to "abc")

    val response = received(execute(request(url = server.url("/feed/42?q=cats&n=3").toString())))

    val sent = taken()
    assertEquals("GET", sent.method)
    assertEquals("/feed/42?q=cats&n=3", sent.target)
    assertEquals(200, response.status)
    assertEquals(json("""{"items":[1,2]}"""), response.body)
    assertEquals("abc", response.headers["x-trace"])
    assertEquals("application/json", response.headers["content-type"])
  }

  @Test
  fun `request headers are sent as given`() {
    reply("{}")

    execute(request(headers = mapOf("Accept" to "application/json", "X-Token" to "s3cret")))

    val sent = taken()
    assertEquals("application/json", sent.headers["Accept"])
    assertEquals("s3cret", sent.headers["X-Token"])
  }

  @Test
  fun `a JSON body is sent as application json`() {
    reply("{}")

    execute(request("POST", body = json("""{"a":1,"b":[true]}""")))

    val sent = taken()
    assertEquals("POST", sent.method)
    assertEquals("""{"a":1,"b":[true]}""", sent.body?.utf8())
    assertTrue(sent.headers["Content-Type"]!!.startsWith("application/json"))
  }

  @Test
  fun `a string body is sent as is and a header content type wins`() {
    reply("{}")
    reply("{}")

    execute(request("PUT", body = JsonPrimitive("plain words")))
    val plain = taken()
    assertEquals("plain words", plain.body?.utf8())
    assertTrue(plain.headers["Content-Type"]!!.startsWith("text/plain"))

    execute(
      request(
        "PUT",
        headers = mapOf("Content-Type" to "application/vnd.test+json"),
        body = json("""{"a":1}"""),
      ),
    )
    val custom = taken()
    assertEquals("""{"a":1}""", custom.body?.utf8())
    assertTrue(custom.headers["Content-Type"]!!.startsWith("application/vnd.test+json"))
  }

  @Test
  fun `every method reaches the server with its own verb`() {
    for (method in listOf("GET", "POST", "PUT", "PATCH", "DELETE", "HEAD")) {
      reply("{}")
      val response = received(execute(request(method, body = null)))
      assertEquals(method, taken().method)
      assertEquals(method, 200, response.status)
    }
    // DELETE may carry a body; the others take it when given.
    reply("{}")
    execute(request("DELETE", body = json("""{"id":9}""")))
    val delete = taken()
    assertEquals("DELETE", delete.method)
    assertEquals("""{"id":9}""", delete.body?.utf8())
    reply("{}")
    execute(request("PATCH", body = json("""{"x":1}""")))
    assertEquals("""{"x":1}""", taken().body?.utf8())
  }

  @Test
  fun `a POST without a body sends an empty one`() {
    reply("{}")

    execute(request("POST"))

    assertEquals(0L, taken().bodySize)
  }

  @Test
  fun `HEAD has an empty body and the headers`() {
    reply("", 200, "X-Count" to "7")

    val response = received(execute(request("HEAD")))

    assertNull(response.body)
    assertEquals("7", response.headers["x-count"])
  }

  @Test
  fun `a body that is not JSON is the raw string and an empty body is null`() {
    reply("hello <b>world</b>")
    reply("OK")
    reply("", 204)

    assertEquals(JsonPrimitive("hello <b>world</b>"), received(execute(request())).body)
    taken()
    assertEquals(JsonPrimitive("OK"), received(execute(request())).body)
    taken()
    val empty = received(execute(request()))
    assertEquals(204, empty.status)
    assertNull(empty.body)
    assertEquals(2, debug.size)
    assertTrue(debug.all { it.contains("not JSON") })
  }

  @Test
  fun `a declared charset is ignored and the body is decoded as UTF-8`() {
    server.enqueue(
      MockResponse.Builder()
        .addHeader("Content-Type", "text/plain; charset=iso-8859-1")
        .body(okio.Buffer().writeByte(0xE9))
        .build(),
    )

    assertEquals(JsonPrimitive("\uFFFD"), received(execute(request())).body)
  }

  @Test
  fun `an error status is a response with its headers and no body`() {
    reply("""{"error":"nope"}""", 404, "X-Why" to "missing")

    val response = received(execute(request()))

    assertEquals(404, response.status)
    assertFalseSuccess(response)
    assertNull(response.body)
    assertEquals("missing", response.headers["x-why"])
  }

  private fun assertFalseSuccess(response: PrototypeRequestResponse.Received) =
    assertTrue(!response.isSuccessful)

  @Test
  fun `redirects are followed`() {
    server.enqueue(
      MockResponse.Builder().code(302).addHeader("Location", server.url("/final")).build(),
    )
    reply("""{"ok":true}""")

    val response = received(execute(request()))

    assertEquals(json("""{"ok":true}"""), response.body)
    taken()
    assertEquals("/final", taken().target)
  }

  @Test
  fun `a body over the cap is too_large and a body at the cap is read`() {
    reply("x".repeat(100))
    val error = failure(execute(request(), maxResponseBytes = 16))
    assertEquals(PrototypeRequestErrorCode.TOO_LARGE, error.code)
    assertEquals("Response body exceeds 16 bytes.", error.message)

    reply("y".repeat(16))
    val atCap = received(execute(request(), maxResponseBytes = 16))
    assertEquals(JsonPrimitive("y".repeat(16)), atCap.body)
  }

  @Test
  fun `a chunked body that crosses the cap is cut off while reading`() {
    server.enqueue(MockResponse.Builder().chunkedBody("z".repeat(500), 50).build())

    val error = failure(execute(request(), maxResponseBytes = 32))

    assertEquals(PrototypeRequestErrorCode.TOO_LARGE, error.code)
  }

  @Test
  fun `a server that never answers times out`() {
    server.enqueue(MockResponse.Builder().onRequestStart(SocketEffect.Stall).build())

    val error = failure(execute(request(timeoutMs = 50)))

    assertEquals(PrototypeRequestErrorCode.TIMEOUT, error.code)
    assertTrue(error.message, error.message.startsWith("Request timed out after 50ms."))
  }

  @Test
  fun `a response slower than the client's own read timeout succeeds within the request timeout`() {
    // OkHttp's default read timeout is 10 s; the request's timeoutMs is the whole-call budget.
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
        clock = { time },
        warn = { message, _ -> warnings += message },
      )

    val response = runBlocking { shortReadTimeouts.execute(request(timeoutMs = 5_000)) }

    assertEquals(200, received(response).status)
  }

  @Test
  fun `a timeout is logged and names the local network permission only for private hosts`() {
    assertTrue(RetrofitPrototypeHttpClient.isLocalNetworkHost("10.0.2.2"))
    assertTrue(RetrofitPrototypeHttpClient.isLocalNetworkHost("192.168.1.5"))
    assertTrue(RetrofitPrototypeHttpClient.isLocalNetworkHost("172.20.0.1"))
    assertTrue(RetrofitPrototypeHttpClient.isLocalNetworkHost("localhost"))
    assertTrue(!RetrofitPrototypeHttpClient.isLocalNetworkHost("172.32.0.1"))
    assertTrue(!RetrofitPrototypeHttpClient.isLocalNetworkHost("example.com"))
    assertTrue(!RetrofitPrototypeHttpClient.isLocalNetworkHost("93.184.216.34"))
  }

  @Test
  fun `a stalled loopback request logs the timeout and hints at the permission`() {
    server.enqueue(MockResponse.Builder().onRequestStart(SocketEffect.Stall).build())

    val error = failure(execute(request(timeoutMs = 50, url = "http://127.0.0.1:${server.port}/")))

    assertEquals(PrototypeRequestErrorCode.TIMEOUT, error.code)
    assertTrue(error.message, error.message.contains("ACCESS_LOCAL_NETWORK"))
    assertEquals(1, warnings.size)
  }

  @Test
  fun `a cleartext refusal is an immediate network error naming the policy`() {
    val refusing =
      okhttp3.OkHttpClient.Builder()
        .dns(loopbackDns)
        .addInterceptor {
          throw java.net.UnknownServiceException(
            "CLEARTEXT communication to x not permitted by network security policy",
          )
        }
        .build()

    val response = runBlocking {
      RetrofitPrototypeHttpClient(
          refusing,
          policy = permissivePolicy,
          clock = { time },
          warn = { m, _ -> warnings += m },
        )
        .execute(request(url = "http://10.0.2.2:18080/feed"))
    }
    val error = failure(response)

    assertEquals(PrototypeRequestErrorCode.NETWORK, error.code)
    assertTrue(error.message, error.message.contains("network security policy"))
    assertEquals(1, warnings.size)
  }

  @Test
  fun `a refused connection is typed`() {
    val url = server.url("/feed").toString()
    server.close()

    val error = failure(execute(request(url = url)))

    assertEquals(PrototypeRequestErrorCode.CONNECTION_REFUSED, error.code)
  }

  @Test
  fun `a url that is not http is invalid_url without a call`() {
    assertEquals(
      PrototypeRequestErrorCode.INVALID_URL,
      failure(execute(request(url = "ftp://example.com/x"))).code,
    )
    assertEquals(
      PrototypeRequestErrorCode.INVALID_URL,
      failure(execute(request(url = "not a url"))).code,
    )
    assertEquals(0, server.requestCount)
  }

  @Test
  fun `a header OkHttp refuses is invalid_request`() {
    val error = failure(execute(request(headers = mapOf("X-Bad" to "line one\nline two"))))

    assertEquals(PrototypeRequestErrorCode.INVALID_REQUEST, error.code)
    assertNotNull(error.message)
    assertEquals(0, server.requestCount)
  }

  @Test
  fun `the duration is measured by the injected clock`() {
    reply("{}")
    time = 100L
    val client =
      RetrofitPrototypeHttpClient(
        OkHttpClient.Builder().dns(loopbackDns).build(),
        policy = permissivePolicy,
        clock = { time.also { time += 25 } },
        warn = { _, _ -> },
      )

    val response = received(runBlocking { client.execute(request()) })

    assertEquals(25L, response.durationMs)
  }

  /** In-memory HTTP responses keep redirect tests independent of sockets, TLS and real DNS. */
  private fun scripted(
    answer: (okhttp3.Request, Int) -> Pair<Int, String?>,
  ): Pair<RetrofitPrototypeHttpClient, MutableList<okhttp3.Request>> {
    val requests = mutableListOf<okhttp3.Request>()
    val transport =
      OkHttpClient.Builder()
        .dns(Dns { error("Unexpected DNS lookup") })
        .addInterceptor { chain ->
          val sent = chain.request()
          requests += sent
          val (code, location) = answer(sent, requests.size)
          Response.Builder()
            .request(sent)
            .protocol(Protocol.HTTP_1_1)
            .code(code)
            .message("test")
            .body("{}".toResponseBody())
            .apply { if (location != null) header("Location", location) }
            .build()
        }
        .build()
    return RetrofitPrototypeHttpClient(transport, warn = { _, _ -> }, debug = {}) to requests
  }

  @Test
  fun `production default refuses blocked destinations before any I O`() = runBlocking {
    val (client, sent) = scripted { _, _ -> 200 to null }
    listOf(
        "127.0.0.1",
        "2130706433",
        "0x7f.1",
        "0177.0.0.1",
        "localhost",
        "LOCALHOST.",
        "[::1]",
        "[::ffff:a9fe:a9fe]",
      )
      .forEach { host ->
        assertEquals(
          host,
          PrototypeRequestErrorCode.BLOCKED_DESTINATION,
          failure(client.execute(request(url = "http://$host/"))).code,
        )
      }
    assertTrue(sent.isEmpty())
  }

  @Test
  fun `each forbidden header is invalid_request before any I O`() = runBlocking {
    val (client, sent) = scripted { _, _ -> 200 to null }
    listOf(
        "Host",
        "Connection",
        "Upgrade",
        "Transfer-Encoding",
        "Content-Length",
        "TE",
        "Trailer",
        "Keep-Alive",
        "Cookie",
        "Origin",
        "Proxy-Authorization",
        "Proxy-Custom",
        "Expect",
        "Via",
        "Forwarded",
        "X-Forwarded-For",
        "X-Forwarded-Host",
        "X-Forwarded-Proto",
        "X-Forwarded-Custom",
        "Accept-Encoding",
        "aCcEpT-eNcOdInG",
        "x-FoRwArDeD-cUsToM",
      )
      .forEach { header ->
        listOf(header, header.lowercase(), header.uppercase()).forEach { name ->
          assertEquals(
            name,
            PrototypeRequestErrorCode.INVALID_REQUEST,
            failure(
                client.execute(
                  request(url = "http://public.test/", headers = mapOf(name to "value")),
                ),
              )
              .code,
          )
        }
      }
    assertTrue(sent.isEmpty())
  }

  @Test
  fun `a redirect to a blocked destination is refused`() = runBlocking {
    listOf("http://127.0.0.1/", "http://2130706433/", "http://10.1.1.1:3000/").forEach { target ->
      val (client, sent) = scripted { _, _ -> 302 to target }
      assertEquals(
        PrototypeRequestErrorCode.BLOCKED_DESTINATION,
        failure(client.execute(request(url = "http://public.test/"))).code,
      )
      assertEquals(1, sent.size)
    }
  }

  @Test
  fun `an https downgrade is refused`() = runBlocking {
    val (client, sent) = scripted { _, _ -> 302 to "http://public.test/final" }
    assertEquals(
      PrototypeRequestErrorCode.BLOCKED_DESTINATION,
      failure(client.execute(request(url = "https://public.test/"))).code,
    )
    assertEquals(1, sent.size)
  }

  @Test
  fun `five redirects are allowed and a sixth is refused`() = runBlocking {
    val (allowed, five) =
      scripted { _, count -> if (count <= 5) 302 to "/hop$count" else 200 to null }
    assertEquals(200, received(allowed.execute(request(url = "http://public.test/"))).status)
    assertEquals(6, five.size)
    val (refused, six) = scripted { _, count -> 302 to "/hop$count" }
    assertEquals(
      PrototypeRequestErrorCode.NETWORK,
      failure(refused.execute(request(url = "http://public.test/"))).code,
    )
    assertEquals(6, six.size)
  }

  @Test
  fun `redirects with missing Location or invalid scheme fail`() = runBlocking {
    val (missing, _) = scripted { _, _ -> 302 to null }
    assertEquals(
      PrototypeRequestErrorCode.NETWORK,
      failure(missing.execute(request(url = "http://public.test/"))).code,
    )
    val (invalid, _) = scripted { _, _ -> 302 to "ftp://public.test/" }
    assertEquals(
      PrototypeRequestErrorCode.INVALID_URL,
      failure(invalid.execute(request(url = "http://public.test/"))).code,
    )
  }

  @Test
  fun `public redirects follow method and body rules`() = runBlocking {
    listOf(301, 302, 303, 307, 308).forEach { code ->
      val (client, sent) =
        scripted { _, count -> if (count == 1) code to "/final" else 200 to null }
      listOf("GET", "HEAD", "POST", "PUT", "PATCH", "DELETE").forEach { method ->
        sent.clear()
        client.execute(
          request(
            method = method,
            url = "http://public.test/",
            body = if (method in listOf("GET", "HEAD")) null else JsonPrimitive("body"),
          ),
        )
        val final = sent.last()
        val changes = code in listOf(301, 302, 303) && method !in listOf("GET", "HEAD")
        assertEquals("$code $method", if (changes) "GET" else method, final.method)
        if (changes || method in listOf("GET", "HEAD")) assertNull(final.body)
        else {
          val buffer = okio.Buffer()
          final.body!!.writeTo(buffer)
          assertEquals("body", buffer.readUtf8())
        }
      }
    }
  }

  @Test
  fun `Authorization is removed on every origin change and retained on the same origin`() =
    runBlocking {
      listOf(
          "https://other.test/final",
          "https://public.test:8443/final",
          "http://public.test/final",
          "/final",
        )
        .forEach { target ->
          val origin =
            if (target.startsWith("http://")) "http://public.test:8080/" else "https://public.test/"
          val (client, sent) =
            scripted { _, count -> if (count == 1) 302 to target else 200 to null }
          client.execute(request(url = origin, headers = mapOf("aUtHoRiZaTiOn" to "token")))
          assertEquals(
            target,
            if (target == "/final") "token" else null,
            sent.last().header("Authorization"),
          )
        }
      val (upgrade, sent) =
        scripted { _, count -> if (count == 1) 302 to "https://public.test/final" else 200 to null }
      upgrade.execute(
        request(url = "http://public.test/", headers = mapOf("Authorization" to "token")),
      )
      assertNull(sent.last().header("Authorization"))
    }

  @Test
  fun `mixed DNS answer is a typed blocked destination with no connection`() = runBlocking {
    var lookups = 0
    val dns = Dns {
      lookups++
      listOf(
        InetAddress.getByAddress(byteArrayOf(8, 8, 8, 8)),
        InetAddress.getByAddress(byteArrayOf(127, 0, 0, 1)),
      )
    }
    val client =
      RetrofitPrototypeHttpClient(OkHttpClient.Builder().dns(dns).build(), warn = { _, _ -> })
    assertEquals(
      PrototypeRequestErrorCode.BLOCKED_DESTINATION,
      failure(client.execute(request(url = "http://public.test/"))).code,
    )
    assertEquals(1, lookups)
  }

  @Test
  fun `a failed exchange is not retried on another validated address`() = runBlocking {
    var connections = 0
    val sockets =
      object : SocketFactory() {
        override fun createSocket(): Socket =
          object : Socket() {
            override fun connect(endpoint: SocketAddress, timeout: Int) {
              connections++
            }

            override fun getInputStream() = ByteArrayInputStream(byteArrayOf())

            override fun getOutputStream() = ByteArrayOutputStream()
          }

        override fun createSocket(host: String, port: Int): Socket = error("Unused overload")

        override fun createSocket(
          host: String,
          port: Int,
          local: InetAddress,
          localPort: Int,
        ): Socket = error("Unused overload")

        override fun createSocket(host: InetAddress, port: Int): Socket = error("Unused overload")

        override fun createSocket(
          host: InetAddress,
          port: Int,
          local: InetAddress,
          localPort: Int,
        ): Socket = error("Unused overload")
      }
    val transport =
      OkHttpClient.Builder()
        .retryOnConnectionFailure(true)
        .socketFactory(sockets)
        .dns(
          Dns {
            listOf(
              InetAddress.getByAddress(byteArrayOf(8, 8, 8, 8)),
              InetAddress.getByAddress(byteArrayOf(8, 8, 4, 4)),
            )
          },
        )
        .build()
    val client = RetrofitPrototypeHttpClient(transport, warn = { _, _ -> })
    assertEquals(
      PrototypeRequestErrorCode.NETWORK,
      failure(client.execute(request(url = "http://public.test/"))).code,
    )
    assertEquals(1, connections)
  }

  @Test
  fun `same origin reuses its connection while other hosts and ports require DNS validation`() =
    runBlocking {
      var lookups = 0
      val dns = Dns {
        lookups++
        loopbackDns.lookup(it)
      }
      val policy = PrototypeDestinationPolicy { host, port, addresses ->
        if (addresses.isNotEmpty() && (host != "public.test" || port != server.port)) {
          PrototypeEgressDecision.Blocked("Test blocked destination")
        } else PrototypeEgressDecision.Allow
      }
      val client =
        RetrofitPrototypeHttpClient(
          OkHttpClient.Builder().dns(dns).build(),
          policy = policy,
          warn = { _, _ -> },
          debug = {},
        )
      repeat(2) {
        reply("{}")
        assertEquals(
          200,
          received(client.execute(request(url = "http://public.test:${server.port}/"))).status,
        )
        taken()
      }
      assertEquals(1, lookups)
      listOf("http://other.test:${server.port}/", "http://public.test:${server.port - 1}/")
        .forEach { url ->
          assertEquals(
            url,
            PrototypeRequestErrorCode.BLOCKED_DESTINATION,
            failure(client.execute(request(url = url))).code,
          )
        }
      assertEquals(3, lookups)
      assertEquals(2, server.requestCount)
    }

  @Test
  fun `the socket uses the validated DNS list without a second lookup`() = runBlocking {
    var lookups = 0
    val loopback = InetAddress.getByAddress(byteArrayOf(127, 0, 0, 1))
    val dns = Dns { if (lookups++ == 0) listOf(loopback) else error("Unexpected second lookup") }
    val checked = mutableListOf<InetAddress>()
    val policy = PrototypeDestinationPolicy { _, _, addresses ->
      checked += addresses
      PrototypeEgressDecision.Allow
    }
    val client =
      RetrofitPrototypeHttpClient(
        OkHttpClient.Builder().dns(dns).build(),
        policy = policy,
        debug = {},
      )
    reply("{}")
    assertEquals(
      200,
      received(client.execute(request(url = "http://public.test:${server.port}/"))).status,
    )
    assertEquals(1, lookups)
    assertTrue(loopback in checked)
    assertEquals("public.test:${server.port}", taken().headers["Host"])
  }
}
