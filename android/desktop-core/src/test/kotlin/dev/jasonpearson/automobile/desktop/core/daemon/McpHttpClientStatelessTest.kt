package dev.jasonpearson.automobile.desktop.core.daemon

import java.io.ByteArrayOutputStream
import java.io.File
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpHeaders
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.ByteBuffer
import java.util.Optional
import java.util.concurrent.Flow
import javax.net.ssl.SSLSession
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Test

/**
 * [McpHttpClient] against a STATELESS streamable-HTTP daemon: one that never returns an
 * `mcp-session-id` and answers 404 "Session not found" to any request that carries one. The client
 * must run the whole handshake without a session header and must never take its 404 replay path
 * (`replayAfterSessionLoss`), which would re-initialize and replay requests. The `initialize`
 * answer comes from `test/fixtures/desktop-wire/stateless-handshake.json`, which the REAL daemon
 * endpoint produced (`test/server/statelessWireParity.test.ts`); regenerate it there, never by
 * hand.
 */
class McpHttpClientStatelessTest {

  @Test
  fun `the handshake and later calls never send a session header`() {
    val server = StatelessServer()
    val client = server.client()

    client.ping()
    assertEquals(listOf("observe"), client.listTools().map { it.name })
    client.callTool("observe", JsonObject(emptyMap()))

    assertEquals(
      listOf("initialize", "notifications/initialized", "tools/list", "tools/call"),
      server.methods(),
    )
    assertTrue(
      server.requests.all { it.sessionHeader == null },
      "no request may carry mcp-session-id: ${server.requests.map { it.sessionHeader }}",
    )
  }

  @Test
  fun `a stateless daemon is never re-initialized or replayed`() {
    val server = StatelessServer()
    val client = server.client()

    repeat(5) { client.listTools() }

    assertEquals(1, server.methods().count { it == "initialize" }, "initialized exactly once")
    assertEquals(5, server.methods().count { it == "tools/list" }, "no request was replayed")
    assertEquals(0, server.sessionRejections, "the 404 session-not-found path was never reached")
  }

  @Test
  fun `a plain JSON reply works the same without a session`() {
    val server = StatelessServer(asEventStream = false)
    val client = server.client()

    assertEquals(listOf("observe"), client.listTools().map { it.name })
    assertEquals(listOf("initialize", "notifications/initialized", "tools/list"), server.methods())
    assertFalse(server.requests.any { it.sessionHeader != null })
  }

  /** What the fake saw for one POST. */
  private class Recorded(val method: String, val headers: HttpHeaders) {
    val sessionHeader: String? = headers.firstValue("mcp-session-id").orElse(null)
  }

  /** The `initialize` message the real daemon answered with, as the fixture recorded it. */
  private class HandshakeFixture(private val root: JsonObject) {
    fun initializeResult(): JsonElement =
      root
        .getValue("exchanges")
        .jsonArray
        .map { it.jsonObject }
        .single { it.getValue("label").jsonPrimitive.content == "initialize" }
        .getValue("response")
        .jsonObject
        .getValue("message")
        .jsonObject
        .getValue("result")

    companion object {
      fun load(): HandshakeFixture {
        val relative = "test/fixtures/desktop-wire/stateless-handshake.json"
        val file =
          generateSequence(File(System.getProperty("user.dir") ?: ".").absoluteFile) {
              it.parentFile
            }
            .map { File(it, relative) }
            .firstOrNull { it.isFile } ?: error("Could not locate $relative")
        return HandshakeFixture(DaemonJson.parseToJsonElement(file.readText()).jsonObject)
      }
    }
  }

  private class StatelessServer(private val asEventStream: Boolean = true) {
    val requests = mutableListOf<Recorded>()

    /** Requests that carried a session id and were therefore answered with the 404. */
    var sessionRejections = 0
    private val fixture = HandshakeFixture.load()

    fun methods(): List<String> = requests.map { it.method }

    fun client() =
      McpHttpClient(
        dev.jasonpearson.automobile.desktop.core.daemon.McpHttpClientOptions(
          endpoint = "http://localhost/mcp",
          tokenProvider = DaemonHttpTokenProvider { null },
          requestSender = HttpRequestSender { request -> handle(request) },
        ),
      )

    private fun handle(request: HttpRequest): HttpResponse<String> {
      val body = DaemonJson.parseToJsonElement(bodyOf(request)).jsonObject
      val method = body.getValue("method").jsonPrimitive.content
      val id = body["id"] ?: JsonNull
      val recorded = Recorded(method, request.headers())
      requests += recorded
      if (recorded.sessionHeader != null) {
        sessionRejections++
        return FakeResponse(
          request,
          404,
          """{"error":"Session not found"}""",
          mapOf("content-type" to listOf("application/json")),
        )
      }
      if (id is JsonNull) {
        return FakeResponse(request, 202, "", emptyMap()) // a notification: accepted, no body
      }
      val result =
        when (method) {
          "initialize" -> fixture.initializeResult().toString()
          "tools/list" -> """{"tools":[{"name":"observe"}]}"""
          else -> """{"content":[{"type":"text","text":"ok"}]}"""
        }
      val payload = """{"jsonrpc":"2.0","id":$id,"result":$result}"""
      return if (asEventStream) {
        FakeResponse(
          request,
          200,
          "event: message\ndata: $payload\n\n",
          mapOf("content-type" to listOf("text/event-stream")),
        )
      } else {
        FakeResponse(request, 200, payload, mapOf("content-type" to listOf("application/json")))
      }
    }

    private fun bodyOf(request: HttpRequest): String {
      val out = ByteArrayOutputStream()
      request
        .bodyPublisher()
        .orElseThrow()
        .subscribe(
          object : Flow.Subscriber<ByteBuffer> {
            override fun onSubscribe(subscription: Flow.Subscription) =
              subscription.request(Long.MAX_VALUE)

            override fun onNext(item: ByteBuffer) {
              val bytes = ByteArray(item.remaining())
              item.get(bytes)
              out.write(bytes)
            }

            override fun onError(throwable: Throwable) = throw throwable

            override fun onComplete() = Unit
          },
        )
      return out.toString(Charsets.UTF_8)
    }
  }

  private class FakeResponse(
    private val requestValue: HttpRequest,
    private val status: Int,
    private val responseBody: String,
    headerMap: Map<String, List<String>>,
  ) : HttpResponse<String> {
    private val responseHeaders = HttpHeaders.of(headerMap) { _, _ -> true }

    override fun statusCode(): Int = status

    override fun request(): HttpRequest = requestValue

    override fun previousResponse(): Optional<HttpResponse<String>> = Optional.empty()

    override fun headers(): HttpHeaders = responseHeaders

    override fun body(): String = responseBody

    override fun sslSession(): Optional<SSLSession> = Optional.empty()

    override fun uri(): URI = requestValue.uri()

    override fun version(): HttpClient.Version = HttpClient.Version.HTTP_1_1
  }
}
