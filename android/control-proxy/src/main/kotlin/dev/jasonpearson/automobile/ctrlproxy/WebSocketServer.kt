package dev.jasonpearson.automobile.ctrlproxy

import android.os.Build
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
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.util.concurrent.atomic.AtomicInteger
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
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
  private val onPermanentStartFailure: () -> Unit = {},
  private val portAvailable: (Int) -> Boolean = { candidatePort ->
    if (candidatePort != 0) {
      ServerSocket().use { it.bind(InetSocketAddress("127.0.0.1", candidatePort)) }
    }
    true
  },
  private val onRetryLockAcquired: () -> Unit = {},
  /** Test seam for a new request arriving as a prior terminal frame finishes enqueueing. */
  private val onCorrelatedRoutingStep: () -> Unit = {},
  private val sendFrame: suspend (DefaultWebSocketSession, String) -> Unit =
    { connection, message ->
      connection.send(Frame.Text(message))
    },
  private val sdkInt: () -> Int = { Build.VERSION.SDK_INT },
  private val sendTimeoutMs: Long = OUTBOUND_SEND_TIMEOUT_MS,
  /** Non-blocking queue cleanup, invoked after ownership removal outside the connections lock. */
  private val onClientDisconnected: (ConnectedClient) -> Unit = {},
) {
  companion object {
    private const val TAG = "WebSocketServer"
    private const val MAX_START_ATTEMPTS = 5
    private const val START_RETRY_BASE_DELAY_MS = 250L
    private const val CONNECTOR_RESOLVE_TIMEOUT_MS = 2_000L
    // Allow large hierarchy frames over adb forward, but expire before ktor's 60-second timeout.
    internal const val OUTBOUND_SEND_TIMEOUT_MS = 15_000L
    // Normal bound; bursts above it shed expendable frames before using the emergency reserve.
    internal const val OUTGOING_CAPACITY = 64
    // Four normal windows absorb short must-deliver bursts while bounding a stalled socket.
    internal const val OUTGOING_HARD_CEILING = 256
    private const val DROP_WARNING_INTERVAL = 32

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

    /** Log only the protocol type and length, never free-form request fields. */
    internal fun inboundFrameLogLine(connectionId: Int, raw: String): String {
      val type =
        extractStringField(raw, "type")?.takeIf { it.matches(Regex("[a-z_]+")) } ?: "unknown"
      return "Received from client #$connectionId: type=$type length=${raw.length}"
    }

    /** Substring every correlated frame carries; passive event frames omit it. */
    private const val REQUEST_ID_TOKEN = "\"requestId\""

    /**
     * Cheap pre-check gating the full JSON parse in [extractRequestId]. The `hierarchy_update`
     * passive frame is the highest-frequency, largest payload in the system and carries no
     * `requestId`, so gating on an `indexOf` lets those frames skip the O(payload)
     * `parseToJsonElement` + throwaway element-tree allocation entirely. See #5462.
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
        is CommitTextResult -> response.requestId
        is SetKeyboardProfileResult -> response.requestId
        is KeyboardProfileCatalogResult -> response.requestId
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
        is OverlayResult -> response.requestId
        is dev.jasonpearson.automobile.protocol.KeystoreDiscoveryResult -> response.requestId
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
        is HierarchyUpdateEvent -> response.requestId
        // Other event/status frames never echo a requestId.
        is ConnectedResponse,
        is OverlayEvent,
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

  internal fun supportedCommands(): List<String> = buildList {
    // The handler dispatches exhaustively over this sealed hierarchy, so its serializer is the
    // source of truth for every request type accepted by the wire decoder.
    val requestDescriptor = ProtocolRequest.serializer().descriptor
    val subtypeDescriptor =
      requestDescriptor.getElementDescriptor(requestDescriptor.getElementIndex("value"))
    for (index in 0 until subtypeDescriptor.elementsCount) {
      add(subtypeDescriptor.getElementDescriptor(index).serialName)
    }
    add("node_selector_actions")
    add("ime_key_events_v1")
    add("tap_double_v1")
    if (sdkInt() >= GestureDisplayRouting.DISPLAY_API) add("gesture_display_id_v1")
    add("full_command_set_v1")
    // Every response to a request carrying requestId echoes it, including hierarchy_update for
    // request_hierarchy. Unsolicited pushes remain id-less; older hosts ignore unknown flags.
    add("request_id_echo_v1")
  }

  @Volatile private var server: EmbeddedServer<*, *>? = null
  private val startLock = Any()
  private var startRetryJob: Job? = null
  private val connections = mutableSetOf<ConnectedClient>()
  private val requestConnections = mutableMapOf<String, ConnectedClient>()
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

  /** Small transport seam so a blocked socket can be exercised with a virtual-time fake. */
  internal interface ClientTransport {
    suspend fun send(message: String)

    suspend fun close(reason: CloseReason)
  }

  internal enum class OutgoingTier {
    DROPPABLE,
    COALESCIBLE,
    MUST_DELIVER,
  }

  internal data class OutgoingFrame(var message: String, val tier: OutgoingTier)

  /** Opaque client identity for disconnect hooks; transport state stays module-internal. */
  class ConnectedClient
  internal constructor(
    internal val id: Int,
    internal val transport: ClientTransport,
    internal val outgoing: Channel<OutgoingFrame>,
    internal val ready: Channel<Unit>,
  ) {
    // Permanent liveness tombstone; read-loop completion may lag an outbound disconnect.
    @Volatile internal var isConnected = true
    internal lateinit var sender: Job
    internal var pendingCount = 0
    internal var droppedCount = 0L
    internal var pendingDroppableCount = 0
    internal var pendingHierarchy: OutgoingFrame? = null
  }

  private suspend fun sendWithDeadline(send: suspend () -> Unit): Boolean =
    // Use the injected dispatcher for deadlines without replacing the caller's cancellation job.
    withContext(scope.coroutineContext.minusKey(Job)) {
      withTimeoutOrNull(sendTimeoutMs) {
        send()
        true
      } ?: false
    }

  internal fun registerClient(id: Int, transport: ClientTransport): ConnectedClient {
    val client =
      ConnectedClient(
        id,
        transport,
        Channel(OUTGOING_HARD_CEILING),
        Channel<Unit>(Channel.CONFLATED),
      )
    client.sender =
      scope.launch(start = CoroutineStart.LAZY) {
        try {
          for (ignored in client.ready) {
            while (true) {
              val frame =
                synchronized(connections) {
                  client.outgoing.tryReceive().getOrNull()?.also {
                    client.pendingCount--
                    if (it.tier == OutgoingTier.DROPPABLE) client.pendingDroppableCount--
                    if (it === client.pendingHierarchy) client.pendingHierarchy = null
                  }
                } ?: break
              if (!sendWithDeadline { transport.send(frame.message) }) {
                Log.w(TAG, "Client #$id send timed out after ${sendTimeoutMs}ms; disconnecting")
                disconnectClient(client, "Outbound send timed out")
                return@launch
              }
            }
          }
        } catch (e: CancellationException) {
          throw e
        } catch (e: Exception) {
          Log.w(TAG, "Client #$id send failed; disconnecting", e)
          disconnectClient(client, "Outbound send failed")
        }
      }
    synchronized(connections) {
      if (connections.isEmpty()) observerSessionGen++
      connections.add(client)
      activeClientConnection.complete(Unit)
    }
    firstClientConnection.complete(Unit)
    client.sender.start()
    return client
  }

  internal fun unregisterClient(client: ConnectedClient) {
    disconnectClient(client, "Connection closed", CloseReason.Codes.NORMAL)
  }

  private fun disconnectClient(
    client: ConnectedClient,
    reason: String,
    code: CloseReason.Codes = CloseReason.Codes.TRY_AGAIN_LATER,
  ) {
    val discarded =
      synchronized(connections) {
        if (!connections.remove(client)) null
        else {
          client.isConnected = false
          requestConnections.values.removeAll { it == client }
          if (connections.isEmpty()) activeClientConnection = CompletableDeferred()
          val count = client.pendingCount
          client.pendingCount = 0
          client.pendingDroppableCount = 0
          client.pendingHierarchy = null
          client.outgoing.cancel()
          client.ready.cancel()
          count
        }
      }
    if (discarded == null) return
    onClientDisconnected(client)
    Log.w(
      TAG,
      "Disconnecting client #${client.id}: $reason; discarded $discarded queued frames; shed ${client.droppedCount} frames total",
    )
    client.sender.cancel()
    scope.launch {
      try {
        client.transport.close(CloseReason(code, reason))
      } catch (e: CancellationException) {
        throw e
      } catch (e: Exception) {
        Log.w(TAG, "Failed to close client #${client.id}", e)
      }
    }
  }

  /** Start the WebSocket server */
  fun start() {
    synchronized(startLock) {
      if (server != null) {
        Log.w(TAG, "Server already running")
        return
      }

      // An explicit start replaces any pending internal retry budget.
      startRetryJob?.cancel()
      startRetryJob = null
      startRetryJob = scope.launch {
        synchronized(startLock) {
          if (!coroutineContext.isActive || server != null || tryStart()) return@launch
        }
        for (retry in 1 until MAX_START_ATTEMPTS) {
          delay(START_RETRY_BASE_DELAY_MS * (1L shl (retry - 1)))
          synchronized(startLock) {
            onRetryLockAcquired()
            if (!coroutineContext.isActive || server != null || tryStart()) return@launch
            if (retry == MAX_START_ATTEMPTS - 1) {
              Log.e(TAG, "WebSocket server failed to start after $MAX_START_ATTEMPTS attempts")
              onPermanentStartFailure()
            }
          }
        }
      }
    }
  }

  private fun tryStart(): Boolean {
    var startedServer: EmbeddedServer<*, *>? = null
    try {
      // CIO binds on an internal coroutine and reports an occupied port as an uncaught failure.
      // Detect the common occupied-port case before starting that coroutine.
      if (!portAvailable(port)) return false

      val candidate =
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
                  val greetingSent = sendWithDeadline {
                    send(
                      Frame.Text(
                        responseJson.encodeToString(
                          WebSocketResponse.serializer(),
                          ConnectedResponse(
                            id = connectionId,
                            supportedCommands = supportedCommands(),
                          ),
                        )
                      )
                    )
                  }
                  if (!greetingSent) {
                    Log.w(
                      TAG,
                      "Client #$connectionId greeting send timed out after ${sendTimeoutMs}ms; disconnecting",
                    )
                    // Abandon the unregistered session without another potentially blocked write.
                    cancel("Outbound greeting send timed out")
                    return@webSocket
                  }

                  val session = this
                  val client =
                    registerClient(
                      connectionId,
                      object : ClientTransport {
                        override suspend fun send(message: String) {
                          session.send(Frame.Text(message))
                        }

                        override suspend fun close(reason: CloseReason) {
                          session.close(reason)
                        }
                      },
                    )

                  try {
                    // Listen for incoming messages
                    for (frame in incoming) {
                      when (frame) {
                        is Frame.Text -> {
                          val text = frame.readText()
                          Log.d(TAG, inboundFrameLogLine(connectionId, text))
                          handleClientMessage(text, client)
                        }
                        is Frame.Close -> {
                          Log.d(TAG, "Client #$connectionId closed connection")
                        }
                        else -> {
                          Log.d(TAG, "Received frame type: ${frame.frameType}")
                        }
                      }
                    }
                  } finally {
                    unregisterClient(client)
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
      startedServer = candidate

      // CIO starts its accept loop asynchronously. Wait for the connector to resolve so a bind
      // failure is caught here, before this instance reports that it is listening.
      runBlocking {
        withTimeout(CONNECTOR_RESOLVE_TIMEOUT_MS) { candidate.engine.resolvedConnectors() }
      }
      server = candidate

      Log.i(TAG, "WebSocket server started on port $port")
      return true
    } catch (e: Exception) {
      Log.e(TAG, "Failed to start WebSocket server", e)
      try {
        startedServer?.stop(0, 0)
      } catch (stopError: Exception) {
        Log.e(TAG, "Failed to stop partially started WebSocket server", stopError)
      }
      server = null
      return false
    }
  }

  /** Stop the WebSocket server */
  fun stop() {
    try {
      synchronized(startLock) {
        startRetryJob?.cancel()
        startRetryJob = null
        val clients = synchronized(connections) { connections.toList() }
        clients.forEach {
          disconnectClient(it, "Server shutting down", CloseReason.Codes.GOING_AWAY)
        }

        server?.stop(1000, 2000)
        server = null
      }
      Log.i(TAG, "WebSocket server stopped")
    } catch (e: Exception) {
      Log.e(TAG, "Error stopping WebSocket server", e)
    }
  }

  /** Broadcast a message to all connected clients */
  suspend fun broadcast(message: String) {
    if (routeCorrelatedResponse(extractRequestId(message), message)) {
      return
    }
    broadcastToClients(message)
  }

  /**
   * Broadcast a message with perf timing data included. Flushes accumulated perf data and injects
   * it into the message.
   *
   * @param messageBuilder Function that takes optional perfTiming JsonElement and returns the
   *   complete message
   */
  suspend fun broadcastWithPerf(
    routeByRequestId: Boolean = true,
    messageBuilder: (perfTiming: JsonElement?) -> String,
  ) {
    val perfTiming = perfProvider.flush()
    val message = messageBuilder(perfTiming)
    if (routeByRequestId && routeCorrelatedResponse(extractRequestId(message), message)) {
      return
    }
    broadcastToClients(message)
  }

  /**
   * Enqueue a message for each client in broadcast order. Each client writes its own queue in
   * order, so a slow socket cannot hold up later broadcasts to other clients.
   *
   * @param messageBuilder Function that takes optional perfTiming JsonElement and returns the
   *   complete message
   */
  suspend fun broadcastWithPerfSync(
    routeByRequestId: Boolean = true,
    messageBuilder: (perfTiming: JsonElement?) -> String,
  ) {
    val perfTiming = perfProvider.flush()
    val message = messageBuilder(perfTiming)
    if (routeByRequestId && routeCorrelatedResponse(extractRequestId(message), message)) {
      return
    }
    broadcastToClients(message)
  }

  // =============================================================================
  // Type-Safe Broadcast API (Protocol Types)
  // =============================================================================

  /** Broadcast mode retained for callers; both modes enqueue in per-client wire order. */
  sealed interface BroadcastMode {
    /** Enqueue without waiting for a socket write. */
    data object Async : BroadcastMode

    /** Enqueue in call order without waiting for a socket write. */
    data object Sync : BroadcastMode
  }

  /**
   * Broadcast a typed WebSocketResponse to all connected clients.
   *
   * This is the preferred API for sending responses as it provides:
   * - Type safety via sealed class hierarchy
   * - Automatic JSON serialization
   * - Ordered per-client queuing for both broadcast modes
   *
   * @param response The typed response object to broadcast
   * @param mode Retained for callers; both modes enqueue without waiting for socket writes
   */
  suspend fun broadcast(
    response: WebSocketResponse,
    mode: BroadcastMode = BroadcastMode.Async,
    waitForClient: Boolean = false,
  ) {
    val message = responseJson.encodeToString(WebSocketResponse.serializer(), response)
    if (routeCorrelatedResponse(correlationRequestId(response), message)) {
      return
    }

    broadcastSerialized(message, mode, waitForClient)
  }

  /**
   * Broadcasts a response whose correlation ID was created outside this WebSocket server.
   *
   * Android broadcast commands do not originate from a socket, so their IDs have no entry in
   * [requestConnections]. Their responses must still reach the daemon that is awaiting the ID,
   * while ordinary orphaned WebSocket responses remain protected by [routeCorrelatedResponse].
   */
  suspend fun broadcastExternallyCorrelatedResponse(
    response: WebSocketResponse,
    mode: BroadcastMode = BroadcastMode.Async,
    waitForClient: Boolean = false,
  ) {
    val message = responseJson.encodeToString(WebSocketResponse.serializer(), response)
    broadcastSerialized(message, mode, waitForClient)
  }

  @Suppress("UNUSED_PARAMETER")
  private suspend fun broadcastSerialized(
    message: String,
    mode: BroadcastMode,
    waitForClient: Boolean,
  ) {
    if (waitForClient) {
      broadcastToClientsWhenClientConnected(message)
    } else {
      broadcastToClients(message)
    }
  }

  internal fun registerRequestOwner(requestId: String, connection: ConnectedClient) {
    synchronized(connections) {
      // A late read-loop dispatch must not restore ownership after disconnect cleared it.
      if (connections.contains(connection)) requestConnections[requestId] = connection
    }
  }

  internal fun hasRequestOwner(requestId: String): Boolean =
    synchronized(connections) { requestConnections.containsKey(requestId) }

  /** Releases a hierarchy owner after a broadcast success, stale skip, or cancellation. */
  internal fun releaseRequestOwner(requestId: String?) {
    if (requestId != null) {
      synchronized(connections) { requestConnections.remove(requestId) }
    }
  }

  /**
   * Sends a correlated response only to its originating client.
   *
   * A request owner is removed when the socket disconnects and when its first terminal response is
   * accepted into its outgoing queue. A later response with that request ID is therefore not an
   * event: broadcasting it could leak one client's screenshot or action result to every other
   * connected client.
   *
   * @return `true` when [requestId] was present and the frame was delivered or deliberately
   *   dropped; `false` for uncorrelated frames that the caller should broadcast normally.
   */
  internal fun routeCorrelatedResponse(requestId: String?, message: String): Boolean {
    if (requestId == null) {
      return false
    }
    // Registration cannot replace this owner between selection and enqueue. Once queued, a reused
    // ID may register and its response follows through the bounded per-client outgoing queue.
    var overflowed: ConnectedClient? = null
    synchronized(connections) {
      val target = requestConnections.remove(requestId)
      if (target == null) {
        Log.w(TAG, "Dropping response for disconnected or completed request $requestId")
      } else {
        if (connections.contains(target) && !enqueueForClient(target, outgoingFrame(message))) {
          overflowed = target
        }
        onCorrelatedRoutingStep()
      }
    }
    overflowed?.let { disconnectClient(it, "Outgoing buffer full") }
    return true
  }

  /**
   * Broadcast a typed SdkEvent to all connected clients.
   *
   * @param event The SDK event to broadcast
   * @param mode Retained for callers; both modes enqueue without waiting for socket writes
   */
  suspend fun broadcast(
    event: SdkEvent,
    mode: BroadcastMode = BroadcastMode.Async,
    waitForClient: Boolean = false,
  ) {
    val message = responseJson.encodeToString(SdkEvent.serializer(), event)
    broadcastSerialized(message, mode, waitForClient)
  }

  /** Wait for a live client to accept the event into its bounded outgoing queue. */
  private suspend fun broadcastToClientsWhenClientConnected(message: String) {
    while (!broadcastToClients(message)) {
      awaitClientConnection()
    }
  }

  private fun outgoingFrame(message: String): OutgoingFrame {
    // A request ID always wins over the frame type, including for future protocol additions.
    if (mightCarryRequestId(message)) return OutgoingFrame(message, OutgoingTier.MUST_DELIVER)
    // Our serializers emit type first. Read only that field, avoiding a full parse of large
    // hierarchy trees; fall back to structured parsing for other field orders.
    val type =
      if (message.startsWith("{\"type\":\""))
        message.substringAfter("{\"type\":\"").substringBefore('"')
      else extractStringField(message, "type")
    val tier =
      when (type) {
        "hierarchy_update" -> OutgoingTier.COALESCIBLE
        "log_event",
        "network_event",
        "websocket_frame_event",
        "broadcast_event",
        "lifecycle_event" -> OutgoingTier.DROPPABLE
        else -> OutgoingTier.MUST_DELIVER
      }
    return OutgoingFrame(message, tier)
  }

  /** Only called while holding [connections], including on the sender's dequeue path. */
  private fun enqueueForClient(client: ConnectedClient, frame: OutgoingFrame): Boolean {
    if (frame.tier == OutgoingTier.COALESCIBLE && client.pendingHierarchy != null) {
      client.pendingHierarchy?.message = frame.message
      recordShed(client)
      return true
    }
    if (client.pendingCount >= OUTGOING_CAPACITY && client.pendingDroppableCount > 0) {
      discardOldestDroppable(client)
      client.pendingCount--
      client.pendingDroppableCount--
      recordShed(client)
    }
    if (client.pendingCount == OUTGOING_HARD_CEILING) return false
    if (!client.outgoing.trySend(frame).isSuccess) return false
    client.pendingCount++
    if (frame.tier == OutgoingTier.DROPPABLE) client.pendingDroppableCount++
    if (frame.tier == OutgoingTier.COALESCIBLE) client.pendingHierarchy = frame
    client.ready.trySend(Unit)
    return true
  }

  /** Rotate the bounded channel under the connection lock to preserve every survivor's position. */
  private fun discardOldestDroppable(client: ConnectedClient) {
    var discarded = false
    repeat(client.pendingCount) {
      val pending = client.outgoing.tryReceive().getOrNull() ?: error("Outgoing count drift")
      if (!discarded && pending.tier == OutgoingTier.DROPPABLE) {
        discarded = true
      } else {
        check(client.outgoing.trySend(pending).isSuccess)
      }
    }
    check(discarded)
  }

  private fun recordShed(client: ConnectedClient) {
    client.droppedCount++
    // First loss is visible; sustained load reports only at 32-frame milestones.
    if (client.droppedCount == 1L || client.droppedCount % DROP_WARNING_INTERVAL == 0L) {
      Log.w(TAG, "Client #${client.id} shed ${client.droppedCount} queued frames total")
    }
  }

  /** A hard-full queue disconnects only its owner; other clients still accept the same frame. */
  private fun broadcastToClients(message: String): Boolean {
    val frame = outgoingFrame(message)
    val overflowed = mutableListOf<ConnectedClient>()
    var delivered = false
    synchronized(connections) {
      connections.forEach { client ->
        if (enqueueForClient(client, frame.copy())) delivered = true else overflowed.add(client)
      }
    }
    overflowed.forEach { disconnectClient(it, "Outgoing buffer full") }
    return delivered
  }

  /** Internal method to send a message to a single client connection. */
  internal fun sendToClient(connection: ConnectedClient, message: String) {
    val frame = outgoingFrame(message)
    val overflowed =
      synchronized(connections) {
        connections.contains(connection) && !enqueueForClient(connection, frame)
      }
    if (overflowed) disconnectClient(connection, "Outgoing buffer full")
  }

  /** Send a typed error response only to the client whose inbound message failed. */
  private suspend fun sendErrorResponse(
    connection: ConnectedClient,
    response: ErrorResponse,
  ) {
    val message = responseJson.encodeToString(WebSocketResponse.serializer(), response)
    response.requestId?.let { requestId ->
      synchronized(connections) { requestConnections.remove(requestId) }
    }
    sendToClient(connection, message)
  }

  /**
   * True when [request] retains an owner for terminal response routing. Hierarchy errors route to
   * the owner; hierarchy successes broadcast to all clients and explicitly release the owner, as do
   * stale skips and cancellations. Fire-and-forget settings / recording commands have no terminal
   * response, so recording them would leak until disconnect. See [handleClientMessage], #3190,
   * and #6621.
   */
  internal fun recordsRequestOwner(request: ProtocolRequest): Boolean =
    when (request) {
      is SetHierarchyInterval,
      is SetRecompositionTracking,
      is SetAccessibilityFlags,
      is SetNetworkMockRules,
      is SetNetworkErrorSimulation,
      is StartRecording,
      is StopRecording -> false
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
  internal suspend fun handleClientMessage(message: String, connection: ConnectedClient) {
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
    // Owned terminal replies route to and clear the entry. Hierarchy errors use that routing;
    // hierarchy successes broadcast to all clients and explicitly release the entry, as do stale
    // skips and cancellations. Fire-and-forget settings / recording commands retain no owner
    // (#3190, #6621); their handler errors and queue-full rejections target the origin directly.
    val recordsOwner = recordsRequestOwner(request)
    if (recordsOwner) {
      request.requestId?.let { requestId ->
        registerRequestOwner(requestId, connection)
      }
    }
    // The read loop enqueues; one per-client FIFO worker executes commands in wire order.
    // Owned replies retain atomic owner routing; unowned errors target this origin directly and
    // successful hierarchy frames and unowned responses retain ordinary broadcasting.
    val readLoopLifetime = currentCoroutineContext().job
    val origin =
      object : QueuedCommandOrigin {
        override val client = connection
        override val lifetime = readLoopLifetime
        override val ownerRecorded = recordsOwner

        override suspend fun sendError(response: ErrorResponse) =
          sendErrorResponse(connection, response)
      }
    try {
      val response = withContext(CommandOriginContext(origin)) { handler.handleMessage(request) }
      if (response != null) {
        broadcast(response)
        request.requestId?.let { requestId ->
          synchronized(connections) { requestConnections.remove(requestId) }
        }
      }
    } catch (e: CancellationException) {
      // Never convert cooperative cancellation into an error frame — it means the read loop /
      // server scope is shutting down. Let it propagate so the coroutine unwinds cleanly, after
      // releasing ownership for a handler that never completed (for example, an expired request).
      request.requestId?.let { requestId ->
        synchronized(connections) {
          if (requestConnections[requestId] == connection) requestConnections.remove(requestId)
        }
      }
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
