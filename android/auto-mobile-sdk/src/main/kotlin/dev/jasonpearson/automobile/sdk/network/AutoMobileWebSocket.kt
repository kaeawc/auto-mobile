package dev.jasonpearson.automobile.sdk.network

import dev.jasonpearson.automobile.protocol.SdkWebSocketFrameEvent
import dev.jasonpearson.automobile.protocol.WebSocketFrameDirection
import dev.jasonpearson.automobile.protocol.WebSocketFrameType
import dev.jasonpearson.automobile.sdk.events.SdkEventBuffer
import java.util.UUID
import okhttp3.Request
import okhttp3.WebSocket
import okio.ByteString

/** WebSocket decorator that observes and optionally gates outbound frames. */
internal class AutoMobileWebSocket(
  private val delegate: WebSocket,
  private val url: String,
  private val buffer: SdkEventBuffer,
  private val applicationId: String?,
  private val controller: WebSocketSendController?,
  private val connectionId: String = UUID.randomUUID().toString().take(8),
) : WebSocket {
  override fun request(): Request = delegate.request()

  override fun queueSize(): Long = delegate.queueSize()

  override fun send(text: String): Boolean {
    return send(WebSocketFrameType.TEXT, text.toByteArray(Charsets.UTF_8).size.toLong()) {
      delegate.send(text)
    }
  }

  override fun send(bytes: ByteString): Boolean {
    return send(WebSocketFrameType.BINARY, bytes.size.toLong()) { delegate.send(bytes) }
  }

  override fun close(code: Int, reason: String?): Boolean {
    recordFrame(
      WebSocketFrameDirection.SENT,
      WebSocketFrameType.CLOSE,
      reason?.toByteArray(Charsets.UTF_8)?.size?.toLong() ?: 0,
    )
    return delegate.close(code, reason)
  }

  override fun cancel() = delegate.cancel()

  private fun send(type: WebSocketFrameType, size: Long, action: () -> Boolean): Boolean {
    recordFrame(WebSocketFrameDirection.SENT, type, size)
    if (controller?.allow(type, size) == false) return false
    return action()
  }

  private fun recordFrame(
    direction: WebSocketFrameDirection,
    type: WebSocketFrameType,
    size: Long,
  ) {
    buffer.add(
      SdkWebSocketFrameEvent(
        timestamp = System.currentTimeMillis(),
        applicationId = applicationId,
        connectionId = connectionId,
        url = url,
        direction = direction,
        frameType = type,
        payloadSize = size,
      )
    )
  }
}
