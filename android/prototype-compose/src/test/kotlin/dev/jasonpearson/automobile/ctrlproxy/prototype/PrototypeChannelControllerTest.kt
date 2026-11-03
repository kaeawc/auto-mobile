package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.PrototypeChannelLimits
import java.io.File
import kotlin.random.Random
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PrototypeChannelControllerTest {
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

  private class FakeTransport(private val clock: () -> Long) : PrototypeChannelTransport {
    val opened = mutableListOf<FakeConnection>()
    val openedAt = mutableListOf<Long>()
    var failEveryOpen: PrototypeChannelError? = null

    override fun open(
      request: PrototypeChannelOpenRequest,
      listener: PrototypeChannelListener,
    ): PrototypeChannelConnection {
      openedAt += clock()
      return FakeConnection(request, listener).also { connection ->
        opened += connection
        failEveryOpen?.let { listener.onClosed(null, null, it) }
      }
    }

    val last: FakeConnection
      get() = opened.last()
  }

  private class RecordingSink : PrototypeChannelSink {
    val states = mutableMapOf<String, JsonObject>()
    val events = mutableListOf<Pair<String, JsonObject>>()
    val runs = mutableListOf<Triple<String, JsonArray, JsonElement>>()

    override suspend fun state(channel: String, state: JsonObject) {
      states[channel] = state
    }

    override suspend fun event(name: String, data: JsonObject) {
      events += name to data
    }

    override suspend fun run(channel: String, actions: JsonArray, event: JsonElement) {
      runs += Triple(channel, actions, event)
    }

    fun statuses(channel: String = "chat") =
      events
        .filter {
          it.first == PrototypeChannelController.STATUS_EVENT &&
            it.second["channel"]?.jsonPrimitive?.content == channel
        }
        .map { it.second.getValue("status").jsonPrimitive.content }

    fun status(channel: String = "chat") = states[channel]?.get("status")?.jsonPrimitive?.content

    fun attempt(channel: String = "chat") = states[channel]?.get("attempt")?.jsonPrimitive?.int
  }

  /** Cycles [values] for nextDouble, as the shared backoff vectors do. */
  private class CyclingRandom(private val values: List<Double>) : Random() {
    private var next = 0

    override fun nextBits(bitCount: Int): Int = 0

    override fun nextDouble(): Double = values[next++ % values.size]
  }

  private class Harness(scope: TestScope, random: Random = CyclingRandom(listOf(0.5))) {
    val sink = RecordingSink()
    val device = FakeTransport { scope.testScheduler.currentTime }
    val host = FakeTransport { scope.testScheduler.currentTime }
    private var ids = 0
    val controller =
      PrototypeChannelController(
        prototypeId = "proto",
        transports = PrototypeChannelTransports(host = host, device = device),
        sink = sink,
        scope = scope.backgroundScope,
        random = random,
        newId = { "c${++ids}" },
      )
  }

  private fun channel(json: String): PrototypeChannelDeclaration =
    checkNotNull(PrototypeChannelDeclaration.parse(Json.parseToJsonElement(json).jsonObject))

  /**
   * Runs every pending timer; the controller's timers live in backgroundScope, which
   * advanceUntilIdle skips.
   */
  private fun TestScope.settle() = advanceTimeBy(SETTLE_MS)

  private val websocket = channel("""{"kind":"websocket","url":"wss://example.com/chat"}""")

  @Test
  fun `status goes connecting, open, reconnecting and open again`() = runTest {
    val h = Harness(this)
    h.controller.update(mapOf("chat" to websocket))
    h.controller.show()
    runCurrent()
    h.host.last.listener.onOpen(null)
    runCurrent()
    h.host.last.listener.onClosed(1006, "gone", null)
    runCurrent()
    assertEquals("reconnecting", h.sink.status())
    assertEquals(1, h.sink.attempt())
    settle()
    assertEquals(2, h.host.opened.size)
    h.host.last.listener.onOpen(null)
    runCurrent()
    assertEquals(listOf("connecting", "open", "reconnecting", "open"), h.sink.statuses())
    assertEquals(1006, h.sink.states.getValue("chat")["closeCode"]?.jsonPrimitive?.int)
  }

  @Test
  fun `via device uses the device transport and host is the default`() = runTest {
    val h = Harness(this)
    h.controller.update(
      mapOf(
        "chat" to websocket,
        "feed" to channel("""{"kind":"sse","url":"https://example.com/feed","via":"device"}"""),
      ),
    )
    h.controller.show()
    assertEquals(listOf("chat"), h.host.opened.map { it.request.channel })
    assertEquals(listOf("feed"), h.device.opened.map { it.request.channel })
    assertEquals("proto", h.host.last.request.prototypeId)
  }

  @Test
  fun `manual channels wait for realtime connect`() = runTest {
    val h = Harness(this)
    h.controller.update(
      mapOf("chat" to channel("""{"kind":"websocket","url":"wss://e.com","connect":"manual"}""")),
    )
    h.controller.show()
    assertTrue(h.host.opened.isEmpty())
    assertEquals("idle", h.sink.status())
    assertNull(h.controller.connect("chat"))
    assertEquals(1, h.host.opened.size)
    assertEquals(
      PrototypeChannelError.INVALID_REQUEST,
      h.controller.connect("missing")?.code,
    )
  }

  @Test
  fun `reconnect delays replay the shared backoff vectors`() = runTest {
    for (case in vectors("backoff.json").getValue("cases").jsonArray.map { it.jsonObject }) {
      val reconnect = case.getValue("reconnect").jsonObject
      val randoms = case.getValue("randoms").jsonArray.map { it.jsonPrimitive.content.toDouble() }
      val expected =
        case
          .getValue("expected")
          .jsonArray
          .map { it.jsonObject }
          .filter {
            it.getValue("attempt").jsonPrimitive.int >= 1
          }
      // The controller consumes one random per attempt, so only a run of attempts 1, 2, ... maps
      // onto its schedule; sparse vectors stay with the pure replay.
      if (expected.map { it.getValue("attempt").jsonPrimitive.int } != (1..expected.size).toList())
        continue
      val h = Harness(this, CyclingRandom(randoms))
      h.host.failEveryOpen = PrototypeChannelError(PrototypeChannelError.NETWORK, "down")
      val declaration =
        websocket.copy(
          maxAttempts = reconnect["maxAttempts"]?.jsonPrimitive?.intOrNull,
          initialDelayMs = reconnect["initialDelayMs"]?.jsonPrimitive?.intOrNull,
          maxDelayMs = reconnect["maxDelayMs"]?.jsonPrimitive?.intOrNull,
        )
      h.controller.update(mapOf("chat" to declaration))
      h.controller.show()
      settle()
      val delays = h.host.openedAt.zipWithNext { a, b -> b - a }
      val eligible = expected.takeWhile { it.getValue("delayMs") !is JsonNull }
      val name = case.getValue("name").jsonPrimitive.content
      assertEquals(
        name,
        eligible.map { it.getValue("delayMs").jsonPrimitive.int.toLong() },
        delays.take(eligible.size),
      )
      if (eligible.size < expected.size) {
        assertEquals(name, eligible.size + 1, h.host.opened.size)
        assertEquals(name, "error", h.sink.status())
      }
      h.controller.close()
    }
  }

  @Test
  fun `attempts reset once a connection stays open`() = runTest {
    val h = Harness(this)
    h.controller.update(mapOf("chat" to websocket))
    h.controller.show()
    runCurrent()
    h.host.last.listener.onClosed(1006, "", null)
    settle()
    h.host.last.listener.onOpen(null)
    runCurrent()
    assertEquals(1, h.sink.attempt())
    // A drop before the stable window counts as the next attempt.
    h.host.last.listener.onClosed(1006, "", null)
    runCurrent()
    assertEquals(2, h.sink.attempt())
    settle()
    h.host.last.listener.onOpen(null)
    advanceTimeBy(PrototypeChannelController.STABLE_OPEN_MS + 1)
    assertEquals(0, h.sink.attempt())
    h.host.last.listener.onClosed(1006, "", null)
    runCurrent()
    assertEquals(1, h.sink.attempt())
  }

  @Test
  fun `queued sends flush on open and drop on close`() = runTest {
    val h = Harness(this)
    h.controller.update(mapOf("chat" to websocket))
    h.controller.show()
    assertNull(h.controller.send("chat", "one"))
    assertNull(h.controller.send("chat", "two"))
    h.host.last.listener.onOpen(null)
    runCurrent()
    assertEquals(listOf("one", "two"), h.host.last.sent)
    assertNull(h.controller.send("chat", "three"))
    assertEquals(listOf("one", "two", "three"), h.host.last.sent)

    h.host.last.listener.onClosed(1006, "", null)
    runCurrent()
    assertNull(h.controller.send("chat", "queued"))
    assertNull(h.controller.disconnect("chat"))
    assertEquals("closed", h.sink.status())
    assertEquals(PrototypeChannelError.NETWORK, h.controller.send("chat", "late")?.code)
    h.controller.connect("chat")
    h.host.last.listener.onOpen(null)
    runCurrent()
    assertTrue(h.host.last.sent.isEmpty())
  }

  @Test
  fun `sends are bounded and websocket only`() = runTest {
    val h = Harness(this)
    h.controller.update(
      mapOf(
        "chat" to websocket,
        "feed" to channel("""{"kind":"sse","url":"https://e.com/feed"}"""),
      ),
    )
    h.controller.show()
    assertEquals(PrototypeChannelError.INVALID_REQUEST, h.controller.send("feed", "x")?.code)
    assertEquals(
      PrototypeChannelError.TOO_LARGE,
      h.controller.send("chat", "x".repeat(PrototypeChannelLimits.maxSendBytes + 1))?.code,
    )
    repeat(PrototypeChannelController.MAX_QUEUED_SENDS) {
      assertNull(h.controller.send("chat", "$it"))
    }
    assertEquals(PrototypeChannelError.TOO_MANY_IN_FLIGHT, h.controller.send("chat", "x")?.code)
  }

  @Test
  fun `the first matching route runs with the decoded frame as its event`() = runTest {
    val h = Harness(this)
    h.controller.update(
      mapOf(
        "chat" to
          channel(
            """{"kind":"websocket","url":"wss://e.com","routes":[
              {"when":{"pointer":"/type","equals":"message"},
               "actions":[{"type":"appendData","path":"/data/messages","value":{"event":"/message"}}]},
              {"actions":[{"type":"increment","key":"other"}]}]}""",
          ),
      ),
    )
    h.controller.show()
    h.host.last.listener.onOpen(null)
    h.host.last.listener.onFrame("""{"type":"message","message":{"id":1}}""", null, null)
    h.host.last.listener.onFrame("""{"type":"ping"}""", null, null)
    runCurrent()
    assertTrue("routes wait for the flush window", h.sink.runs.isEmpty())
    advanceTimeBy(PrototypeChannelLimits.flushMs.toLong() + 1)
    assertEquals(
      listOf("appendData", "increment"),
      h.sink.runs.map { it.second.first().jsonObject.getValue("type").jsonPrimitive.content },
    )
    assertEquals(Json.parseToJsonElement("""{"type":"ping"}"""), h.sink.runs[1].third)
    assertEquals(2L, h.sink.states.getValue("chat")["framesIn"]?.jsonPrimitive?.content?.toLong())
    assertEquals(2, h.sink.events.count { it.first == PrototypeChannelController.FRAME_EVENT })
  }

  @Test
  fun `a flush window coalesces same-target writes but keeps appends`() = runTest {
    val h = Harness(this)
    h.controller.update(
      mapOf(
        "chat" to
          channel(
            """{"kind":"websocket","url":"wss://e.com","routes":[
              {"when":{"pointer":"/kind","equals":"pos"},
               "actions":[{"type":"setData","path":"/data/driver","value":{"event":"/at"}}]},
              {"actions":[{"type":"appendData","path":"/data/log","value":{"event":""}}]}]}""",
          ),
      ),
    )
    h.controller.show()
    h.host.last.listener.onOpen(null)
    h.host.last.listener.onFrame("""{"kind":"pos","at":1}""", null, null)
    h.host.last.listener.onFrame("""{"kind":"pos","at":2}""", null, null)
    h.host.last.listener.onFrame("""{"kind":"log","n":1}""", null, null)
    h.host.last.listener.onFrame("""{"kind":"log","n":2}""", null, null)
    advanceTimeBy(PrototypeChannelLimits.flushMs.toLong() + 1)
    assertEquals(
      listOf("""{"kind":"pos","at":2}""", """{"kind":"log","n":1}""", """{"kind":"log","n":2}""")
        .map(Json::parseToJsonElement),
      h.sink.runs.map { it.third },
    )
  }

  @Test
  fun `undecodable and oversized frames count as dropped`() = runTest {
    val h = Harness(this)
    h.controller.update(mapOf("chat" to websocket))
    h.controller.show()
    h.host.last.listener.onOpen(null)
    h.host.last.listener.onFrame("not json", null, null)
    h.host.last.listener.onFrame(
      "\"x".padEnd(PrototypeChannelLimits.maxFrameBytes + 2, 'x'),
      null,
      null,
    )
    advanceTimeBy(PrototypeChannelLimits.flushMs.toLong() + 1)
    val state = h.sink.states.getValue("chat")
    assertEquals("2", state["framesDropped"]?.jsonPrimitive?.content)
    assertEquals("0", state["framesIn"]?.jsonPrimitive?.content)
  }

  @Test
  fun `text channels deliver the raw frame and sse ids resume`() = runTest {
    val h = Harness(this)
    h.controller.update(
      mapOf(
        "feed" to
          channel(
            """{"kind":"sse","url":"https://e.com","decode":"text","routes":[
              {"when":{"event":"tick"},"actions":[{"type":"setState","key":"t","value":{"event":""}}]}]}""",
          ),
      ),
    )
    h.controller.show()
    h.host.last.listener.onOpen(null)
    h.host.last.listener.onFrame("hello", "tick", "41")
    h.host.last.listener.onClosed(null, null, null)
    settle()
    assertEquals(Json.parseToJsonElement("\"hello\""), h.sink.runs.single().third)
    assertEquals("41", h.host.last.request.lastEventId)
  }

  @Test
  fun `statusKey and callbacks run as actions`() = runTest {
    val h = Harness(this)
    h.controller.update(
      mapOf(
        "chat" to
          channel(
            """{"kind":"websocket","url":"wss://e.com","statusKey":"chatStatus",
              "reconnect":{"maxAttempts":0,"initialDelayMs":100,"maxDelayMs":100},
              "onOpen":[{"type":"setState","key":"opened","value":true}],
              "onError":[{"type":"setState","key":"failed","value":true}]}""",
          ),
      ),
    )
    h.controller.show()
    h.host.last.listener.onOpen(null)
    h.host.last.listener.onClosed(
      null,
      null,
      PrototypeChannelError(PrototypeChannelError.HANDSHAKE_FAILED, "no", 403),
    )
    runCurrent()
    val keys =
      h.sink.runs.map { it.second.first().jsonObject.getValue("key").jsonPrimitive.content }
    assertEquals(listOf("chatStatus", "chatStatus", "opened", "chatStatus", "failed"), keys)
    assertEquals("error", h.sink.status())
    assertEquals(
      "403",
      h.sink.states.getValue("chat")["error"]?.jsonObject?.get("status")?.jsonPrimitive?.content,
    )
  }

  @Test
  fun `dismiss closes every connection and silences late callbacks`() = runTest {
    val h = Harness(this)
    h.controller.update(mapOf("chat" to websocket))
    h.controller.show()
    h.host.last.listener.onOpen(null)
    runCurrent()
    val connection = h.host.last
    val before = h.sink.events.size
    h.controller.close()
    connection.listener.onFrame("{}", null, null)
    connection.listener.onClosed(1006, "", null)
    settle()
    assertEquals(PrototypeChannelController.GOING_AWAY, connection.closedWith)
    assertEquals(before, h.sink.events.size)
    assertEquals(1, h.host.opened.size)
  }

  @Test
  fun `a patch reconnects only changed channels`() = runTest {
    val h = Harness(this)
    val feed = channel("""{"kind":"sse","url":"https://e.com/feed"}""")
    h.controller.update(mapOf("chat" to websocket, "feed" to feed))
    h.controller.show()
    h.host.opened.forEach { it.listener.onOpen(null) }
    runCurrent()
    val (chat, oldFeed) = h.host.opened.toList()
    h.controller.update(
      mapOf("chat" to websocket, "feed" to feed.copy(url = "https://e.com/feed2")),
    )
    assertNull(chat.closedWith)
    assertEquals(PrototypeChannelController.GOING_AWAY, oldFeed.closedWith)
    assertEquals("https://e.com/feed2", h.host.last.request.url)
    assertEquals(3, h.host.opened.size)
    // Removing a channel closes it.
    h.controller.update(mapOf("feed" to feed.copy(url = "https://e.com/feed2")))
    assertEquals(PrototypeChannelController.GOING_AWAY, chat.closedWith)
    assertNull(h.controller.state("chat"))
  }

  @Test
  fun `a patch keeps a disconnected or exhausted channel closed`() = runTest {
    val h = Harness(this)
    val failing = websocket.copy(maxAttempts = 0)
    h.controller.update(mapOf("chat" to websocket, "once" to failing))
    h.controller.show()
    h.controller.disconnect("chat")
    h.host.opened.last { it.request.channel == "once" }.listener.onClosed(1006, "", null)
    runCurrent()
    assertEquals("closed", h.sink.status("once"))
    val opens = h.host.opened.size
    h.controller.update(
      mapOf(
        "chat" to websocket.copy(url = "wss://example.com/other"),
        "once" to failing.copy(url = "wss://example.com/other"),
      ),
    )
    assertEquals(opens, h.host.opened.size)
    // A channel the patch adds still connects on show.
    h.controller.update(mapOf("added" to websocket))
    assertEquals("added", h.host.last.request.channel)
  }

  @Test
  fun `a patch drops routed frames still waiting for the flush`() = runTest {
    val h = Harness(this)
    val routed =
      channel(
        """{"kind":"websocket","url":"wss://e.com","routes":[
          {"actions":[{"type":"increment","key":"n"}]}]}""",
      )
    h.controller.update(mapOf("chat" to routed))
    h.controller.show()
    h.host.last.listener.onOpen(null)
    h.host.last.listener.onFrame("{}", null, null)
    runCurrent()
    h.controller.update(mapOf("chat" to routed.copy(url = "wss://e.com/v2")))
    settle()
    assertTrue(h.sink.runs.isEmpty())
  }

  private fun vectors(name: String): JsonObject {
    val file =
      generateSequence(File(System.getProperty("user.dir")).absoluteFile) { it.parentFile }
        .map { File(it, "test/fixtures/prototype-spec/realtime/$name") }
        .first { it.isFile }
    return Json.parseToJsonElement(file.readText()).jsonObject
  }

  private companion object {
    const val SETTLE_MS = 10 * 60 * 1000L
  }
}
