package dev.jasonpearson.automobile.ctrlproxy.prototype

import java.net.InetAddress
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.Dns
import okhttp3.OkHttpClient
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/** WebSocket upgrade, SSE stream and egress refusal for the `via: "device"` channel transport. */
class OkHttpPrototypeChannelTransportTest {
  private val server = MockWebServer()
  private val permissivePolicy = PrototypeDestinationPolicy { _, _, _ ->
    PrototypeEgressDecision.Allow
  }

  private sealed interface Seen {
    data class Open(val protocol: String?) : Seen

    data class Frame(val data: String, val event: String?, val id: String?) : Seen

    data class Closed(val code: Int?, val reason: String?, val error: PrototypeChannelError?) : Seen
  }

  private class Recorder : PrototypeChannelListener {
    val seen = LinkedBlockingQueue<Seen>()

    override fun onOpen(protocol: String?) {
      seen += Seen.Open(protocol)
    }

    override fun onFrame(data: String, event: String?, id: String?) {
      seen += Seen.Frame(data, event, id)
    }

    override fun onClosed(code: Int?, reason: String?, error: PrototypeChannelError?) {
      seen += Seen.Closed(code, reason, error)
    }

    fun next(): Seen = checkNotNull(seen.poll(5, TimeUnit.SECONDS)) { "No callback" }
  }

