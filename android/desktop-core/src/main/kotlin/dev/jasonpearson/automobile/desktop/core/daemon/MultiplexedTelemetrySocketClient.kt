package dev.jasonpearson.automobile.desktop.core.daemon

import dev.jasonpearson.automobile.desktop.core.connection.ConnectionState
import dev.jasonpearson.automobile.desktop.core.logging.Logger
import dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory
import dev.jasonpearson.automobile.desktop.core.telemetry.TelemetryDisplayEvent
import dev.jasonpearson.automobile.desktop.core.telemetry.TelemetryPushRequest
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
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.plus
import kotlinx.coroutines.runInterruptible

/** A connection taken off the table, to be cancelled and closed outside its lock. */
private class DetachedConnection(
  private val job: Job?,
  private val socket: TelemetrySocket?,
  private val wire: TelemetryWire,
) {
  fun shutDown() {
    job?.cancel()
    wire.closeQuietly(socket)
  }
}

/** How [MultiplexedTelemetrySocketClient] reaches the daemon; every member is a test seam. */
internal class TelemetryTransport(
  val openSocket: (String) -> TelemetrySocket = ::ChannelTelemetrySocket,
  val socketAvailable: (String) -> Boolean = { Files.exists(Path.of(it)) },
  val retryDelay: TelemetryRetryDelay = TelemetryRetryDelay { delay(it) },
  val socketPath: () -> String = { AutoMobileSocketPaths.socketPath("telemetry-push.sock") },
)

/**
 * Every observed device's telemetry over ONE socket and ONE reader thread (#16968). Each
 * [subscribe] sends its own device-scoped `subscribe`, so the daemon gives each device its own
 * `subscriptionId` and its own backfill; `telemetry_push` frames are routed by that id. Releasing a
 * subscription sends `unsubscribe` for its id, and the socket closes with the last one.
 *
 * After the socket drops, it reconnects with jittered backoff and subscribes every live device
 * again. A subscription the daemon refuses (e.g. a device that is not live yet) is retried on its
 * own backoff without touching the other devices' subscriptions; only a refused desktop session,
 * which no device can recover from, fails them all.
 */
