package dev.jasonpearson.automobile.sdk.network

import dev.jasonpearson.automobile.protocol.SdkEvent
import dev.jasonpearson.automobile.protocol.SdkWebSocketFrameEvent
import dev.jasonpearson.automobile.protocol.WebSocketFrameDirection
import dev.jasonpearson.automobile.protocol.WebSocketFrameType
import dev.jasonpearson.automobile.sdk.events.SdkEventBuffer
import java.util.concurrent.Executors
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import okhttp3.Request
import okhttp3.WebSocket
import okio.ByteString
import okio.ByteString.Companion.encodeUtf8
import org.junit.Test

class AutoMobileWebSocketTest {

  private fun collectingBuffer(): Pair<SdkEventBuffer, MutableList<SdkEvent>> {
    val events = mutableListOf<SdkEvent>()
    val buffer =
      SdkEventBuffer(
        maxBufferSize = 1,
        flushIntervalMs = 60_000,
        onFlush = { events.addAll(it) },
        executor = Executors.newSingleThreadScheduledExecutor(),
      )
    return buffer to events
  }

  @Test
  fun `captures outbound text with byte size and stable connection metadata`() {
    val (buffer, events) = collectingBuffer()
    val delegate = FakeWebSocket(sendResult = true)
    val webSocket =
      AutoMobileWebSocket(
        delegate = delegate,
        url = "wss://example.com/ws",
        buffer = buffer,
        applicationId = "com.example.app",
        controller = null,
        connectionId = "connection-1",
      )

    assertTrue(webSocket.send("hé"))

    val event = events.single() as SdkWebSocketFrameEvent
    assertEquals(WebSocketFrameDirection.SENT, event.direction)
    assertEquals(WebSocketFrameType.TEXT, event.frameType)
    assertEquals(3L, event.payloadSize)
    assertEquals("wss://example.com/ws", event.url)
    assertEquals("connection-1", event.connectionId)
    assertEquals("com.example.app", event.applicationId)
    assertEquals(listOf("hé"), delegate.textSends)
  }

  @Test
  fun `captures outbound binary and preserves delegate result`() {
    val (buffer, events) = collectingBuffer()
    val delegate = FakeWebSocket(sendResult = false)
    val webSocket =
      AutoMobileWebSocket(
        delegate,
        "wss://x",
        buffer,
        applicationId = null,
        controller = null,
        connectionId = "c1",
      )
    val bytes = "binary".encodeUtf8()

    assertFalse(webSocket.send(bytes))

    val event = events.single() as SdkWebSocketFrameEvent
    assertEquals(WebSocketFrameType.BINARY, event.frameType)
    assertEquals(bytes.size.toLong(), event.payloadSize)
    assertEquals(listOf(bytes), delegate.binarySends)
  }

  @Test
  fun `blocked send records attempted frame without calling delegate`() {
    val (buffer, events) = collectingBuffer()
    val delegate = FakeWebSocket(sendResult = true)
    val controller = WebSocketSendController { _, _ -> false }
    val webSocket =
      AutoMobileWebSocket(
        delegate,
        "wss://x",
        buffer,
        applicationId = null,
        controller = controller,
        connectionId = "c1",
      )

    assertFalse(webSocket.send("blocked"))

    assertTrue(delegate.textSends.isEmpty())
    val event = events.single() as SdkWebSocketFrameEvent
    assertEquals(WebSocketFrameDirection.SENT, event.direction)
    assertEquals(WebSocketFrameType.TEXT, event.frameType)
  }

  @Test
  fun `captures close and delegates close operation`() {
    val (buffer, events) = collectingBuffer()
    val delegate = FakeWebSocket(sendResult = true, closeResult = true)
    val webSocket =
      AutoMobileWebSocket(
        delegate,
        "wss://x",
        buffer,
        applicationId = null,
        controller = null,
        connectionId = "c1",
      )

    assertTrue(webSocket.close(1000, "adiós"))

    assertEquals(1000 to "adiós", delegate.closeCalls.single())
    val event = events.single() as SdkWebSocketFrameEvent
    assertEquals(WebSocketFrameType.CLOSE, event.frameType)
    assertEquals(6L, event.payloadSize)
  }

  private class FakeWebSocket(
    private val sendResult: Boolean,
    private val closeResult: Boolean = false,
  ) : WebSocket {
    val textSends = mutableListOf<String>()
    val binarySends = mutableListOf<ByteString>()
    val closeCalls = mutableListOf<Pair<Int, String?>>()

    override fun request(): Request = Request.Builder().url("https://fake").build()

    override fun queueSize(): Long = 0

    override fun send(text: String): Boolean {
      textSends.add(text)
      return sendResult
    }

    override fun send(bytes: ByteString): Boolean {
      binarySends.add(bytes)
      return sendResult
    }

    override fun close(code: Int, reason: String?): Boolean {
      closeCalls.add(code to reason)
      return closeResult
    }

    override fun cancel() {}
  }
}
