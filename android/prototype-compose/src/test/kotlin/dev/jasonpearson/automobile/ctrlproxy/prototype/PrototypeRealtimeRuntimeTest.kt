package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.*
import dev.jasonpearson.automobile.prototype.PlatformCall
import dev.jasonpearson.automobile.prototype.PlatformCallResult
import kotlin.random.Random
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.BeforeClass
import org.junit.Test

class PrototypeRealtimeRuntimeTest {
  companion object {
    @JvmStatic
    @BeforeClass
    fun warm() {
      // Pay serializer, mapper and coroutine initialization outside each measured test.
      with(PrototypeRealtimeRuntimeTest()) {
        runTest {
          val transport = FakeTransport()
          val runtime = runtime(transport)
          runtime.shown()
          runCurrent()
          check(transport.opened.isNotEmpty()) { "warm: no connection; warnings=$warnings" }
          transport.last.listener.onOpen(null)
          transport.last.listener.onFrame("""{"id":1,"text":"warm"}""", null, null)
          advanceTimeBy(PrototypeChannelLimits.flushMs + 1L)
          runCurrent()
          runtime.patch(runtime.current.revision, roomPatch("warm"), json) {
            json.decodeFromJsonElement(PrototypeSpec.serializer(), it)
          }
          runtime.handle(PrototypeInteraction.Tap(listOf(send("""{"warm":true}"""))))
          runCurrent()
          runtime.finishDismissal(PrototypeDismissReason.USER)
          runCurrent()
        }
      }
    }
  }

  private class FakeConnection(
    val request: PrototypeChannelOpenRequest,
    val listener: PrototypeChannelListener,
  ) : PrototypeChannelConnection {
    val sent = mutableListOf<String>()
    var closedWith: Int? = null

    override fun send(data: String): Boolean = closedWith == null && sent.add(data)

    override fun close(code: Int, reason: String) {
      closedWith = code
    }
  }

  private class FakeTransport : PrototypeChannelTransport {
    val opened = mutableListOf<FakeConnection>()
    /** How many of the next opens throw instead of reporting. */
    var throwing = 0

    override fun open(
      request: PrototypeChannelOpenRequest,
      listener: PrototypeChannelListener,
    ): PrototypeChannelConnection {
      if (throwing > 0) {
        throwing--
        throw IllegalStateException("transport exploded")
      }
      return FakeConnection(request, listener).also { opened += it }
    }

    val last: FakeConnection
      get() = opened.last()
  }

  private val json = Json { classDiscriminator = "type" }

  /** Refusals the runtime explains; every test expects none. */
  private val warnings = mutableListOf<String>()

  private fun obj(vararg pairs: Pair<String, JsonElement>) = JsonObject(mapOf(*pairs))

  private fun spec(connect: String? = null) =
    PrototypeSpec(
      "realtime",
      PrototypeWindow(PrototypeFullscreenPlacement()),
      state = mapOf("status" to PrototypeScalar.Text("idle"), "room" to PrototypeScalar.Text("a")),
      root = PrototypeTextNode(text = "{platform:/realtime/chat/status}"),
      data = obj("messages" to JsonArray(emptyList())),
      requires = PrototypeRequires(platform = listOf("realtime")),
      channels =
        mapOf(
          "chat" to
            PrototypeChannel(
              kind = "websocket",
              url = "wss://example.test/{room}",
              connect = connect,
              statusKey = "status",
              routes =
                listOf(
                  PrototypeChannelRoute(
                    actions =
                      listOf(
                        PrototypeUpsertDataAction(
                          path = "/data/messages",
                          value = obj("event" to JsonPrimitive("")),
                          key = "/id",
                        ),
                      ),
                  ),
                ),
            ),
        ),
    )

  private fun TestScope.runtime(
    transport: FakeTransport,
    spec: PrototypeSpec = spec(),
    lock: Mutex = Mutex(),
    events: MutableList<PrototypeEvent> = mutableListOf(),
    httpClients: PrototypeHttpClients = PrototypeHttpClients.Unavailable,
  ): PrototypeRuntime {
    var id = 0
    var seq = 0L
    return PrototypeRuntime(
        spec,
        sink = { events += it },
        clock = { testScheduler.currentTime },
        monotonicMs = { testScheduler.currentTime },
        nextSequence = { ++seq },
        requestScope = backgroundScope,
        exclusively = { lock.withLock { it() } },
        newRequestId = { "id-${++id}" },
        warn = { warnings += it },
        httpClients = httpClients,
        realtime =
          PrototypeRealtimeConfig(PrototypeChannelTransports(transport, transport), Random(0)),
      )
      .also { it.startPlatformModules() }
  }

