package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.*
import java.io.File
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.BeforeClass
import org.junit.Test

/**
 * The `request` action on the device (#12528): the status lifecycle, the response written through
 * the data-write path, the `prototype_request` event, follow-ups, and the concurrency rules. A fake
 * [PrototypeHttpClient] answers when the test says so, and the request scope is the test's own, so
 * nothing waits on a real network or a real clock.
 */
class PrototypeRequestRuntimeTest {
  companion object {
    @JvmStatic
    @BeforeClass
    fun warmValidator() {
      PrototypeSpecValidator.validate("{}")
    }
  }

  /** Records each request and holds it until the test answers (or the runtime cancels it). */
  private class FakeHttp(val name: String) : PrototypeHttpClient {
    val requests = mutableListOf<PrototypeHttpRequest>()
    val cancelled = mutableListOf<String>()
    private val answers = mutableListOf<CompletableDeferred<PrototypeRequestResponse>>()

    override suspend fun execute(request: PrototypeHttpRequest): PrototypeRequestResponse {
      val answer = CompletableDeferred<PrototypeRequestResponse>()
      requests += request
      answers += answer
      try {
        return answer.await()
      } catch (error: kotlinx.coroutines.CancellationException) {
        cancelled += request.requestId
        throw error
      }
    }

    fun answer(index: Int, response: PrototypeRequestResponse) {
      answers[index].complete(response)
    }
  }

  private val host = FakeHttp("host")
  private val device = FakeHttp("device")
  private val events = mutableListOf<PrototypeEvent>()
  private val warnings = mutableListOf<String>()
  private var sequence = 0L
  private var requestIds = 0
  private var now = 1_000L

  private fun spec(
    actions: String,
    state: String = """{"status":"idle","count":0,"flag":false,"q":"cats"}""",
  ): PrototypeSpec {
    val input =
      """{"id":"req","window":{"placement":{"type":"fullscreen"}},"state":$state,"data":{"title":"Feed"},""" +
        """"root":{"type":"column","children":[{"type":"button","label":"Go","onTap":[$actions]}]}}"""
    val validation = PrototypeSpecValidator.validate(input)
    return (validation as? PrototypeSpecValidation.Success)?.spec ?: error(validation.toString())
  }

  private fun request(extra: String = "") =
    """{"type":"request","url":"http://localhost:8080/feed","into":"/data/feed","statusKey":"status"${
      if (extra.isEmpty()) "" else ",$extra"
    }}"""

  private fun TestScope.runtime(spec: PrototypeSpec) =
    PrototypeRuntime(
      spec,
      PrototypeEventSink { events += it },
      { now },
      { ++sequence },
      warn = { warnings += it },
      httpClients = PrototypeHttpClients(host, device),
      requestScope = backgroundScope,
      newRequestId = { "r-${++requestIds}" },
    )

  private fun tapOf(runtime: PrototypeRuntime) =
    PrototypeInteraction.Tap(checkNotNull(runtime.renderModel().root.children[0].source?.onTap))

  private fun actionsOf(actions: String): List<PrototypeAction> =
    checkNotNull(
      ((spec(actions).root as PrototypeColumnNode).children[0] as PrototypeButtonNode).onTap,
    )

  private fun PrototypeRuntime.status() = (current.state["status"] as PrototypeScalar.Text).value

  private fun PrototypeRuntime.data(key: String) = current.spec.data?.get(key)

  private fun received(body: JsonElement?, status: Int = 200) =
    PrototypeRequestResponse.Received(
      status,
      mapOf("content-type" to "application/json"),
      body,
      31,
    )

  private fun failed(code: PrototypeRequestErrorCode, message: String = "boom") =
    PrototypeRequestResponse.Failed(PrototypeRequestError(code, message), 7)

  private fun json(text: String) = Json.parseToJsonElement(text)

  /** `kind/name` of each event, with a state `change` shown as `change:key=value`. */
  private fun summary(): List<String> = events.map { event ->
    val payload = event.payload as? JsonObject
    when {
      event.kind == PrototypeEventKind.CHANGE -> "data:${event.name}"
      event.name == "change" && payload?.containsKey("key") == true ->
        "state:${payload.getValue("key").jsonPrimitive.content}=${payload.getValue("value").jsonPrimitive.content}"
      event.kind == PrototypeEventKind.EMIT -> "emit:${event.name}"
      else -> event.kind.name
    }
  }

