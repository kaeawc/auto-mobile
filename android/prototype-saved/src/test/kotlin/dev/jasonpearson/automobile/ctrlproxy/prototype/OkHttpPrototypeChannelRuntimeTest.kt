package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.PrototypeAction
import dev.jasonpearson.automobile.protocol.PrototypeChannel
import dev.jasonpearson.automobile.protocol.PrototypeChannelReconnect
import dev.jasonpearson.automobile.protocol.PrototypeFullscreenPlacement
import dev.jasonpearson.automobile.protocol.PrototypePlatformAction
import dev.jasonpearson.automobile.protocol.PrototypePlatformHandlers
import dev.jasonpearson.automobile.protocol.PrototypeRequires
import dev.jasonpearson.automobile.protocol.PrototypeScalar
import dev.jasonpearson.automobile.protocol.PrototypeSetStateAction
import dev.jasonpearson.automobile.protocol.PrototypeSpec
import dev.jasonpearson.automobile.protocol.PrototypeTextNode
import dev.jasonpearson.automobile.protocol.PrototypeWindow
import java.util.concurrent.Executors
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import kotlin.random.Random
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.OkHttpClient
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.BeforeClass
import org.junit.Test

/**
 * A runtime's `via: "device"` channels on the OkHttp transport, end to end against MockWebServer on
 * loopback: status, `platform.on` frames, sends from `onOpen`, and SSE resume.
 */
class OkHttpPrototypeChannelRuntimeTest {
  companion object {
    @JvmStatic
    @BeforeClass
    fun warm() {
      // Pay OkHttp, serializer and runtime initialization outside each measured test.
      with(OkHttpPrototypeChannelRuntimeTest()) {
        start()
        try {
          `a device websocket channel opens, sends from onOpen and lands echoed frames`()
        } finally {
          stop()
        }
      }
    }
  }

  /** Full jitter with no jitter: every reconnect is immediate, so the test waits on no timer. */
  private object NoJitter : Random() {
    override fun nextBits(bitCount: Int): Int = 0
  }

  private val server = MockWebServer()
  private val executor = Executors.newSingleThreadExecutor()
  private val scope = CoroutineScope(SupervisorJob() + executor.asCoroutineDispatcher())
  private val warnings = LinkedBlockingQueue<String>()
  private val permissivePolicy = PrototypeDestinationPolicy { _, _, _ ->
    PrototypeEgressDecision.Allow
  }

  @Before
  fun start() {
    server.start()
  }

  @After
  fun stop() {
    scope.cancel()
    executor.shutdownNow()
    server.close()
  }

  private fun obj(vararg pairs: Pair<String, JsonElement>) = JsonObject(mapOf(*pairs))

  private fun spec(channel: PrototypeChannel) =
    PrototypeSpec(
      "realtime-device",
      PrototypeWindow(PrototypeFullscreenPlacement()),
      state = mapOf("status" to PrototypeScalar.Text("idle"), "last" to PrototypeScalar.Text("")),
      root = PrototypeTextNode(text = "{state:last}"),
      requires = PrototypeRequires(platform = listOf("realtime")),
      channels = mapOf("chat" to channel),
      platform =
        PrototypePlatformHandlers(
          mapOf(
            "realtime.frame" to
              listOf<PrototypeAction>(
                PrototypeSetStateAction(
                  "last",
                  PrototypeScalar.Binding(obj("event" to JsonPrimitive("/data/text"))),
                ),
              ),
          ),
        ),
    )

  private fun runtime(spec: PrototypeSpec): PrototypeRuntime {
    val lock = Mutex()
    var seq = 0L
    var id = 0
    val transport =
      OkHttpPrototypeChannelTransport(OkHttpClient(), permissivePolicy, warn = { _, _ -> })
    return PrototypeRuntime(
        spec,
        nextSequence = { ++seq },
        requestScope = scope,
        exclusively = { block -> lock.withLock { block() } },
        newRequestId = { "id-${++id}" },
        warn = { warnings += it },
        realtime =
          PrototypeRealtimeConfig(
            PrototypeChannelTransports.forSavedPrototype(transport),
            NoJitter,
          ),
      )
      .also {
        it.startPlatformModules()
        runBlocking { it.shown() }
      }
  }