  /** The channel URL binds `{room}`, so a state patch rebinds it. */
  private fun roomPatch(room: String): JsonArray =
    json.parseToJsonElement("""[{"op":"replace","path":"/state/room","value":"$room"}]""").jsonArray

  private fun call(name: String, vararg args: Pair<String, JsonElement>) =
    PrototypePlatformAction(
      name,
      mapOf("channel" to obj("value" to JsonPrimitive("chat"))) +
        args.associate { (key, value) -> key to obj("value" to value) },
    )

  private fun send(body: String) = call("realtime.send", "body" to JsonPrimitive(body))

  private fun PrototypeRuntime.chat(): JsonObject? =
    (current.platformState["realtime"] as? JsonObject)?.get("chat")?.jsonObject

  private fun PrototypeRuntime.messages(): List<String> =
    current.spec.data!!.getValue("messages").jsonArray.map {
      it.jsonObject.getValue("text").jsonPrimitive.content
    }

  @Test
  fun `show connects and lands status, statusKey and routed frames as one write`() = runTest {
    val transport = FakeTransport()
    val runtime = runtime(transport)
    runtime.shown()
    runCurrent()
    assertEquals(emptyList<String>(), warnings)
    assertEquals("wss://example.test/a", transport.last.request.url)
    assertEquals("connecting", runtime.chat()?.get("status")?.jsonPrimitive?.content)
    assertEquals(PrototypeScalar.Text("connecting"), runtime.current.state["status"])

    transport.last.listener.onOpen(null)
    transport.last.listener.onFrame("""{"id":1,"text":"hi"}""", null, null)
    transport.last.listener.onFrame("""{"id":1,"text":"hi, edited"}""", null, null)
    transport.last.listener.onFrame("""{"id":2,"text":"there"}""", null, null)
    advanceTimeBy(PrototypeChannelLimits.flushMs + 1L)
    runCurrent()

    assertEquals(emptyList<String>(), warnings)
    assertEquals(PrototypeScalar.Text("open"), runtime.current.state["status"])
    assertEquals(runtime.chat().toString(), listOf("hi, edited", "there"), runtime.messages())
    assertEquals(3, runtime.chat()?.get("framesIn")?.jsonPrimitive?.content?.toInt())
  }

  @Test
  fun `a state patch under the interaction lock while frames flush rebinds and reconnects`() =
    runTest {
      val lock = Mutex()
      val transport = FakeTransport()
      val runtime = runtime(transport, lock = lock)
      runtime.shown()
      runCurrent()
      val first = transport.last
      first.listener.onOpen(null)
      runCurrent()

      first.listener.onFrame("""{"id":1,"text":"during patch"}""", null, null)
      runCurrent()

      lock.withLock {
        // The flush takes the controller lock, then waits in the sink for the interaction lock.
        advanceTimeBy(PrototypeChannelLimits.flushMs + 1L)
        runCurrent()
        // A runtime that called the controller here would wait on its lock forever.
        val result =
          withTimeout(1_000) {
            runtime.patch(runtime.current.revision, roomPatch("b"), json) {
              json.decodeFromJsonElement(PrototypeSpec.serializer(), it)
            }
          }
        assertTrue(result.toString(), result is PrototypeRuntime.PatchResult.Applied)
      }
      runCurrent()

      assertEquals(emptyList<String>(), warnings)
      assertEquals(runtime.chat().toString(), listOf("during patch"), runtime.messages())
      assertEquals(2, transport.opened.size)
      assertEquals(PrototypeChannelController.GOING_AWAY, first.closedWith)
      assertEquals("wss://example.test/b", transport.last.request.url)
      assertEquals("connecting", runtime.chat()?.get("status")?.jsonPrimitive?.content)
    }

