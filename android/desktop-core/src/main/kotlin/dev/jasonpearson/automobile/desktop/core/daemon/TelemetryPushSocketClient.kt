package dev.jasonpearson.automobile.desktop.core.daemon

import dev.jasonpearson.automobile.desktop.core.connection.ConnectionState
import dev.jasonpearson.automobile.desktop.core.connection.isConnected
import dev.jasonpearson.automobile.desktop.core.connection.shouldReconnect
import dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory
import dev.jasonpearson.automobile.desktop.core.telemetry.TelemetryDisplayEvent
import dev.jasonpearson.automobile.desktop.core.telemetry.TelemetryPushRequest
import dev.jasonpearson.automobile.desktop.core.telemetry.TelemetryPushResponse
import dev.jasonpearson.automobile.desktop.core.telemetry.parseTelemetryEvent
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
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * Client for the telemetry push Unix socket server. Subscribes to receive real-time telemetry
 * events (network, log, custom, OS) from the MCP server.
 *
 * Socket path: ~/.auto-mobile/telemetry-push.sock
 */
class TelemetryPushSocketClient : TelemetryPushClient {
  companion object {
    private fun getSocketPath(): String = AutoMobileSocketPaths.socketPath("telemetry-push.sock")

    fun socketExists(): Boolean = Files.exists(Path.of(getSocketPath()))
  }

  private val log = LoggerFactory.getLogger(TelemetryPushSocketClient::class.java)
  private val json = DaemonJson
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

  private var channel: SocketChannel? = null
  private var reader: BufferedReader? = null
  private var writer: BufferedWriter? = null
  private var connectionJob: Job? = null

  private val _state = MutableStateFlow<ConnectionState>(ConnectionState.Disconnected(null))
  override val connectionState: SharedFlow<ConnectionState> = _state.asStateFlow()

  private val _isConnected: Boolean
    get() = _state.value.isConnected

  private val _shouldReconnect: Boolean
    get() = _state.value.shouldReconnect

  // Retry configuration
  private val initialRetryDelayMs = 1000L
  private val maxRetryDelayMs = 30000L

  // Flow for live telemetry events — replay caches recent events for late collectors (e.g. tab
  // re-open)
  private val _telemetryEvents =
    MutableSharedFlow<TelemetryDisplayEvent>(
      replay = 500,
      extraBufferCapacity = 200,
      onBufferOverflow = kotlinx.coroutines.channels.BufferOverflow.DROP_OLDEST,
    )
  override val telemetryEvents: SharedFlow<TelemetryDisplayEvent> = _telemetryEvents.asSharedFlow()

  private var subscribedDeviceId: String? = null

  /**
   * Connect to the telemetry push socket and subscribe to events.
   *
   * @param deviceId Optional device ID for server-side filtering. Null subscribes to all devices.
   */
  override fun connect(deviceId: String?) {
    if (_isConnected) {
      log.info("Already connected to telemetry push")
      return
    }

    subscribedDeviceId = deviceId
    connectionJob?.cancel()
    _state.update { ConnectionState.Connecting }

    connectionJob = scope.launch {
      connectWithRetry()
    }
  }

  private suspend fun connectWithRetry() {
    val socketPath = getSocketPath()
    var attempt = 0

    while (_shouldReconnect) {
      log.info("Connecting to telemetry push at $socketPath (attempt ${attempt + 1})")

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
        log.info("Connected to telemetry push")

        // Subscribe to all events (filter client-side)
        subscribe()

        // Read messages (blocks until disconnected)
        readMessages()

        // If we get here, connection was lost
        if (_shouldReconnect) {
          log.info("Telemetry push connection lost, will attempt to reconnect")
          attempt++
          _state.update { ConnectionState.Reconnecting(attempt, calculateBackoff(attempt)) }
        }
      } catch (e: Exception) {
        cleanupConnection()

        if (!_shouldReconnect) {
          log.info("Telemetry push reconnection disabled, stopping")
          _state.update { ConnectionState.Disconnected("Disconnected") }
          return
        }

        attempt++
        val delayMs = calculateBackoff(attempt)

        log.warn(
          "Failed to connect to telemetry push (attempt $attempt): ${e.message}. Retrying in ${delayMs}ms"
        )
        _state.update { ConnectionState.Reconnecting(attempt, delayMs) }

        delay(delayMs)
      }
    }

