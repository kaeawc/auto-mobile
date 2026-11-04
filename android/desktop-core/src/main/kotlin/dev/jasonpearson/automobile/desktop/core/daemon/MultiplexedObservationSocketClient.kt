package dev.jasonpearson.automobile.desktop.core.daemon

import dev.jasonpearson.automobile.desktop.core.connection.ConnectionState
import dev.jasonpearson.automobile.desktop.core.logging.Logger
import dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory
import java.nio.file.Files
import java.nio.file.Path
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.plus
import kotlinx.coroutines.runInterruptible
import kotlinx.serialization.SerializationException
import kotlinx.serialization.serializer

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

/** How [MultiplexedObservationSocketClient] reaches the daemon; every member is a test seam. */
internal class ObservationMuxTransport(
  // A line socket: the same AF_UNIX transport the telemetry multiplexer uses.
  val openSocket: (String) -> TelemetrySocket = ::ChannelTelemetrySocket,
  val socketAvailable: (String) -> Boolean = { Files.exists(Path.of(it)) },
  val socketPath: () -> String = { ObservationStreamClient.getSocketPath() },
  val readerThreads: StreamReaderDispatcherFactory = DedicatedStreamReaderThreads,
)

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
  private val transport: ObservationMuxTransport,
  parentScope: CoroutineScope,
  private val sessionUuidProvider: (() -> String?)? = null,
  private val log: Logger = LoggerFactory.getLogger(MultiplexedObservationSocketClient::class.java),
  private val newRequestId: () -> String = { UUID.randomUUID().toString() },
) : ObservationMultiplexer {
  // A child of [parentScope], so closing this client never cancels its caller's scope.
  private val job = SupervisorJob(parentScope.coroutineContext[Job])
  private val scope = parentScope + job

  // Every field below is guarded by [lock].
  private val lock = Any()
  private var socket: TelemetrySocket? = null
  private var connection: Job? = null
  private val channels = LinkedHashSet<MuxObservationChannel>()
  private val bySubscriptionId = HashMap<String, MuxObservationChannel>()
  // In-flight `subscribe` requests, kept after a release so a late acknowledgement is unsubscribed.
  private val bySubscribeRequest = HashMap<String, MuxObservationChannel>()
  // In-flight on-demand requests, whose replies carry only the request id.
  private val byRequest = HashMap<String, MuxObservationChannel>()
  private var sessionRejected = false
  private var closed = false

  // Serializes opening the shared socket, so devices connecting together open it once.
  private val openLock = Any()
  // A request frame is one write; keep concurrent writers (commands, pongs) from interleaving.
  private val writeLock = Any()

  override fun stream(): ObservationStream = MuxObservationChannel(this)

  override fun close() {
    val (all, detached) =
      synchronized(lock) {
        closed = true
        channels.toList().onEach { it.live = false }.also { channels.clear() } to detach()
      }
    all.forEach { it.mutableState.value = ConnectionState.Disconnected() }
    shutDown(detached)
    job.cancel()
  }

  fun connect(channel: MuxObservationChannel, deviceId: String?, deviceSessionUuid: String?) {
    if (!canSubscribe()) return
    synchronized(lock) {
      if (closed || channel.disposed) return
      // Connected, or a subscribe already in flight: nothing to do (the hub's manual retry).
      if (channel.live && (channel.isConnected() || channel.requestId != null)) return
    }
    channel.mutableState.value = ConnectionState.Connecting
    val open =
      try {
        openSocket()
      } catch (e: java.io.IOException) {
        log.warn("Failed to connect to observation stream: ${e.message}")
        channel.mutableState.value = ConnectionState.Disconnected(e.message)
        return
      }
    val (request, unused) =
      synchronized(lock) {
        val request = register(channel, open, deviceId, deviceSessionUuid)
        // Opened for a stream released meanwhile, with no other device on it: close it again.
        request to if (request == null && channels.isEmpty() && socket === open) detach() else null
      }
    if (request == null) {
      unused?.let(::shutDown)
      // The socket ended or the stream was released while opening: report it down so the owner's
      // supervision decides whether to try again.
      channel.mutableState.value = ConnectionState.Disconnected("Stream ended")
      return
    }
    write(open, request)
  }

  fun disconnect(channel: MuxObservationChannel, dispose: Boolean) {
    val (open, released, detached) =
      synchronized(lock) {
        if (dispose) channel.disposed = true
        if (!channel.live)
          return@synchronized Triple<TelemetrySocket?, String?, Detached?>(null, null, null)
        channel.live = false
        channels.remove(channel)
        channel.requestId = null
        channel.cadenceDirty = false
        byRequest.values.removeAll { it === channel }
        val released = channel.subscriptionId?.also { bySubscriptionId.remove(it) }
        channel.subscriptionId = null
        val open = socket
        // Decide and detach in one step: a device connecting right after this release must open
        // a fresh connection, not join the socket being shut down.
        Triple(open, released, if (channels.isEmpty()) detach() else null)
      }
    channel.mutableState.value = ConnectionState.Disconnected()
    if (open != null && released != null) write(open, unsubscribe(released))
    detached?.let(::shutDown)
  }

  fun setCadence(channel: MuxObservationChannel, cadence: ObservationCadence) {
    val (open, request) =
      synchronized(lock) {
        if (channel.cadence == cadence) return
        channel.cadence = cadence
        val subscriptionId = channel.subscriptionId
        if (subscriptionId == null) {
          // The in-flight subscribe carries the older cadence; send this one on acknowledgement.
          if (channel.requestId != null) channel.cadenceDirty = true
          return
        }
        (socket ?: return) to cadenceUpdate(channel, subscriptionId)
      }
    write(open, request)
  }

  fun requestNavigationGraph(channel: MuxObservationChannel, appId: String?) =
    sendRequest(channel) { id ->
      StreamRequest(
        id = id,
        command = "request_navigation_graph",
        appId = appId,
        deviceSessionUuid = channel.deviceSessionUuid,
        sessionUuid = sessionUuidProvider?.invoke(),
      )
    }

  fun requestObservation(channel: MuxObservationChannel, deviceId: String?) =
    sendRequest(channel) { id ->
      StreamRequest(
        id = id,
        command = "request_observation",
        deviceId = deviceId,
        deviceSessionUuid = channel.deviceSessionUuid,
        sessionUuid = sessionUuidProvider?.invoke(),
      )
    }

  private fun canSubscribe(): Boolean =
    synchronized(lock) { !sessionRejected } &&
      (sessionUuidProvider == null || sessionUuidProvider.invoke() != null)

  private inline fun sendRequest(
    channel: MuxObservationChannel,
    build: (String) -> StreamRequest,
  ) {
    val (open, request) =
      synchronized(lock) {
        if (!channel.live || !channel.isConnected()) return
        val open = socket ?: return
        val id = newRequestId()
        byRequest[id] = channel
        open to build(id)
      }
    write(open, request)
  }

  /** The shared socket, opened (with its reader) by the first device to need it. */
  private fun openSocket(): TelemetrySocket =
    synchronized(openLock) {
      synchronized(lock) {
        if (closed) throw java.io.IOException("Observation multiplexer is closed")
        socket?.let {
          return it
        }
      }
      val path = transport.socketPath()
      if (!transport.socketAvailable(path)) {
        log.warn("Observation stream socket not found at $path")
        throw java.io.IOException("Socket not found")
      }
      val open = transport.openSocket(path)
      synchronized(lock) {
        if (closed) {
          closeQuietly(open)
          throw java.io.IOException("Observation multiplexer is closed")
        }
        socket = open
        connection = scope.launch { read(open) }
      }
      log.info("Connected to observation stream (multiplexed)")
      open
    }

  // Called under [lock]. The `subscribe` for [channel] on [open], or null if it cannot subscribe.
  private fun register(
    channel: MuxObservationChannel,
    open: TelemetrySocket,
    deviceId: String?,
    deviceSessionUuid: String?,
  ): StreamRequest? {
    if (socket !== open || closed || channel.disposed || sessionRejected) return null
    channel.live = true
    channels.add(channel)
    channel.deviceId = deviceId
    channel.deviceSessionUuid = deviceSessionUuid
    channel.subscriptionId?.let { bySubscriptionId.remove(it) }
    channel.subscriptionId = null
    channel.cadenceDirty = false
    val id = newRequestId()
    channel.requestId = id
    bySubscribeRequest[id] = channel
    // Subscribed once the request is on the wire, as the per-device client reports it; a refusal
    // takes it down again.
    channel.mutableState.value = ConnectionState.Connected(subscribed = true)
    return StreamRequest(
      id = id,
      command = "subscribe",
      sessionUuid = sessionUuidProvider?.invoke(),
      deviceId = deviceId,
      deviceSessionUuid = deviceSessionUuid,
      screenshotIntervalMs = channel.cadence.screenshotIntervalMs,
      hierarchyIntervalMs = channel.cadence.hierarchyIntervalMs,
    )
  }

  private suspend fun read(open: TelemetrySocket) {
    try {
      transport.readerThreads.create(READER_THREAD_NAME).use { readFrames(it, open) }
    } catch (e: CancellationException) {
      throw e
    } catch (e: java.io.IOException) {
      log.warn(ObservationStreamClient.readErrorLogMessage(e))
    } finally {
      ended(open)
    }
  }

  private suspend fun readFrames(readerThread: CoroutineDispatcher, open: TelemetrySocket) {
    while (true) {
      val line = runInterruptible(readerThread) { open.readLine() } ?: return
      currentCoroutineContext().ensureActive()
      if (line.isNotBlank()) handle(open, line)
      if (synchronized(lock) { sessionRejected }) return
    }
  }

  /** The socket [open] is gone: every device on it is down until its owner reconnects it. */
  private fun ended(open: TelemetrySocket) {
    val dropped =
      synchronized(lock) {
        // Only the connection that still owns the table resets it.
        if (socket !== open) return@synchronized emptyList()
        socket = null
        connection = null
        forgetSubscriptions()
        if (sessionRejected) emptyList() else channels.toList()
      }
    closeQuietly(open)
    dropped.forEach { it.mutableState.value = ConnectionState.Disconnected("Stream ended") }
    if (dropped.isNotEmpty()) log.info("Observation stream disconnected")
  }

  private fun handle(open: TelemetrySocket, line: String) {
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
      "ping" -> write(open, StreamRequest(id = newRequestId(), command = "pong"))
      "subscription_response" ->
        if (response.success == true) acknowledge(open, response) else refuse(response)
      "error" -> refuse(response)
      "device_session_started" -> Unit
      else -> route(response)
    }
  }

  private fun route(response: StreamResponse) {
    val channel =
      synchronized(lock) {
        response.subscriptionId?.let(bySubscriptionId::get) ?: response.id?.let(byRequest::remove)
      }
    if (channel == null) {
      log.debug("Observation ${response.type} for no live subscription; dropped")
      return
    }
    if (!channel.deliver(response)) log.warn("Unknown message type: ${response.type}")
  }

  private fun acknowledge(open: TelemetrySocket, response: StreamResponse) {
    val id = response.id ?: return
    val subscriptionId = response.subscriptionId
    val (stale, cadence) =
      synchronized(lock) {
        // An on-demand request's acknowledgement completes it; unsubscribe/cadence acks match
        // nothing.
        if (byRequest.remove(id) != null) return
        val channel = bySubscribeRequest.remove(id) ?: return
        if (subscriptionId == null) return
        if (channel.requestId != id || !channel.live) {
          // Released (or re-subscribed) while this subscribe was in flight.
          return@synchronized Pair<String?, StreamRequest?>(subscriptionId, null)
        }
        channel.requestId = null
        channel.subscriptionId = subscriptionId
        bySubscriptionId[subscriptionId] = channel
        val dirty = channel.cadenceDirty
        channel.cadenceDirty = false
        null to if (dirty) cadenceUpdate(channel, subscriptionId) else null
      }
    stale?.let { write(open, unsubscribe(it)) }
    cadence?.let { write(open, it) }
  }

  private fun refuse(response: StreamResponse) {
    val error = response.error
    if (isStreamSessionRejection(error)) {
      rejectSession(error)
      return
    }
    val id = response.id
    val refused =
      synchronized(lock) {
        if (id != null && byRequest.remove(id) != null) {
          log.warn("Observation request failed: $error")
          return
        }
        id
          ?.let(bySubscribeRequest::remove)
          ?.takeIf { it.requestId == id }
          ?.also {
            it.requestId = null
            it.cadenceDirty = false
          }
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
    val channel = synchronized(lock) { subscriptionId?.let(bySubscriptionId::get) }
    if (channel == null) {
      log.warn("Observation stream error: ${response.error}")
      return
    }
    val lost = response.toConnectionLost()
    if (lost != null) {
      channel.deviceConnectionLost(lost)
      return
    }
    // Any other error naming a subscription (e.g. a backfill overflow) means the daemon ended it
    // while the socket stays open for the other devices; the owner subscribes it again.
    val ended =
      synchronized(lock) {
        if (bySubscriptionId.remove(subscriptionId) !== channel) return
        channel.subscriptionId = null
        channel.live
      }
    log.warn("Observation subscription for ${channel.deviceId} ended: ${response.error}")
    if (ended) channel.mutableState.value = ConnectionState.Disconnected(response.error)
  }

  private fun rejectSession(error: String?) {
    log.warn("Observation subscription refused for this session: $error")
    val all =
      synchronized(lock) {
        sessionRejected = true
        forgetSubscriptions()
        channels.toList()
      }
    // The reader stops after this frame and closes the socket.
    all.forEach {
      it.mutableState.value = ConnectionState.Error(error ?: "Session registration required")
    }
  }

  // Called under [lock]: the daemon-side subscriptions are gone with their socket.
  private fun forgetSubscriptions() {
    bySubscriptionId.clear()
    bySubscribeRequest.clear()
    byRequest.clear()
    channels.forEach {
      it.subscriptionId = null
      it.requestId = null
      it.cadenceDirty = false
    }
  }

  /** A connection taken off the table, to be cancelled and closed outside the lock. */
  private class Detached(val reader: Job?, val socket: TelemetrySocket?)

  // Called under [lock], once no device is left: hands the socket over to be shut down outside it.
  private fun detach(): Detached {
    val detached = Detached(connection, socket)
    socket = null
    connection = null
    forgetSubscriptions()
    // A refused session is refused for the devices that saw it; a later lease (e.g. after the
    // desktop session registers again) may try afresh.
    sessionRejected = false
    return detached
  }

  private fun shutDown(detached: Detached) {
    detached.reader?.cancel()
    closeQuietly(detached.socket)
  }

  private fun cadenceUpdate(channel: MuxObservationChannel, subscriptionId: String) =
    StreamRequest(
      id = newRequestId(),
      command = "update_cadence",
      subscriptionId = subscriptionId,
      deviceId = channel.deviceId,
      deviceSessionUuid = channel.deviceSessionUuid,
      screenshotIntervalMs = channel.cadence.screenshotIntervalMs,
      hierarchyIntervalMs = channel.cadence.hierarchyIntervalMs,
    )

  private fun unsubscribe(subscriptionId: String) =
    StreamRequest(id = newRequestId(), command = "unsubscribe", subscriptionId = subscriptionId)

  private fun write(open: TelemetrySocket, request: StreamRequest) {
    try {
      val line = DaemonJson.encodeToString(serializer<StreamRequest>(), request)
      synchronized(writeLock) { open.writeLine(line) }
    } catch (e: java.io.IOException) {
      // The reader sees the broken socket and reports every device down.
      log.warn("Failed to send observation stream request: ${e.message}")
    }
  }

  private fun closeQuietly(open: TelemetrySocket?) {
    try {
      open?.close()
    } catch (e: java.io.IOException) {
      log.debug("Could not close observation socket: ${e.message}")
    }
  }

  companion object {
    internal const val READER_THREAD_NAME = "observation-stream-mux-reader"

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