  @Test
  fun `a flush blocked on the lock drops its actions when a replacement removes the channel`() =
    runTest {
      val lock = Mutex()
      val transport = FakeTransport()
      val runtime = runtime(transport, lock = lock)
      runtime.shown()
      runCurrent()
      val first = transport.last
      first.listener.onOpen(null)
      first.listener.onFrame("""{"id":1,"text":"stale"}""", null, null)
      runCurrent()

      lock.withLock {
        // The flush holds the controller lock and waits in the sink for the interaction lock.
        advanceTimeBy(PrototypeChannelLimits.flushMs + 1L)
        runCurrent()
        runtime.replace(
          spec().copy(channels = null, root = PrototypeTextNode(text = "no channels")),
        )
      }
      runCurrent()

      assertEquals(emptyList<String>(), warnings)
      assertEquals(emptyList<String>(), runtime.messages())
      assertNull(runtime.chat())
      assertEquals(PrototypeChannelController.GOING_AWAY, first.closedWith)
    }

  @Test
  fun `a send queued behind a blocked frame never goes out once dismissal begins`() = runTest {
    val lock = Mutex()
    val transport = FakeTransport()
    val runtime = runtime(transport, lock = lock)
    runtime.shown()
    runCurrent()
    val connection = transport.last
    connection.listener.onOpen(null)
    runCurrent()
    val module =
      runtime.platformRegistry.modules.filterIsInstance<PrototypeRealtimeModule>().single()
    var result: PlatformCallResult? = null

    lock.withLock {
      // The frame's event waits in the sink for the interaction lock, holding the controller lock.
      connection.listener.onFrame("""{"id":1,"text":"blocked"}""", null, null)
      runCurrent()
      backgroundScope.launch {
        result =
          module.call(
            PlatformCall(
              "send-1",
              PrototypeRealtimeModule.SEND,
              obj("channel" to JsonPrimitive("chat"), "body" to JsonPrimitive("late")),
            ),
          )
      }
      runCurrent()
      runtime.close()
    }
    runCurrent()

    assertEquals(emptyList<String>(), connection.sent)
    assertEquals(PrototypeChannelController.GOING_AWAY, connection.closedWith)
    assertTrue(result.toString(), result is PlatformCallResult.Failure)
  }

  @Test
  fun `realtime calls connect, send and disconnect a manual channel`() = runTest {
    val transport = FakeTransport()
    val events = mutableListOf<PrototypeEvent>()
    val runtime = runtime(transport, spec(connect = "manual"), events = events)
    runtime.shown()
    runCurrent()
    assertTrue(transport.opened.isEmpty())

    runtime.handle(
      PrototypeInteraction.Tap(listOf(call("realtime.connect"), send("""{"q":1}"""))),
    )
    runCurrent()
    transport.last.listener.onOpen(null)
    runCurrent()
    assertEquals(listOf("""{"q":1}"""), transport.last.sent)

    runtime.handle(PrototypeInteraction.Tap(listOf(call("realtime.disconnect"))))
    runCurrent()
    assertEquals(PrototypeChannelController.NORMAL_CLOSURE, transport.last.closedWith)
    assertEquals(PrototypeScalar.Text("closed"), runtime.current.state["status"])
    val failures = events.filter {
      it.name == PrototypePlatform.CALL_EVENT_NAME &&
        (it.payload as? JsonObject)?.get("outcome")?.jsonPrimitive?.content == "error"
    }
    assertTrue(failures.toString(), failures.isEmpty())
  }

  @Test
  fun `a route setState bound to the frame writes the scalar it reads`() = runTest {
    val base = spec()
    val bound =
      base.copy(
        state = base.state.orEmpty() + ("last" to PrototypeScalar.Text("")),
        channels =
          base.channels!!.mapValues { (_, channel) ->
            channel.copy(
              routes =
                listOf(
                  PrototypeChannelRoute(
                    actions =
                      listOf(
                        PrototypeSetStateAction(
                          "last",
                          PrototypeScalar.Binding(obj("event" to JsonPrimitive("/text"))),
                        ),
                      ),
                  ),
                ),
            )
          },
      )
    val transport = FakeTransport()
    val runtime = runtime(transport, bound)
    runtime.shown()
    runCurrent()
    transport.last.listener.onOpen(null)
    transport.last.listener.onFrame("""{"text":"hello"}""", null, null)
    advanceTimeBy(PrototypeChannelLimits.flushMs + 1L)
    runCurrent()

    assertEquals(emptyList<String>(), warnings)
    assertEquals(PrototypeScalar.Text("hello"), runtime.current.state["last"])
  }

