package dev.jasonpearson.automobile.sdk.network

import dev.jasonpearson.automobile.protocol.SdkEvent
import dev.jasonpearson.automobile.protocol.SdkWebSocketFrameEvent
import dev.jasonpearson.automobile.protocol.WebSocketFrameDirection
import dev.jasonpearson.automobile.protocol.WebSocketFrameType
import dev.jasonpearson.automobile.sdk.events.DropCounter
import dev.jasonpearson.automobile.sdk.events.DropReason
import dev.jasonpearson.automobile.sdk.events.SdkEventBuffer
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertSame
import kotlin.test.assertTrue
import okhttp3.Request
import okhttp3.WebSocket
import okio.ByteString
import okio.ByteString.Companion.encodeUtf8
import org.junit.After
import org.junit.Test

class AutoMobileWebSocketTest {
  private var bufferExecutor: ScheduledExecutorService? = null

  @After
  fun tearDown() {
    bufferExecutor?.shutdownNow()
  }

  private fun collectingBuffer(): Pair<SdkEventBuffer, MutableList<SdkEvent>> {
    val events = mutableListOf<SdkEvent>()
    val executor = Executors.newSingleThreadScheduledExecutor()
    val buffer =
      SdkEventBuffer(
        maxBufferSize = 1,
        flushIntervalMs = 60_000,
        onFlush = { events.addAll(it) },
        executor = executor,
      )
    bufferExecutor = executor
    return buffer to events
  }

  private fun drainDelivery() {
    bufferExecutor!!.submit {}.get(1, TimeUnit.SECONDS)
  }

  private fun throwingBuffer(): SdkEventBuffer {
    val buffer =
      SdkEventBuffer(
        onFlush = {},
        dropCounter =
          object : DropCounter {
            override fun increment(reason: DropReason, count: Int): Nothing =
              throw IllegalStateException("recording failed")

            override fun snapshot(): Map<DropReason, Long> = emptyMap()

            override fun reset() = Unit
          },
      )
    buffer.shutdown()
    return buffer
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

    drainDelivery()
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

    drainDelivery()
    val event = events.single() as SdkWebSocketFrameEvent
    assertEquals(WebSocketFrameType.BINARY, event.frameType)
    assertEquals(bytes.size.toLong(), event.payloadSize)
    assertEquals(listOf(bytes), delegate.binarySends)
    assertEquals(false, event.success)
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
    drainDelivery()
    val event = events.single() as SdkWebSocketFrameEvent
    assertEquals(WebSocketFrameDirection.SENT, event.direction)
    assertEquals(WebSocketFrameType.TEXT, event.frameType)
    assertEquals(false, event.success)
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
    drainDelivery()
    val event = events.single() as SdkWebSocketFrameEvent
    assertEquals(WebSocketFrameType.CLOSE, event.frameType)
    assertEquals(6L, event.payloadSize)
    assertEquals(true, event.success)
  }

  @Test
  fun `shared connection id correlates listener and websocket events`() {
    val (buffer, events) = collectingBuffer()
    val delegate = FakeWebSocket(sendResult = true)
    val connectionId = "shared-connection"
    val listener =
      AutoMobileWebSocketListener(
        delegate = object : okhttp3.WebSocketListener() {},
        url = "wss://x",
        buffer = buffer,
        connectionId = connectionId,
      )
    val webSocket =
      AutoMobileWebSocket(
        delegate,
        "wss://x",
        buffer,
        applicationId = null,
        controller = null,
        connectionId = connectionId,
      )

    listener.onMessage(delegate, "received")
    webSocket.send("sent")

    drainDelivery()
    assertEquals(
      listOf(connectionId, connectionId),
      events.map { (it as SdkWebSocketFrameEvent).connectionId },
    )
  }

  @Test
  fun `controller failure leaves send delegated exactly once`() {
    val (buffer, _) = collectingBuffer()
    val delegate = FakeWebSocket(sendResult = true)
    val webSocket =
      AutoMobileWebSocket(
        delegate,
        "wss://x",
        buffer,
        applicationId = null,
        controller =
          WebSocketSendController { _, _ -> throw IllegalStateException("control failed") },
        connectionId = "c1",
      )

    assertTrue(webSocket.send("sent"))
    assertEquals(listOf("sent"), delegate.textSends)
  }

  @Test
  fun `recording failures preserve successful send and close results`() {
    val buffer = throwingBuffer()
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

    assertTrue(webSocket.send("text"))
    assertTrue(webSocket.send("binary".encodeUtf8()))
    assertTrue(webSocket.close(1000, "bye"))
    assertEquals(listOf("text"), delegate.textSends)
    assertEquals(listOf("binary".encodeUtf8()), delegate.binarySends)
    assertEquals(listOf(1000 to ("bye" as String?)), delegate.closeCalls)
  }

  @Test
  fun `host WebSocket failures remain unchanged`() {
    val (buffer, _) = collectingBuffer()
    val failure = IllegalStateException("host failure")
    val delegate =
      FakeWebSocket(
        sendResult = true,
        sendFailure = failure,
        closeFailure = failure,
        cancelFailure = failure,
      )
    val webSocket =
      AutoMobileWebSocket(
        delegate,
        "wss://x",
        buffer,
        applicationId = null,
        controller = null,
        connectionId = "c1",
      )

    assertSame(failure, assertFailsWith<IllegalStateException> { webSocket.send("text") })
    assertSame(failure, assertFailsWith<IllegalStateException> { webSocket.close(1000, "bye") })
    assertSame(failure, assertFailsWith<IllegalStateException> { webSocket.cancel() })
    assertEquals(1, delegate.textSendCalls)
    assertEquals(1, delegate.closeCalls.size)
    assertEquals(1, delegate.cancelCalls)
  }

  private class FakeWebSocket(
    private val sendResult: Boolean,
    private val closeResult: Boolean = false,
    private val sendFailure: Exception? = null,
    private val closeFailure: Exception? = null,
    private val cancelFailure: Exception? = null,
  ) : WebSocket {
    val textSends = mutableListOf<String>()
    val binarySends = mutableListOf<ByteString>()
    val closeCalls = mutableListOf<Pair<Int, String?>>()
    var textSendCalls = 0
    var cancelCalls = 0

    override fun request(): Request = Request.Builder().url("https://fake").build()

    override fun queueSize(): Long = 0

    override fun send(text: String): Boolean {
      textSendCalls++
      textSends.add(text)
      sendFailure?.let { throw it }
      return sendResult
    }

    override fun send(bytes: ByteString): Boolean {
      binarySends.add(bytes)
      return sendResult
    }

    override fun close(code: Int, reason: String?): Boolean {
      closeCalls.add(code to reason)
      closeFailure?.let { throw it }
      return closeResult
    }

    override fun cancel() {
      cancelCalls++
      cancelFailure?.let { throw it }
    }
  }
}
