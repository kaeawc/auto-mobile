package dev.jasonpearson.automobile.desktop.core.daemon

import dev.jasonpearson.automobile.desktop.core.connection.ConnectionState
import dev.jasonpearson.automobile.desktop.core.logging.Logger
import java.nio.file.Files
import java.nio.file.Path
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.runInterruptible

/** How [MultiplexedObservationSocketClient] reaches the daemon; every member is a test seam. */
internal class ObservationMuxTransport(
  // A line socket: the same AF_UNIX transport the telemetry multiplexer uses.
  val openSocket: (String) -> TelemetrySocket = ::ChannelTelemetrySocket,
  val socketAvailable: (String) -> Boolean = { Files.exists(Path.of(it)) },
  val socketPath: () -> String = { ObservationStreamClient.getSocketPath() },
  val readerThreads: StreamReaderDispatcherFactory = DedicatedStreamReaderThreads,
)

/**
 * The one shared observation socket and its reader: opened by the first device that needs it, read
 * on one dedicated thread, and torn down when it ends or its last device leaves.
 */
internal class ObservationMuxConnection(
  private val transport: ObservationMuxTransport,
  private val table: ObservationMuxTable,
  private val wire: ObservationMuxWire,
  private val frames: ObservationMuxFrames,
  private val scope: CoroutineScope,
  private val log: Logger,
) {
  // Serializes opening, so devices connecting together open the socket once.
  private val openLock = Any()

  /** The shared socket, opened (with its reader) by the first device to need it. */
  fun open(): TelemetrySocket =
    synchronized(openLock) {
      synchronized(table.lock) {
        if (table.closed) throw java.io.IOException("Observation multiplexer is closed")
        table.socket?.let {
          return it
        }
      }
      val path = transport.socketPath()
      if (!transport.socketAvailable(path)) {
        log.warn("Observation stream socket not found at $path")
        throw java.io.IOException("Socket not found")
      }
      val open = transport.openSocket(path)
      synchronized(table.lock) {
        if (table.closed) {
          wire.closeQuietly(open)
          throw java.io.IOException("Observation multiplexer is closed")
        }
        table.socket = open
        table.connection = scope.launch { read(open) }
      }
      log.info("Connected to observation stream (multiplexed)")
      open
    }

  fun shutDown(detached: DetachedObservationConnection) {
    detached.reader?.cancel()
    wire.closeQuietly(detached.socket)
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
      if (line.isNotBlank()) frames.handle(open, line)
      if (synchronized(table.lock) { table.sessionRejected }) return
    }
  }

  /** The socket [open] is gone: every device on it is down until its owner reconnects it. */
  private fun ended(open: TelemetrySocket) {
    val dropped =
      synchronized(table.lock) {
        // Only the connection that still owns the table resets it.
        if (table.socket !== open) return@synchronized emptyList()
        table.socket = null
        table.connection = null
        table.forgetSubscriptions()
        if (table.sessionRejected) emptyList() else table.channels.toList()
      }
    wire.closeQuietly(open)
    dropped.forEach { it.mutableState.value = ConnectionState.Disconnected("Stream ended") }
    if (dropped.isNotEmpty()) log.info("Observation stream disconnected")
  }

  companion object {
    internal const val READER_THREAD_NAME = "observation-stream-mux-reader"
  }
}
