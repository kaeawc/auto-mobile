package dev.jasonpearson.automobile.desktop.core.daemon

import dev.jasonpearson.automobile.desktop.core.connection.ConnectionState
import dev.jasonpearson.automobile.desktop.core.logging.Logger
import dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory
import java.util.UUID
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.plus

/**
 * Carries every observed device's observation stream for the [SharedDaemonStreamHub]. Each [stream]
 * is one device's [ObservationStream]; all of them share one connection.
 */
interface ObservationMultiplexer {
  /** A new device stream on the shared connection; [ObservationStream.connect] subscribes it. */
  fun stream(): ObservationStream

  /** Release every subscription and the connection. */
  fun close()
}

/**
 * Every observed device's observation stream over ONE socket and ONE reader thread (#17011). Each
 * device stream sends its own device-scoped `subscribe` (carrying its own cadence), so the daemon
 * gives it its own `subscriptionId`; data frames are routed by that id, and replies to a device's
 * `request_navigation_graph` / `request_observation` by the request's own id. `update_cadence` and
 * `unsubscribe` name the device's `subscriptionId`.
 *
 * Reconnecting is the owner's job, as it is for the per-device client: when the socket drops, every
 * device stream reports Disconnected, and the hub's per-device supervision calls `connect` again,
 * which reopens the shared socket once and re-subscribes that device. A device the daemon refuses,
 * or whose subscription the daemon ends, goes Disconnected alone; only a refused desktop session,
 * which no device can recover from, fails them all. The socket closes with the last device stream.
 */
