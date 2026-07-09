package dev.jasonpearson.automobile.desktop.core.daemon

import dev.jasonpearson.automobile.desktop.core.connection.ConnectionState
import dev.jasonpearson.automobile.desktop.core.connection.isConnected
import dev.jasonpearson.automobile.desktop.core.connection.shouldReconnect
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
import kotlin.math.min
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * Client for the failures push Unix socket server. Subscribes to receive real-time failure
 * notifications from the MCP server.
 *
 * Socket path: ~/.auto-mobile/failures-push.sock
 */
class FailuresPushSocketClient {
  companion object {
    private fun getSocketPath(): String {
      return "${System.getProperty("user.home")}/.auto-mobile/failures-push.sock"
    }
  }

  private val log = LoggerFactory.getLogger(FailuresPushSocketClient::class.java)
  private val json = Json { ignoreUnknownKeys = true }
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

  private var channel: SocketChannel? = null
  private var reader: BufferedReader? = null
  private var writer: BufferedWriter? = null
  private var connectionJob: Job? = null

  private val _state = MutableStateFlow<ConnectionState>(ConnectionState.Disconnected(null))
  val connectionState: StateFlow<ConnectionState> = _state.asStateFlow()

  private val _isConnected: Boolean
    get() = _state.value.isConnected

  private val _shouldReconnect: Boolean
    get() = _state.value.shouldReconnect

  // Retry configuration
  private val initialRetryDelayMs = 1000L
  private val maxRetryDelayMs = 30000L

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
    if (_isConnected) {
      log.info("Already connected to failures push")
      return
    }

    // Cancel any existing connection job
    connectionJob?.cancel()
    _state.update { ConnectionState.Connecting }

    connectionJob = scope.launch {
      connectWithRetry(type, severity)
    }
  }

  private suspend fun connectWithRetry(type: String?, severity: String?) {
    val socketPath = getSocketPath()
    var attempt = 0

    while (_shouldReconnect) {
      log.info("Connecting to failures push at $socketPath (attempt ${attempt + 1})")

      try {
        val path = Path.of(socketPath)
        if (!Files.exists(path)) {
          throw SocketNotFoundError("Socket not found at $socketPath")
        }

        val address = UnixDomainSocketAddress.of(socketPath)
        channel = SocketChannel.open(address)
        reader =
          BufferedReader(
            InputStreamReader(Channels.newInputStream(channel!!), StandardCharsets.UTF_8)
          )
        writer =
          BufferedWriter(
            OutputStreamWriter(Channels.newOutputStream(channel!!), StandardCharsets.UTF_8)
          )

        _state.update { ConnectionState.Connected(subscribed = false) }
        attempt = 0
        log.info("Connected to failures push")

        // Send subscribe request
        subscribe(type, severity)

        // Read messages (blocks until disconnected)
        readMessages()

        // If we get here, connection was lost
        if (_shouldReconnect) {
          log.info("Connection lost, will attempt to reconnect")
          attempt++
          _state.update { ConnectionState.Reconnecting(attempt, calculateBackoff(attempt)) }
        }
      } catch (e: Exception) {
        cleanupConnection()

        if (!_shouldReconnect) {
          log.info("Reconnection disabled, stopping connection attempts")
          _state.update { ConnectionState.Disconnected("Disconnected") }
          return
        }

        attempt++
        val delayMs = calculateBackoff(attempt)

        log.warn(
          "Failed to connect to failures push (attempt $attempt): ${e.message}. Retrying in ${delayMs}ms"
        )
        _state.update { ConnectionState.Reconnecting(attempt, delayMs) }

        delay(delayMs)
      }
    }

    _state.update { ConnectionState.Disconnected("Stopped") }
  }

  private fun calculateBackoff(attempt: Int): Long {
    // Exponential backoff with jitter
    val exponentialDelay = initialRetryDelayMs * (1L shl min(attempt - 1, 10))
    val cappedDelay = min(exponentialDelay, maxRetryDelayMs)
    // Add up to 10% jitter
    val jitter = (cappedDelay * 0.1 * Math.random()).toLong()
    return cappedDelay + jitter
  }

  private class SocketNotFoundError(message: String) : Exception(message)

  fun disconnect() {
    val previousState = _state.value
    // Stop reconnection attempts by moving to Disconnected
    _state.update { ConnectionState.Disconnected(null) }

    connectionJob?.cancel()
    connectionJob = null

    if (previousState !is ConnectionState.Connected) {
      return
    }

    try {
      if (previousState.subscribed) {
        val request =
          FailuresPushRequest(
            id = UUID.randomUUID().toString(),
            command = "unsubscribe",
          )
        sendRequest(request)
      }

      channel?.close()
    } catch (e: Exception) {
      log.warn("Error disconnecting from failures push: ${e.message}")
    }

    channel = null
    reader = null
    writer = null
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

  private fun subscribe(type: String?, severity: String?) {
    val request =
      FailuresPushRequest(
        id = UUID.randomUUID().toString(),
        command = "subscribe",
        type = type,
        severity = severity,
      )

    if (sendRequest(request)) {
      _state.update { current ->
        if (current is ConnectionState.Connected) {
          current.copy(subscribed = true)
        } else {
          current
        }
      }
      log.info(
        "Subscribed to failures push (type: ${type ?: "all"}, severity: ${severity ?: "all"})"
      )
    }
  }

  private fun sendRequest(request: FailuresPushRequest): Boolean {
    val currentWriter = writer ?: return false

    return try {
      val message = json.encodeToString(FailuresPushRequest.serializer(), request)
      currentWriter.write(message)
      currentWriter.newLine()
      currentWriter.flush()
      true
    } catch (e: Exception) {
      log.warn("Failed to send request: ${e.message}")
      false
    }
  }

  private suspend fun readMessages() {
    val currentReader = reader ?: return

    try {
      log.info("Starting failures push message read loop")

      while (_isConnected) {
        val line = currentReader.readLine() ?: break
        if (line.isBlank()) continue

        try {
          handleMessage(line)
        } catch (e: Exception) {
          log.warn("Failed to parse failures push message: ${e.message}", e)
        }
      }
    } catch (e: Exception) {
      log.warn("Error reading from failures push: ${e.message}", e)
    }

    // Clean up connection state - reconnection is handled by connectWithRetry
    cleanupConnection()
    log.info("Failures push read loop ended")
  }

  private fun cleanupConnection() {
    try {
      channel?.close()
    } catch (_: Exception) {}
    channel = null
    reader = null
    writer = null
  }

  private suspend fun handleMessage(message: String) {
    val response = json.decodeFromString(FailuresPushResponse.serializer(), message)

    when (response.type) {
      "subscription_response" -> {
        log.info("Failures push subscription response: success=${response.success}")
        if (response.success != true) {
          log.warn("Subscription failed: ${response.error}")
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
        sendPong()
      }
      "error" -> {
        log.warn("Failures push error: ${response.error}")
      }
      else -> {
        log.warn("Unknown message type: ${response.type}")
      }
    }
  }

  private fun sendPong() {
    val request =
      FailuresPushRequest(
        id = UUID.randomUUID().toString(),
        command = "pong",
      )
    sendRequest(request)
  }
}

@Serializable
data class FailuresPushRequest(
  val id: String,
  val command: String,
  val type: String? = null,
  val severity: String? = null,
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
