package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.*
import kotlin.random.Random
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** `prototype simulate` of `realtime.frame` (#14269), at the controller and through a runtime. */
class PrototypeRealtimeSimulationTest {
  /** Records every sink call; a simulated frame lands in [simulated], never in [events]. */
  private class RecordingSink : PrototypeChannelSink {
    val states = mutableMapOf<String, JsonObject>()
    val events = mutableListOf<Pair<String, JsonObject>>()
    val simulated = mutableListOf<Pair<String, JsonObject>>()
    val runs = mutableListOf<Triple<String, JsonArray, JsonElement>>()
    val warnings = mutableListOf<String>()

    override suspend fun state(channel: String, state: JsonObject) {
      states[channel] = state
    }

    override suspend fun event(name: String, data: JsonObject) {
      events += name to data
    }

    override suspend fun simulatedEvent(name: String, data: JsonObject) {
      simulated += name to data
    }

    override suspend fun run(channel: String, actions: JsonArray, event: JsonElement) {
      runs += Triple(channel, actions, event)
    }

    override fun warn(message: String) {
      warnings += message
    }
  }

  /** Counts opens and fails each one, so a simulated frame that opened a connection shows. */
  private class CountingTransport : PrototypeChannelTransport {
    var opens = 0

    override fun open(
      request: PrototypeChannelOpenRequest,
      listener: PrototypeChannelListener,
    ): PrototypeChannelConnection {
      opens++
      listener.onClosed(null, null, PrototypeChannelError(PrototypeChannelError.NETWORK, "no"))
      return object : PrototypeChannelConnection {
        override fun send(data: String) = false

        override fun close(code: Int, reason: String) = Unit
      }
    }
  }

  private fun TestScope.controller(sink: RecordingSink, transport: PrototypeChannelTransport) =
    PrototypeChannelController(
      prototypeId = "proto",
      transports = PrototypeChannelTransports(host = transport, device = transport),
      sink = sink,
      scope = backgroundScope,
      random = Random(0),
      onError = { throw it },
      newId = { "c1" },
    )

  private fun channel(text: String): PrototypeChannelDeclaration =
    checkNotNull(PrototypeChannelDeclaration.parse(Json.parseToJsonElement(text).jsonObject))

  @Test
  fun `a simulated frame is decoded, counted and routed like a server frame without a connection`() =
    runTest {
      val sink = RecordingSink()
      val transport = CountingTransport()
      val controller = controller(sink, transport)
      controller.update(
        mapOf(
          "chat" to
            channel(
              """{"kind":"websocket","url":"wss://e.com","connect":"manual","routes":[
                {"when":{"pointer":"/type","equals":"message"},
                 "actions":[{"type":"increment","key":"n"}]}]}""",
            ),
        ),
      )
      controller.show()
      controller.simulateFrame("chat", """{"type":"message"}""", "chat-message", "7")
      controller.simulateFrame("chat", "not json", null, null)
      runCurrent()
      advanceTimeBy(PrototypeChannelLimits.flushMs.toLong() + 1)
      assertEquals("a manual channel opens nothing", 0, transport.opens)
      assertEquals(
        listOf("increment"),
        sink.runs.map { it.second.first().jsonObject.getValue("type").jsonPrimitive.content },
      )
      val (name, frame) = sink.simulated.single()
      assertEquals(PrototypeChannelController.FRAME_EVENT, name)
      assertEquals(
        Json.parseToJsonElement(
          """{"channel":"chat","data":{"type":"message"},"event":"chat-message","id":"7"}""",
        ),
        frame,
      )
      assertTrue(sink.events.none { it.first == PrototypeChannelController.FRAME_EVENT })
      val state = sink.states.getValue("chat")
      assertEquals(1L, state["framesIn"]?.jsonPrimitive?.content?.toLong())
      assertEquals(1L, state["framesDropped"]?.jsonPrimitive?.content?.toLong())
      assertEquals("idle", state["status"]?.jsonPrimitive?.content)
    }

  @Test
  fun `a simulated frame for an undeclared channel is dropped with a warning`() = runTest {
    val sink = RecordingSink()
    val controller = controller(sink, CountingTransport())
    controller.update(mapOf("chat" to channel("""{"kind":"websocket","url":"wss://e.com"}""")))
    controller.simulateFrame("other", "{}", null, null)
    runCurrent()
    assertTrue(sink.simulated.isEmpty())
    assertEquals(listOf("Simulated frame for undeclared channel other was dropped"), sink.warnings)
  }

  /** One manual `chat` channel that upserts every frame into `/data/messages` by `/id`. */
  private fun spec() =
    PrototypeSpec(
      "realtime",
      PrototypeWindow(PrototypeFullscreenPlacement()),
      root = PrototypeTextNode(text = "{platform:/realtime/chat/status}"),
      data = JsonObject(mapOf("messages" to JsonArray(emptyList()))),
      requires = PrototypeRequires(platform = listOf("realtime")),
      channels =
        mapOf(
          "chat" to
            PrototypeChannel(
              kind = "websocket",
              url = "wss://example.test/chat",
              connect = "manual",
              routes =
                listOf(
                  PrototypeChannelRoute(
                    actions =
                      listOf(
                        PrototypeUpsertDataAction(
                          path = "/data/messages",
                          value = JsonObject(mapOf("event" to JsonPrimitive(""))),
                          key = "/id",
                        ),
                      ),
                  ),
                ),
            ),
        ),
    )

  private fun TestScope.runtime(
    transport: PrototypeChannelTransport,
    events: MutableList<PrototypeEvent>,
    warnings: MutableList<String>,
  ): PrototypeRuntime {
    var id = 0
    var seq = 0L
    return PrototypeRuntime(
        spec(),
        sink = { events += it },
        clock = { testScheduler.currentTime },
        monotonicMs = { testScheduler.currentTime },
        nextSequence = { ++seq },
        requestScope = backgroundScope,
        exclusively = { it() },
        newRequestId = { "id-${++id}" },
        warn = { warnings += it },
        realtime =
          PrototypeRealtimeConfig(PrototypeChannelTransports(transport, transport), Random(0)),
      )
      .also { it.startPlatformModules() }
  }

  private fun PrototypeRuntime.chat(): JsonObject? =
    (current.platformState["realtime"] as? JsonObject)?.get("chat")?.jsonObject

  private fun obj(vararg pairs: Pair<String, JsonElement>) = JsonObject(mapOf(*pairs))

  @Test
  fun `a simulated frame runs the channel's routes and reaches the host marked simulated`() =
    runTest {
      val transport = CountingTransport()
      val events = mutableListOf<PrototypeEvent>()
      val warnings = mutableListOf<String>()
      val runtime = runtime(transport, events, warnings)
      runtime.shown()
      runCurrent()
      val frame =
        obj(
          "channel" to JsonPrimitive("chat"),
          "data" to obj("id" to JsonPrimitive(1), "text" to JsonPrimitive("hi")),
        )
      assertTrue(runtime.simulatePlatformEvent("realtime.frame", frame))
      advanceTimeBy(PrototypeChannelLimits.flushMs + 1L)
      runCurrent()
      assertEquals(emptyList<String>(), warnings)
      assertEquals("a simulated frame opens no connection", 0, transport.opens)
      assertEquals(
        listOf("hi"),
        runtime.current.spec.data!!.getValue("messages").jsonArray.map {
          it.jsonObject.getValue("text").jsonPrimitive.content
        },
      )
      assertEquals(1, runtime.chat()?.get("framesIn")?.jsonPrimitive?.content?.toInt())
      val delivered =
        events
          .mapNotNull { it.payload as? JsonObject }
          .filter { it["event"]?.jsonPrimitive?.content == "realtime.frame" }
      assertEquals(1, delivered.size)
      assertEquals(JsonPrimitive(true), delivered.single()["simulated"])
    }

  @Test
  fun `a simulated status or a frame for an undeclared channel is refused`() = runTest {
    val runtime = runtime(CountingTransport(), mutableListOf(), mutableListOf())
    runtime.shown()
    runCurrent()
    val status = obj("channel" to JsonPrimitive("chat"), "status" to JsonPrimitive("open"))
    assertEquals(false, runtime.simulatePlatformEvent("realtime.status", status))
    val elsewhere = obj("channel" to JsonPrimitive("other"), "data" to JsonPrimitive("x"))
    assertEquals(false, runtime.simulatePlatformEvent("realtime.frame", elsewhere))
    runCurrent()
    assertEquals(0, runtime.chat()?.get("framesIn")?.jsonPrimitive?.content?.toInt())
    assertEquals("idle", runtime.chat()?.get("status")?.jsonPrimitive?.content)
  }
}