  @Test
  fun `a refused platform-on frame handler leaves later frames flowing`() = runTest {
    val base = spec()
    val handled =
      base.copy(
        state = base.state.orEmpty() + ("last" to PrototypeScalar.Text("")),
        platform =
          PrototypePlatformHandlers(
            mapOf(
              "realtime.frame" to
                listOf(
                  PrototypeSetStateAction(
                    "last",
                    PrototypeScalar.Binding(obj("event" to JsonPrimitive("/data/text"))),
                  ),
                ),
            ),
          ),
      )
    val transport = FakeTransport()
    val runtime = runtime(transport, handled)
    runtime.shown()
    runCurrent()
    transport.last.listener.onOpen(null)
    transport.last.listener.onFrame("""{"id":1}""", null, null)
    transport.last.listener.onFrame("""{"id":2,"text":"after"}""", null, null)
    advanceTimeBy(PrototypeChannelLimits.flushMs + 1L)
    runCurrent()

    assertEquals(1, warnings.size)
    assertTrue(warnings.single(), warnings.single().startsWith("Refused realtime.frame handler"))
    assertEquals(PrototypeScalar.Text("after"), runtime.current.state["last"])
    assertEquals(2, runtime.chat()?.get("framesIn")?.jsonPrimitive?.content?.toInt())
  }

  @Test
  fun `an onOpen send follow-up binds state to the captured event`() = runTest {
    val base = spec()
    val followed =
      base.copy(
        state = base.state.orEmpty() + ("captured" to PrototypeScalar.Text("")),
        channels =
          base.channels!!.mapValues { (_, channel) ->
            channel.copy(
              onOpen =
                listOf(
                  send("hello")
                    .copy(
                      onSuccess =
                        listOf(
                          PrototypeSetStateAction(
                            "captured",
                            PrototypeScalar.Binding(obj("event" to JsonPrimitive("/status"))),
                          ),
                        ),
                    ),
                ),
            )
          },
      )
    val transport = FakeTransport()
    val runtime = runtime(transport, followed)
    runtime.shown()
    runCurrent()
    transport.last.listener.onOpen(null)
    runCurrent()

    assertEquals(emptyList<String>(), warnings)
    assertEquals(listOf("hello"), transport.last.sent)
    assertEquals(PrototypeScalar.Text("open"), runtime.current.state["captured"])
  }

  @Test
  fun `removing the last channel drops its platform state and closes it`() = runTest {
    val transport = FakeTransport()
    val runtime = runtime(transport)
    runtime.shown()
    runCurrent()
    transport.last.listener.onOpen(null)
    runCurrent()
    assertEquals("open", runtime.chat()?.get("status")?.jsonPrimitive?.content)

    runtime.replace(spec().copy(channels = null, root = PrototypeTextNode(text = "no channels")))
    runCurrent()

    assertNull(runtime.chat())
    assertEquals(PrototypeChannelController.GOING_AWAY, transport.last.closedWith)
  }

  @Test
  fun `dismiss closes every connection and drops frames that arrive after it`() = runTest {
    val transport = FakeTransport()
    val runtime = runtime(transport)
    runtime.shown()
    runCurrent()
    val connection = transport.last
    connection.listener.onOpen(null)
    runCurrent()

    runtime.finishDismissal(PrototypeDismissReason.USER)
    runCurrent()
    connection.listener.onFrame("""{"id":9,"text":"late"}""", null, null)
    advanceTimeBy(PrototypeChannelLimits.flushMs + 1L)
    runCurrent()

    assertEquals(PrototypeChannelController.GOING_AWAY, connection.closedWith)
    assertEquals(emptyList<String>(), runtime.messages())
    assertNull(runtime.current.platformState["realtime"]?.jsonObject?.get("late"))
  }

  @Test
  fun `a request started by a status handler binds its follow-up to the captured event`() =
    runTest {
      val base = spec()
      val followed =
        base.copy(
          state = base.state.orEmpty() + ("captured" to PrototypeScalar.Text("")),
          platform =
            PrototypePlatformHandlers(
              mapOf(
                "realtime.status" to
                  listOf(
                    PrototypeRequestAction(
                      url = "https://example.test/ack",
                      onSuccess =
                        listOf(
                          PrototypeSetStateAction(
                            "captured",
                            PrototypeScalar.Binding(obj("event" to JsonPrimitive("/status"))),
                          ),
                        ),
                    ),
                  ),
              ),
            ),
        )
      val http = PrototypeHttpClient {
        PrototypeRequestResponse.Received(200, emptyMap(), JsonObject(emptyMap()), 1)
      }
      val transport = FakeTransport()
      val runtime = runtime(transport, followed, httpClients = PrototypeHttpClients(http, http))
      runtime.shown()
      runCurrent()
      transport.last.listener.onOpen(null)
      runCurrent()

      assertEquals(emptyList<String>(), warnings)
      assertEquals(PrototypeScalar.Text("open"), runtime.current.state["captured"])
    }

