package dev.jasonpearson.automobile.desktop.core.daemon

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
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

private val LOG = LoggerFactory.getLogger("DaemonNotificationClient")

/** Method the daemon accepts to opt a session into pushed notifications. */
internal const val SUBSCRIBE_NOTIFICATIONS_METHOD = "daemon/subscribe-notifications"

internal const val TOOLS_LIST_CHANGED_METHOD = "notifications/tools/list_changed"
internal const val RESOURCES_LIST_CHANGED_METHOD = "notifications/resources/list_changed"

/** Which cached list the daemon says is stale. */
enum class ListChangedKind {
  Tools,
  Resources;

  companion object {
    fun forMethod(method: String?): ListChangedKind? =
      when (method) {
        TOOLS_LIST_CHANGED_METHOD -> Tools
        RESOURCES_LIST_CHANGED_METHOD -> Resources
        else -> null
      }
  }
}

/** Where the notification subscription stands. */
sealed class NotificationSubscriptionState {
  data object Idle : NotificationSubscriptionState()

  data object Connecting : NotificationSubscriptionState()

  data object Subscribed : NotificationSubscriptionState()

  /** The daemon predates `daemon/subscribe-notifications`. Terminal -- retrying cannot help. */
  data class Unsupported(val reason: String) : NotificationSubscriptionState()

  data class Disconnected(val reason: String?) : NotificationSubscriptionState()
}

/** Receives the daemon's pushed list-changed notifications. */
interface DaemonNotificationSource {
  val notifications: SharedFlow<ListChangedKind>
  val state: StateFlow<NotificationSubscriptionState>

  fun connect()

  fun disconnect()
}

/**
 * Holds a long-lived connection to the daemon control socket purely to receive pushed
 * notifications.
 *
 * This is deliberately separate from [McpDaemonClient] rather than a mode of it. That client is
 * request/response: it opens a socket, writes one line, reads one line and closes, which is correct
 * for its callers and is also precisely why a push can never reach it. Rather than make every
 * existing caller share a connection lifecycle they do not need, this follows the same shape as the
 * other push clients in this package ([TelemetryPushSocketClient], [FailuresPushSocketClient]) —
 * own connection, own reader, own retry.
 *
 * A daemon that predates the subscribe method answers with a well-formed failure rather than
 * closing, so that case is reported as [NotificationSubscriptionState.Unsupported] and **not**
 * retried; only transport failures back off and reconnect.
 */
