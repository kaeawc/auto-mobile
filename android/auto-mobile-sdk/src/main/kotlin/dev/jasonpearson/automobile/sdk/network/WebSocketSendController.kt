package dev.jasonpearson.automobile.sdk.network

import dev.jasonpearson.automobile.protocol.WebSocketFrameType

/** Optional debug/test hook evaluated before an outbound WebSocket frame is sent. */
fun interface WebSocketSendController {
  /**
   * Returns whether the frame should be sent.
   *
   * Returning false blocks the application send and still records the attempted frame.
   */
  fun allow(type: WebSocketFrameType, payloadSize: Long): Boolean
}