  private fun requestEvents(): List<JsonObject> =
    events
      .filter { it.kind == PrototypeEventKind.EMIT && it.name == PrototypeRequests.EVENT_NAME }
      .map { it.payload as JsonObject }

  @Test
  fun `the status key runs loading then success around the response`() = runTest {
    val runtime =
      runtime(
        spec(
          request(
            """"onSuccess":[{"type":"setState","key":"count","value":1}],"onError":[{"type":"toggle","key":"flag"}]""",
          ),
        ),
      )

    runtime.handle(tapOf(runtime))
    assertEquals("loading", runtime.status())
    assertEquals(listOf("state:status=loading"), summary())
    runCurrent()
    assertEquals(1, host.requests.size)
    assertTrue(device.requests.isEmpty())

    host.answer(0, received(json("""{"items":[1,2]}""")))
    runCurrent()

    assertEquals("success", runtime.status())
    assertEquals(json("""{"items":[1,2]}"""), runtime.data("feed"))
    assertEquals(
      listOf(
        "state:status=loading",
        "data:/data/feed",
        "data:/data/feed__meta",
        "state:status=success",
        "emit:prototype_request",
        "state:count=1.0",
      ),
      summary(),
    )
    // onError never ran.
    assertEquals(PrototypeScalar.BooleanValue(false), runtime.current.state["flag"])
    assertEquals(PrototypeScalar.Numeric(1.0), runtime.current.state["count"])
  }

  @Test
  fun `into and the meta sibling are written through the data write path`() = runTest {
    val runtime = runtime(spec(request()))
    runtime.handle(tapOf(runtime))
    runCurrent()

    host.answer(0, received(json("""{"items":[1]}""")))
    runCurrent()

    assertEquals(
      json(
        """{"status":200,"headers":{"content-type":"application/json"},"durationMs":31}""",
      ),
      runtime.data("feed__meta"),
    )
    val write = events.first { it.name == "/data/feed" }
    assertEquals(PrototypeEventKind.CHANGE, write.kind)
    assertEquals("set", (write.payload as JsonObject).getValue("op").jsonPrimitive.content)
    // The revision moved with each accepted write.
    assertTrue(runtime.current.revision >= 3L)
  }

  @Test
  fun `a non-JSON body is stored as a string and an empty body as an empty string`() = runTest {
    val runtime = runtime(spec(request()))
    runtime.handle(tapOf(runtime))
    runCurrent()
    host.answer(0, received(JsonPrimitive("plain text")))
    runCurrent()
    assertEquals(JsonPrimitive("plain text"), runtime.data("feed"))

    runtime.handle(tapOf(runtime))
    runCurrent()
    host.answer(1, received(null, 204))
    runCurrent()
    assertEquals(JsonPrimitive(""), runtime.data("feed"))
  }

  @Test
  fun `a non-2xx status leaves into alone and runs onError`() = runTest {
    val runtime =
      runtime(
        spec(
          request(
            """"onSuccess":[{"type":"setState","key":"count","value":1}],"onError":[{"type":"toggle","key":"flag"}]""",
          ),
        ),
      )
    runtime.handle(tapOf(runtime))
    runCurrent()

    host.answer(0, received(json("""{"error":"nope"}"""), 404))
    runCurrent()

    assertEquals("error", runtime.status())
    assertNull(runtime.data("feed"))
    assertEquals(
      json(
        """{"status":404,"headers":{"content-type":"application/json"},"durationMs":31,"error":{"code":"http_error","message":"HTTP 404"}}""",
      ),
      runtime.data("feed__meta"),
    )
    assertEquals(PrototypeScalar.BooleanValue(true), runtime.current.state["flag"])
    assertEquals(PrototypeScalar.Numeric(0.0), runtime.current.state["count"])
    val event = requestEvents().single()
    assertEquals("error", event.getValue("outcome").jsonPrimitive.content)
    assertEquals(404, event.getValue("status").jsonPrimitive.int)
    assertEquals(
      json("""{"code":"http_error","message":"HTTP 404"}"""),
      event.getValue("error"),
    )
  }

