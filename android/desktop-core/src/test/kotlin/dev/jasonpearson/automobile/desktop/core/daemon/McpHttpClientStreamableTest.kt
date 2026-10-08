package dev.jasonpearson.automobile.desktop.core.daemon

import java.io.ByteArrayOutputStream
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
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Test

/**
 * [McpHttpClient] against the MCP SDK's streamable-HTTP contract (the daemon's
 * `/auto-mobile/streamable` endpoint), driven through the [HttpRequestSender] seam: a required
 * `Accept` header, JSON or `text/event-stream` replies, and `404 Session not found` recovery.
 */
class McpHttpClientStreamableTest {

  @Test
  fun `every POST advertises both response forms`() {
    val server = FakeStreamable()
    server.client().listTools()

    assertEquals(listOf("initialize", "notifications/initialized", "tools/list"), server.methods())
    server.requests.forEach {
      assertEquals("application/json, text/event-stream", it.headers.firstValue("accept").get())
    }
  }

  @Test
  fun `a plain JSON reply still decodes`() {
    val server = FakeStreamable(asEventStream = false)

    assertEquals(listOf("observe"), server.client().listTools().map { it.name })
  }

  @Test
  fun `an event stream reply decodes`() {
    val server = FakeStreamable()

    assertEquals(listOf("observe"), server.client().listTools().map { it.name })
  }

  @Test
  fun `the reply is matched by id past keepalives, priming events and server notifications`() {
    val server = FakeStreamable()
    server.streamFor["tools/list"] = { id ->
      listOf(
          ":keepalive\n\n",
          "id: 7\nretry: 1000\ndata: \n\n", // priming event: empty data
          event("""{"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info"}}"""),
          event("""{"jsonrpc":"2.0","id":"someone-else","result":{"tools":[{"name":"other"}]}}"""),
          event("""{"jsonrpc":"2.0","id":"$id","result":{"tools":[{"name":"observe"}]}}"""),
        )
        .joinToString("")
    }

    assertEquals(listOf("observe"), server.client().listTools().map { it.name })
  }

  @Test
  fun `an event stream with CRLF framing and a multi-line data field decodes`() {
    val server = FakeStreamable()
    server.streamFor["tools/list"] = { id ->
      "event: message\r\ndata: {\"jsonrpc\":\"2.0\",\r\ndata: \"id\":\"$id\",\r\n" +
        "data: \"result\":{\"tools\":[{\"name\":\"observe\"}]}}\r\n\r\n"
    }

    assertEquals(listOf("observe"), server.client().listTools().map { it.name })
  }

  @Test
  fun `an event stream without a reply to the request fails clearly`() {
    val server = FakeStreamable()
    server.streamFor["tools/list"] = {
      event("""{"jsonrpc":"2.0","id":"someone-else","result":{"tools":[]}}""")
    }

    val error = assertFailsWith<McpConnectionException> { server.client().listTools() }
    assertTrue(error.message.orEmpty().contains("without a reply to tools/list"), error.message)
  }

  @Test
  fun `a lost session re-initializes once and replays the request`() {
    val server = FakeStreamable()
    val client = server.client()
    client.listTools()
    server.forgetSessions()

    assertEquals(listOf("observe"), client.listTools().map { it.name })

    assertEquals(
      listOf(
        "initialize",
        "notifications/initialized",
        "tools/list",
        "tools/list", // rejected with 404, never executed
        "initialize",
        "notifications/initialized",
        "tools/list",
      ),
      server.methods(),
    )
    assertEquals(2, server.executed.count { it == "tools/list" }, "the 404'd attempt never ran")
    val rejected = server.requests[3]
    val replayed = server.requests[6]
    assertEquals(rejected.id, replayed.id)
    assertEquals("session-1", rejected.sessionId)
    assertEquals("session-2", replayed.sessionId)
    assertEquals(null, server.requests[4].sessionId, "initialize must not carry the dead session")
  }

  @Test
  fun `a tool call rejected for a lost session runs exactly once after the replay`() {
    val server = FakeStreamable()
    val client = server.client()
    client.listTools()
    server.forgetSessions()

    client.callTool("observe", JsonObject(emptyMap()))

    assertEquals(1, server.executed.count { it == "tools/call" })
  }

  @Test
  fun `the SDK's JSON-RPC session not found 404 is recovered too`() {
    val server = FakeStreamable(notFoundBody = SDK_NOT_FOUND)
    val client = server.client()
    client.listTools()
    server.forgetSessions()

    assertEquals(listOf("observe"), client.listTools().map { it.name })
    assertEquals(2, server.methods().count { it == "initialize" })
  }

  @Test
  fun `a daemon that keeps answering 404 fails with a clear error after one re-initialize`() {
    val server = FakeStreamable()
    val client = server.client()
    client.listTools()
    server.alwaysRejectSessions = true

    val error = assertFailsWith<McpConnectionException> { client.listTools() }

    assertTrue(error.message.orEmpty().contains("MCP session lost"), error.message)
    assertEquals(2, server.methods().count { it == "initialize" }, "one re-initialize only")
    assertEquals(3, server.methods().count { it == "tools/list" }, "original plus one replay")

    // The failed recovery leaves the client ready to start over, not wedged on a dead session.
    server.alwaysRejectSessions = false
    assertEquals(listOf("observe"), client.listTools().map { it.name })
    assertEquals(3, server.methods().count { it == "initialize" })
  }