  /** Answers the client's close so MockWebServer can shut down. */
  private open class ServerSocket : WebSocketListener() {
    override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
      webSocket.close(code, null)
    }
  }

  @Before
  fun start() {
    server.start()
  }

  @After
  fun stop() {
    server.close()
  }

  private fun transport(
    policy: PrototypeDestinationPolicy = permissivePolicy,
    maxFrameBytes: Int = 65_536,
    client: OkHttpClient = OkHttpClient(),
    handshakeTimeoutMs: Long = OkHttpPrototypeChannelTransport.HANDSHAKE_TIMEOUT_MS,
  ) =
    OkHttpPrototypeChannelTransport(
      client,
      policy,
      maxFrameBytes,
      warn = { _, _ -> },
      handshakeTimeoutMs = handshakeTimeoutMs,
    )

  private fun request(
    kind: PrototypeChannelKind,
    url: String,
    protocols: List<String> = emptyList(),
    headers: Map<String, String> = emptyMap(),
    lastEventId: String? = null,
  ) = PrototypeChannelOpenRequest("c1", "proto", "chat", kind, url, protocols, headers, lastEventId)

  private fun wsUrl() = server.url("/chat").toString().replaceFirst("http", "ws")

  @Test
  fun `a websocket upgrade opens, receives and sends text frames`() {
    server.enqueue(
      MockResponse.Builder()
        .setHeader("Sec-WebSocket-Protocol", "chat.v1")
        .webSocketUpgrade(
          object : ServerSocket() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
              webSocket.send("hello")
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
              webSocket.send("echo:$text")
            }
          },
        )
        .build(),
    )
    val recorder = Recorder()
    val connection =
      transport()
        .open(
          request(
            PrototypeChannelKind.WEBSOCKET,
            wsUrl(),
            protocols = listOf("chat.v1"),
            headers = mapOf("Authorization" to "Bearer t"),
          ),
          recorder,
        )
    assertEquals(Seen.Open("chat.v1"), recorder.next())
    assertEquals(Seen.Frame("hello", null, null), recorder.next())
    assertTrue(connection.send("ping"))
    assertEquals(Seen.Frame("echo:ping", null, null), recorder.next())
    val upgrade = checkNotNull(server.takeRequest(2, TimeUnit.SECONDS))
    assertEquals("Bearer t", upgrade.headers["Authorization"])
    assertEquals("chat.v1", upgrade.headers["Sec-WebSocket-Protocol"])
    connection.close(1000, "")
    assertNull(
      "no callback after the caller closes",
      recorder.seen.poll(200, TimeUnit.MILLISECONDS),
    )
  }

  @Test
  fun `a refused upgrade is handshake_failed with the status`() {
    server.enqueue(MockResponse.Builder().code(403).build())
    val recorder = Recorder()
    transport().open(request(PrototypeChannelKind.WEBSOCKET, wsUrl()), recorder)
    val closed = recorder.next() as Seen.Closed
    assertEquals(PrototypeChannelError.HANDSHAKE_FAILED, closed.error?.code)
    assertEquals(403, closed.error?.status)
  }

  @Test
  fun `an upgrade redirect is not followed`() {
    server.enqueue(MockResponse.Builder().code(302).setHeader("Location", "/elsewhere").build())
    val recorder = Recorder()
    transport().open(request(PrototypeChannelKind.WEBSOCKET, wsUrl()), recorder)
    val closed = recorder.next() as Seen.Closed
    assertEquals(302, closed.error?.status)
    assertEquals(1, server.requestCount)
  }

  @Test
  fun `a websocket frame over the cap closes with too_large`() {
    server.enqueue(
      MockResponse.Builder()
        .webSocketUpgrade(
          object : ServerSocket() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
              webSocket.send("x".repeat(9))
            }
          },
        )
        .build(),
    )
    val recorder = Recorder()
    transport(maxFrameBytes = 8).open(request(PrototypeChannelKind.WEBSOCKET, wsUrl()), recorder)
    assertTrue(recorder.next() is Seen.Open)
    val closed = recorder.next() as Seen.Closed
    assertEquals(PrototypeChannelError.TOO_LARGE, closed.error?.code)
  }

  @Test
  fun `an sse stream delivers named events with ids and resumes from Last-Event-ID`() {
    server.enqueue(
      MockResponse.Builder()
        .setHeader("Content-Type", "text/event-stream")
        .body("id: 7\nevent: tick\ndata: {\"n\":1}\n\ndata: plain\n\n")
        .build(),
    )
    val recorder = Recorder()
    transport()
      .open(
        request(PrototypeChannelKind.SSE, server.url("/feed").toString(), lastEventId = "6"),
        recorder,
      )
    assertEquals(Seen.Open(null), recorder.next())
    assertEquals(Seen.Frame("{\"n\":1}", "tick", "7"), recorder.next())
    assertEquals(Seen.Frame("plain", null, "7"), recorder.next())
    assertEquals(Seen.Closed(null, null, null), recorder.next())
    val sent = checkNotNull(server.takeRequest(2, TimeUnit.SECONDS))
    assertEquals("6", sent.headers["Last-Event-ID"])
    assertEquals("text/event-stream", sent.headers["Accept"])
  }

  @Test
  fun `an sse answer that is not an event stream is handshake_failed`() {
    server.enqueue(MockResponse.Builder().setHeader("Content-Type", "text/plain").body("x").build())
    val recorder = Recorder()
    transport().open(request(PrototypeChannelKind.SSE, server.url("/feed").toString()), recorder)
    val closed = recorder.next() as Seen.Closed
    assertEquals(PrototypeChannelError.HANDSHAKE_FAILED, closed.error?.code)
    assertEquals(200, closed.error?.status)
  }

  @Test
  fun `the production policy refuses loopback and localhost before any I O`() {
    val production = transport(policy = PrototypeEgressPolicy())
    for (url in listOf(wsUrl(), "ws://localhost:${server.port}/chat")) {
      val recorder = Recorder()
      production.open(request(PrototypeChannelKind.WEBSOCKET, url), recorder)
      val closed = recorder.next() as Seen.Closed
      assertEquals(url, PrototypeChannelError.BLOCKED_DESTINATION, closed.error?.code)
    }
    val recorder = Recorder()
    production.open(request(PrototypeChannelKind.SSE, server.url("/feed").toString()), recorder)
    assertEquals(
      PrototypeChannelError.BLOCKED_DESTINATION,
      (recorder.next() as Seen.Closed).error?.code,
    )
    assertEquals(0, server.requestCount)
  }

  @Test
  fun `a resolved address the policy refuses is blocked_destination`() {
    val policy = PrototypeDestinationPolicy { _, _, addresses ->
      if (addresses.isEmpty()) PrototypeEgressDecision.Allow
      else PrototypeEgressDecision.Blocked("Blocked destination address")
    }
    val recorder = Recorder()
    val loopback = Dns { listOf(InetAddress.getByAddress(byteArrayOf(127, 0, 0, 1))) }
    transport(policy = policy, client = OkHttpClient.Builder().dns(loopback).build())
      .open(request(PrototypeChannelKind.WEBSOCKET, "ws://example.test:${server.port}/"), recorder)
    assertEquals(
      PrototypeChannelError.BLOCKED_DESTINATION,
      (recorder.next() as Seen.Closed).error?.code,
    )
    assertEquals(0, server.requestCount)
  }

  @Test
  fun `a malformed header is invalid_request`() {
    val recorder = Recorder()
    transport()
      .open(
        request(PrototypeChannelKind.WEBSOCKET, wsUrl(), headers = mapOf("Bad\n" to "x")),
        recorder,
      )
    assertEquals(
      PrototypeChannelError.INVALID_REQUEST,
      (recorder.next() as Seen.Closed).error?.code,
    )
  }

  @Test
  fun `a handshake that never answers times out`() {
    server.enqueue(MockResponse.Builder().headersDelay(2, TimeUnit.SECONDS).build())
    val recorder = Recorder()
    transport(handshakeTimeoutMs = 200)
      .open(request(PrototypeChannelKind.SSE, server.url("/feed").toString()), recorder)
    assertEquals("timeout", (recorder.next() as Seen.Closed).error?.code)
  }

  @Test
  fun `an open websocket outlives the handshake timeout`() {
    server.enqueue(
      MockResponse.Builder()
        .webSocketUpgrade(
          object : ServerSocket() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
              Thread {
                Thread.sleep(STREAM_DELAY_MS)
                webSocket.send("late")
              }
                .start()
            }
          },
        )
        .build(),
    )
    val recorder = Recorder()
    val connection =
      transport(handshakeTimeoutMs = OUTLIVED_HANDSHAKE_MS)
        .open(request(PrototypeChannelKind.WEBSOCKET, wsUrl()), recorder)
    assertTrue(recorder.next() is Seen.Open)
    assertEquals(Seen.Frame("late", null, null), recorder.next())
    connection.close(1000, "")
  }

  @Test
  fun `an open sse stream outlives the handshake timeout`() {
    server.enqueue(
      MockResponse.Builder()
        .setHeader("Content-Type", "text/event-stream")
        .bodyDelay(STREAM_DELAY_MS, TimeUnit.MILLISECONDS)
        .body("data: late\n\n")
        .build(),
    )
    val recorder = Recorder()
    transport(handshakeTimeoutMs = OUTLIVED_HANDSHAKE_MS)
      .open(request(PrototypeChannelKind.SSE, server.url("/feed").toString()), recorder)
    assertEquals(Seen.Open(null), recorder.next())
    assertEquals(Seen.Frame("late", null, null), recorder.next())
  }

  private companion object {
    /**
     * Generous enough that a loaded runner still upgrades in time; the stream then waits longer.
     */
    const val OUTLIVED_HANDSHAKE_MS = 1_000L
    const val STREAM_DELAY_MS = 1_500L
  }
}
