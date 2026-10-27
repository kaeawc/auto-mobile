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
      newRequestId = { "request-${++sequence}" },
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
    val list = checkNotNull(runtime.renderModel().root.list)
    list.render(list.rows.first(), 0)
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
  fun `guarded lazy row taps honor current row bound enabled state`() = runTest {
    val base = listSpec()
    val button =
      PrototypeButtonNode(
        label = "Choose",
        enabledWhen = PrototypeCondition("ready_{post.id}", PrototypeScalar.BooleanValue(true)),
        onTap = listOf(PrototypeEmitAction("chosen")),
      )
    val runtime =
      runtime(
        base.copy(
          root =
            (base.root as PrototypeListNode).copy(
              children = listOf(PrototypeColumnNode(children = listOf(button))),
            ),
          state =
            base.state.orEmpty() +
              mapOf(
                "ready_0" to PrototypeScalar.BooleanValue(true),
                "ready_1" to PrototypeScalar.BooleanValue(false),
              ),
        ),
      )
    val list = checkNotNull(runtime.renderModel().root.list)
    val enabled = list.render(list.rows[0], 0).children.single()
    val disabled = list.render(list.rows[1], 1).children.single()
    assertTrue(enabled.enabled)
    assertFalse(disabled.enabled)
    val tap = PrototypeInteraction.Tap(checkNotNull(button.onTap))
    runtime.handle(PrototypeInteraction.Guarded(enabled.identity, tap))
    assertEquals(listOf("chosen"), events.map { it.name })
    runtime.handle(PrototypeInteraction.Guarded(disabled.identity, tap))
    assertEquals(1, events.size)
    runtime.handle(
      PrototypeInteraction.Tap(
        listOf(
          PrototypeSetStateAction("ready_0", PrototypeScalar.BooleanValue(false)),
        ),
      ),
    )
    events.clear()
    runtime.handle(PrototypeInteraction.Guarded(enabled.identity, tap))
    assertTrue(events.isEmpty())
  }

  @Test
  fun oversizedPrependPageOmitsOnlyTheEventValue() = runTest {
    val runtime = runtime(listSpec())
    val page =
      JsonArray(
        (2..40).map { index ->
          buildJsonObject {
            put("id", index)
            put("title", "x".repeat(500))
          }
        },
      )
    runtime.handle(
      PrototypeInteraction.Tap(
        listOf(PrototypePrependDataAction("/data/items", buildJsonObject { put("value", page) })),
      ),
    )
    assertEquals(
      listOf(2, 3),
      runtime.data("items")!!.jsonArray.map {
        it.jsonObject.getValue("id").jsonPrimitive.int
      },
    )
    val payload = events.single().payload!!.jsonObject
    assertEquals("prepend", payload.getValue("op").jsonPrimitive.content)
    assertEquals(2, payload.getValue("maxItems").jsonPrimitive.int)
    assertFalse(payload.containsKey("value"))
    runtime.close()
  }

  @Test
  fun `prependData trims in one revision and reports the replay limit`() = runTest {
    val runtime = runtime(listSpec())
    runtime.handle(
      PrototypeInteraction.Tap(
        listOf(
          PrototypePrependDataAction(
            "/data/items",
            json("""{"value":[{"id":2,"title":"Third"}]}""").jsonObject,
          ),
        ),
      ),
    )
    assertEquals(
      listOf(2, 0),
      runtime.data("items")!!.jsonArray.map { it.jsonObject.getValue("id").jsonPrimitive.int },
    )
    assertEquals(1, events.size)
    assertEquals(PrototypeEventKind.CHANGE, events.single().kind)
    assertEquals("/data/items", events.single().name)
    val payload = events.single().payload!!.jsonObject
    assertEquals("prepend", payload.getValue("op").jsonPrimitive.content)
    assertEquals(2, payload.getValue("maxItems").jsonPrimitive.int)
    assertEquals(runtime.current.revision, payload.getValue("revision").jsonPrimitive.long)
  }

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

  @Test
  fun `prependData refuses duplicate keys without a change event`() = runTest {
    val spec = listSpec()
    val runtime = runtime(spec)
    runtime.handle(
      PrototypeInteraction.Tap(
        listOf(
          PrototypePrependDataAction(
            "/data/items",
            json("""{"value":[{"id":0,"title":"Duplicate"}]}""").jsonObject,
          ),
        ),
      ),
    )
    assertEquals(spec.data, runtime.current.spec.data)
    assertTrue(events.isEmpty())
    assertTrue(warnings.single().contains("Duplicate repeat key"))
  }

  @Test
  fun `appendData refuses duplicate keys without a change event`() = runTest {
    val spec = listSpec()
    val runtime = runtime(spec)
    runtime.handle(
      PrototypeInteraction.Tap(
        listOf(
          PrototypeAppendDataAction(
            "/data/items",
            json("""{"value":{"id":1,"title":"Duplicate"}}""").jsonObject,
          ),
        ),
      ),
    )
    assertEquals(spec.data, runtime.current.spec.data)
    assertTrue(events.isEmpty())
    assertTrue(warnings.single().contains("Duplicate repeat key"))
  }

  @Test
  fun `setData refuses missing and non scalar keys and non object rows`() = runTest {
    for (rows in listOf("[{}]", "[{\"id\":{}}]", "[1]")) {
      val spec = listSpec()
      val runtime = runtime(spec)
      runtime.handle(
        PrototypeInteraction.Tap(
          listOf(PrototypeSetDataAction("/data/items", json("{\"value\":$rows}").jsonObject)),
        ),
      )
      assertEquals(spec.data, runtime.current.spec.data)
      assertTrue(events.isEmpty())
    }
  }

  @Test
  fun `descendant writes cannot remove or duplicate list keys`() = runTest {
    for (action in
      listOf(
        PrototypeRemoveDataAction("/data/items/1/id"),
        PrototypeSetDataAction("/data/items/1/id", json("""{"value":0}""").jsonObject),
      )) {
      val spec = listSpec()
      val runtime = runtime(spec)
      runtime.handle(PrototypeInteraction.Tap(listOf(action)))
      assertEquals(spec.data, runtime.current.spec.data)
      assertTrue(events.isEmpty())
    }
  }

  @Test
  fun `overlapping request page is refused atomically`() = runTest {
    val spec = listSpec()
    val runtime = runtime(spec)
    runtime.handle(PrototypeInteraction.Tap(listOf(appendRequest())))
    runCurrent()
    events.clear()
    host.answer(0, received(json("""{"items":[{"id":1,"title":"Duplicate"}],"next":"p3"}""")))
    runCurrent()
    assertEquals(spec.data!!["items"], runtime.data("items"))
    assertNull(runtime.data("page"))
    assertFalse(
      events.any { it.name == "/data/items" || it.name == "/data/page" || it.name == "done" },
    )
    assertEquals(
      "invalid_response",
      requestEvents().single().getValue("error").jsonObject.getValue("code").jsonPrimitive.content,
    )
  }

  @Test
  fun `refresh refuses an ancestor replacement above the list maximum`() = runTest {
    val base = listSpec()
    val root =
      (base.root as PrototypeListNode).copy(
        repeat = (base.root as PrototypeListNode).repeat.copy(itemsPath = "/feed/items"),
      )
    val spec = base.copy(root = root, data = buildJsonObject { put("feed", base.data!!) })
    val runtime = runtime(spec)
    runtime.handle(
      PrototypeInteraction.Tap(listOf(appendRequest().copy(into = "/data/feed", append = null))),
    )
    runCurrent()
    events.clear()
    host.answer(0, received(json("""{"items":[{"id":0},{"id":1},{"id":2}]}""")))
    runCurrent()
    assertEquals(spec.data!!["feed"], runtime.data("feed"))
    assertFalse(events.any { it.name == "/data/feed" || it.name == "done" })
    assertEquals(
      "invalid_response",
      requestEvents().single().getValue("error").jsonObject.getValue("code").jsonPrimitive.content,
    )
  }

  @Test
  fun `over budget extend commits rows but omits event value`() = runTest {
    val runtime = runtime(listSpec())
    runtime.handle(PrototypeInteraction.Tap(listOf(appendRequest())))
    runCurrent()
    val title = "x".repeat(PrototypeSpecValidator.MAX_PROTOTYPE_EMIT_PAYLOAD_BYTES)
    val page = buildJsonObject {
      put(
        "items",
        buildJsonArray {
          add(
            buildJsonObject {
              put("id", 2)
              put("title", title)
            },
          )
        },
      )
    }
    host.answer(0, received(page))
    runCurrent()
    val event = events.single { it.name == "/data/items" }
    assertFalse(event.payload!!.jsonObject.containsKey("value"))
    val decoded = checkNotNull(prototypeDataWriteOf("change", event.name, event.payload))
    assertNull(decoded.write())
    assertEquals("success", runtime.status())
  }

  @Test
  fun `page then refresh cancels overlapping ancestor target`() = runTest {
    assertSuperseded(
      appendRequest()
        .copy(into = null, append = PrototypeRequestAppend("/items", "/data/feed/items")),
      appendRequest().copy(into = "/data/feed", append = null),
    )
  }

  @Test
  fun `refresh then page cancels overlapping descendant target`() = runTest {
    assertSuperseded(
      appendRequest().copy(into = "/data/feed", append = null),
      appendRequest()
        .copy(into = null, append = PrototypeRequestAppend("/items", "/data/feed/items")),
    )
  }

  @Test
  fun `two append only requests to the same target supersede`() = runTest {
    assertSuperseded(appendRequest().copy(into = null), appendRequest().copy(into = null))
  }

  private suspend fun TestScope.assertSuperseded(
    first: PrototypeRequestAction,
    second: PrototypeRequestAction,
  ) {
    val spec = listSpec()
    val runtime = runtime(spec)
    runtime.handle(PrototypeInteraction.Tap(listOf(first)))
    runCurrent()
    runtime.handle(PrototypeInteraction.Tap(listOf(second)))
    runCurrent()
    val cancelled = requestEvents().single()
    assertEquals(
      "cancelled",
      cancelled.getValue("error").jsonObject.getValue("code").jsonPrimitive.content,
    )
    host.answer(0, received(json("""{"items":[{"id":2,"title":"Old"}]}""")))
    runCurrent()
    assertEquals(spec.data, runtime.current.spec.data)
    assertFalse(
      events.any { it.kind == PrototypeEventKind.CHANGE || it.name == "done" || it.name == "bad" },
    )
    assertEquals(1, requestEvents().size)
    runtime.close()
  }
}