  @Test
  fun `a transport failure writes only error metadata`() = runTest {
    val runtime = runtime(spec(request()))
    runtime.handle(tapOf(runtime))
    runCurrent()

    host.answer(0, failed(PrototypeRequestErrorCode.TIMEOUT, "Request timed out after 10000ms."))
    runCurrent()

    assertEquals("error", runtime.status())
    assertNull(runtime.data("feed"))
    assertEquals(
      json(
        """{"durationMs":7,"error":{"code":"timeout","message":"Request timed out after 10000ms."}}""",
      ),
      runtime.data("feed__meta"),
    )
    val event = requestEvents().single()
    assertNull(event["status"])
    assertEquals(
      "timeout",
      event.getValue("error").jsonObject.getValue("code").jsonPrimitive.content,
    )
  }

  @Test
  fun `a body data cannot hold is an invalid_response error`() = runTest {
    val runtime = runtime(spec(request()))
    runtime.handle(tapOf(runtime))
    runCurrent()

    host.answer(0, received(json("""{"a":null}""")))
    runCurrent()

    assertEquals("error", runtime.status())
    assertNull(runtime.data("feed"))
    val meta = runtime.data("feed__meta")!!.jsonObject
    assertEquals(200, meta.getValue("status").jsonPrimitive.int)
    assertEquals(
      "invalid_response",
      meta.getValue("error").jsonObject.getValue("code").jsonPrimitive.content,
    )
  }

  @Test
  fun `the event payload names the request, the resolved url and the transport`() = runTest {
    val runtime =
      runtime(
        spec(
          request(
              """"query":{"q":{"state":"q"},"limit":{"value":20}},"via":"device","method":"POST","body":{"value":{"a":1}}""",
            )
            .replace("http://localhost:8080/feed", "http://localhost:8080/feed/{q}"),
        ),
      )
    runtime.handle(tapOf(runtime))
    runCurrent()
    device.answer(0, received(json("1"), 201))
    runCurrent()

    assertEquals(
      json(
        """{"requestId":"r-1","method":"POST","url":"http://localhost:8080/feed/cats?q=cats&limit=20","via":"device","into":"/data/feed","outcome":"success","status":201,"durationMs":31}""",
      ),
      requestEvents().single(),
    )
    // A device request never touched the host transport.
    assertTrue(host.requests.isEmpty())
  }

  @Test
  fun `the transport gets the resolved request with the default method and timeout`() = runTest {
    val runtime =
      runtime(
        spec(
          request(
            """"headers":{"Accept":"application/json","X-Title":{"data":"/title"},"X-Q":{"state":"q"}},""" +
              """"query":{"q":{"state":"q"}}""",
          ),
        ),
      )
    runtime.handle(tapOf(runtime))
    runCurrent()

    val sent = host.requests.single()
    assertEquals("r-1", sent.requestId)
    assertEquals("req", sent.prototypeId)
    assertEquals("GET", sent.method)
    assertEquals("http://localhost:8080/feed?q=cats", sent.url)
    assertEquals(
      mapOf("Accept" to "application/json", "X-Title" to "Feed", "X-Q" to "cats"),
      sent.headers,
    )
    assertNull(sent.body)
    assertEquals(PrototypeSpecValidator.DEFAULT_PROTOTYPE_REQUEST_TIMEOUT_MS, sent.timeoutMs)
  }

  @Test
  fun `a request that cannot be resolved fails at once without touching the network`() = runTest {
    // A data pointer that resolves to nothing cannot supply the header.
    val broken =
      spec(
        request(
          """"headers":{"X-Missing":{"data":"/absent"}},"onError":[{"type":"toggle","key":"flag"}]""",
        ),
      )
    val bad = runtime(broken)
    bad.handle(tapOf(bad))
    runCurrent()

    assertTrue(host.requests.isEmpty())
    assertEquals("error", bad.status())
    assertEquals(PrototypeScalar.BooleanValue(true), bad.current.state["flag"])
    val meta = bad.data("feed__meta")!!.jsonObject
    assertEquals(
      "invalid_request",
      meta.getValue("error").jsonObject.getValue("code").jsonPrimitive.content,
    )
    assertEquals(
      "invalid_request",
      requestEvents().single().getValue("error").jsonObject.getValue("code").jsonPrimitive.content,
    )
    // One status change straight to the final value, never a stray loading.
    assertEquals(
      listOf(
        "data:/data/feed__meta",
        "state:status=error",
        "emit:prototype_request",
        "state:flag=true",
      ),
      summary(),
    )
  }