  private fun PrototypeRuntime.text(key: String) =
    (current.state[key] as? PrototypeScalar.Text)?.value

  private fun eventually(what: String, condition: () -> Boolean) {
    val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
    while (!condition()) {
      check(System.nanoTime() < deadline) { "Timed out waiting for $what; warnings=$warnings" }
      Thread.sleep(1)
    }
  }

  @Test
  fun `a device websocket channel opens, sends from onOpen and lands echoed frames`() {
    val received = LinkedBlockingQueue<String>()
    server.enqueue(
      MockResponse.Builder()
        .webSocketUpgrade(
          object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
              webSocket.send("""{"text":"hello"}""")
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
              received += text
              webSocket.send("""{"text":"echo:$text"}""")
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
              webSocket.close(code, null)
            }
          },
        )
        .build(),
    )
    val url = server.url("/chat").toString().replaceFirst("http", "ws")
    val send =
      PrototypePlatformAction(
        "realtime.send",
        mapOf(
          "channel" to obj("value" to JsonPrimitive("chat")),
          "body" to obj("value" to JsonPrimitive("ping")),
        ),
      )
    val runtime =
      runtime(
        spec(
          PrototypeChannel(
            kind = "websocket",
            url = url,
            via = PrototypeHttpClients.VIA_DEVICE,
            statusKey = "status",
            onOpen = listOf(send),
          ),
        ),
      )

    eventually("the echo") { runtime.text("last") == "echo:ping" }
    assertEquals("ping", received.poll(1, TimeUnit.SECONDS))
    assertEquals("open", runtime.text("status"))
    assertEquals(emptyList<String>(), warnings.toList())
    runtime.close()
  }

  @Test
  fun `a device sse channel reconnects with Last-Event-ID and lands the resumed event`() {
    server.enqueue(
      MockResponse.Builder()
        .setHeader("Content-Type", "text/event-stream")
        .body("id: 7\ndata: {\"text\":\"first\"}\n\n")
        .build(),
    )
    server.enqueue(
      MockResponse.Builder()
        .setHeader("Content-Type", "text/event-stream")
        .body("id: 8\ndata: {\"text\":\"resumed\"}\n\n")
        .build(),
    )
    val runtime =
      runtime(
        spec(
          PrototypeChannel(
            kind = "sse",
            url = server.url("/feed").toString(),
            via = PrototypeHttpClients.VIA_DEVICE,
            statusKey = "status",
            // One reconnect, so no further attempt waits on the drained server.
            reconnect =
              PrototypeChannelReconnect(maxAttempts = 1, initialDelayMs = 500, maxDelayMs = 500),
          ),
        ),
      )

    eventually("the resumed event") { runtime.text("last") == "resumed" }
    val first = checkNotNull(server.takeRequest(1, TimeUnit.SECONDS))
    val second = checkNotNull(server.takeRequest(1, TimeUnit.SECONDS))
    assertEquals(null, first.headers["Last-Event-ID"])
    assertEquals("7", second.headers["Last-Event-ID"])
    assertEquals(emptyList<String>(), warnings.toList())
    runtime.close()
  }

  @Test
  fun `a saved prototype refuses a host channel at once`() {
    val runtime =
      runtime(
        spec(
          PrototypeChannel(
            kind = "websocket",
            url = "wss://example.test/chat",
            statusKey = "status",
          ),
        ),
      )

    eventually("the refusal") {
      val chat = (runtime.current.platformState["realtime"] as? JsonObject)?.get("chat")
      val error = (chat as? JsonObject)?.get("error") as? JsonObject
      (error?.get("message") as? JsonPrimitive)?.content ==
        PrototypeChannelTransports.SAVED_HOST_UNAVAILABLE_MESSAGE
    }
    assertEquals(0, server.requestCount)
    runtime.close()
  }
}
