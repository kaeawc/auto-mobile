package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.protocol.ErrorResponse
import dev.jasonpearson.automobile.protocol.RequestCancelImeCommit
import dev.jasonpearson.automobile.protocol.WebSocketMessageHandler
import dev.jasonpearson.automobile.protocol.WebSocketRequest
import dev.jasonpearson.automobile.protocol.WebSocketResponse
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.coroutines.AbstractCoroutineContextElement
import kotlin.coroutines.CoroutineContext
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.ThreadContextElement
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.supervisorScope

// Mirrors #8166's outbound ceiling: absorb gesture-move bursts behind a slow command, with a bound.
internal const val INBOUND_COMMAND_CAPACITY = 256

/** Owned results use atomic owner routing; successful unowned results use ordinary broadcasting. */
internal enum class QueuedReplyRouting {
  OWNER,
  STANDARD,
}

/** Per-request dispatch facts supplied by the server, without changing the protocol handler. */
internal interface QueuedCommandOrigin {
  val client: WebSocketServer.ConnectedClient
  val lifetime: Job
  val ownerRecorded: Boolean

  suspend fun sendError(response: ErrorResponse)
}

internal class CommandOriginContext(val origin: QueuedCommandOrigin) :
  AbstractCoroutineContextElement(Key), ThreadContextElement<QueuedCommandOrigin?> {
  override fun updateThreadContext(context: CoroutineContext): QueuedCommandOrigin? {
    val previous = currentOrigin.get()
    currentOrigin.set(origin)
    return previous
  }

  override fun restoreThreadContext(context: CoroutineContext, oldState: QueuedCommandOrigin?) {
    currentOrigin.set(oldState)
  }

  companion object Key : CoroutineContext.Key<CommandOriginContext> {
    private val currentOrigin = ThreadLocal<QueuedCommandOrigin?>()

    fun currentClient(): WebSocketServer.ConnectedClient? = currentOrigin.get()?.client
  }
}

/**
 * One bounded FIFO and sequential worker per connection, on the injected dispatcher. Inline
 * delegate blocking calls and its remaining runBlocking bridges occupy that connection's IO worker,
 * never Ktor's read loop. Existing actions' service jobs and gesture callbacks retain their thread
 * requirements. Workers run concurrently; a child job isolates command cancellation from the loop.
 * Cancellation is cooperative: a blocking Android API must return before the worker can advance.
 *
 * Disconnect immediately drops pending work and cancels the active child. Lifetime completion
 * provides the same cleanup if the read loop exits first. Delegate actions that launch service jobs
 * retain their existing asynchronous completion semantics.
 */
