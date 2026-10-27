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
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import okhttp3.Dns
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/** Destination policy, redirects, and DNS validation for the Retrofit device client. */
class RetrofitPrototypeHttpClientDestinationPolicyTest {
  private val server = MockWebServer()
  private val loopbackDns = Dns { listOf(InetAddress.getByAddress(byteArrayOf(127, 0, 0, 1))) }

  @Before
  fun start() {
    server.start()
  }

  @After
  fun stop() {
    server.close()
  }

  private fun request(
    url: String,
    method: String = "GET",
    headers: Map<String, String> = emptyMap(),
    body: JsonElement? = null,
  ) = PrototypeHttpRequest("r-1", "proto", method, url, headers, body, 5_000)

  private fun reply(body: String) = server.enqueue(MockResponse.Builder().body(body).build())

  private fun taken(): RecordedRequest = checkNotNull(server.takeRequest(2, TimeUnit.SECONDS))

  private fun received(response: PrototypeRequestResponse) =
    response as? PrototypeRequestResponse.Received ?: error("Expected a response: $response")

  private fun failure(response: PrototypeRequestResponse) =
    (response as? PrototypeRequestResponse.Failed ?: error("Expected a failure: $response")).error

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
        // Fetch redirect rule: POST becomes GET on 301/302; any method but HEAD becomes GET on 303.
        val changes =
          (code == 303 && method != "HEAD" && method != "GET") ||
            ((code == 301 || code == 302) && method == "POST")
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
