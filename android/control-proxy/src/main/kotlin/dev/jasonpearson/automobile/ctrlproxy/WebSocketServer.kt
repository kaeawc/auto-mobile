package dev.jasonpearson.automobile.ctrlproxy

import android.util.Log
import dev.jasonpearson.automobile.ctrlproxy.perf.PerfProvider
import dev.jasonpearson.automobile.protocol.*
import dev.jasonpearson.automobile.protocol.WebSocketRequest as ProtocolRequest
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
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

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

    /**
     * Maximum accepted inbound WebSocket frame (64 MiB). ktor caps frame size by default;
     * `Long.MAX_VALUE` removed the ceiling so a single hostile frame advertising a multi-GB length
     * would be buffered into memory -> OutOfMemoryError, downing the runner. Cap it above any
     * legitimate command/hierarchy payload (issue #3711, the twin of iOS #3626).
     */
    internal const val MAX_FRAME_SIZE_BYTES: Long = 64L * 1024 * 1024

    /** Lenient parser for best-effort field extraction from a raw (possibly malformed) payload. */
    private val lenientJson = Json {
      ignoreUnknownKeys = true
      isLenient = true
    }

    /**
     * Best-effort extraction of a top-level string [field] from a raw JSON payload. Returns null
     * when the payload is unparseable, the field is absent, or the field is not a JSON string.
     */
    private fun extractStringField(raw: String, field: String): String? =
      try {
        (lenientJson.parseToJsonElement(raw) as? JsonObject)?.get(field)?.let { element ->
          (element as? JsonPrimitive)?.takeIf { it.isString }?.content
        }
      } catch (e: Exception) {
        // Expected for genuinely malformed payloads; correlation is best-effort by design.
        null
      }

    /** Substring every correlated frame carries and no `hierarchy_update`/event frame does. */
    private const val REQUEST_ID_TOKEN = "\"requestId\""

    /**
     * Cheap pre-check gating the full JSON parse in [extractRequestId]. The `hierarchy_update`
     * frame is the highest-frequency, largest payload in the system and provably carries no
     * `requestId` (see `recordsRequestOwner`), so gating on an `indexOf` lets those frames skip the
     * O(payload) `parseToJsonElement` + throwaway element-tree allocation entirely. See #5462.
     */
    internal fun mightCarryRequestId(raw: String): Boolean = raw.contains(REQUEST_ID_TOKEN)

    /**
     * Best-effort extraction of `requestId` from a raw JSON payload for error correlation,
     * mirroring the iOS runner's `extractRequestId`. Returns null when it can't be determined.
     * Short-circuits without parsing when the payload cannot contain a `requestId`.
     * See #2985, #5462.
     */
    internal fun extractRequestId(raw: String): String? =
      if (mightCarryRequestId(raw)) extractStringField(raw, "requestId") else null

    /**
     * `requestId` read directly off a typed [response], avoiding the encode→parse round-trip the
     * raw-string [extractRequestId] path pays. Exhaustive over the sealed hierarchy so a newly
     * added correlated response type fails to compile until it is wired in here (mirrors what
     * `sendErrorResponse` reads off `ErrorResponse` directly). See #5462.
     */
    internal fun correlationRequestId(response: WebSocketResponse): String? =
      when (response) {
        is ErrorResponse -> response.requestId
        is ScreenshotResult -> response.requestId
        is ScreenshotErrorResult -> response.requestId
        is SwipeResult -> response.requestId
        is TapCoordinatesResult -> response.requestId
        is DragResult -> response.requestId
        is PinchResult -> response.requestId
        is SetTextResult -> response.requestId
        is ImeActionResult -> response.requestId
        is SelectAllResult -> response.requestId
        is ActionResult -> response.requestId
        is ClipboardResult -> response.requestId
        is SettingsGetResult -> response.requestId
        is SettingsPutResult -> response.requestId
        is SettingsListResult -> response.requestId
        is CaCertResult -> response.requestId
        is DeviceOwnerStatusResult -> response.requestId
        is PermissionResult -> response.requestId
        is GlobalActionResult -> response.requestId
        is FrameContextValidationResult -> response.requestId
        is DeviceInfoResult -> response.requestId
        is CurrentFocusResult -> response.requestId
        is TraversalOrderResult -> response.requestId
        is HighlightResponse -> response.requestId
        is PreferenceFilesResult -> response.requestId
        is PreferencesResult -> response.requestId
        is SubscribeStorageResult -> response.requestId
        is UnsubscribeStorageResult -> response.requestId
        is GetPreferenceResult -> response.requestId
        is SetPreferenceResult -> response.requestId
        is RemovePreferenceResult -> response.requestId
        is ClearPreferencesResult -> response.requestId
        is InstalledPackagesResult -> response.requestId
        is PackageInfoResult -> response.requestId
        is LaunchIntentResult -> response.requestId
        // Uncorrelated event/status frames never echo a requestId.
        is ConnectedResponse,
        is HierarchyUpdateEvent,
        is InteractionEvent,
        is PackageEvent,
        is NavigationEventResponse,
        is HandledExceptionEvent,
        is NetworkEventResponse,
        is WebSocketFrameResponse,
        is LogEventResponse,
        is BroadcastEventResponse,
        is LifecycleEventResponse,
        is FrameMetricsEventResponse,
        is StorageChangedEvent,
        is CrashEvent,
        is AnrEvent -> null
      }

    /**
     * Maps an inbound-decode failure into an actionable, legible wire message. An unknown/
     * unregistered command type surfaces "Unknown command type: <type>" (symmetric to the iOS
     * `CommandError.unknownCommand` contract); everything else surfaces "Malformed request:
     * <cause>" so an out-of-range numeric literal or a JSON syntax error is actionable rather than
     * opaque. See #2985 (parallels the iOS #2965 legibility mapping).
     */
    internal fun describeDecodeFailure(raw: String, throwable: Throwable): String {
      val cause =
        throwable.message?.takeIf { it.isNotBlank() }
          ?: throwable::class.simpleName
          ?: "unknown error"
      val looksLikeUnknownType =
        cause.contains("polymorphic", ignoreCase = true) ||
          cause.contains("class discriminator", ignoreCase = true)
      if (looksLikeUnknownType) {
        extractStringField(raw, "type")?.let { type ->
          return "Unknown command type: $type"
        }
      }
      val looksLikeOutOfRangeNumber =
        cause.contains("special floating-point value", ignoreCase = true) ||
          cause.contains("non-finite floating point", ignoreCase = true) ||
          cause.contains("does not conform JSON specification", ignoreCase = true)
      if (looksLikeOutOfRangeNumber) {
        return "Malformed request: a numeric value is out of range or not representable."
      }
      return "Malformed request: $cause"
    }
  }

  private var server: EmbeddedServer<*, *>? = null
  private val connections = mutableSetOf<DefaultWebSocketSession>()
  private val requestConnections = mutableMapOf<String, DefaultWebSocketSession>()
  private val connectionCount = AtomicInteger(0)
  private val firstClientConnection = CompletableDeferred<Unit>()
  private var activeClientConnection = CompletableDeferred<Unit>()

  /**
   * Observer-session generation: bumped ONLY on the empty→non-empty edge (the first client of a new
   * session connecting after the observer set was empty), never when a second/third concurrent
   * client joins. Guarded by the same `connections` monitor as every add/remove, so the 0→1 check
   * reads a consistent size. See [observerSessionGeneration].
   */
  private var observerSessionGen = 0

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
        // CtrlProxy is reached exclusively through adb forward. Binding loopback
        // prevents the accessibility-control endpoint from being exposed to the
        // device LAN when the runner is installed on a physical device.
        embeddedServer(CIO, host = "127.0.0.1", port = port) {
            install(WebSockets) {
              pingPeriod = 15.seconds
              timeout = 60.seconds
              maxFrameSize = MAX_FRAME_SIZE_BYTES
              masking = false
            }

            install(ContentNegotiation) { json(json) }

            routing {
              webSocket("/ws") {
                val connectionId = connectionCount.incrementAndGet()
                Log.d(TAG, "Client #$connectionId connected")

                try {
                  // Send connection greeting before registering for broadcasts
                  send(
                    Frame.Text(
                      responseJson.encodeToString(
                        WebSocketResponse.serializer(),
                        ConnectedResponse(
                          id = connectionId,
                          supportedCommands =
                            listOf(
                              "set_hierarchy_interval",
                              "node_selector_actions",
                              "request_activate_accessibility_link",
                            ),
                        ),
                      )
                    )
                  )

                  synchronized(connections) {
                    // Bump the observer-session generation only when this connection is the first
                    // of
                    // a new session (the set was empty before this add), NOT when a concurrent
                    // client joins an already-observed session. Checked against the pre-add size
                    // inside the same monitor that guards every add/remove.
                    if (connections.isEmpty()) {
                      observerSessionGen++
                    }
                    connections.add(this)
                    activeClientConnection.complete(Unit)
                  }
                  firstClientConnection.complete(Unit)

                  // Listen for incoming messages
                  for (frame in incoming) {
                    when (frame) {
                      is Frame.Text -> {
                        val text = frame.readText()
                        Log.d(TAG, "Received from client #$connectionId: $text")
                        handleClientMessage(text, this)
                      }
                      is Frame.Close -> {
                        Log.d(TAG, "Client #$connectionId closed connection")
                      }
                      else -> {
                        Log.d(TAG, "Received frame type: ${frame.frameType}")
                      }
                    }
                  }
                } catch (e: CancellationException) {
                  // Read loop is a coroutine: on scope shutdown, `incoming` / the inline
                  // `handleClientMessage` throw cancellation. Let it unwind (after `finally`)
                  // instead of logging a connection error and re-swallowing the rethrow
                  // handleClientMessage already performs (#3130).
                  throw e
                } catch (e: Exception) {
                  Log.e(TAG, "Error in WebSocket connection #$connectionId", e)
                } finally {
                  synchronized(connections) {
                    connections.remove(this)
                    requestConnections.values.removeAll { it == this }
                    if (connections.isEmpty()) {
                      activeClientConnection = CompletableDeferred()
                    }
                  }
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
            } catch (e: CancellationException) {
              // Let cooperative cancellation unwind cleanly rather than logging it as an error
              // (#3130).
              throw e
            } catch (e: Exception) {
              Log.e(TAG, "Error closing connection", e)
            }
          }
        }
        connections.clear()
        requestConnections.clear()
        activeClientConnection = CompletableDeferred()
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
    val target =
      extractRequestId(message)?.let { requestId ->
        synchronized(connections) { requestConnections.remove(requestId) }
      }
    if (target != null) {
      sendToClient(target, message)
      return
    }
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
    val target =
      extractRequestId(message)?.let { requestId ->
        synchronized(connections) { requestConnections.remove(requestId) }
      }
    if (target != null) {
      sendToClient(target, message)
      return
    }
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
    val target =
      extractRequestId(message)?.let { requestId ->
        synchronized(connections) { requestConnections.remove(requestId) }
      }
    if (target != null) {
      sendToClient(target, message)
      return
    }
    broadcastToClients(message)
  }

  // =============================================================================
  // Type-Safe Broadcast API (Protocol Types)
  // =============================================================================

  /** Broadcast mode for controlling message delivery. */
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
  suspend fun broadcast(
    response: WebSocketResponse,
    mode: BroadcastMode = BroadcastMode.Async,
    waitForClient: Boolean = false,
  ) {
    val message = responseJson.encodeToString(WebSocketResponse.serializer(), response)
    val requestId = correlationRequestId(response)
    val target =
      if (requestId != null) {
        synchronized(connections) { requestConnections.remove(requestId) }
      } else {
        null
      }
    if (target != null) {
      sendToClient(target, message)
      return
    }

    if (waitForClient) {
      broadcastToClientsWhenClientConnected(message)
    } else {
      when (mode) {
        BroadcastMode.Async -> _messageFlow.emit(message)
        BroadcastMode.Sync -> broadcastToClients(message)
      }
    }
  }

  /**
   * Broadcast a typed SdkEvent to all connected clients.
   *
   * @param event The SDK event to broadcast
   * @param mode Broadcast mode - Async (default) or Sync for ordering guarantees
   */
  suspend fun broadcast(
    event: SdkEvent,
    mode: BroadcastMode = BroadcastMode.Async,
    waitForClient: Boolean = false,
  ) {
    val message = responseJson.encodeToString(SdkEvent.serializer(), event)
    if (waitForClient) {
      broadcastToClientsWhenClientConnected(message)
    } else {
      when (mode) {
        BroadcastMode.Async -> _messageFlow.emit(message)
        BroadcastMode.Sync -> broadcastToClients(message)
      }
    }
  }

  /**
   * Sends only after at least one current client accepts the message.
   *
   * A client can disconnect after a caller observes it but before the send begins. Retrying from
   * the synchronized connection snapshot keeps queued SDK events available for a replacement.
   */
  private suspend fun broadcastToClientsWhenClientConnected(message: String) {
    while (!broadcastToClients(message)) {
      awaitClientConnection()
    }
  }

  /** Internal method to send message to all connected clients. */
  private suspend fun broadcastToClients(message: String): Boolean {
    val deadConnections = mutableListOf<DefaultWebSocketSession>()
    var delivered = false

    val currentConnections = synchronized(connections) { connections.toList() }
    currentConnections.forEach { connection ->
      try {
        connection.send(Frame.Text(message))
        delivered = true
      } catch (e: CancellationException) {
        // The broadcast collector is cancelled when `scope` shuts down mid-send; let it unwind
        // rather than mis-marking a live connection as dead and continuing the loop (#3130).
        throw e
      } catch (e: Exception) {
        Log.w(TAG, "Failed to send to connection, marking as dead", e)
        deadConnections.add(connection)
      }
    }

    // Remove dead connections
    if (deadConnections.isNotEmpty()) {
      synchronized(connections) {
        connections.removeAll(deadConnections.toSet())
        if (connections.isEmpty()) {
          activeClientConnection = CompletableDeferred()
        }
      }
      Log.d(TAG, "Removed ${deadConnections.size} dead connections. Active: ${connections.size}")
    }
    return delivered
  }

  /** Internal method to send a message to a single client connection. */
  private suspend fun sendToClient(connection: DefaultWebSocketSession, message: String) {
    try {
      connection.send(Frame.Text(message))
    } catch (e: CancellationException) {
      // Cooperative cancellation means `scope` is shutting down, not that the connection is
      // dead — rethrow so the caller unwinds instead of mis-marking a live connection (#3191).
      throw e
    } catch (e: Exception) {
      Log.w(TAG, "Failed to send to originating connection, marking as dead", e)
      synchronized(connections) {
        connections.remove(connection)
        requestConnections.values.removeAll { it == connection }
        if (connections.isEmpty()) {
          activeClientConnection = CompletableDeferred()
        }
      }
    }
  }

  /** Send a typed error response only to the client whose inbound message failed. */
  private suspend fun sendErrorResponse(
    connection: DefaultWebSocketSession,
    response: ErrorResponse,
  ) {
    val message = responseJson.encodeToString(WebSocketResponse.serializer(), response)
    response.requestId?.let { requestId ->
      synchronized(connections) { requestConnections.remove(requestId) }
    }
    sendToClient(connection, message)
  }

  /**
   * True when [request]'s normal completion echoes its `requestId` back over the wire so the owner
   * mapping recorded for it can later be cleared. Hierarchy requests are uncorrelated on success
   * (no requestId reaches the action layer or the `hierarchy_update` frame, and the stale-skip path
   * emits nothing), so recording them would leak until disconnect — see [handleClientMessage]
   * and #3190.
   */
  private fun recordsRequestOwner(request: ProtocolRequest): Boolean =
    when (request) {
      is RequestHierarchy,
      is RequestHierarchyIfStale -> false
      else -> true
    }

  /** Get the number of active connections */
  fun getConnectionCount(): Int {
    return synchronized(connections) { connections.size }
  }

  /**
   * Observer-session generation: a marker that is STABLE for as long as at least one client stays
   * continuously connected, and advances only after the observer set has emptied and a new client
   * arrives (the empty→non-empty edge). Unlike [getConnectionCount] (the live count, which returns
   * to 1 after a reconnect and so cannot distinguish a continuous client from a reconnected one),
   * and unlike a total-connections counter (which would also advance when a SECOND concurrent
   * client joins), this changes exactly once per observer session.
   *
   * Observers use it as a session marker to discard state accumulated under a previous session
   * after any disconnect — including one with no intervening activity (issue #5470) — while NOT
   * discarding a still-connected client's in-flight state when a concurrent client joins.
   */
  fun observerSessionGeneration(): Int = synchronized(connections) { observerSessionGen }

  /** Suspends until a client has completed the WebSocket handshake. */
  suspend fun awaitFirstClientConnection() {
    firstClientConnection.await()
  }

  /** Suspends until a client is currently connected, including after a reconnect. */
  suspend fun awaitClientConnection() {
    val connection =
      synchronized(connections) {
        if (connections.isEmpty()) activeClientConnection else null
      }
    connection?.await()
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
  private suspend fun handleClientMessage(message: String, connection: DefaultWebSocketSession) {
    val handler = messageHandler
    if (handler == null) {
      Log.w(TAG, "No message handler configured; ignoring inbound message: $message")
      return
    }

    val request =
      try {
        protocolJson.decodeFromString<ProtocolRequest>(message)
      } catch (e: CancellationException) {
        // `decodeFromString` is synchronous, so cooperative cancellation cannot arise here today;
        // rethrow anyway so this fn stays compliant with the auto-discovered suspend-fn scan
        // (#3191) if this try ever grows a suspend call.
        throw e
      } catch (e: Exception) {
        // Surface a structured error (correlated by best-effort requestId) rather than swallowing
        // the failure: a silent return leaves the daemon's awaiter hanging until timeout. See
        // #2985.
        Log.w(TAG, "Failed to parse client message: $message", e)
        sendErrorResponse(
          connection,
          CorrelatedErrorReporter.frame(
            requestId = extractRequestId(message),
            errorMessage = describeDecodeFailure(message, e),
          ),
        )
        return
      }

    Log.d(TAG, "Received ${request::class.simpleName} (requestId: ${request.requestId})")
    // Only record owner mappings for request types whose normal completion carries the same
    // requestId back over the wire (raw or typed responses route to and clear the entry).
    // Hierarchy requests are the exception: the action layer never
    // receives their requestId, the success `hierarchy_update` frame has no requestId, and the
    // stale-skip path emits no frame at all — so a recorded owner would never be cleared until the
    // WebSocket disconnects, recreating the long-lived-session leak and leaving a stale id
    // available
    // for later same-id error misrouting (#3190, follow-up to #3159). Their correlated error path
    // (a handler throw) still targets the originating connection directly via `sendErrorResponse`,
    // not this map, so skipping the record preserves PR #3159's targeted delivery.
    if (recordsRequestOwner(request)) {
      request.requestId?.let { requestId ->
        synchronized(connections) { requestConnections[requestId] = connection }
      }
    }
    // Dispatch inline on the WebSocket read loop (already a coroutine) rather than launching into
    // `scope`, so commands execute in wire order: a synchronous command such as
    // set_accessibility_flags fully applies before the next frame (e.g. a request_hierarchy that
    // must observe those flags) is dispatched. Long-running actions launch their own coroutines
    // inside the callbacks, so this does not block the read loop.
    try {
      val response = handler.handleMessage(request)
      if (response != null) {
        broadcast(response)
        request.requestId?.let { requestId ->
          synchronized(connections) { requestConnections.remove(requestId) }
        }
      }
    } catch (e: CancellationException) {
      // Never convert cooperative cancellation into an error frame — it means the read loop /
      // server scope is shutting down. Let it propagate so the coroutine unwinds cleanly.
      throw e
    } catch (e: Exception) {
      // Surface a structured error correlated by the decoded requestId instead of only logging, so
      // the awaiting client fails fast rather than timing out. See #2985.
      Log.e(TAG, "Error handling message via handler", e)
      sendErrorResponse(
        connection,
        CorrelatedErrorReporter.frame(
          requestId = request.requestId,
          errorMessage = "Handler error: ${CorrelatedErrorReporter.causeOf(e)}",
        ),
      )
    }
  }
}