  @Test
  fun `the latest request for the same into wins and the older one reports cancelled`() = runTest {
    val runtime = runtime(spec(request()))
    runtime.handle(tapOf(runtime))
    runCurrent()
    now = 1_250L
    runtime.handle(tapOf(runtime))
    runCurrent()

    assertEquals(listOf("r-1"), host.cancelled)
    val cancelled = requestEvents().single()
    assertEquals("r-1", cancelled.getValue("requestId").jsonPrimitive.content)
    assertEquals("error", cancelled.getValue("outcome").jsonPrimitive.content)
    assertEquals(250, cancelled.getValue("durationMs").jsonPrimitive.int)
    assertEquals(
      "cancelled",
      cancelled.getValue("error").jsonObject.getValue("code").jsonPrimitive.content,
    )
    // The cancelled request wrote nothing and left the status key alone.
    assertNull(runtime.data("feed"))
    assertNull(runtime.data("feed__meta"))
    assertEquals("loading", runtime.status())

    host.answer(1, received(json("""{"v":2}""")))
    runCurrent()

    assertEquals("success", runtime.status())
    assertEquals(json("""{"v":2}"""), runtime.data("feed"))
    assertEquals(2, requestEvents().size)
    assertEquals("r-2", requestEvents().last().getValue("requestId").jsonPrimitive.content)
  }

  @Test
  fun `a superseded request runs no follow-up even if its answer is late`() = runTest {
    val runtime = runtime(spec(request(""""onError":[{"type":"toggle","key":"flag"}]""")))
    runtime.handle(tapOf(runtime))
    runCurrent()
    runtime.handle(tapOf(runtime))
    runCurrent()

    host.answer(0, failed(PrototypeRequestErrorCode.NETWORK))
    runCurrent()

    assertEquals(PrototypeScalar.BooleanValue(false), runtime.current.state["flag"])
    assertNull(runtime.data("feed__meta"))
  }

  @Test
  fun `requests to different into paths run side by side`() = runTest {
    val runtime =
      runtime(
        spec(
          request().replace("/data/feed", "/data/a") +
            "," +
            request().replace("/data/feed", "/data/b"),
        ),
      )
    runtime.handle(tapOf(runtime))
    runCurrent()

    assertEquals(2, host.requests.size)
    assertTrue(host.cancelled.isEmpty())
  }

  @Test
  fun `more requests than the in-flight cap fail with too_many_in_flight`() = runTest {
    val limit = PrototypeSpecValidator.MAX_PROTOTYPE_REQUESTS_IN_FLIGHT
    val started =
      (0 until limit).joinToString(",") {
        """{"type":"request","url":"http://h.test/$it","into":"/data/r$it"}"""
      }
    val over =
      """{"type":"request","url":"http://h.test/over","into":"/data/over","statusKey":"status","onError":[{"type":"toggle","key":"flag"}]}"""
    val runtime = runtime(spec("$started,$over"))

    runtime.handle(tapOf(runtime))
    runCurrent()

    assertEquals(limit, host.requests.size)
    assertEquals("error", runtime.status())
    assertEquals(PrototypeScalar.BooleanValue(true), runtime.current.state["flag"])
    val event = requestEvents().single()
    assertEquals("http://h.test/over", event.getValue("url").jsonPrimitive.content)
    assertEquals(
      "too_many_in_flight",
      event.getValue("error").jsonObject.getValue("code").jsonPrimitive.content,
    )
    assertNull(runtime.data("over"))
    assertNotNull(runtime.data("over__meta"))

    // A slot frees up when a request settles.
    host.answer(0, received(json("1")))
    runCurrent()
    runtime.handle(
      PrototypeInteraction.Tap(
        actionsOf("""{"type":"request","url":"http://h.test/x","into":"/data/x"}"""),
      ),
    )
    runCurrent()
    assertEquals(limit + 1, host.requests.size)
  }