internal class MultiplexedObservationSocketClient(
  transport: ObservationMuxTransport,
  parentScope: CoroutineScope,
  private val sessionUuidProvider: (() -> String?)? = null,
  private val log: Logger = LoggerFactory.getLogger(MultiplexedObservationSocketClient::class.java),
  newRequestId: () -> String = { UUID.randomUUID().toString() },
) : ObservationMultiplexer {
  // A child of [parentScope], so closing this client never cancels its caller's scope.
  private val job = SupervisorJob(parentScope.coroutineContext[Job])
  private val table = ObservationMuxTable()
  private val wire = ObservationMuxWire(log, newRequestId, sessionUuidProvider)
  private val storage = ObservationMuxStorage(table, wire, log)
  private val connection =
    ObservationMuxConnection(
      transport,
      table,
      wire,
      ObservationMuxFrames(table, wire, storage, log),
      parentScope + job,
      log,
    )

  override fun stream(): ObservationStream = MuxObservationChannel(this)

  override fun close() {
    val (all, detached) =
      synchronized(table.lock) {
        table.closed = true
        val all = table.channels.toList().onEach { it.live = false }
        table.channels.clear()
        all to table.detach()
      }
    all.forEach { it.mutableState.value = ConnectionState.Disconnected() }
    connection.shutDown(detached)
    job.cancel()
  }

  fun connect(channel: MuxObservationChannel, deviceId: String?, deviceSessionUuid: String?) {
    if (!canSubscribe()) return
    synchronized(table.lock) {
      if (table.closed || channel.disposed) return
      // Connected, or a subscribe already in flight: nothing to do (the hub's manual retry).
      if (channel.live && (channel.isConnected() || channel.requestId != null)) return
    }
    channel.mutableState.value = ConnectionState.Connecting
    val open =
      try {
        connection.open()
      } catch (e: java.io.IOException) {
        log.warn("Failed to connect to observation stream: ${e.message}")
        channel.mutableState.value = ConnectionState.Disconnected(e.message)
        return
      }
    val (request, unused) =
      synchronized(table.lock) {
        channel.deviceId = deviceId
        channel.deviceSessionUuid = deviceSessionUuid
        val id = wire.newId()
        val registered = table.register(channel, open, id)
        // Subscribed once the request is on the wire, as the per-device client reports it; a
        // refusal takes it down again.
        if (registered) channel.mutableState.value = ConnectionState.Connected(subscribed = true)
        // Opened for a stream released meanwhile, with no other device on it: close it again.
        val idle = !registered && table.channels.isEmpty() && table.socket === open
        (if (registered) wire.subscribe(channel, id) else null) to
          (if (idle) table.detach() else null)
      }
    if (request == null) {
      unused?.let(connection::shutDown)
      // The socket ended or the stream was released while opening: report it down so the owner's
      // supervision decides whether to try again.
      channel.mutableState.value = ConnectionState.Disconnected("Stream ended")
      return
    }
    wire.write(open, request)
    // Re-register the device's remembered storage observers, so live updates survive a reconnect.
    storage.reapply(channel)
  }

  fun disconnect(channel: MuxObservationChannel, dispose: Boolean) {
    val release =
      synchronized(table.lock) {
        if (dispose) channel.disposed = true
        if (!channel.live) return@synchronized null
        val released = table.leave(channel)
        // Decide and detach in one step: a device connecting right after this release must open
        // a fresh connection, not join the socket being shut down.
        val detached = if (table.channels.isEmpty()) table.detach() else null
        // A closing socket releases its observers on the daemon by itself; an open one is told.
        val owed = if (detached == null) storage.release(channel) else emptyList()
        channel.storage.connectionReset()
        Release(table.socket ?: detached?.socket, released, owed, detached)
      }
    if (dispose) channel.flows.closeStorage()
    channel.mutableState.value = ConnectionState.Disconnected()
    release ?: return
    release.socket?.let { open ->
      release.subscriptionId?.let { wire.write(open, wire.unsubscribe(it)) }
      release.storage.forEach { wire.write(open, it) }
    }
    release.detached?.let(connection::shutDown)
  }

  fun subscribeStorage(channel: MuxObservationChannel, key: StorageSubscriptionKey) =
    storage.subscribe(channel, key)

  fun unsubscribeStorage(channel: MuxObservationChannel, key: StorageSubscriptionKey) =
    storage.unsubscribe(channel, key)

  fun setCadence(channel: MuxObservationChannel, cadence: ObservationCadence) {
    val (open, request) =
      synchronized(table.lock) {
        if (channel.cadence == cadence) return
        channel.cadence = cadence
        val subscriptionId = channel.subscriptionId
        if (subscriptionId == null) {
          // The in-flight subscribe carries the older cadence; send this one on acknowledgement.
          if (channel.requestId != null) channel.cadenceDirty = true
          return
        }
        (table.socket ?: return) to wire.cadence(channel, subscriptionId)
      }
    wire.write(open, request)
  }

  fun requestNavigationGraph(channel: MuxObservationChannel, appId: String?) =
    send(channel) { id -> wire.navigationGraph(channel, id, appId) }

  fun requestObservation(channel: MuxObservationChannel, deviceId: String?) =
    send(channel) { id -> wire.observation(channel, id, deviceId) }

  private fun canSubscribe(): Boolean =
    synchronized(table.lock) { !table.sessionRejected } &&
      (sessionUuidProvider == null || sessionUuidProvider.invoke() != null)

  /** Send an on-demand request whose reply names only its id, routed back to [channel]. */
  private inline fun send(channel: MuxObservationChannel, build: (String) -> StreamRequest) {
    val (open, request) =
      synchronized(table.lock) {
        if (!channel.live || !channel.isConnected()) return
        val open = table.socket ?: return
        val id = wire.newId()
        table.requests.put(id, channel)
        open to build(id)
      }
    wire.write(open, request)
  }

  /** What a released device still owes the daemon, sent outside the lock. */
  private class Release(
    val socket: TelemetrySocket?,
    val subscriptionId: String?,
    val storage: List<StreamRequest>,
    val detached: DetachedObservationConnection?,
  )

  companion object {
    /** The desktop's production multiplexer: one observation socket for every observed device. */
    fun create(
      sessionUuidProvider: () -> String?,
      ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
    ): ObservationMultiplexer =
      MultiplexedObservationSocketClient(
        ObservationMuxTransport(),
        CoroutineScope(SupervisorJob() + ioDispatcher),
        sessionUuidProvider,
      )
  }
}
