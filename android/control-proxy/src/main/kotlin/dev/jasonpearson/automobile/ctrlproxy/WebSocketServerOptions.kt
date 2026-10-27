package dev.jasonpearson.automobile.ctrlproxy

import android.os.Build
import dev.jasonpearson.automobile.protocol.WebSocketMessageHandler
import io.ktor.websocket.DefaultWebSocketSession
import io.ktor.websocket.Frame
import io.ktor.websocket.send
import java.net.InetSocketAddress
import java.net.ServerSocket

/** Transport policy, injected I/O seams, and connection lifecycle callbacks. */
data class WebSocketServerOptions(
  /** Type-safe inbound dispatcher; null for broadcast-only servers. */
  val messageHandler: WebSocketMessageHandler? = null,
  val onPermanentStartFailure: () -> Unit = {},
  val portAvailable: (Int) -> Boolean = { candidatePort ->
    if (candidatePort != 0) {
      ServerSocket().use { it.bind(InetSocketAddress("127.0.0.1", candidatePort)) }
    }
    true
  },
  val onRetryLockAcquired: () -> Unit = {},
  /** Test seam for a new request arriving as a prior terminal frame finishes enqueueing. */
  val onCorrelatedRoutingStep: () -> Unit = {},
  val sendFrame: suspend (DefaultWebSocketSession, String) -> Unit = { connection, message ->
    connection.send(Frame.Text(message))
  },
  val sdkInt: () -> Int = { Build.VERSION.SDK_INT },
  val sendTimeoutMs: Long = WebSocketServer.OUTBOUND_SEND_TIMEOUT_MS,
  /** Non-blocking queue cleanup, invoked after ownership removal outside the connections lock. */
  val onClientDisconnected: (WebSocketServer.ConnectedClient) -> Unit = {},
  /** Removal-time snapshot; a reconnect must not erase the zero-client edge before delivery. */
  val onClientCountChanged: (Int, Int) -> Unit = { _, _ -> },
  /**
   * Called once a client is registered, so state held back while no host was attached can go out.
   */
  val onClientConnected: () -> Unit = {},
  /** Per-request-type caps checked on the raw frame before it is decoded (#9935). */
  val inboundFrameLimits: InboundFrameLimits = InboundFrameLimits.DEFAULT,
  /**
   * A host's `prototype_response` (#12528) answers a `prototype_request` this device sent. It is
   * not a protocol request, so it is routed here before decoding rather than to
   * [WebSocketServerOptions.messageHandler].
   */
  val onPrototypeResponse: (String) -> Unit = {},
)
