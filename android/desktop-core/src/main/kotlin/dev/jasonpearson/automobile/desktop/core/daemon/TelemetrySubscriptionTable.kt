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
  var rejections = 0
  var retryJob: Job? = null
  var released = false

  override fun retry() = onRetry(this)

  override fun close() = onClose(this)
}

/**
 * The bookkeeping of one multiplexed telemetry socket: which device each in-flight `subscribe`
 * request and each acknowledged `subscriptionId` belongs to. Every member is guarded by [lock].
 */
internal class TelemetrySubscriptionTable {
  val lock = Any()
  private val entries = LinkedHashSet<MuxSubscription>()
  private val bySubscriptionId = HashMap<String, MuxSubscription>()
  private val byRequestId = HashMap<String, MuxSubscription>()
  var socket: TelemetrySocket? = null
  var connection: Job? = null
  var sessionRejected = false
  var closed = false

  /** Nothing to connect for: no live subscriptions, a refused session, or a closed client. */
  val idle: Boolean
    get() = entries.isEmpty() || sessionRejected || closed

  fun add(entry: MuxSubscription) {
    entries.add(entry)
  }

  fun snapshot(): List<MuxSubscription> = entries.toList()

  /**
   * Record a `subscribe` for [entry] as [requestId]; false when released or already subscribing.
   */
  fun begin(entry: MuxSubscription, requestId: String): Boolean {
    if (entry.released || entry.requestId != null || entry.subscriptionId != null) return false
    entry.requestId = requestId
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