class DaemonNotificationClient(
  private val socketPathValue: String = DaemonSocketPaths.socketPath(),
  private val json: Json = Json {
    ignoreUnknownKeys = true
    // `type` is a default on the request class but the daemon routes on it; without this the
    // subscribe goes out untyped.
    encodeDefaults = true
  },
  private val initialBackoffMs: Long = 1_000,
  private val maxBackoffMs: Long = 30_000,
) : DaemonNotificationSource {

  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

  private val _notifications =
    MutableSharedFlow<ListChangedKind>(
      // replay = 1 so a collector that attaches just after a notification still learns the list is
      // stale; with replay = 0 the emission is dropped outright when nobody is collecting yet.
      replay = 1,
      // A burst of changes only means "refetch", so coalescing is fine.
      extraBufferCapacity = 16,
      onBufferOverflow = BufferOverflow.DROP_OLDEST,
    )
  override val notifications: SharedFlow<ListChangedKind> = _notifications.asSharedFlow()

  private val _state =
    MutableStateFlow<NotificationSubscriptionState>(NotificationSubscriptionState.Idle)
  override val state: StateFlow<NotificationSubscriptionState> = _state.asStateFlow()

  private var connectionJob: Job? = null
  private var channel: SocketChannel? = null

  @Volatile private var shouldReconnect = false

  override fun connect() {
    if (connectionJob?.isActive == true) return
    shouldReconnect = true
    connectionJob = scope.launch { connectWithRetry() }
  }

  override fun disconnect() {
    shouldReconnect = false
    connectionJob?.cancel()
    connectionJob = null
    closeChannel()
    _state.value = NotificationSubscriptionState.Idle
  }

  /** Disconnects and cancels the internal scope. The instance must not be reused afterwards. */
  fun dispose() {
    disconnect()
    scope.coroutineContext[Job]?.cancel()
  }

  private suspend fun connectWithRetry() {
    var attempt = 0

    while (shouldReconnect) {
      _state.value = NotificationSubscriptionState.Connecting
      try {
        if (!Files.exists(Path.of(socketPathValue))) {
          throw IllegalStateException("Daemon socket not found at $socketPathValue")
        }

        SocketChannel.open(UnixDomainSocketAddress.of(socketPathValue)).use { socket ->
          channel = socket
          val reader =
            BufferedReader(
              InputStreamReader(Channels.newInputStream(socket), StandardCharsets.UTF_8)
            )
          val writer =
            BufferedWriter(
              OutputStreamWriter(Channels.newOutputStream(socket), StandardCharsets.UTF_8)
            )

          if (!subscribe(reader, writer)) {
            // Unsupported: the daemon answered, it just does not know this method. Reconnecting
            // would produce the same answer forever.
            return
          }

          attempt = 0
          _state.value = NotificationSubscriptionState.Subscribed
          readNotifications(reader)
        }
      } catch (e: Exception) {
        if (!shouldReconnect) return
        LOG.debug("Daemon notification connection failed: ${e.message}")
      } finally {
        channel = null
      }

      if (!shouldReconnect) return
      attempt++
      val backoff = min(initialBackoffMs shl (attempt - 1).coerceAtMost(5), maxBackoffMs)
      _state.value = NotificationSubscriptionState.Disconnected("Reconnecting in ${backoff}ms")
      delay(backoff)
    }
  }

  /** Returns true when subscribed; false when the daemon does not support the method. */
  private fun subscribe(reader: BufferedReader, writer: BufferedWriter): Boolean {
    val request =
      DaemonNotificationRequest(
        id = UUID.randomUUID().toString(),
        method = SUBSCRIBE_NOTIFICATIONS_METHOD,
      )
    writer.write(json.encodeToString(DaemonNotificationRequest.serializer(), request))
    writer.newLine()
    writer.flush()

    val line = reader.readLine() ?: throw IllegalStateException("Daemon closed during subscribe")
    val response = json.decodeFromString(DaemonFrame.serializer(), line)

    if (response.success != true) {
      val reason = response.error ?: "Daemon does not support pushed notifications"
      LOG.info("Daemon notifications unavailable: $reason")
      _state.value = NotificationSubscriptionState.Unsupported(reason)
      return false
    }
    return true
  }

  private fun readNotifications(reader: BufferedReader) {
    while (shouldReconnect) {
      val line = reader.readLine() ?: return
      if (line.isBlank()) continue

      val frame =
        try {
          json.decodeFromString(DaemonFrame.serializer(), line)
        } catch (e: Exception) {
          // A frame this client does not model is not a reason to drop the subscription.
          LOG.debug("Ignoring unparseable daemon frame: ${e.message}")
          continue
        }

      if (frame.type != "daemon_notification") continue
      val kind = ListChangedKind.forMethod(frame.method)
      if (kind == null) {
        LOG.debug("Ignoring unknown daemon notification: ${frame.method}")
        continue
      }
      _notifications.tryEmit(kind)
    }
  }

  private fun closeChannel() {
    try {
      channel?.close()
    } catch (e: Exception) {
      LOG.debug("Closing the daemon notification socket failed: ${e.message}")
    }
    channel = null
  }
}

@Serializable
internal data class DaemonNotificationRequest(
  val id: String,
  val type: String = "mcp_request",
  val method: String,
)

/**
 * Lenient view of anything the control socket sends.
 *
 * Every field is optional on purpose: a `daemon_notification` carries no `id` and no `success`,
 * while an `mcp_response` carries both. Modelling them as one tolerant shape avoids failing to
 * decode the very frames this client exists to read.
 */
@Serializable
internal data class DaemonFrame(
  val id: String? = null,
  val type: String? = null,
  val success: Boolean? = null,
  val method: String? = null,
  val error: String? = null,
)

/** In-memory [DaemonNotificationSource] for previews and tests. */
class FakeDaemonNotificationSource(private val unsupportedReason: String? = null) :
  DaemonNotificationSource {
  private val _notifications =
    MutableSharedFlow<ListChangedKind>(
      extraBufferCapacity = 16,
      onBufferOverflow = BufferOverflow.DROP_OLDEST,
    )
  override val notifications: SharedFlow<ListChangedKind> = _notifications.asSharedFlow()

  private val _state =
    MutableStateFlow<NotificationSubscriptionState>(NotificationSubscriptionState.Idle)
  override val state: StateFlow<NotificationSubscriptionState> = _state.asStateFlow()

  override fun connect() {
    _state.value =
      if (unsupportedReason != null) NotificationSubscriptionState.Unsupported(unsupportedReason)
      else NotificationSubscriptionState.Subscribed
  }

  override fun disconnect() {
    _state.value = NotificationSubscriptionState.Idle
  }

  /** Pushes a notification, as the daemon would. */
  fun emit(kind: ListChangedKind) {
    _notifications.tryEmit(kind)
  }
}
