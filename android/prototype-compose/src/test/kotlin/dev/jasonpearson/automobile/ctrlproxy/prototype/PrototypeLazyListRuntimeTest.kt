package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.*
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.BeforeClass
import org.junit.Test

class PrototypeLazyListRuntimeTest {
  companion object {
    @JvmStatic
    @BeforeClass
    fun warmValidator() {
      PrototypeSpecValidator.validate("{}")
      PrototypeLazyListRuntimeTest().warmRuntime()
    }
  }

  private class FakeHttp : PrototypeHttpClient {
    private val answers = mutableListOf<CompletableDeferred<PrototypeRequestResponse>>()

    override suspend fun execute(request: PrototypeHttpRequest): PrototypeRequestResponse {
      val answer = CompletableDeferred<PrototypeRequestResponse>()
      answers += answer
      return answer.await()
    }

    fun answer(index: Int, response: PrototypeRequestResponse) {
      answers[index].complete(response)
    }
  }

  private val host = FakeHttp()
  private val events = mutableListOf<PrototypeEvent>()
  private val warnings = mutableListOf<String>()
  private var sequence = 0L

  private fun TestScope.runtime(
    spec: PrototypeSpec,
    exclusively: suspend (suspend () -> Unit) -> Unit = { it() },
    sink: PrototypeEventSink = PrototypeEventSink { events += it },
  ) =
    PrototypeRuntime(
      spec,
      sink,
      { 1000L },
      { ++sequence },
      warn = { warnings += it },
      httpClients = PrototypeHttpClients(host, host),
      requestScope = backgroundScope,
      newRequestId = { "request" },
      exclusively = exclusively,
    )

  private fun PrototypeRuntime.data(key: String) = current.spec.data?.get(key)

  private fun PrototypeRuntime.status() = (current.state["status"] as PrototypeScalar.Text).value

  private fun json(text: String) = Json.parseToJsonElement(text)

  private fun received(body: JsonElement) =
    PrototypeRequestResponse.Received(200, emptyMap(), body, 1)

  private fun requestEvents() =
    events
      .filter { it.kind == PrototypeEventKind.EMIT && it.name == PrototypeRequests.EVENT_NAME }
      .map { it.payload!!.jsonObject }

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

  private fun warmRuntime() = runTest {
    val runtime = runtime(listSpec())
    runtime.handle(PrototypeInteraction.Tap(listOf(appendRequest())))
    runCurrent()
    host.answer(0, received(json("""{"items":[{"id":2,"title":"Third"}],"next":"p3"}""")))
    runCurrent()
    runtime.close()
  }

  private fun listSpec(): PrototypeSpec {
    val spec = PrototypeLazyListTest().spec(2)
    return spec.copy(
      root = (spec.root as PrototypeListNode).copy(maxItems = 2),
      state = spec.state.orEmpty() + ("status" to PrototypeScalar.Text("idle")),
    )
  }

  private fun appendRequest() =
    PrototypeRequestAction(
      url = "http://localhost:8080/feed",
      into = "/data/page",
      append = PrototypeRequestAppend("/items", "/data/items"),
      statusKey = "status",
      onSuccess = listOf(PrototypeEmitAction("done")),
      onError = listOf(PrototypeEmitAction("bad")),
    )

  @Test
  fun `appendData trims in one revision and reports the replay limit`() = runTest {
    val runtime = runtime(listSpec())
    runtime.handle(
      PrototypeInteraction.Tap(
        listOf(
          PrototypeAppendDataAction(
            "/data/items",
            json("""{"value":{"id":2,"title":"Third"}}""").jsonObject,
          ),
        ),
      ),
    )
    assertEquals(
      listOf(1, 2),
      runtime.data("items")!!.jsonArray.map { it.jsonObject.getValue("id").jsonPrimitive.int },
    )
    assertEquals(1, events.size)
    val payload = events.single().payload!!.jsonObject
    assertEquals("append", payload.getValue("op").jsonPrimitive.content)
    assertEquals(2, payload.getValue("maxItems").jsonPrimitive.int)
    assertEquals(runtime.current.revision, payload.getValue("revision").jsonPrimitive.long)
  }

