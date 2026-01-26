package dev.jasonpearson.automobile.ide.daemon

import com.intellij.openapi.diagnostic.Logger
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
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement

/**
 * Client for the observation stream Unix socket server.
 * Subscribes to receive real-time hierarchy and screenshot updates from the MCP server.
 *
 * Socket path: ~/.auto-mobile/observation-stream.sock
 * or /tmp/auto-mobile-observation-stream.sock (in external mode)
 */
class ObservationStreamClient {
    companion object {
        private fun getSocketPath(): String {
            // Check for external mode (matches the server's logic)
            val isExternalMode = System.getenv("AUTOMOBILE_EMULATOR_EXTERNAL") == "true"
            return if (isExternalMode) {
                "/tmp/auto-mobile-observation-stream.sock"
            } else {
                "${System.getProperty("user.home")}/.auto-mobile/observation-stream.sock"
            }
        }
    }

    private val log = Logger.getInstance(ObservationStreamClient::class.java)
    private val json = Json { ignoreUnknownKeys = true }
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private var channel: SocketChannel? = null
    private var reader: BufferedReader? = null
    private var writer: BufferedWriter? = null
    private val connected = AtomicBoolean(false)
    private val subscribed = AtomicBoolean(false)

    // Flow for hierarchy updates
    private val _hierarchyUpdates = MutableSharedFlow<HierarchyStreamUpdate>(replay = 1)
    val hierarchyUpdates: SharedFlow<HierarchyStreamUpdate> = _hierarchyUpdates.asSharedFlow()

    // Flow for screenshot updates
    private val _screenshotUpdates = MutableSharedFlow<ScreenshotStreamUpdate>(replay = 1)
    val screenshotUpdates: SharedFlow<ScreenshotStreamUpdate> = _screenshotUpdates.asSharedFlow()

    // Flow for connection state
    private val _connectionState = MutableSharedFlow<StreamConnectionState>(replay = 1)
    val connectionState: SharedFlow<StreamConnectionState> = _connectionState.asSharedFlow()

    /**
     * Connect to the observation stream socket and subscribe to updates.
     * @param deviceId Optional device ID to subscribe to. If null, subscribes to all devices.
     */
    fun connect(deviceId: String? = null) {
        if (connected.get()) {
            log.info("Already connected to observation stream")
            return
        }

        val socketPath = getSocketPath()
        log.info("Connecting to observation stream at $socketPath")

        scope.launch {
            _connectionState.emit(StreamConnectionState.Connecting)
        }

        try {
            val path = Path.of(socketPath)
            if (!Files.exists(path)) {
                log.warn("Observation stream socket not found at $socketPath")
                scope.launch {
                    _connectionState.emit(StreamConnectionState.Disconnected("Socket not found"))
                }
                return
            }

            val address = UnixDomainSocketAddress.of(socketPath)
            channel = SocketChannel.open(address)
            reader = BufferedReader(
                InputStreamReader(Channels.newInputStream(channel!!), StandardCharsets.UTF_8)
            )
            writer = BufferedWriter(
                OutputStreamWriter(Channels.newOutputStream(channel!!), StandardCharsets.UTF_8)
            )

            connected.set(true)
            log.info("Connected to observation stream")

            // Send subscribe request
            subscribe(deviceId)

            // Start reading messages
            scope.launch {
                readMessages()
            }

        } catch (e: Exception) {
            log.warn("Failed to connect to observation stream: ${e.message}")
            scope.launch {
                _connectionState.emit(StreamConnectionState.Disconnected(e.message))
            }
        }
    }

    fun disconnect() {
        if (!connected.get()) return

        try {
            // Send unsubscribe request
            if (subscribed.get()) {
                val request = StreamRequest(
                    id = UUID.randomUUID().toString(),
                    command = "unsubscribe",
                )
                sendRequest(request)
            }

            channel?.close()
        } catch (e: Exception) {
            log.warn("Error disconnecting from observation stream: ${e.message}")
        }

        channel = null
        reader = null
        writer = null
        connected.set(false)
        subscribed.set(false)

        scope.launch {
            _connectionState.emit(StreamConnectionState.Disconnected(null))
        }
    }

    fun isConnected(): Boolean = connected.get()

    private fun subscribe(deviceId: String?) {
        val request = StreamRequest(
            id = UUID.randomUUID().toString(),
            command = "subscribe",
            deviceId = deviceId,
        )

        if (sendRequest(request)) {
            subscribed.set(true)
            log.info("Subscribed to observation stream (device: ${deviceId ?: "all"})")
        }
    }

    private fun sendRequest(request: StreamRequest): Boolean {
        val currentWriter = writer ?: return false

        return try {
            val message = json.encodeToString(StreamRequest.serializer(), request)
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
            _connectionState.emit(StreamConnectionState.Connected)

            while (connected.get()) {
                val line = currentReader.readLine() ?: break
                if (line.isBlank()) continue

                try {
                    handleMessage(line)
                } catch (e: Exception) {
                    log.warn("Failed to parse observation stream message: ${e.message}")
                }
            }
        } catch (e: Exception) {
            log.warn("Error reading from observation stream: ${e.message}")
        }

        connected.set(false)
        subscribed.set(false)
        _connectionState.emit(StreamConnectionState.Disconnected("Stream ended"))
    }

    private suspend fun handleMessage(message: String) {
        val response = json.decodeFromString(StreamResponse.serializer(), message)

        when (response.type) {
            "subscription_response" -> {
                if (response.success != true) {
                    log.warn("Subscription failed: ${response.error}")
                }
            }
            "hierarchy_update" -> {
                val update = HierarchyStreamUpdate(
                    deviceId = response.deviceId,
                    timestamp = response.timestamp ?: System.currentTimeMillis(),
                    data = response.data,
                )
                _hierarchyUpdates.emit(update)
            }
            "screenshot_update" -> {
                val update = ScreenshotStreamUpdate(
                    deviceId = response.deviceId,
                    timestamp = response.timestamp ?: System.currentTimeMillis(),
                    screenshotBase64 = response.screenshotBase64,
                    screenWidth = response.screenWidth ?: 1080,
                    screenHeight = response.screenHeight ?: 2340,
                )
                _screenshotUpdates.emit(update)
            }
            "error" -> {
                log.warn("Observation stream error: ${response.error}")
            }
            else -> {
                log.warn("Unknown message type: ${response.type}")
            }
        }
    }
}

@Serializable
data class StreamRequest(
    val id: String,
    val command: String,
    val deviceId: String? = null,
)

@Serializable
data class StreamResponse(
    val id: String? = null,
    val type: String,
    val success: Boolean? = null,
    val error: String? = null,
    val deviceId: String? = null,
    val timestamp: Long? = null,
    val data: JsonElement? = null,
    val screenshotBase64: String? = null,
    val screenWidth: Int? = null,
    val screenHeight: Int? = null,
)

data class HierarchyStreamUpdate(
    val deviceId: String?,
    val timestamp: Long,
    val data: JsonElement?,
)

data class ScreenshotStreamUpdate(
    val deviceId: String?,
    val timestamp: Long,
    val screenshotBase64: String?,
    val screenWidth: Int,
    val screenHeight: Int,
)

sealed class StreamConnectionState {
    data object Connecting : StreamConnectionState()
    data object Connected : StreamConnectionState()
    data class Disconnected(val reason: String?) : StreamConnectionState()
}