  @Test
  fun `a 404 that is not a session loss is a plain HTTP failure and is not replayed`() {
    val server = FakeStreamable(notFoundBody = "Not Found")
    val client = server.client()
    client.listTools()
    server.forgetSessions()

    val error = assertFailsWith<McpConnectionException> { client.listTools() }

    assertEquals("MCP HTTP 404: Not Found", error.message)
    assertEquals(1, server.methods().count { it == "initialize" })
  }

  @Test
  fun `a 406 surfaces the JSON-RPC error and the HTTP status`() {
    val server = FakeStreamable()
    server.rejectAccept = true

    val error = assertFailsWith<McpConnectionException> { server.client().ping() }

    assertTrue(error.message.orEmpty().contains("Not Acceptable"), error.message)
    assertTrue(error.message.orEmpty().contains("HTTP 406"), error.message)
  }

  @Test
  fun `a non JSON-RPC success body is a connection error, not a serialization crash`() {
    val server = FakeStreamable(asEventStream = false)
    server.rawJsonFor["tools/list"] = """{"status":"ok"}"""

    val error = assertFailsWith<McpConnectionException> { server.client().listTools() }

    assertTrue(error.message.orEmpty().contains("not a JSON-RPC message"), error.message)
  }

  /** What the fake saw for one POST. */
  private class Recorded(val method: String, val id: JsonElement, val headers: HttpHeaders) {
    val sessionId: String? = headers.firstValue("mcp-session-id").orElse(null)
  }

  /** A scripted streamable-HTTP endpoint with the SDK's `Accept` and session rules. */
  private class FakeStreamable(
    private val asEventStream: Boolean = true,
    private val notFoundBody: String = """{"error":"Session not found"}""",
  ) {
    val requests = mutableListOf<Recorded>()

    /** Methods the server actually ran (excludes requests rejected with 404/406). */
    val executed = mutableListOf<String>()
    val streamFor = mutableMapOf<String, (String) -> String>()
    val rawJsonFor = mutableMapOf<String, String>()
    var alwaysRejectSessions = false
    var rejectAccept = false
    private val sessions = mutableSetOf<String>()
    private var sessionCount = 0

    fun methods(): List<String> = requests.map { it.method }

    fun forgetSessions() = sessions.clear()

    fun client() = McpHttpClient(endpoint = "http://localhost/mcp", requestSender = sender)

    private val sender = HttpRequestSender { request -> handle(request) }

    private fun handle(request: HttpRequest): HttpResponse<String> {
      val body = DaemonJson.parseToJsonElement(bodyOf(request)).jsonObject
      val method = body.getValue("method").jsonPrimitive.content
      val id = body["id"] ?: JsonNull
      requests += Recorded(method, id, request.headers())
      val accept = request.headers().firstValue("accept").orElse("")
      if (
        rejectAccept ||
          !accept.contains("application/json") ||
          !accept.contains("text/event-stream")
      ) {
        return fake(
          request,
          406,
          """{"jsonrpc":"2.0","error":{"code":-32000,"message":"Not Acceptable: Client must accept both application/json and text/event-stream"}}""",
        )
      }
      if (method == "initialize") {
        sessions += "session-${++sessionCount}"
        executed += method
        return reply(request, method, id, sessions.last())
      }
      val session = request.headers().firstValue("mcp-session-id").orElse(null)
      if (alwaysRejectSessions || session == null || session !in sessions) {
        return fake(request, 404, notFoundBody)
      }
      executed += method
      return reply(request, method, id, session)
    }

    private fun reply(
      request: HttpRequest,
      method: String,
      id: JsonElement,
      session: String,
    ): HttpResponse<String> {
      val headers = mapOf("mcp-session-id" to listOf(session))
      if (id is JsonNull) {
        return fake(request, 202, "", headers) // a notification: accepted, no body
      }
      val payload =
        rawJsonFor[method]
          ?: when (method) {
            "initialize" ->
              """{"jsonrpc":"2.0","id":${id},"result":{"protocolVersion":"2025-11-25","capabilities":{},"serverInfo":{"name":"t","version":"1"}}}"""
            "tools/list" ->
              """{"jsonrpc":"2.0","id":${id},"result":{"tools":[{"name":"observe"}]}}"""
            else ->
              """{"jsonrpc":"2.0","id":${id},"result":{"content":[{"type":"text","text":"ok"}]}}"""
          }
      if (!asEventStream) {
        return fake(request, 200, payload, headers + ("content-type" to listOf("application/json")))
      }
      val stream =
        streamFor[method]?.invoke(id.jsonPrimitive.content)
          ?: ":keepalive\n\nevent: message\ndata: $payload\n\n"
      return fake(request, 200, stream, headers + ("content-type" to listOf("text/event-stream")))
    }

    private fun fake(
      request: HttpRequest,
      status: Int,
      body: String,
      headers: Map<String, List<String>> = emptyMap(),
    ): HttpResponse<String> = FakeResponse(request, status, body, headers)

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

  private companion object {
    fun event(json: String) = "event: message\ndata: $json\n\n"

    const val SDK_NOT_FOUND =
      """{"jsonrpc":"2.0","error":{"code":-32001,"message":"Session not found"},"id":null}"""
  }
}
