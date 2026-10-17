package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.PrototypeRequestErrorCode
import dev.jasonpearson.automobile.protocol.PrototypeRequestResponse
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import mockwebserver3.SocketEffect
import okhttp3.OkHttpClient
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

  private fun client(maxResponseBytes: Int = 1024) =
    RetrofitPrototypeHttpClient(
      OkHttpClient(),
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
    assertEquals("Request timed out after 50ms.", error.message)
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
        OkHttpClient(),
        clock = { time.also { time += 25 } },
        warn = { _, _ -> },
      )

    val response = received(runBlocking { client.execute(request()) })

    assertEquals(25L, response.durationMs)
  }
}