internal class MultiplexedTelemetrySocketClient(
  private val transport: TelemetryTransport,
  parentScope: CoroutineScope,
  private val options: TelemetryPushSocketOptions = TelemetryPushSocketOptions(),
  private val log: Logger = LoggerFactory.getLogger(MultiplexedTelemetrySocketClient::class.java),
  newRequestId: () -> String = { UUID.randomUUID().toString() },
) : TelemetryMultiplexer {
  // A child of [parentScope], so closing this client never cancels its caller's scope.
  private val job = SupervisorJob(parentScope.coroutineContext[Job])
  private val scope = parentScope + job
  private val table = TelemetrySubscriptionTable()
  private val wire = TelemetryWire(log, newRequestId, options.sessionUuidProvider)
  private val frames = TelemetryFrameHandler(table, wire, log, ::resubscribeLater)

  override fun subscribe(
    key: DeviceStreamKey,
    sink: (TelemetryDisplayEvent) -> Unit,
  ): TelemetrySubscription {
    val entry = MuxSubscription(key, sink, ::retryEntry, ::release)
    val pending =
      synchronized(table.lock) {
        check(!table.closed) { "Telemetry multiplexer is closed" }
        table.add(entry)
        ensureConnection()
        prepare(entry)
      }
    pending?.let { (open, request) -> wire.write(open, request) }
    return entry
  }

  override fun close() {
    val (all, detached) =
      synchronized(table.lock) {
        table.closed = true
        table.snapshot().onEach { table.remove(it) } to detachConnection()
      }
    all.publish(ConnectionState.Disconnected(null))
    detached.shutDown()
    job.cancel()
  }

  private fun release(entry: MuxSubscription) {
    val (open, released, detached) =
      synchronized(table.lock) {
        if (entry.released) return
        val id = table.remove(entry)
        // Decide and detach in one step: a device subscribing right after this release must start
        // a fresh connection, not join the socket being shut down.
        Triple(table.socket, id, if (table.snapshot().isEmpty()) detachConnection() else null)
      }
    entry.mutableState.value = ConnectionState.Disconnected(null)
    if (open != null && released != null) wire.write(open, wire.unsubscribe(released))
    detached?.shutDown()
  }

  private fun retryEntry(entry: MuxSubscription) {
    val pending =
      synchronized(table.lock) {
        if (entry.released || table.sessionRejected) return
        if (table.connection?.isActive != true) {
          ensureConnection()
          return
        }
        entry.retryJob?.cancel()
        entry.rejections = 0
        prepare(entry)
      }
    pending?.let { (open, request) -> wire.write(open, request) }
  }

  /** A refused device subscribes again on its own backoff; the others are untouched. */
  private fun resubscribeLater(entry: MuxSubscription) {
    synchronized(table.lock) {
      if (entry.released) return
      entry.rejections++
      if (entry.rejections >= TelemetryPushSocketClient.MAX_RECONNECT_ATTEMPTS) return
      val attempt = entry.rejections
      entry.retryJob = scope.launch {
        transport.retryDelay.wait(telemetryBackoffMs(attempt, options.random))
        val pending = synchronized(table.lock) { prepare(entry) }
        pending?.let { (open, request) -> wire.write(open, request) }
      }
    }
  }

  // Called under the table lock. The socket and request to subscribe [entry] on, if it needs one.
  private fun prepare(entry: MuxSubscription): Pair<TelemetrySocket, TelemetryPushRequest>? {
    val open = table.socket ?: return null
    val requestId = wire.newId()
    if (!table.begin(entry, requestId)) return null
    if (entry.state.value !is ConnectionState.Error) {
      entry.mutableState.value = ConnectionState.Connecting
    }
    return open to wire.subscribe(entry.key, requestId)
  }

  // Called under the table lock.
  private fun ensureConnection() {
    if (table.connection?.isActive == true || table.idle) return
    table.connection = scope.launch { connectWithRetry() }
  }

  // Called under the table lock: hands the connection over to be shut down outside it.
  private fun detachConnection(): DetachedConnection {
    val detached = DetachedConnection(table.connection, table.socket, wire)
    table.connection = null
    table.socket = null
    return detached
  }

  private suspend fun connectWithRetry() {
    var attempt = 0
    while (true) {
      if (options.sessionUuidProvider != null && options.sessionUuidProvider.invoke() == null) {
        // Subscribing before the desktop session registers would be refused for good; a retry
        // reconnects once it has.
        synchronized(table.lock) { table.snapshot() }.publish(ConnectionState.Disconnected(null))
        return
      }
      runConnection { attempt = 0 }
      currentCoroutineContext().ensureActive()
      if (synchronized(table.lock) { table.idle }) return
      attempt++
      val all = synchronized(table.lock) { table.snapshot() }
      if (attempt >= TelemetryPushSocketClient.MAX_RECONNECT_ATTEMPTS) {
        all.publish(ConnectionState.Error("Telemetry unavailable on this daemon"))
        return
      }
      val delayMs = telemetryBackoffMs(attempt, options.random)
      all.publish(ConnectionState.Reconnecting(attempt, delayMs))
      transport.retryDelay.wait(delayMs)
    }
  }

  private suspend fun runConnection(onHealthy: () -> Unit) {
    val path = transport.socketPath()
    var current: TelemetrySocket? = null
    try {
      if (!transport.socketAvailable(path)) throw java.io.IOException("Socket not found at $path")
      current = transport.openSocket(path)
      currentCoroutineContext().ensureActive()
      val open = current
      val subscribes =
        synchronized(table.lock) {
          if (table.idle) return
          table.socket = open
          table.snapshot().mapNotNull(::prepare)
        }
      // Subscribes every live device, including after a reconnect, each with its own backfill.
      subscribes.forEach { (socket, request) -> wire.write(socket, request) }
      options.readerThreads.create(READER_THREAD_NAME).use { readFrames(it, open, onHealthy) }
    } catch (e: CancellationException) {
      throw e
    } catch (e: java.io.IOException) {
      log.warn("Telemetry push connection failed: ${e.message}")
    } catch (e: IllegalStateException) {
      log.warn("Telemetry push connection failed: ${e.message}")
    } finally {
      synchronized(table.lock) {
        // Only the connection that still owns the table resets it: a replacement opened after this
        // one was detached keeps its own subscriptions.
        if (current != null && table.socket === current) {
          table.socket = null
          table.resetSubscriptions()
        }
      }
      wire.closeQuietly(current)
    }
  }

  private suspend fun readFrames(
    readerThread: CoroutineDispatcher,
    open: TelemetrySocket,
    onHealthy: () -> Unit,
  ) {
    while (true) {
      val line = runInterruptible(readerThread) { open.readLine() } ?: return
      currentCoroutineContext().ensureActive()
      if (line.isNotBlank()) frames.handle(open, line, onHealthy)
      if (synchronized(table.lock) { table.sessionRejected }) return
    }
  }

  companion object {
    internal const val READER_THREAD_NAME = "telemetry-push-mux-reader"

    /** The desktop's production multiplexer: one telemetry socket for every observed device. */
    fun create(
      sessionUuidProvider: () -> String?,
      ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
    ): TelemetryMultiplexer =
      MultiplexedTelemetrySocketClient(
        TelemetryTransport(),
        CoroutineScope(SupervisorJob() + ioDispatcher),
        TelemetryPushSocketOptions(sessionUuidProvider = sessionUuidProvider),
      )
  }
}
