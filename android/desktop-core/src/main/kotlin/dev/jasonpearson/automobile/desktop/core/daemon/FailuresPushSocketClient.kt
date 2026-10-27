package dev.jasonpearson.automobile.desktop.core.daemon

import dev.jasonpearson.automobile.desktop.core.connection.ConnectionState
import dev.jasonpearson.automobile.desktop.core.connection.isConnected
import dev.jasonpearson.automobile.desktop.core.connection.shouldReconnect
import dev.jasonpearson.automobile.desktop.core.logging.Logger
import dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory
import java.io.BufferedReader
import java.io.BufferedWriter
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.net.UnixDomainSocketAddress
import java.nio.channels.Channels
import java.nio.channels.SocketChannel
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import java.util.UUID
import java.util.concurrent.atomic.AtomicReference
import kotlin.math.min
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.runInterruptible
import kotlinx.serialization.Serializable
import kotlinx.serialization.serializer

/** Socket close must be idempotent because disconnect and read-loop cleanup can race. */
internal interface FailuresSocket : AutoCloseable {
  fun readLine(): String?

  fun writeLine(line: String)
}

internal fun interface FailuresRetryDelay {
  suspend fun wait(delayMs: Long)
}

internal data class FailuresPushSocketOptions(
  val sessionUuidProvider: (() -> String?)? = null,
  val jitter: () -> Double = { Math.random() },
  val socketPath: () -> String = { AutoMobileSocketPaths.socketPath("failures-push.sock") },
)

private class ChannelFailuresSocket(path: String) : FailuresSocket {
  private val channel = SocketChannel.open(UnixDomainSocketAddress.of(path))
  private val reader =
    BufferedReader(InputStreamReader(Channels.newInputStream(channel), StandardCharsets.UTF_8))
  private val writer =
    BufferedWriter(OutputStreamWriter(Channels.newOutputStream(channel), StandardCharsets.UTF_8))

  override fun readLine(): String? = reader.readLine()

  override fun writeLine(line: String) {
    writer.write(line)
    writer.newLine()
    writer.flush()
  }

  override fun close() = channel.close()
}

/**
 * Client for the failures push Unix socket server. Subscribes to receive real-time failure
 * notifications from the MCP server.
 *
 * Socket path: ~/.auto-mobile/failures-push.sock
 */
