package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.*
import kotlin.random.Random
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withTimeout
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
          transport.last.listener.onOpen(null)
          transport.last.listener.onFrame("""{"id":1,"text":"warm"}""", null, null)
          advanceTimeBy(PrototypeChannelLimits.flushMs + 1L)
          runCurrent()
          runtime.patch(runtime.current.revision, urlPatch("wss://example.test/warm"), json) {
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

    override fun open(
      request: PrototypeChannelOpenRequest,
      listener: PrototypeChannelListener,
    ): PrototypeChannelConnection = FakeConnection(request, listener).also { opened += it }

    val last: FakeConnection
      get() = opened.last()
  }

  private val json = Json { classDiscriminator = "type" }

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
                          path = "/messages",
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
        warn = { error(it) },
        realtime =
          PrototypeRealtimeConfig(PrototypeChannelTransports(transport, transport), Random(0)),
      )
      .also { it.startPlatformModules() }
  }

  private fun urlPatch(url: String): JsonArray =
    json
      .parseToJsonElement("""[{"op":"replace","path":"/channels/chat/url","value":"$url"}]""")
      .jsonArray

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
    assertEquals("wss://example.test/a", transport.last.request.url)
    assertEquals("connecting", runtime.chat()?.get("status")?.jsonPrimitive?.content)
    assertEquals(PrototypeScalar.Text("connecting"), runtime.current.state["status"])

    transport.last.listener.onOpen(null)
    transport.last.listener.onFrame("""{"id":1,"text":"hi"}""", null, null)
    transport.last.listener.onFrame("""{"id":1,"text":"hi, edited"}""", null, null)
    transport.last.listener.onFrame("""{"id":2,"text":"there"}""", null, null)
    advanceTimeBy(PrototypeChannelLimits.flushMs + 1L)
    runCurrent()

    assertEquals(PrototypeScalar.Text("open"), runtime.current.state["status"])
    assertEquals(listOf("hi, edited", "there"), runtime.messages())
    assertEquals(3, runtime.chat()?.get("framesIn")?.jsonPrimitive?.content?.toInt())
  }

  @Test
  fun `a patch under the interaction lock while frames flush reconnects without deadlock`() =
    runTest {
      val lock = Mutex()
      val transport = FakeTransport()
      val runtime = runtime(transport, lock = lock)
      runtime.shown()
      runCurrent()
      val first = transport.last
      first.listener.onOpen(null)
      runCurrent()

      lock.withLock {
        first.listener.onFrame("""{"id":1,"text":"during patch"}""", null, null)
        // The flush takes the controller lock, then waits in the sink for the interaction lock.
        advanceTimeBy(PrototypeChannelLimits.flushMs + 1L)
        runCurrent()
        // A runtime that called the controller here would wait on its lock forever.
        val result =
          withTimeout(1_000) {
            runtime.patch(runtime.current.revision, urlPatch("wss://example.test/b"), json) {
              json.decodeFromJsonElement(PrototypeSpec.serializer(), it)
            }
          }
        assertTrue(result is PrototypeRuntime.PatchResult.Applied)
      }
      runCurrent()

      assertEquals(listOf("during patch"), runtime.messages())
      assertEquals(2, transport.opened.size)
      assertEquals(PrototypeChannelController.GOING_AWAY, first.closedWith)
      assertEquals("wss://example.test/b", transport.last.request.url)
      assertEquals("reconnecting", runtime.chat()?.get("status")?.jsonPrimitive?.content)
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
}
