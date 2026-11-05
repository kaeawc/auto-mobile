package dev.jasonpearson.automobile.desktop.core.daemon

import dev.jasonpearson.automobile.desktop.core.connection.ConnectionState
import dev.jasonpearson.automobile.desktop.core.telemetry.TelemetryDisplayEvent
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** One device's subscription on a [MultiplexedTelemetrySocketClient]. */
internal class MuxSubscription(
  val key: DeviceStreamKey,
  val sink: (TelemetryDisplayEvent) -> Unit,
  private val onRetry: (MuxSubscription) -> Unit,
  private val onClose: (MuxSubscription) -> Unit,
) : TelemetrySubscription {
  val mutableState = MutableStateFlow<ConnectionState>(ConnectionState.Connecting)
  override val state: StateFlow<ConnectionState> = mutableState.asStateFlow()

  // Guarded by the owning [TelemetrySubscriptionTable.lock].
  var subscriptionId: String? = null
  var requestId: String? = null
  /** The desktop session UUID the in-flight `subscribe` ([requestId]) was sent under. */
  var requestSessionUuid: String? = null
  var rejections = 0
  var retryJob: Job? = null
  var released = false

  override fun retry() = onRetry(this)

  override fun close() = onClose(this)
}

/** The daemon refused desktop session [sessionUuid] with [error]. */
internal data class SessionRefusal(val sessionUuid: String?, val error: String)

/**
 * The bookkeeping of one multiplexed telemetry socket: which device each in-flight `subscribe`
 * request and each acknowledged `subscriptionId` belongs to. Every member is guarded by [lock].
 * [currentSessionUuid] is the desktop session UUID a new `subscribe` would be sent under.
 */
internal class TelemetrySubscriptionTable(
  private val currentSessionUuid: () -> String? = { null },
) {
  val lock = Any()
  private val entries = LinkedHashSet<MuxSubscription>()
  private val bySubscriptionId = HashMap<String, MuxSubscription>()
  private val byRequestId = HashMap<String, MuxSubscription>()
  var socket: TelemetrySocket? = null
  var connection: Job? = null
  private var refusal: SessionRefusal? = null
  var closed = false

  /**
   * The recorded session refusal while it still applies: until a different, non-null desktop
   * session UUID is current, subscribing again would only be refused again (#17018).
   */
  val activeRefusal: SessionRefusal?
    get() = refusal?.takeIf { refused ->
      val current = currentSessionUuid()
      current == null || current == refused.sessionUuid
    }

  /** Nothing to connect for: no live subscriptions, a refused session, or a closed client. */
  val idle: Boolean
    get() = entries.isEmpty() || activeRefusal != null || closed

  /**
   * Record that the daemon refused the desktop session with [error]: the session the refused
   * request [requestId] was sent under, or the current one when the frame names no request. Returns
   * every live subscription, to be told.
   */
  fun refuseSession(requestId: String?, error: String): List<MuxSubscription> {
    val refusedUuid = reject(requestId)?.requestSessionUuid ?: currentSessionUuid()
    refusal = SessionRefusal(refusedUuid, error)
    return snapshot()
  }

  fun add(entry: MuxSubscription) {
    entries.add(entry)
  }

  fun snapshot(): List<MuxSubscription> = entries.toList()

  /**
   * Record a `subscribe` for [entry] as [requestId]; false when released or already subscribing.
   */
  fun begin(entry: MuxSubscription, requestId: String, sessionUuid: String?): Boolean {
    if (entry.released || entry.requestId != null || entry.subscriptionId != null) return false
    entry.requestId = requestId
    entry.requestSessionUuid = sessionUuid
    byRequestId[requestId] = entry
    return true
  }

  /**
   * Release [entry]; returns its acknowledged `subscriptionId` to unsubscribe, if any. A
   * `subscribe` still in flight stays mapped so its acknowledgement can be unsubscribed when it
   * arrives.
   */
  fun remove(entry: MuxSubscription): String? {
    if (!entries.remove(entry)) return null
    entry.released = true
    entry.retryJob?.cancel()
    return entry.subscriptionId?.also {
      bySubscriptionId.remove(it)
      entry.subscriptionId = null
    }
  }

  /** The device whose `subscribe` [requestId] was acknowledged as [subscriptionId], if any. */
  fun acknowledge(requestId: String?, subscriptionId: String): MuxSubscription? {
    val entry = requestId?.let(byRequestId::remove) ?: return null
    entry.requestId = null
    if (!entry.released) {
      entry.subscriptionId = subscriptionId
      entry.rejections = 0
      bySubscriptionId[subscriptionId] = entry
    }
    return entry
  }

  /** The device whose `subscribe` [requestId] the daemon refused, if any. */
  fun reject(requestId: String?): MuxSubscription? =
    requestId?.let(byRequestId::remove)?.also { it.requestId = null }

  fun target(subscriptionId: String?): MuxSubscription? = subscriptionId?.let(bySubscriptionId::get)

  /**
   * The device whose acknowledged [subscriptionId] the daemon ended on its own (e.g. a backfill
   * overflow) while the socket stays open; its mapping is cleared so it can subscribe again.
   */
  fun end(subscriptionId: String?): MuxSubscription? =
    subscriptionId?.let(bySubscriptionId::remove)?.also { it.subscriptionId = null }

  /**
   * Take the connection off the table, returning its job and socket to shut down outside [lock].
   * Its in-flight `subscribe` requests are dropped too: the socket is closing, so their
   * acknowledgements can never arrive, and a released subscription must not stay reachable.
   */
  fun detach(): Pair<Job?, TelemetrySocket?> {
    val detached = connection to socket
    connection = null
    socket = null
    byRequestId.values.forEach { it.requestId = null }
    byRequestId.clear()
    return detached
  }

  /** Forget every daemon-side subscription: the socket carrying them is gone. */
  fun resetSubscriptions() {
    bySubscriptionId.clear()
    byRequestId.clear()
    entries.forEach {
      it.subscriptionId = null
      it.requestId = null
      it.retryJob?.cancel()
    }
  }
}

/** Publish [state] to every subscription in this snapshot. */
internal fun List<MuxSubscription>.publish(state: ConnectionState) = forEach {
  it.mutableState.value = state
}
