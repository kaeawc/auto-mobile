package dev.jasonpearson.automobile.ctrlproxy

import android.util.Log
import dev.jasonpearson.automobile.ctrlproxy.perf.PerfProvider
import dev.jasonpearson.automobile.protocol.SdkEvent
import dev.jasonpearson.automobile.protocol.WebSocketMessageHandler
import dev.jasonpearson.automobile.protocol.WebSocketResponse
import io.ktor.http.*
import io.ktor.serialization.kotlinx.json.*
import io.ktor.server.application.*
import io.ktor.server.cio.*
import io.ktor.server.engine.*
import io.ktor.server.plugins.contentnegotiation.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import io.ktor.server.websocket.*
import io.ktor.websocket.*
import java.util.concurrent.atomic.AtomicInteger
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import dev.jasonpearson.automobile.protocol.WebSocketRequest as ProtocolRequest

/**
 * WebSocket server that streams view hierarchy updates to connected clients and dispatches inbound
 * commands. Designed to work with adb port forwarding for MCP server communication.
 *
 * Inbound messages are decoded into the sealed [ProtocolRequest] hierarchy and dispatched through
 * the injected [messageHandler]. Callers that only broadcast (e.g. lifecycle tests) may omit it, in
 * which case inbound messages are ignored.
 */