class FailuresPushSocketClient
internal constructor(
  private val openSocket: (String) -> FailuresSocket,
  private val retryDelay: FailuresRetryDelay,
  private val scope: CoroutineScope,
  private val socketAvailable: (String) -> Boolean,
  private val log: Logger = LoggerFactory.getLogger(FailuresPushSocketClient::class.java),
  internal val options: FailuresPushSocketOptions = FailuresPushSocketOptions(),
) {
  constructor(
    sessionUuidProvider: (() -> String?)? = null,
  ) : this(
    ::ChannelFailuresSocket,
    FailuresRetryDelay { delay(it) },
    CoroutineScope(SupervisorJob() + Dispatchers.IO),
    { Files.exists(Path.of(it)) },
    options = FailuresPushSocketOptions(sessionUuidProvider = sessionUuidProvider),
  )

  @Volatile private var sessionRejected = false

  private val json = DaemonJson
  private val socket = AtomicReference<FailuresSocket?>()
  private val connectionLock = Any()
  private val writer = FailuresSocketWriter(log)
  private var connectionGeneration = 0L
  private var connectionJob: Job? = null

  private val _state = MutableStateFlow<ConnectionState>(ConnectionState.Disconnected(null))
  val connectionState: StateFlow<ConnectionState> = _state.asStateFlow()

  private val _isConnected: Boolean
    get() = _state.value.isConnected

  private val _shouldReconnect: Boolean
    get() = _state.value.shouldReconnect

  // Retry configuration

  // Flow for live failure notifications
  private val _failureNotifications =
    MutableSharedFlow<FailureNotification>(
      replay = 1,
      extraBufferCapacity = 50,
      onBufferOverflow = kotlinx.coroutines.channels.BufferOverflow.DROP_OLDEST,
    )
  val failureNotifications: SharedFlow<FailureNotification> = _failureNotifications.asSharedFlow()

  /**
   * Connect to the failures push socket and subscribe to updates. Will retry with exponential
   * backoff if the socket is not available.
   *
   * @param type Optional failure type to filter by (crash, anr, tool_failure, nonfatal). Null = all
   *   types.
   * @param severity Optional severity to filter by (low, medium, high, critical). Null = all
   *   severities.
   */
  fun connect(type: String? = null, severity: String? = null) {
    synchronized(connectionLock) {
      if (
        sessionRejected ||
          (options.sessionUuidProvider != null && options.sessionUuidProvider.invoke() == null)
      )
        return
      if (_isConnected || connectionJob?.isActive == true) {
        log.info("Failures push connection already active")
        return
      }
      val generation = ++connectionGeneration
      _state.value = ConnectionState.Connecting
      connectionJob = scope.launch { connectWithRetry(type, severity, generation) }
    }
  }

  private suspend fun connectWithRetry(type: String?, severity: String?, generation: Long) {
    val socketPath = options.socketPath()
    var attempt = 0

    while (_shouldReconnect && !sessionRejected) {
      currentCoroutineContext().ensureActive()
      log.info("Connecting to failures push at $socketPath (attempt ${attempt + 1})")
      try {
        connectAndRead(type, severity, generation, socketPath) { attempt = 0 }
      } catch (e: CancellationException) {
        throw e
      } catch (e: java.io.IOException) {
        log.warn("Failures push connection failed: ${e.message}", e)
      } catch (e: SocketNotFoundError) {
        log.warn("Failures push connection failed: ${e.message}", e)
      } catch (e: IllegalStateException) {
        log.warn("Failures push connection failed: ${e.message}", e)
      }

      currentCoroutineContext().ensureActive()
      val delayMs: Long
      synchronized(connectionLock) {
        if (generation != connectionGeneration || sessionRejected || !_shouldReconnect) return
        attempt++
        delayMs = calculateFailuresBackoff(attempt, options.jitter)
        _state.value = ConnectionState.Reconnecting(attempt, delayMs)
      }
      retryDelay.wait(delayMs)
    }
  }

  private suspend fun connectAndRead(
    type: String?,
    severity: String?,
    generation: Long,
    socketPath: String,
    onHealthy: () -> Unit,
  ) {
    var currentSocket: FailuresSocket? = null
    try {

      if (!socketAvailable(socketPath)) {
        throw SocketNotFoundError("Socket not found at $socketPath")
      }
      val openedSocket = openSocket(socketPath)
      currentSocket = openedSocket
      currentCoroutineContext().ensureActive()
      synchronized(connectionLock) {
        // A disconnected or superseded attempt must never publish its late socket.
        if (generation != connectionGeneration) return
        socket.set(openedSocket)
        _state.value = ConnectionState.Connected(subscribed = false)
      }
      writer.subscribe(subscribeRequest(type, severity), openedSocket)
      synchronized(connectionLock) {
        if (generation != connectionGeneration) return
        _state.update { current ->
          if (current is ConnectionState.Connected) {
            current.copy(subscribed = true)
          } else {
            current
          }
        }
        log.info(
          "Subscribed to failures push (type: ${type ?: "all"}, severity: ${severity ?: "all"})",
        )
      }
      readMessages(openedSocket, generation) {
        // Accepting a socket is not healthy: reset only after a message is received.
        onHealthy()
      }
    } finally {
      cleanupConnection(currentSocket)
    }
  }

  private class SocketNotFoundError(message: String) : Exception(message)

  fun disconnect() {
    val previousState: ConnectionState
    val previousSocket: FailuresSocket?
    synchronized(connectionLock) {
      connectionGeneration++
      previousState = _state.value
      if (!sessionRejected) _state.value = ConnectionState.Disconnected(null)
      connectionJob?.cancel()
      connectionJob = null
      previousSocket = socket.getAndSet(null)
    }

    try {
      if (previousState is ConnectionState.Connected && previousState.subscribed) {
        val request =
          FailuresPushRequest(id = UUID.randomUUID().toString(), command = "unsubscribe")
        writer.sendRequestIfIdle(request, previousSocket)
      }
    } finally {
      cleanupConnection(previousSocket)
    }
  }

  fun isConnected(): Boolean = _isConnected

  /**
   * Disconnect and cancel the internal coroutine scope. After calling dispose(), this client
   * instance should not be reused.
   */
  fun dispose() {
    disconnect()
    scope.coroutineContext[Job]?.cancel()
  }

  private suspend fun readMessages(
    currentSocket: FailuresSocket,
    generation: Long,
    onHealthy: () -> Unit,
  ) {
    while (_isConnected && !sessionRejected) {
      // Inherit the injected scope's dispatcher; production uses IO, tests use virtual scheduling.
      val line = runInterruptible { currentSocket.readLine() } ?: return
      currentCoroutineContext().ensureActive()
      if (line.isBlank()) continue
      val needsPong =
        synchronized(connectionLock) {
          if (generation != connectionGeneration) return
          onHealthy()
          try {
            handleMessage(line)
          } catch (e: CancellationException) {
            throw e
          } catch (e: kotlinx.serialization.SerializationException) {
            log.warn("Failed to parse failures push message: ${e.message}", e)
            false
          }
        }
      if (needsPong) {
        synchronized(connectionLock) {
          if (generation != connectionGeneration) return
        }
        writer.sendPong(currentSocket)
      }
    }
  }

  private fun cleanupConnection(currentSocket: FailuresSocket?) {
    try {
      currentSocket?.close()
    } catch (e: CancellationException) {
      throw e
    } catch (e: java.io.IOException) {
      log.warn("Failed to close failures push socket: ${e.message}", e)
    } finally {
      socket.compareAndSet(currentSocket, null)
    }
  }

  private fun handleMessage(message: String): Boolean {
    val response = json.decodeFromString(serializer<FailuresPushResponse>(), message)

    when (response.type) {
      "subscription_response" -> {
        log.info("Failures push subscription response: success=${response.success}")
        if (response.success != true) {
          rejectSession(response.error)
          if (!sessionRejected) log.warn("Subscription failed: ${response.error}")
        }
      }
      "failure_push" -> {
        val data = response.data
        if (data != null) {
          log.info("Failure push received - type=${data.type}, title=${data.title}")
          _failureNotifications.tryEmit(data)
        }
      }
      "ping" -> {
        log.debug("Received ping, sending pong")
        return true
      }
      "error" -> {
        rejectSession(response.error)
        if (!sessionRejected) log.warn("Failures push error: ${response.error}")
      }
      else -> {
        log.warn("Unknown message type: ${response.type}")
      }
    }
    return false
  }

  private fun rejectSession(error: String?) {
    if (!sessionRejected && (error == "session_rejected" || isStreamSessionRejection(error))) {
      sessionRejected = true
      _state.value = ConnectionState.Error(error ?: "Session registration required")
      log.warn("Subscription failed: $error")
    }
  }
}

