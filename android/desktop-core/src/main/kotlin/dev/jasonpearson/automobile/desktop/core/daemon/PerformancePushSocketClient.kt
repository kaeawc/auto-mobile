package dev.jasonpearson.automobile.desktop.core.daemon

import dev.jasonpearson.automobile.desktop.core.connection.ConnectionState
import dev.jasonpearson.automobile.desktop.core.connection.isConnected
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
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
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
 * Client for the performance push Unix socket server. Subscribes to receive real-time performance
 * metrics from the MCP server.
 *
 * Socket path: ~/.auto-mobile/performance-push.sock
 */
class PerformancePushSocketClient {
  companion object {
    private fun getSocketPath(): String {
      return "${System.getProperty("user.home")}/.auto-mobile/performance-push.sock"
    }
  }

  private val log = LoggerFactory.getLogger(PerformancePushSocketClient::class.java)
  private val json = Json { ignoreUnknownKeys = true }
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

  private var channel: SocketChannel? = null
  private var reader: BufferedReader? = null
  private var writer: BufferedWriter? = null

  private val _state = MutableStateFlow<ConnectionState>(ConnectionState.Disconnected(null))
  val connectionState: StateFlow<ConnectionState> = _state.asStateFlow()

  private val _isConnected: Boolean
    get() = _state.value.isConnected

  // Flow for live performance data
  private val _performanceData =
    MutableSharedFlow<LivePerformanceData>(
      replay = 1,
      extraBufferCapacity = 10,
      onBufferOverflow = kotlinx.coroutines.channels.BufferOverflow.DROP_OLDEST,
    )
  val performanceData: SharedFlow<LivePerformanceData> = _performanceData.asSharedFlow()

  /**
   * Connect to the performance push socket and subscribe to updates.
   *
   * @param deviceId Optional device ID to subscribe to. If null, subscribes to all devices.
   * @param packageName Optional package name to subscribe to. If null, subscribes to all packages.
   */
  fun connect(deviceId: String? = null, packageName: String? = null) {
    if (_isConnected) {
      log.info("Already connected to performance push")
      return
    }

    val socketPath = getSocketPath()
    log.info("Connecting to performance push at $socketPath")

    _state.update { ConnectionState.Connecting }

    try {
      val path = Path.of(socketPath)
      if (!Files.exists(path)) {
        log.warn("Performance push socket not found at $socketPath")
        _state.update { ConnectionState.Disconnected("Socket not found") }
        return
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
      log.info("Connected to performance push")

      // Send subscribe request
      subscribe(deviceId, packageName)

      // Start reading messages
      scope.launch {
        readMessages()
      }
    } catch (e: Exception) {
      log.warn("Failed to connect to performance push: ${e.message}")
      _state.update { ConnectionState.Disconnected(e.message) }
    }
  }

  fun disconnect() {
    if (!_isConnected) return

    try {
      val currentState = _state.value
      if (currentState is ConnectionState.Connected && currentState.subscribed) {
        val request =
          PushRequest(
            id = UUID.randomUUID().toString(),
            command = "unsubscribe",
          )
        sendRequest(request)
      }

      channel?.close()
    } catch (e: Exception) {
      log.warn("Error disconnecting from performance push: ${e.message}")
    }

    channel = null
    reader = null
    writer = null
    _state.update { ConnectionState.Disconnected(null) }
  }

  fun isConnected(): Boolean = _isConnected

  private fun subscribe(deviceId: String?, packageName: String?) {
    val request =
      PushRequest(
        id = UUID.randomUUID().toString(),
        command = "subscribe",
        deviceId = deviceId,
        packageName = packageName,
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
        "Subscribed to performance push (device: ${deviceId ?: "all"}, package: ${packageName ?: "all"})"
      )
    }
  }

  private fun sendRequest(request: PushRequest): Boolean {
    val currentWriter = writer ?: return false

    return try {
      val message = json.encodeToString(PushRequest.serializer(), request)
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
      log.info("Starting performance push message read loop")

      while (_isConnected) {
        val line = currentReader.readLine() ?: break
        if (line.isBlank()) continue

        try {
          handleMessage(line)
        } catch (e: Exception) {
          log.warn("Failed to parse performance push message: ${e.message}", e)
        }
      }
    } catch (e: Exception) {
      log.warn("Error reading from performance push: ${e.message}", e)
    }

    channel?.close()
    channel = null
    reader = null
    writer = null
    _state.update { ConnectionState.Disconnected("Stream ended") }
    log.info("Performance push disconnected")
  }

  private suspend fun handleMessage(message: String) {
    val response = json.decodeFromString(PushResponse.serializer(), message)

    when (response.type) {
      "subscription_response" -> {
        log.info("Performance push subscription response: success=${response.success}")
        if (response.success != true) {
          log.warn("Subscription failed: ${response.error}")
        }
      }
      "performance_push" -> {
        val data = response.data
        if (data != null) {
          log.debug("Performance push received - device=${data.deviceId}, fps=${data.metrics.fps}")
          _performanceData.tryEmit(data)
        }
      }
      "ping" -> {
        log.debug("Received ping, sending pong")
        sendPong()
      }
      "error" -> {
        log.warn("Performance push error: ${response.error}")
      }
      else -> {
        log.warn("Unknown message type: ${response.type}")
      }
    }
  }

  private fun sendPong() {
    val request =
      PushRequest(
        id = UUID.randomUUID().toString(),
        command = "pong",
      )
    sendRequest(request)
  }
}

@Serializable
data class PushRequest(
  val id: String,
  val command: String,
  val deviceId: String? = null,
  val packageName: String? = null,
)

@Serializable
data class PushResponse(
  val id: String? = null,
  val type: String,
  val success: Boolean? = null,
  val error: String? = null,
  val timestamp: Long? = null,
  val data: LivePerformanceData? = null,
)

@Serializable
data class LivePerformanceData(
  val deviceId: String,
  val packageName: String,
  val timestamp: Long,
  val nodeId: Int? = null,
  val screenName: String? = null,
  val metrics: LivePerformanceMetrics,
  val thresholds: PerformanceThresholds,
  val health: String, // "healthy" | "warning" | "critical"
)

@Serializable
data class LivePerformanceMetrics(
  val fps: Float? = null,
  val frameTimeMs: Float? = null,
  val jankFrames: Int? = null,
  val touchLatencyMs: Float? = null,
  val ttffMs: Float? = null,
  val ttiMs: Float? = null,
  val cpuUsagePercent: Float? = null,
  val memoryUsageMb: Float? = null,
)

@Serializable
data class PerformanceThresholds(
  val fpsWarning: Float,
  val fpsCritical: Float,
  val frameTimeWarning: Float,
  val frameTimeCritical: Float,
  val jankWarning: Int,
  val jankCritical: Int,
  val touchLatencyWarning: Float,
  val touchLatencyCritical: Float,
  val ttffWarning: Float,
  val ttffCritical: Float,
  val ttiWarning: Float,
  val ttiCritical: Float,
)