  @Test
  fun `request append emits extend then into metadata status request and success`() = runTest {
    val runtime = runtime(listSpec())
    runtime.handle(PrototypeInteraction.Tap(listOf(appendRequest())))
    runCurrent()
    events.clear()
    host.answer(0, received(json("""{"items":[{"id":2,"title":"Third"}],"next":"p3"}""")))
    runCurrent()
    assertEquals(
      listOf(
        "data:/data/items",
        "data:/data/page",
        "data:/data/page__meta",
        "state:status=success",
        "emit:prototype_request",
        "emit:done",
      ),
      summary(),
    )
    assertEquals(json("""{"next":"p3"}"""), runtime.data("page"))
    assertEquals(2, events.first().payload!!.jsonObject.getValue("maxItems").jsonPrimitive.int)
    val revisions =
      events.take(3).map { it.payload!!.jsonObject.getValue("revision").jsonPrimitive.long }
    assertEquals(revisions.sorted().distinct(), revisions)
    assertEquals(
      listOf(1, 2),
      runtime.data("items")!!.jsonArray.map { it.jsonObject.getValue("id").jsonPrimitive.int },
    )
  }

  @Test
  fun `request append failure rolls back both target and into`() = runTest {
    val spec = listSpec()
    val runtime = runtime(spec)
    runtime.handle(
      PrototypeInteraction.Tap(listOf(appendRequest().copy(into = "/data/missing/child"))),
    )
    runCurrent()
    events.clear()
    host.answer(0, received(json("""{"items":[{"id":2,"title":"Third"}],"next":"p3"}""")))
    runCurrent()
    assertEquals(spec.data?.get("items"), runtime.data("items"))
    assertNull(runtime.data("page"))
    assertFalse(events.any { it.name == "/data/items" })
    assertEquals("error", runtime.status())
    assertEquals(
      "invalid_response",
      requestEvents().single().getValue("error").jsonObject.getValue("code").jsonPrimitive.content,
    )
  }

  @Test
  fun `setData cannot interleave with staged append completion while event delivery suspends`() =
    runTest {
      val lock = kotlinx.coroutines.sync.Mutex()
      val entered = CompletableDeferred<Unit>()
      val release = CompletableDeferred<Unit>()
      val runtime =
        runtime(
          listSpec(),
          exclusively = { block ->
            lock.lock()
            try {
              block()
            } finally {
              lock.unlock()
            }
          },
          sink =
            PrototypeEventSink { event ->
              events += event
              if (event.name == "/data/items") {
                entered.complete(Unit)
                release.await()
              }
            },
        )
      runtime.handle(PrototypeInteraction.Tap(listOf(appendRequest())))
      runCurrent()
      host.answer(0, received(json("""{"items":[{"id":2,"title":"Third"}],"next":"p3"}""")))
      runCurrent()
      assertTrue(entered.isCompleted)
      val update = backgroundScope.launch {
        lock.lock()
        try {
          runtime.handle(
            PrototypeInteraction.Tap(
              listOf(
                PrototypeSetDataAction("/data/page", json("""{"value":{"new":true}}""").jsonObject),
              ),
            ),
          )
        } finally {
          lock.unlock()
        }
      }
      runCurrent()
      assertFalse(update.isCompleted)
      assertNull(runtime.data("page"))
      release.complete(Unit)
      runCurrent()
      assertTrue(update.isCompleted)
      assertTrue(warnings.toString(), warnings.isEmpty())
      assertEquals(json("""{"new":true}"""), runtime.data("page"))
      assertEquals(
        listOf("/data/items", "/data/page", "/data/page__meta", "/data/page"),
        events.filter { it.kind == PrototypeEventKind.CHANGE }.map { it.name },
      )
    }
}