    _state.update { ConnectionState.Disconnected("Stopped") }
  }

  private fun calculateBackoff(attempt: Int): Long {
    val exponentialDelay = initialRetryDelayMs * (1L shl min(attempt - 1, 10))
    val cappedDelay = min(exponentialDelay, maxRetryDelayMs)
    val jitter = (cappedDelay * 0.1 * Math.random()).toLong()
    return cappedDelay + jitter
  }

  private class SocketNotFoundError(message: String) : Exception(message)

  override fun disconnect() {
    val previousState = _state.value
    _state.update { ConnectionState.Disconnected(null) }

    connectionJob?.cancel()
    connectionJob = null

    if (previousState !is ConnectionState.Connected) {
      return
    }

    try {
      if (previousState.subscribed) {
        val request =
          TelemetryPushRequest(
            id = UUID.randomUUID().toString(),
            command = "unsubscribe",
          )
        sendRequest(request)
      }

      channel?.close()
    } catch (e: Exception) {
      log.warn("Error disconnecting from telemetry push: ${e.message}")
    }

    channel = null
    reader = null
    writer = null
  }

  override fun isConnected(): Boolean = _isConnected

  /**
   * Disconnect and cancel the internal coroutine scope. After calling dispose(), this client
   * instance should not be reused.
   */
  override fun dispose() {
    disconnect()
    scope.coroutineContext[Job]?.cancel()
  }

  private fun subscribe() {
    val request =
      TelemetryPushRequest(
        id = UUID.randomUUID().toString(),
        command = "subscribe",
        category = null, // subscribe to all categories, filter client-side
        deviceId = subscribedDeviceId,
      )

    if (sendRequest(request)) {
      _state.update { current ->
        if (current is ConnectionState.Connected) {
          current.copy(subscribed = true)
        } else {
          current
        }
      }
      log.info("Subscribed to telemetry push (device: ${subscribedDeviceId ?: "all"})")
    }
  }

  private fun sendRequest(request: TelemetryPushRequest): Boolean {
    val currentWriter = writer ?: return false

    return try {
      val message = json.encodeToString(TelemetryPushRequest.serializer(), request)
      currentWriter.write(message)
      currentWriter.newLine()
      currentWriter.flush()
      true
    } catch (e: Exception) {
      log.warn("Failed to send telemetry push request: ${e.message}")
      false
    }
  }

  private suspend fun readMessages() {
    val currentReader = reader ?: return

    try {
      log.info("Starting telemetry push message read loop")

      while (_isConnected) {
        val line = currentReader.readLine() ?: break
        if (line.isBlank()) continue

        try {
          handleMessage(line)
        } catch (e: Exception) {
          log.warn("Failed to parse telemetry push message: ${e.message}", e)
        }
      }
    } catch (e: Exception) {
      log.warn("Error reading from telemetry push: ${e.message}", e)
    }

    cleanupConnection()
    log.info("Telemetry push read loop ended")
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
    val response = json.decodeFromString(TelemetryPushResponse.serializer(), message)

    when (response.type) {
      "subscription_response" -> {
        log.info("Telemetry push subscription response: success=${response.success}")
        if (response.success != true) {
          log.warn("Telemetry subscription failed: ${response.error}")
        }
      }
      "telemetry_push" -> {
        val envelope = response.data
        if (envelope != null) {
          try {
            val event = parseTelemetryEvent(envelope)
            if (event != null) {
              _telemetryEvents.tryEmit(event)
            }
          } catch (e: Exception) {
            log.warn("Failed to parse telemetry push message: ${e.message}")
          }
        }
      }
      "ping" -> {
        log.debug("Received telemetry ping, sending pong")
        sendPong()
      }
      "error" -> {
        log.warn("Telemetry push error: ${response.error}")
      }
      else -> {
        log.warn("Unknown telemetry push message type: ${response.type}")
      }
    }
  }

  private fun sendPong() {
    val request =
      TelemetryPushRequest(
        id = UUID.randomUUID().toString(),
        command = "pong",
      )
    sendRequest(request)
  }
}
