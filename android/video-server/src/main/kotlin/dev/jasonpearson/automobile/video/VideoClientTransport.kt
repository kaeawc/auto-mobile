package dev.jasonpearson.automobile.video

import dev.jasonpearson.automobile.video.VideoStreamWriter.Companion.NO_WRITE_IN_PROGRESS
import dev.jasonpearson.automobile.video.VideoStreamWriter.Companion.TRACK_ID_VIDEO
import dev.jasonpearson.automobile.video.VideoStreamWriter.Companion.WRITER_JOIN_TIMEOUT_MS
import dev.jasonpearson.automobile.video.VideoStreamWriter.Companion.WRITE_STALL_POLL_MS
import dev.jasonpearson.automobile.video.VideoStreamWriter.Companion.WRITE_STALL_TIMEOUT_MS
import java.io.IOException

/** Owns listening, command reading and bounded transport-worker teardown for one stream. */
internal class VideoClientTransport(
  private val socketName: String,
  private val nowMs: () -> Long,
  private val socketFactory: VideoServerSocketFactory,
  private val handoff: FrameHandoff,
  private val output: VideoClientOutput,
  private val admission: VideoClientAdmission,
) {
  private var serverSocket: VideoServerSocket? = null
  private var commandHandler: ((Int) -> Unit)? = null
  @Volatile private var writerThread: Thread? = null
  @Volatile private var watchdogThread: Thread? = null
  private val stopped: Boolean
    get() = output.stopped

  fun start(onClientConnected: () -> Unit) {
    bindServerSocket()
    writerThread =
      Thread({ drainToTransport() }, "video-transport-writer").apply {
        isDaemon = true
        start()
      }
    watchdogThread =
      Thread({ runWriteWatchdog() }, "video-write-watchdog").apply {
        isDaemon = true
        start()
      }
    Thread(
        { acceptClients(onClientConnected) },
        "video-client-acceptor",
      )
      .apply { isDaemon = true }
      .start()
  }

  private fun drainToTransport() {
    while (!stopped) {
      val frame = handoff.take() ?: break
      output.writePacket(TRACK_ID_VIDEO, frame.ptsAndFlags, frame.data)
    }
  }

  private fun runWriteWatchdog() {
    while (!stopped) {
      checkWriteStall()
      try {
        Thread.sleep(WRITE_STALL_POLL_MS)
      } catch (_: InterruptedException) {
        Thread.currentThread().interrupt()
        return
      }
    }
  }

  internal fun checkWriteStall(): Boolean {
    val startedAt = output.writeStartedAtMs
    if (startedAt == NO_WRITE_IN_PROGRESS) return false
    if (nowMs() - startedAt < WRITE_STALL_TIMEOUT_MS) return false
    val client = output.clientSocket ?: return false
    println(
      "VIDEO_CLIENT_WRITE_STALL socket=$socketName force-closing after ${nowMs() - startedAt}ms",
    )
    try {
      client.close()
    } catch (_: IOException) {
      // Already gone; the wedged write will still observe the close and throw.
    }
    return true
  }

  internal fun bindServerSocket() {
    serverSocket = socketFactory.create(socketName)
    synchronized(output.lock) { output.reconnectWindow.start() }
    println("Waiting for client connection on localabstract:$socketName")
  }

  fun startCommandReader(onCommand: (Int) -> Unit) {
    synchronized(output.lock) {
      commandHandler = onCommand
    }
  }

  private fun startCommandReaderFor(client: VideoClientConnection) {
    val input = client.inputStream
    Thread(
        {
          try {
            while (!stopped && output.isCurrentClient(client)) {
              val command = input.read()
              if (command < 0) break
              // Whitelist control bytes before forwarding (issue #4732). Unknown values are
              // unauthenticated control input on the shared socket; ignoring (and debug-logging)
              // them keeps the control surface minimal. Once the #4729 handshake authenticates the
              // connection this channel is implicitly authenticated too, but we validate anyway for
              // defense-in-depth. The reader still reads one byte per iteration and buffers
              // nothing,
              // so an unknown-byte flood cannot grow memory or wedge the daemon-threaded reader.
              if (!VideoStreamProtocol.isKnownCommand(command)) {
                println("VIDEO_COMMAND_IGNORED socket=$socketName unknown command byte=$command")
                continue
              }
              commandHandler?.invoke(command)
            }
          } catch (_: IOException) {
            // The write path or a replacement connection owns cleanup.
          } finally {
            output.detachIfCurrent(client)
          }
        },
        "video-command-reader",
      )
      .apply { isDaemon = true }
      .start()
  }

  fun stop() {
    output.stopped = true
    handoff.close()
    // Unblock the writer thread if it is wedged in a blocking socket write (it holds `lock` for the
    // duration, so we must NOT take `lock` here). Closing the socket makes that write throw.
    try {
      output.clientSocket?.close()
    } catch (_: IOException) {}
    writerThread?.let {
      try {
        // Bounded: the socket close above unblocks a wedged write promptly; the join only lets the
        // writer thread unwind cleanly and must never hang shutdown.
        it.join(WRITER_JOIN_TIMEOUT_MS)
      } catch (_: InterruptedException) {
        Thread.currentThread().interrupt()
      }
    }
    writerThread = null
    // The watchdog only sleeps and reads volatiles; interrupt its sleep so it exits promptly.
    watchdogThread?.interrupt()
    watchdogThread = null
    output.closeClient()
    try {
      serverSocket?.close()
    } catch (_: IOException) {}
    serverSocket = null
  }

  fun acceptClients(onClientConnected: () -> Unit) {
    while (!stopped) {
      val client =
        try {
          serverSocket?.accept() ?: return
        } catch (e: IOException) {
          if (!stopped) println("Error accepting video client: ${e.message}")
          return
        }
      if (!admission.accepts(client)) continue
      if (!output.attach(client)) continue
      println("Client connected, writing stream header")
      startCommandReaderFor(client)
      onClientConnected()
    }
  }
}