class WebSocketServer(
    private val port: Int = 8765,
    private val scope: CoroutineScope,
    private val perfProvider: PerfProvider = PerfProvider.instance,
    /** Type-safe handler that receives decoded requests. When null, inbound messages are ignored. */
    private val messageHandler: WebSocketMessageHandler? = null,
) {
  companion object {
    private const val TAG = "WebSocketServer"
  }

  private var server: EmbeddedServer<*, *>? = null
  private val connections = mutableSetOf<DefaultWebSocketSession>()
  private val connectionCount = AtomicInteger(0)

  // Flow to broadcast messages to all connected clients
  private val _messageFlow = MutableSharedFlow<String>(replay = 0, extraBufferCapacity = 10)

  private val json = Json {
    prettyPrint = false
    ignoreUnknownKeys = true
  }

  /** JSON configuration for protocol sealed classes with polymorphic serialization */
  private val protocolJson = Json {
    prettyPrint = false
    ignoreUnknownKeys = true
    classDiscriminator = "type"
  }

  /** JSON for encoding responses */
  private val responseJson = Json {
    prettyPrint = false
    encodeDefaults = true
    classDiscriminator = "type"
  }

  /** Start the WebSocket server */
  fun start() {
    if (server != null) {
      Log.w(TAG, "Server already running")
      return
    }

    try {
      server =
          embeddedServer(CIO, port = port) {
                install(WebSockets) {
                  pingPeriod = 15.seconds
                  timeout = 60.seconds
                  maxFrameSize = Long.MAX_VALUE
                  masking = false
                }

                install(ContentNegotiation) { json(json) }

                routing {
                  webSocket("/ws") {
                    val connectionId = connectionCount.incrementAndGet()
                    Log.d(TAG, "Client #$connectionId connected")

                    try {
                      // Send connection greeting before registering for broadcasts
                      send(Frame.Text("""{"type":"connected","id":$connectionId}"""))

                      synchronized(connections) { connections.add(this) }

                      // Listen for incoming messages
                      for (frame in incoming) {
                        when (frame) {
                          is Frame.Text -> {
                            val text = frame.readText()
                            Log.d(TAG, "Received from client #$connectionId: $text")
                            handleClientMessage(text)
                          }
                          is Frame.Close -> {
                            Log.d(TAG, "Client #$connectionId closed connection")
                          }
                          else -> {
                            Log.d(TAG, "Received frame type: ${frame.frameType}")
                          }
                        }
                      }
                    } catch (e: Exception) {
                      Log.e(TAG, "Error in WebSocket connection #$connectionId", e)
                    } finally {
                      synchronized(connections) { connections.remove(this) }
                      Log.d(
                          TAG,
                          "Client #$connectionId disconnected. Active connections: ${connections.size}",
                      )
                    }
                  }

                  // Health check endpoint
                  get("/health") { call.respond(HttpStatusCode.OK, "OK") }
                }
              }
              .start(wait = false)

      // Launch coroutine to handle message broadcasting
      scope.launch {
        _messageFlow.asSharedFlow().collect { message -> broadcastToClients(message) }
      }

      Log.i(TAG, "WebSocket server started on port $port")
    } catch (e: Exception) {
      Log.e(TAG, "Failed to start WebSocket server", e)
      server = null
    }
  }

  /** Stop the WebSocket server */
  fun stop() {
    try {
      synchronized(connections) {
        connections.forEach { connection ->
          scope.launch {
            try {
              connection.close(CloseReason(CloseReason.Codes.GOING_AWAY, "Server shutting down"))
            } catch (e: Exception) {
              Log.e(TAG, "Error closing connection", e)
            }
          }
        }
        connections.clear()
      }

      server?.stop(1000, 2000)
      server = null
      Log.i(TAG, "WebSocket server stopped")
    } catch (e: Exception) {
      Log.e(TAG, "Error stopping WebSocket server", e)
    }
  }

  /** Broadcast a message to all connected clients */
  suspend fun broadcast(message: String) {
    _messageFlow.emit(message)
  }

  /**
   * Broadcast a message with perf timing data included. Flushes accumulated perf data and injects
   * it into the message.
   *
   * @param messageBuilder Function that takes optional perfTiming JsonElement and returns the
   *   complete message
   */
  suspend fun broadcastWithPerf(messageBuilder: (perfTiming: JsonElement?) -> String) {
    val perfTiming = perfProvider.flush()
    val message = messageBuilder(perfTiming)
    _messageFlow.emit(message)
  }

  /**
   * Broadcast a message synchronously (waits for delivery to all clients). Use this when message
   * ordering is critical (e.g., hierarchy update before set_text_result).
   *
   * @param messageBuilder Function that takes optional perfTiming JsonElement and returns the
   *   complete message
   */
  suspend fun broadcastWithPerfSync(messageBuilder: (perfTiming: JsonElement?) -> String) {
    val perfTiming = perfProvider.flush()
    val message = messageBuilder(perfTiming)
    broadcastToClients(message)
  }

  // =============================================================================
  // Type-Safe Broadcast API (Protocol Types)
  // =============================================================================

  /**
   * Broadcast mode for controlling message delivery.
   */
  sealed interface BroadcastMode {
    /** Async broadcast via SharedFlow - non-blocking, best for event-driven updates */
    data object Async : BroadcastMode

    /** Sync broadcast - waits for delivery, use when ordering is critical */
    data object Sync : BroadcastMode
  }

  /**
   * Broadcast a typed WebSocketResponse to all connected clients.
   *
   * This is the preferred API for sending responses as it provides:
   * - Type safety via sealed class hierarchy
   * - Automatic JSON serialization
   * - Unified sync/async control
   *
   * @param response The typed response object to broadcast
   * @param mode Broadcast mode - Async (default) or Sync for ordering guarantees
   */
  suspend fun broadcast(response: WebSocketResponse, mode: BroadcastMode = BroadcastMode.Async) {
    val message = responseJson.encodeToString(WebSocketResponse.serializer(), response)
    when (mode) {
      BroadcastMode.Async -> _messageFlow.emit(message)
      BroadcastMode.Sync -> broadcastToClients(message)
    }
  }

  /**
   * Broadcast a typed SdkEvent to all connected clients.
   *
   * @param event The SDK event to broadcast
   * @param mode Broadcast mode - Async (default) or Sync for ordering guarantees
   */
  suspend fun broadcast(event: SdkEvent, mode: BroadcastMode = BroadcastMode.Async) {
    val message = responseJson.encodeToString(SdkEvent.serializer(), event)
    when (mode) {
      BroadcastMode.Async -> _messageFlow.emit(message)
      BroadcastMode.Sync -> broadcastToClients(message)
    }
  }

  /** Internal method to send message to all connected clients */
  private suspend fun broadcastToClients(message: String) {
    val deadConnections = mutableListOf<DefaultWebSocketSession>()

    synchronized(connections) { connections.toList() }
        .forEach { connection ->
          try {
            connection.send(Frame.Text(message))
          } catch (e: Exception) {
            Log.w(TAG, "Failed to send to connection, marking as dead", e)
            deadConnections.add(connection)
          }
        }

    // Remove dead connections
    if (deadConnections.isNotEmpty()) {
      synchronized(connections) { connections.removeAll(deadConnections.toSet()) }
      Log.d(TAG, "Removed ${deadConnections.size} dead connections. Active: ${connections.size}")
    }
  }

  /** Get the number of active connections */
  fun getConnectionCount(): Int {
    return synchronized(connections) { connections.size }
  }

  /** Check if server is running */
  fun isRunning(): Boolean = server != null

  /**
   * Get the actual port the server is listening on. Useful when port 0 is specified to let the OS
   * assign an available port. Returns null if server is not running.
   */
  @Suppress("UNCHECKED_CAST")
  fun getActualPort(): Int? {
    val srv = server ?: return null
    return try {
      val engine = (srv as EmbeddedServer<CIOApplicationEngine, *>).engine
      runBlocking { engine.resolvedConnectors().firstOrNull()?.port ?: port }
    } catch (e: Exception) {
      Log.w(TAG, "Could not get actual port, returning configured port", e)
      port
    }
  }

  /** Handle an incoming client message by decoding it and dispatching via [messageHandler]. */
  private fun handleClientMessage(message: String) {
    val handler = messageHandler
    if (handler == null) {
      Log.w(TAG, "No message handler configured; ignoring inbound message: $message")
      return
    }

    val request =
        try {
          protocolJson.decodeFromString<ProtocolRequest>(message)
        } catch (e: Exception) {
          Log.w(TAG, "Failed to parse client message: $message", e)
          return
        }

    Log.d(TAG, "Received ${request::class.simpleName} (requestId: ${request.requestId})")
    scope.launch {
      try {
        val response = handler.handleMessage(request)
        if (response != null) {
          broadcast(response)
        }
      } catch (e: Exception) {
        Log.e(TAG, "Error handling message via handler", e)
      }
    }
  }
}