@Serializable
data class FailuresPushRequest(
  val id: String,
  val command: String,
  val type: String? = null,
  val severity: String? = null,
  val sessionUuid: String? = null,
)

@Serializable
data class FailuresPushResponse(
  val id: String? = null,
  val type: String,
  val success: Boolean? = null,
  val error: String? = null,
  val timestamp: Long? = null,
  val data: FailureNotification? = null,
)

@Serializable
data class FailureNotification(
  val occurrenceId: String,
  val groupId: String,
  val type: String, // "crash" | "anr" | "tool_failure" | "nonfatal"
  val severity: String, // "low" | "medium" | "high" | "critical"
  val title: String,
  val message: String,
  val timestamp: Long,
)

private const val INITIAL_RETRY_DELAY_MS = 1000L
private const val MAX_RETRY_DELAY_MS = 30000L

private fun calculateFailuresBackoff(attempt: Int, randomJitter: () -> Double): Long {
  // Exponential backoff with jitter
  val exponentialDelay = INITIAL_RETRY_DELAY_MS * (1L shl min(attempt - 1, 10))
  val cappedDelay = min(exponentialDelay, MAX_RETRY_DELAY_MS)
  // Add up to 10% jitter
  val jitter = (cappedDelay * 0.1 * randomJitter()).toLong()
  return cappedDelay + jitter
}

internal fun FailuresPushSocketClient.subscribeRequest(
  type: String?,
  severity: String?,
): FailuresPushRequest =
  FailuresPushRequest(
    id = UUID.randomUUID().toString(),
    command = "subscribe",
    type = type,
    severity = severity,
    sessionUuid = options.sessionUuidProvider?.invoke(),
  )
