package dev.jasonpearson.automobile.desktop.core.daemon

import dev.jasonpearson.automobile.desktop.core.connection.ConnectionState
import dev.jasonpearson.automobile.desktop.core.connection.isConnected
import dev.jasonpearson.automobile.desktop.core.connection.shouldReconnect
import dev.jasonpearson.automobile.desktop.core.logging.Logger
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
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.runInterruptible
import kotlinx.serialization.serializer

internal interface TelemetrySocket : AutoCloseable {
  fun readLine(): String?

  fun writeLine(line: String)
}

internal fun interface TelemetryRetryDelay {
  suspend fun wait(delayMs: Long)
}

private class ChannelTelemetrySocket(path: String) : TelemetrySocket {
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
 * Client for the telemetry push Unix socket server. Subscribes to receive real-time telemetry
 * events (network, log, custom, OS) from the MCP server.
 *
 * Socket path: ~/.auto-mobile/telemetry-push.sock
 */
internal data class TelemetryPushSocketOptions(
  val beforeSocketPublish: () -> Unit = {},
  val sessionUuidProvider: (() -> String?)? = null,
)

class TelemetryPushSocketClient
internal constructor(
  private val openSocket: (String) -> TelemetrySocket,
  private val retryDelay: TelemetryRetryDelay,
  private val scope: CoroutineScope,
  private val socketAvailable: (String) -> Boolean,
  private val log: Logger = LoggerFactory.getLogger(TelemetryPushSocketClient::class.java),
  private val options: TelemetryPushSocketOptions = TelemetryPushSocketOptions(),
) : TelemetryPushClient {
  constructor(
    sessionUuidProvider: (() -> String?)? = null,
  ) : this(
    ::ChannelTelemetrySocket,
    TelemetryRetryDelay { delay(it) },
    CoroutineScope(SupervisorJob() + Dispatchers.IO),
    { Files.exists(Path.of(it)) },
    options = TelemetryPushSocketOptions(sessionUuidProvider = sessionUuidProvider),
  )

  companion object {
    internal const val MAX_RECONNECT_ATTEMPTS = 5
    internal const val DEVICE_NOT_LIVE_MESSAGE = "Device session is not registered on the daemon"
    private const val DEVICE_NOT_LIVE_MARKER = "does not identify a live device session"

    private fun getSocketPath(): String = AutoMobileSocketPaths.socketPath("telemetry-push.sock")

    fun socketExists(): Boolean = Files.exists(Path.of(getSocketPath()))
  }

  @Volatile private var sessionRejected = false

  private val json = DaemonJson
  private val socket = AtomicReference<TelemetrySocket?>()
  private val connectionLock = Any()
  private var connectionGeneration = 0L
  private var connectionJob: Job? = null
  private val loggedFieldMismatches = mutableSetOf<String>()

  private fun warnFieldMismatch(category: String, field: String) {
    val key = "$category:$field"
    synchronized(loggedFieldMismatches) {
      if (loggedFieldMismatches.add(key)) {
        log.warn("Recovered telemetry field shape mismatch: category=$category field=$field")
      }
    }
  }

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
  private var subscribedDeviceSessionUuid: String? = null

  /** Set when the daemon refuses a subscribe because the named device has no live session yet. */
  @Volatile private var deviceNotLive = false

  /** Reconnect with the device arguments of the last [connect] instead of widening to all. */
  override fun reconnect() = connect(subscribedDeviceId, subscribedDeviceSessionUuid)

  /**
   * Connect to the telemetry push socket and subscribe to events.
   *
   * @param deviceId Optional device ID for server-side filtering. Null subscribes to all devices.
   * @param deviceSessionUuid The device's live session identity, preferred by the daemon over
   *   [deviceId] when both are sent.
   */
  override fun connect(deviceId: String?, deviceSessionUuid: String?) {
    if (
      sessionRejected ||
        (options.sessionUuidProvider != null && options.sessionUuidProvider.invoke() == null)
    )
      return
    synchronized(connectionLock) {
      if (_isConnected || connectionJob?.isActive == true) {
        log.info("Telemetry push connection already active")
        return
      }
      subscribedDeviceId = deviceId
      subscribedDeviceSessionUuid = deviceSessionUuid
      val generation = ++connectionGeneration
      _state.update { ConnectionState.Connecting }
      connectionJob = scope.launch { connectWithRetry(generation) }
    }
  }

  private suspend fun connectWithRetry(generation: Long) {
    val socketPath = getSocketPath()
    var attempt = 0

    while (_shouldReconnect) {
      log.info("Connecting to telemetry push at $socketPath (attempt ${attempt + 1})")
      var currentSocket: TelemetrySocket? = null
      deviceNotLive = false

      try {
        if (!socketAvailable(socketPath)) {
          throw SocketNotFoundError("Socket not found at $socketPath")
        }
        currentSocket = openSocket(socketPath)
        currentCoroutineContext().ensureActive()
        options.beforeSocketPublish()
        synchronized(connectionLock) {
          // Cancellation may race the last ensureActive check. Only this attempt may publish.
          if (generation != connectionGeneration) return
          socket.set(currentSocket)
        }

        // Subscribe to all events (filter client-side)
        subscribe(currentSocket)

        // Read messages (blocks until disconnected)
        readMessages(currentSocket) { attempt = 0 }
      } catch (e: CancellationException) {
        throw e
      } catch (e: Exception) {
        log.warn("Telemetry push connection failed: ${e.message}")
      } finally {
        cleanupConnection(currentSocket)
      }

      currentCoroutineContext().ensureActive()
      if (!_shouldReconnect) return
      attempt++
      if (attempt >= MAX_RECONNECT_ATTEMPTS) {
        _state.value =
          ConnectionState.Error(
            if (deviceNotLive) DEVICE_NOT_LIVE_MESSAGE else "Telemetry unavailable on this daemon",
          )
        return
      }
      val delayMs = calculateBackoff(attempt)
      _state.value = ConnectionState.Reconnecting(attempt, delayMs)
      retryDelay.wait(delayMs)
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
    val previousState: ConnectionState
    val previousSocket: TelemetrySocket?
    synchronized(connectionLock) {
      connectionGeneration++
      previousState = _state.value
      _state.update { ConnectionState.Disconnected(null) }
      connectionJob?.cancel()
      connectionJob = null
      previousSocket = socket.getAndSet(null)
    }

    try {
      if (previousState is ConnectionState.Connected && previousState.subscribed) {
        val request =
          TelemetryPushRequest(
            id = UUID.randomUUID().toString(),
            command = "unsubscribe",
          )
        sendRequest(request, previousSocket)
      }
    } catch (e: Exception) {
      log.warn("Error disconnecting from telemetry push: ${e.message}")
    }
    cleanupConnection(previousSocket)
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

  internal fun subscribeRequest(): TelemetryPushRequest =
    TelemetryPushRequest(
      id = UUID.randomUUID().toString(),
      command = "subscribe",
      sessionUuid = options.sessionUuidProvider?.invoke(),
      category = null, // subscribe to all categories, filter client-side
      deviceId = subscribedDeviceId,
      deviceSessionUuid = subscribedDeviceSessionUuid,
    )

  private fun subscribe(currentSocket: TelemetrySocket) {
    val request = subscribeRequest()

    if (!sendRequest(request, currentSocket)) {
      throw IllegalStateException("Failed to send telemetry subscription")
    }
  }

  private fun sendRequest(
    request: TelemetryPushRequest,
    currentSocket: TelemetrySocket? = socket.get(),
  ): Boolean {
    currentSocket ?: return false

    return try {
      val message = json.encodeToString(serializer<TelemetryPushRequest>(), request)
      currentSocket.writeLine(message)
      true
    } catch (e: Exception) {
      log.warn("Failed to send telemetry push request: ${e.message}")
      false
    }
  }

  private suspend fun readMessages(currentSocket: TelemetrySocket, onHealthy: () -> Unit) {
    try {
      log.info("Starting telemetry push message read loop")

      while (_shouldReconnect) {
        val line = runInterruptible(Dispatchers.IO) { currentSocket.readLine() } ?: break
        currentCoroutineContext().ensureActive()
        if (line.isBlank()) continue

        if (processMessage(line) && !_isConnected) {
          onHealthy()
          _state.value = ConnectionState.Connected(subscribed = true)
          log.info("Connected to telemetry push")
        }
        // The device may simply not be registered yet; end this read so the caller backs off
        // and subscribes again, bounded by MAX_RECONNECT_ATTEMPTS.
        if (deviceNotLive) break
      }
    } catch (e: CancellationException) {
      throw e
    } catch (e: Exception) {
      log.warn("Error reading from telemetry push: ${e.message}", e)
    }

    log.info("Telemetry push read loop ended")
  }

  private fun cleanupConnection(currentSocket: TelemetrySocket?) {
    try {
      currentSocket?.close()
    } catch (_: Exception) {}
    socket.compareAndSet(currentSocket, null)
  }

  internal suspend fun processMessage(message: String): Boolean =
    try {
      handleMessage(message)
    } catch (e: CancellationException) {
      throw e
    } catch (e: Exception) {
      log.warn("Malformed telemetry push message; skipped: ${e.message}", e)
      false
    }

  private suspend fun handleMessage(message: String): Boolean {
    val response = json.decodeFromString(serializer<TelemetryPushResponse>(), message)

    return when (response.type) {
      "subscription_response" -> {
        log.info("Telemetry push subscription response: success=${response.success}")
        if (response.success != true) {
          noteDeviceNotLive(response.error)
          rejectSession(response.error)
          if (!sessionRejected && !deviceNotLive) {
            log.warn("Telemetry subscription failed: ${response.error}")
          }
        }
        response.success == true
      }
      "telemetry_push" -> {
        val envelope = response.data
        if (envelope != null && envelope.category.isNotBlank()) {
          try {
            val event =
              parseTelemetryEvent(envelope) { field ->
                warnFieldMismatch(envelope.category, field)
              }
            if (event != null) {
              _telemetryEvents.tryEmit(event)
            }
            event != null
          } catch (e: Exception) {
            log.warn("Malformed telemetry push event; skipped: ${e.message}")
            false
          }
        } else {
          log.warn("Malformed telemetry push event; missing data or category; skipped")
          false
        }
      }
      "ping" -> {
        log.debug("Received telemetry ping, sending pong")
        sendPong()
        false
      }
      "error" -> {
        noteDeviceNotLive(response.error)
        rejectSession(response.error)
        if (!sessionRejected && !deviceNotLive) {
          log.warn("Telemetry push error: ${response.error}")
        }
        false
      }
      else -> {
        log.warn("Unknown telemetry push message type: ${response.type}")
        false
      }
    }
  }

  private fun noteDeviceNotLive(error: String?) {
    if (error?.contains(DEVICE_NOT_LIVE_MARKER) == true) {
      deviceNotLive = true
      log.info("Telemetry device not live yet; will retry: $error")
    }
  }

  private fun rejectSession(error: String?) {
    if (!sessionRejected && isStreamSessionRejection(error)) {
      sessionRejected = true
      _state.value = ConnectionState.Error(error ?: "Session registration required")
      log.warn("Subscription failed: $error")
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
