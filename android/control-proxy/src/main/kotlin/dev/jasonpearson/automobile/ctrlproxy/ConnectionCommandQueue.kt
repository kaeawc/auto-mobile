package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.protocol.RequestCancelImeCommit
import dev.jasonpearson.automobile.protocol.WebSocketMessageHandler
import dev.jasonpearson.automobile.protocol.WebSocketRequest
import dev.jasonpearson.automobile.protocol.WebSocketResponse
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.supervisorScope

// Mirrors #8166's outbound ceiling: absorb gesture-move bursts behind a slow command, with a bound.
internal const val INBOUND_COMMAND_CAPACITY = 256

/** Successful unowned results retain ordinary server routing; only unowned failures fall back. */
internal enum class QueuedReplyRouting {
  OWNER,
  STANDARD,
  EXTERNAL_ERROR,
}

/**
 * One bounded FIFO and sequential worker per connection, on the injected dispatcher. Inline
 * delegate blocking calls and its remaining runBlocking bridges occupy that connection's IO worker,
 * never Ktor's read loop. Existing actions' service jobs and gesture callbacks retain their thread
 * requirements. Workers run concurrently; a child job isolates command cancellation from the loop.
 * Cancellation is cooperative: a blocking Android API must return before the worker can advance.
 *
 * [K] is independent of the connection's lifetime job so the key source can later change without
 * changing execution. Completion of the lifetime drops pending work and cancels the active child.
 * Delegate actions that launch service jobs retain their existing asynchronous completion
 * semantics.
 */
internal class ConnectionCommandQueue<K : Any>(
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

  private data class QueuedCommand(val request: WebSocketRequest, val ownerRecorded: Boolean)

  private class Connection(val lifetime: Job, capacity: Int) {
    val pending = Channel<QueuedCommand>(capacity)
    val started = AtomicBoolean()
    lateinit var worker: Job
  }

  private val connections = ConcurrentHashMap<K, Connection>()
  private val ownedErrors =
    CorrelatedErrorReporter(
      broadcastError = { reply(it.requestId, it, QueuedReplyRouting.OWNER) },
      logError = logError,
    )
  private val unownedErrors =
    CorrelatedErrorReporter(
      broadcastError = { reply(it.requestId, it, QueuedReplyRouting.EXTERNAL_ERROR) },
      logError = logError,
    )

  private fun errorsFor(command: QueuedCommand): CorrelatedErrorReporter =
    if (command.ownerRecorded) ownedErrors else unownedErrors

  internal val connectionCount: Int
    get() = connections.size

  /**
   * Never waits for queue space or for a command; the reply sink must also enqueue without waiting.
   */
  suspend fun enqueue(key: K, lifetime: Job, request: WebSocketRequest) {
    if (!lifetime.isActive) return
    // handleClientMessage registers ownership before dispatch. Snapshot here instead of copying
    // WebSocketServer.recordsRequestOwner's private type list. A disconnect between registration
    // and this snapshot can clear the owner and misclassify an owned request; passing the origin
    // and ownership policy into dispatch is the follow-up that closes this tiny race window.
    val command = QueuedCommand(request, request.requestId?.let(hasRequestOwner) == true)
    val connection = connections.computeIfAbsent(key) { createConnection(lifetime) }
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

  private fun createConnection(lifetime: Job): Connection {
    val connection = Connection(lifetime, capacity)
    connection.worker =
      scope.launch(dispatcher, start = CoroutineStart.LAZY) {
        for (command in connection.pending) runCommand(connection, command)
      }
    return connection
  }

  private fun startConnection(key: K, lifetime: Job, connection: Connection) {
    if (!connection.started.compareAndSet(false, true)) return
    // Install after map insertion: an already completed job invokes this callback immediately.
    val completion = lifetime.invokeOnCompletion {
      connection.pending.cancel()
      connection.worker.cancel()
      connections.remove(key, connection)
    }
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
    launch {
      currentCoroutineContext().ensureActive()
      if (!connection.lifetime.isActive) {
        logDebug("Skipping command for inactive connection: ${command.request.requestId}")
        return@launch
      }
      val requestId = command.request.requestId
      if (command.ownerRecorded && requestId != null && !hasRequestOwner(requestId)) {
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
          if (command.ownerRecorded) QueuedReplyRouting.OWNER else QueuedReplyRouting.STANDARD
        reply(request.requestId, response, routing)
      }
    }
  }
}

/**
 * Ktor's read-loop coroutine has a stable, unique Job per connection. This deliberate key-source
 * limitation is imposed by the current WebSocketMessageHandler contract: it receives no client. A
 * follow-up allowed to edit WebSocketServer need only replace this key source. A missing Job
 * retains inline behavior. IME cancellation bypasses ordering only to set the delegate's tombstone/
 * flag; it never cancels the command job or replies for the commit. The delegate owns the single
 * commit result and its partial-application counts. Gesture-end cancellation remains queued.
 */
internal class QueuedWebSocketMessageHandler(
  private val delegate: WebSocketMessageHandler,
  private val commands: ConnectionCommandQueue<Job>,
) : WebSocketMessageHandler {
  internal val connectionCount: Int
    get() = commands.connectionCount

  override suspend fun handleMessage(request: WebSocketRequest): WebSocketResponse? {
    val connection = currentCoroutineContext()[Job] ?: return delegate.handleMessage(request)
    if (request is RequestCancelImeCommit) {
      return delegate.handleMessage(request)
    }
    commands.enqueue(connection, connection, request)
    return null
  }
}
