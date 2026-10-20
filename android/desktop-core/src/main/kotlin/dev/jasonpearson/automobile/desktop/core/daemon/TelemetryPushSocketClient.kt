package dev.jasonpearson.automobile.desktop.core.daemon

import dev.jasonpearson.automobile.desktop.core.connection.ConnectionState
import dev.jasonpearson.automobile.desktop.core.connection.isConnected
import dev.jasonpearson.automobile.desktop.core.connection.shouldReconnect
import dev.jasonpearson.automobile.desktop.core.logging.Logger
import dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory
import dev.jasonpearson.automobile.desktop.core.telemetry.TelemetryDisplayEvent
import dev.jasonpearson.automobile.desktop.core.telemetry.TelemetryPushRequest
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
  val ioDispatcher: kotlinx.coroutines.CoroutineDispatcher = Dispatchers.IO,
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
    ioDispatcher: kotlinx.coroutines.CoroutineDispatcher = Dispatchers.IO,
  ) : this(
    ::ChannelTelemetrySocket,
    TelemetryRetryDelay { delay(it) },
    CoroutineScope(SupervisorJob() + ioDispatcher),
    { Files.exists(Path.of(it)) },
    options =
      TelemetryPushSocketOptions(
        sessionUuidProvider = sessionUuidProvider,
        ioDispatcher = ioDispatcher,
      ),
  )

  companion object {
    internal const val MAX_RECONNECT_ATTEMPTS = 5
    internal const val DEVICE_NOT_LIVE_MESSAGE = "Device session is not registered on the daemon"
    private const val DEVICE_NOT_LIVE_MARKER = "does not identify a live device session"

    private fun getSocketPath(): String = AutoMobileSocketPaths.socketPath("telemetry-push.sock")

    fun socketExists(): Boolean = Files.exists(Path.of(getSocketPath()))
  }

  private val sessionRejected: Boolean
    get() = messages.sessionRejected

  private val socket = AtomicReference<TelemetrySocket?>()
  private val connectionLock = Any()
  private var connectionGeneration = 0L
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

  private var subscribedDeviceId: String?
    get() = writer.subscribedDeviceId
    set(value) {
      writer.subscribedDeviceId = value
    }

  private var subscribedDeviceSessionUuid: String?
    get() = writer.subscribedDeviceSessionUuid
    set(value) {
      writer.subscribedDeviceSessionUuid = value
    }

  /** Set when the daemon refuses a subscribe because the named device has no live session yet. */
  private var deviceNotLive: Boolean
    get() = messages.deviceNotLive
    set(value) {
      messages.deviceNotLive = value
    }

  private val writer = TelemetrySocketWriter(log, options) { socket.get() }
  private val messages = TelemetryMessageHandler(log, _state, _telemetryEvents, writer::sendPong)

  internal fun subscribeRequest(): TelemetryPushRequest = writer.subscribeRequest()

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
        writer.subscribe(currentSocket)

        // Read messages (blocks until disconnected)
        readMessages(currentSocket) { attempt = 0 }
      } catch (e: CancellationException) {
        throw e
      } catch (e: java.io.IOException) {
        log.warn("Telemetry push connection failed: ${e.message}")
      } catch (e: IllegalStateException) {
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
      val delayMs = calculateTelemetryBackoff(attempt, initialRetryDelayMs, maxRetryDelayMs)
      _state.value = ConnectionState.Reconnecting(attempt, delayMs)
      retryDelay.wait(delayMs)
    }

    _state.update { ConnectionState.Disconnected("Stopped") }
  }

  private class SocketNotFoundError(message: String) : java.io.IOException(message)

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
        writer.sendRequest(request, previousSocket)
      }
    } catch (cancellation: CancellationException) {
      throw cancellation
    } catch (e: java.io.IOException) {
      log.warn("Error disconnecting from telemetry push: ${e.message}")
    } catch (e: IllegalStateException) {
      log.warn("Error disconnecting from telemetry push: ${e.message}")
    } finally {
      cleanupConnection(previousSocket)
    }
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

  private suspend fun readMessages(currentSocket: TelemetrySocket, onHealthy: () -> Unit) {
    try {
      log.info("Starting telemetry push message read loop")

      while (_shouldReconnect) {
        val line = runInterruptible(options.ioDispatcher) { currentSocket.readLine() } ?: break
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
    } catch (e: java.io.IOException) {
      log.warn("Error reading from telemetry push: ${e.message}", e)
    } catch (e: IllegalStateException) {
      log.warn("Error reading from telemetry push: ${e.message}", e)
    }

    log.info("Telemetry push read loop ended")
  }

  private fun cleanupConnection(currentSocket: TelemetrySocket?) {
    try {
      currentSocket?.close()
    } catch (error: java.io.IOException) {
      log.debug("Could not close telemetry socket: ${error.message}")
    }
    socket.compareAndSet(currentSocket, null)
  }

  internal fun processMessage(message: String): Boolean =
    try {
      messages.handleMessage(message)
    } catch (e: CancellationException) {
      throw e
    } catch (e: IllegalArgumentException) {
      log.warn("Malformed telemetry push message; skipped: ${e.message}", e)
      false
    } catch (e: IllegalStateException) {
      log.warn("Malformed telemetry push message; skipped: ${e.message}", e)
      false
    }
}

private fun calculateTelemetryBackoff(
  attempt: Int,
  initialRetryDelayMs: Long,
  maxRetryDelayMs: Long,
): Long {
  val exponentialDelay = initialRetryDelayMs * (1L shl min(attempt - 1, 10))
  val cappedDelay = min(exponentialDelay, maxRetryDelayMs)
  val jitter = (cappedDelay * 0.1 * Math.random()).toLong()
  return cappedDelay + jitter
}