internal class ConnectionCommandQueue(
  private val scope: CoroutineScope,
  private val dispatcher: CoroutineDispatcher,
  private val delegate: WebSocketMessageHandler,
  private val reply: suspend (String?, WebSocketResponse, QueuedReplyRouting) -> Unit,
  private val hasRequestOwner: (String) -> Boolean,
  private val logError: (String, Throwable) -> Unit,
  private val logWarning: (String) -> Unit,
  private val logDebug: (String) -> Unit,
  private val capacity: Int = INBOUND_COMMAND_CAPACITY,
) {
  init {
    require(capacity > 0) { "Command capacity must be positive" }
  }

  private data class QueuedCommand(val request: WebSocketRequest, val origin: QueuedCommandOrigin)

  private class Connection(val lifetime: Job, capacity: Int) {
    val pending = Channel<QueuedCommand>(capacity)
    val started = AtomicBoolean()
    lateinit var worker: Job
  }

  private val connections = ConcurrentHashMap<WebSocketServer.ConnectedClient, Connection>()
  private val ownedErrors =
    CorrelatedErrorReporter(
      broadcastError = { reply(it.requestId, it, QueuedReplyRouting.OWNER) },
      logError = logError,
    )

  private fun errorsFor(command: QueuedCommand): CorrelatedErrorReporter =
    if (command.origin.ownerRecorded) ownedErrors
    else CorrelatedErrorReporter(command.origin::sendError, logError)

  internal val connectionCount: Int
    get() = connections.size

  /**
   * Never waits for queue space or for a command; the reply sink must also enqueue without waiting.
   */
  suspend fun enqueue(origin: QueuedCommandOrigin, request: WebSocketRequest) {
    val key = origin.client
    val lifetime = origin.lifetime
    if (!key.isConnected || !lifetime.isActive) return
    val command = QueuedCommand(request, origin)
    // Serialize creation with disconnect's map removal. The client flag is a permanent tombstone,
    // so a late read-loop dispatch cannot recreate a worker even while its Job remains active.
    val connection =
      connections.compute(key) { _, existing ->
        existing ?: if (key.isConnected && lifetime.isActive) createConnection(lifetime) else null
      } ?: return
    startConnection(key, lifetime, connection)
    val result = connection.pending.trySend(command)
    if (result.isFailure && !result.isClosed) {
      val message = "ctrlproxy_busy: command queue full ($capacity pending); retry"
      logWarning("$message (requestId: ${request.requestId})")
      request.requestId?.let { requestId ->
        errorsFor(command).emit(requestId, message) { "Failed to report full command queue" }
      }
    }
  }

  /** Non-blocking and idempotent with lifetime/worker completion, in either order. */
  fun disconnect(key: WebSocketServer.ConnectedClient) {
    key.isConnected = false
    connections.remove(key)?.let { connection ->
      connection.pending.cancel()
      connection.worker.cancel()
    }
  }

  private fun createConnection(lifetime: Job): Connection {
    val connection = Connection(lifetime, capacity)
    connection.worker =
      scope.launch(dispatcher, start = CoroutineStart.LAZY) {
        for (command in connection.pending) runCommand(connection, command)
      }
    return connection
  }

  private fun startConnection(
    key: WebSocketServer.ConnectedClient,
    lifetime: Job,
    connection: Connection,
  ) {
    if (!connection.started.compareAndSet(false, true)) return
    // Install after map insertion: an already completed job invokes this callback immediately.
    val completion = lifetime.invokeOnCompletion { disconnect(key) }
    connection.worker.invokeOnCompletion {
      completion.dispose()
      connection.pending.cancel()
      connections.remove(key, connection)
    }
    connection.worker.start()
  }

  private suspend fun runCommand(connection: Connection, command: QueuedCommand) = supervisorScope {
    // Keep cooperative delegate cancellation isolated from the sequential worker. Check inside
    // the child, immediately before dispatch, even if lifetime completion has not run its hook.
    launch(CommandOriginContext(command.origin)) {
        currentCoroutineContext().ensureActive()
        if (!command.origin.client.isConnected || !connection.lifetime.isActive) {
          logDebug("Skipping command for inactive connection: ${command.request.requestId}")
          return@launch
        }
        val requestId = command.request.requestId
        if (command.origin.ownerRecorded && requestId != null && !hasRequestOwner(requestId)) {
          logDebug("Skipping command for disconnected owner: $requestId")
          return@launch
        }
        dispatch(command)
      }
      .join()
  }

  private suspend fun dispatch(command: QueuedCommand) {
    val request = command.request
    errorsFor(command).guarding(
      requestId = request.requestId,
      failureLogMessage = { "Error handling message via queued handler" },
      errorMessagePrefix = { "Handler error" },
      doubleFailureLogMessage = { "Failed to report queued handler error" },
    ) {
      val response = delegate.handleMessage(request)
      currentCoroutineContext().ensureActive()
      if (response != null) {
        val routing =
          if (command.origin.ownerRecorded) QueuedReplyRouting.OWNER
          else QueuedReplyRouting.STANDARD
        reply(request.requestId, response, routing)
      }
    }
  }
}

/**
 * The server supplies a client and immutable ownership decision through [CommandOriginContext].
 * Calls without an origin are programming errors: inline execution would bypass ordering and
 * targeted error delivery. IME cancellation bypasses ordering only to set the delegate's tombstone/
 * flag; it never cancels the command job or replies for the commit. The delegate owns the single
 * commit result and its partial-application counts. Gesture-end cancellation remains queued.
 */
internal class QueuedWebSocketMessageHandler(
  private val delegate: WebSocketMessageHandler,
  private val commands: ConnectionCommandQueue,
) : WebSocketMessageHandler {
  internal val connectionCount: Int
    get() = commands.connectionCount

  fun disconnect(client: WebSocketServer.ConnectedClient) = commands.disconnect(client)

  override suspend fun handleMessage(request: WebSocketRequest): WebSocketResponse? {
    val origin =
      checkNotNull(currentCoroutineContext()[CommandOriginContext]) {
          "Queued WebSocket dispatch requires an originating client"
        }
        .origin
    if (!origin.client.isConnected || !origin.lifetime.isActive) return null
    if (request is RequestCancelImeCommit) {
      delegate.handleMessage(request)
      return null
    }
    commands.enqueue(origin, request)
    return null
  }
}
