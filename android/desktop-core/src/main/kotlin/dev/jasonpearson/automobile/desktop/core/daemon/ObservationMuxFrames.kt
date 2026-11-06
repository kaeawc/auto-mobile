package dev.jasonpearson.automobile.desktop.core.daemon

import dev.jasonpearson.automobile.desktop.core.connection.ConnectionState
import dev.jasonpearson.automobile.desktop.core.logging.Logger
import kotlinx.serialization.SerializationException
import kotlinx.serialization.serializer

/**
 * Handles one frame from the multiplexed observation socket: routes data frames by `subscriptionId`
 * (or a reply by its request id), settles `subscribe` acknowledgements, and confines a refused or
 * daemon-ended subscription to its own device unless the daemon refused the desktop session itself,
 * which fails every device.
 */
internal class ObservationMuxFrames(
  private val table: ObservationMuxTable,
  private val wire: ObservationMuxWire,
  private val storage: ObservationMuxStorage,
  private val log: Logger,
) {
  fun handle(open: TelemetrySocket, line: String) {
    val response =
      try {
        DaemonJson.decodeFromString(serializer<StreamResponse>(), line)
      } catch (e: SerializationException) {
        log.warn("Malformed observation stream message; skipped: ${e.message}")
        return
      } catch (e: IllegalArgumentException) {
        log.warn("Malformed observation stream message; skipped: ${e.message}")
        return
      }
    when (response.type) {
      "ping" -> wire.write(open, wire.pong())
      "subscription_response" ->
        if (response.success == true) acknowledge(open, response) else refuse(response)
      "error" -> refuse(response)
      "device_session_started" -> Unit
      "storage_reconciliation_required" -> storage.reconcile(response)
      else -> route(response)
    }
  }

  private fun route(response: StreamResponse) {
    val (channel, unsolicited) =
      synchronized(table.lock) {
        val channel = table.target(response.subscriptionId) ?: table.requests.take(response.id)
        channel to (channel != null && unsolicitedStorage(channel, response))
      }
    if (channel == null) {
      log.debug("Observation ${response.type} for no live subscription; dropped")
      return
    }
    if (unsolicited) return
    if (!channel.flows.deliver(response)) log.warn("Unknown message type: ${response.type}")
  }

  /**
   * Called under the table lock. The daemon pushes a device's `storage_update` frames to every
   * observation subscription for that device, so a stream also receives files another client
   * observes. The storage queue is unbounded and lossless, so only files [channel] wants may enter
   * it; anything else would be retained until a local storage collector starts, which may be never
   * (#17040).
   */
  private fun unsolicitedStorage(
    channel: MuxObservationChannel,
    response: StreamResponse,
  ): Boolean {
    if (response.type != "storage_update") return false
    val event = response.storageEvent ?: return false
    return !channel.storage.isDesired(StorageSubscriptionKey(event.packageName, event.fileName))
  }

  private fun acknowledge(open: TelemetrySocket, response: StreamResponse) {
    val id = response.id ?: return
    if (storage.resolve(id, success = true, error = null)) return
    val ack =
      synchronized(table.lock) {
        // An on-demand request's acknowledgement completes it; unsubscribe/cadence acks match
        // nothing.
        if (table.requests.take(id) != null) return
        val subscriptionId = response.subscriptionId ?: return
        table.acknowledge(id, subscriptionId)
      }
    when (ack) {
      is SubscribeAck.Stale -> wire.write(open, wire.unsubscribe(ack.subscriptionId))
      is SubscribeAck.Live ->
        if (ack.cadenceDirty) {
          val cadence =
            synchronized(table.lock) {
              ack.channel.subscriptionId?.let { wire.cadence(ack.channel, it) }
            }
          cadence?.let { wire.write(open, it) }
        }
      null -> Unit
    }
  }

  private fun refuse(response: StreamResponse) {
    val error = response.error
    // Checked first: a refused session fails every device, whichever request the refusal answers,
    // including a storage command (#17117).
    if (isStreamSessionRejection(error)) {
      rejectSession(error)
      return
    }
    if (response.id?.let { storage.resolve(it, success = false, error = error) } == true) return
    val id = response.id
    val refused =
      synchronized(table.lock) {
        if (table.requests.take(id) != null) {
          log.warn("Observation request failed: $error")
          return
        }
        table.refuse(id)
      }
    if (refused != null) {
      log.warn("Observation subscription for ${refused.deviceId} refused: $error")
      refused.mutableState.value = ConnectionState.Disconnected(error ?: "Subscription failed")
      return
    }
    subscriptionError(response)
  }

  /** An error pushed to one acknowledged subscription. */
  private fun subscriptionError(response: StreamResponse) {
    val subscriptionId = response.subscriptionId
    val channel = synchronized(table.lock) { table.target(subscriptionId) }
    if (subscriptionId == null || channel == null) {
      log.warn("Observation stream error: ${response.error}")
      return
    }
    val lost = response.toConnectionLost()
    if (lost != null) {
      channel.flows.connectionLost(lost)
      return
    }
    // Any other error naming a subscription (e.g. a backfill overflow) means the daemon ended it
    // while the socket stays open for the other devices; the owner subscribes it again.
    val live = synchronized(table.lock) { table.end(subscriptionId, channel) }
    log.warn("Observation subscription for ${channel.deviceId} ended: ${response.error}")
    if (live) channel.mutableState.value = ConnectionState.Disconnected(response.error)
  }

  private fun rejectSession(error: String?) {
    log.warn("Observation subscription refused for this session: $error")
    val all =
      synchronized(table.lock) {
        table.sessionRejected = true
        table.forgetSubscriptions()
        table.channels.toList()
      }
    // The reader stops after this frame and closes the socket.
    all.forEach {
      it.mutableState.value = ConnectionState.Error(error ?: "Session registration required")
    }
  }
}