  @Test
  fun `a transport that throws fails one attempt and the channel keeps working`() = runTest {
    val transport = FakeTransport().apply { throwing = 1 }
    val runtime = runtime(transport)
    runtime.shown()
    runCurrent()
    assertEquals(1, warnings.size)
    assertTrue(warnings.single(), "transport exploded" in warnings.single())
    assertTrue(transport.opened.isEmpty())
    warnings.clear()

    // The failed attempt backs off and reconnects; both inboxes are still draining.
    advanceTimeBy(60_000)
    runCurrent()
    val connection = transport.last
    connection.listener.onOpen(null)
    runCurrent()
    runtime.handle(PrototypeInteraction.Tap(listOf(send("after"))))
    runCurrent()
    assertEquals(listOf("after"), connection.sent)

    runtime.finishDismissal(PrototypeDismissReason.USER)
    runCurrent()
    assertEquals(emptyList<String>(), warnings)
    assertEquals(PrototypeChannelController.GOING_AWAY, connection.closedWith)
  }

  @Test
  fun `a send whose caller timed out while it waited for the controller never goes out`() =
    runTest {
      val lock = Mutex()
      val transport = FakeTransport()
      val runtime = runtime(transport, lock = lock)
      runtime.shown()
      runCurrent()
      val connection = transport.last
      connection.listener.onOpen(null)
      runCurrent()
      val module =
        runtime.platformRegistry.modules.filterIsInstance<PrototypeRealtimeModule>().single()
      var result: PlatformCallResult? = null
      var finished = false

      lock.withLock {
        // The frame's event waits in the sink for the interaction lock, holding the controller's.
        connection.listener.onFrame("""{"id":1,"text":"blocked"}""", null, null)
        runCurrent()
        backgroundScope.launch {
          result =
            withTimeoutOrNull(10) {
              module.call(
                PlatformCall(
                  "send-1",
                  PrototypeRealtimeModule.SEND,
                  obj("channel" to JsonPrimitive("chat"), "body" to JsonPrimitive("late")),
                ),
              )
            }
          finished = true
        }
        advanceTimeBy(11)
        runCurrent()
        assertTrue(finished)
      }
      runCurrent()

      assertNull(result)
      assertEquals(emptyList<String>(), connection.sent)
      assertNull(connection.closedWith)
      assertEquals(emptyList<String>(), warnings)
    }

  @Test
  fun `a frame for a channel a commit removed lands nothing`() = runTest {
    val lock = Mutex()
    val transport = FakeTransport()
    val routeless =
      spec().let { base ->
        base.copy(channels = base.channels!!.mapValues { it.value.copy(routes = null) })
      }
    val runtime = runtime(transport, routeless, lock = lock)
    runtime.shown()
    runCurrent()
    val first = transport.last
    first.listener.onOpen(null)
    first.listener.onFrame("""{"id":1,"text":"stale"}""", null, null)
    runCurrent()

    lock.withLock {
      // The flush publishes the frame's snapshot and waits in the sink for the interaction lock.
      advanceTimeBy(PrototypeChannelLimits.flushMs + 1L)
      runCurrent()
      runtime.replace(spec().copy(channels = null, root = PrototypeTextNode(text = "no channels")))
    }
    runCurrent()
    // A frame the old connection reports after the commit is dropped too.
    first.listener.onFrame("""{"id":2,"text":"later"}""", null, null)
    advanceTimeBy(PrototypeChannelLimits.flushMs + 1L)
    runCurrent()

    assertEquals(emptyList<String>(), warnings)
    assertNull(runtime.chat())
    assertNull(runtime.current.platformState["realtime"]?.jsonObject?.get("chat"))
    assertEquals(PrototypeChannelController.GOING_AWAY, first.closedWith)
  }
}
