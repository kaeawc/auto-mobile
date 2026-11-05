package dev.jasonpearson.automobile.desktop.core.daemon

import kotlinx.coroutines.Job

/** In-flight requests whose replies name only the request id, by the device that sent each. */
internal class PendingRequests {
  private val byId = HashMap<String, MuxObservationChannel>()

  fun put(id: String, channel: MuxObservationChannel) {
    byId[id] = channel
  }

  fun take(id: String?): MuxObservationChannel? = id?.let(byId::remove)

  fun drop(channel: MuxObservationChannel) {
    byId.values.removeAll { it === channel }
  }

  fun clear() = byId.clear()
}

/** A connection taken off the table, to be cancelled and closed outside its lock. */
internal class DetachedObservationConnection(val reader: Job?, val socket: TelemetrySocket?)

/** What a `subscribe` acknowledgement settles. */
internal sealed interface SubscribeAck {
  /** Released or re-subscribed while in flight: the daemon-side subscription must go. */
  data class Stale(val subscriptionId: String) : SubscribeAck

  /** [channel] is now subscribed; [cadenceDirty] when its cadence changed in flight. */
  data class Live(val channel: MuxObservationChannel, val cadenceDirty: Boolean) : SubscribeAck
}

/**
 * The bookkeeping of one multiplexed observation socket: which device each in-flight request and
 * each acknowledged `subscriptionId` belongs to. Every member, and every [MuxObservationChannel]
 * field it touches, is guarded by [lock].
 */
internal class ObservationMuxTable {
  val lock = Any()
  var socket: TelemetrySocket? = null
  var connection: Job? = null
  var sessionRejected = false
  var closed = false
  val channels = LinkedHashSet<MuxObservationChannel>()
  // `subscribe` requests stay mapped after a release, so a late acknowledgement is unsubscribed.
  val subscribes = PendingRequests()
  // On-demand requests (`request_navigation_graph`, `request_observation`).
  val requests = PendingRequests()
  private val bySubscriptionId = HashMap<String, MuxObservationChannel>()

  fun target(subscriptionId: String?): MuxObservationChannel? =
    subscriptionId?.let(bySubscriptionId::get)

  /**
   * Put [channel] on [open] with a `subscribe` recorded as [requestId]; false when it cannot
   * subscribe there (the socket was replaced, the client closed, the stream disposed or the session
   * refused).
   */
  fun register(channel: MuxObservationChannel, open: TelemetrySocket, requestId: String): Boolean {
    if (socket !== open || closed) return false
    if (channel.disposed || sessionRejected) return false
    channel.live = true
    channels.add(channel)
    channel.subscriptionId?.let(bySubscriptionId::remove)
    channel.subscriptionId = null
    channel.cadenceDirty = false
    channel.requestId = requestId
    subscribes.put(requestId, channel)
    return true
  }

  /** Settle the `subscribe` [requestId] as [subscriptionId]; null when it is not one of ours. */
  fun acknowledge(requestId: String, subscriptionId: String): SubscribeAck? {
    val channel = subscribes.take(requestId) ?: return null
    if (channel.requestId != requestId || !channel.live) return SubscribeAck.Stale(subscriptionId)
    channel.requestId = null
    channel.subscriptionId = subscriptionId
    bySubscriptionId[subscriptionId] = channel
    val dirty = channel.cadenceDirty
    channel.cadenceDirty = false
    return SubscribeAck.Live(channel, dirty)
  }

  /** The device whose current `subscribe` [requestId] the daemon refused, if any. */
  fun refuse(requestId: String?): MuxObservationChannel? =
    subscribes
      .take(requestId)
      ?.takeIf { it.requestId == requestId }
      ?.also {
        it.requestId = null
        it.cadenceDirty = false
      }

  /** The daemon ended [channel]'s [subscriptionId] on its own; true while [channel] is live. */
  fun end(subscriptionId: String, channel: MuxObservationChannel): Boolean {
    if (bySubscriptionId[subscriptionId] !== channel) return false
    bySubscriptionId.remove(subscriptionId)
    channel.subscriptionId = null
    return channel.live
  }

  /** Take [channel] off the socket; returns its acknowledged `subscriptionId` to unsubscribe. */
  fun leave(channel: MuxObservationChannel): String? {
    channel.live = false
    channels.remove(channel)
    channel.requestId = null
    channel.cadenceDirty = false
    requests.drop(channel)
    val released = channel.subscriptionId?.also { bySubscriptionId.remove(it) }
    channel.subscriptionId = null
    return released
  }

  /** Forget every daemon-side subscription: the socket carrying them is gone. */
  fun forgetSubscriptions() {
    bySubscriptionId.clear()
    subscribes.clear()
    requests.clear()
    channels.forEach {
      it.subscriptionId = null
      it.requestId = null
      it.cadenceDirty = false
    }
  }

  /** Hand the connection over to be shut down outside the lock, once no device is left. */
  fun detach(): DetachedObservationConnection {
    val detached = DetachedObservationConnection(connection, socket)
    socket = null
    connection = null
    forgetSubscriptions()
    // A refused session is refused for the devices that saw it; a later lease (e.g. after the
    // desktop session registers again) may try afresh.
    sessionRejected = false
    return detached
  }
}