  @Test
  fun `dismissing the prototype cancels its requests and reports nothing`() = runTest {
    val runtime = runtime(spec(request(""""onError":[{"type":"toggle","key":"flag"}]""")))
    runtime.handle(tapOf(runtime))
    runCurrent()
    val before = events.size

    runtime.dismiss()
    runCurrent()

    assertEquals(listOf("r-1"), host.cancelled)
    // Only the dismissed event follows; the request has no completion, event or follow-up.
    assertEquals(before + 1, events.size)
    assertEquals(PrototypeEventKind.DISMISSED, events.last().kind)
    assertFalse(runtime.current.active)
    assertNull(runtime.data("feed__meta"))
  }

  @Test
  fun `an answer that arrives after dismissal is ignored`() = runTest {
    val runtime = runtime(spec(request()))
    runtime.handle(tapOf(runtime))
    runCurrent()
    runtime.dismiss()
    val before = events.size

    host.answer(0, received(json("1")))
    runCurrent()

    assertEquals(before, events.size)
    assertNull(runtime.data("feed"))
  }

  @Test
  fun `a follow-up request starts when its parent succeeds`() = runTest {
    val runtime =
      runtime(
        spec(
          request(
            """"onSuccess":[{"type":"request","url":"https://example.com/seen","method":"POST","body":{"value":{"seen":true}},"via":"device"}]""",
          ),
        ),
      )
    runtime.handle(tapOf(runtime))
    runCurrent()
    host.answer(0, received(json("1")))
    runCurrent()

    val seen = device.requests.single()
    assertEquals("https://example.com/seen", seen.url)
    assertEquals("POST", seen.method)
    assertEquals(json("""{"seen":true}"""), seen.body)
    assertEquals(1, requestEvents().size)
  }

  @Test
  fun `a failing transport that throws becomes a network error`() = runTest {
    val throwing = PrototypeHttpClient { error("socket exploded") }
    val runtime =
      PrototypeRuntime(
        spec(request()),
        PrototypeEventSink { events += it },
        { now },
        { ++sequence },
        warn = { warnings += it },
        httpClients = PrototypeHttpClients(throwing, throwing),
        requestScope = backgroundScope,
        newRequestId = { "r-${++requestIds}" },
      )
    runtime.handle(tapOf(runtime))
    runCurrent()

    assertEquals("error", runtime.status())
    assertEquals(
      "network",
      requestEvents().single().getValue("error").jsonObject.getValue("code").jsonPrimitive.content,
    )
    assertTrue(warnings.any { "socket exploded" in it })
  }

  @Test
  fun `the shared request fixture decodes and its first button reaches the host transport`() =
    runTest {
      val root =
        generateSequence(File(System.getProperty("user.dir") ?: ".").absoluteFile) { it.parentFile }
          .map { File(it, "test/fixtures/prototype-spec/valid/request-actions.json") }
          .first { it.isFile }
      val validation = PrototypeSpecValidator.validate(root.readText())
      val spec = (validation as PrototypeSpecValidation.Success).spec
      val column = spec.root as PrototypeColumnNode
      val feed =
        (column.children[2] as PrototypeButtonNode).onTap!!.single() as PrototypeRequestAction
      val post =
        (column.children[3] as PrototypeButtonNode).onTap!!.single() as PrototypeRequestAction
      assertEquals("host", feed.via)
      assertEquals(5000, feed.timeoutMs)
      assertEquals("device", post.via)
      assertEquals("POST", post.method)
      assertEquals(2, feed.onSuccess!!.size)
      assertTrue(feed.onSuccess!![1] is PrototypeRequestAction)

      val runtime =
        PrototypeRuntime(
          spec,
          PrototypeEventSink { events += it },
          { now },
          { ++sequence },
          httpClients = PrototypeHttpClients(host, device),
          requestScope = backgroundScope,
          newRequestId = { "r-${++requestIds}" },
        )
      runtime.handle(PrototypeInteraction.Tap(feed.let { listOf(it) }))
      runCurrent()

      val sent = host.requests.single()
      assertEquals("http://localhost:8080/feed?q=cats&limit=20", sent.url)
      assertEquals("Feed", sent.headers["X-Title"])
      assertEquals(5000, sent.timeoutMs)
      assertEquals(
        PrototypeScalar.Text("loading"),
        runtime.current.state["feedStatus"],
      )
    }
}
