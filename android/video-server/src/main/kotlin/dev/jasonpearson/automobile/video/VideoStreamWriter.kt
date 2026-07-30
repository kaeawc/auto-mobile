package dev.jasonpearson.automobile.video

import android.media.MediaCodec
import android.net.LocalServerSocket
import android.net.LocalSocket
import android.os.SystemClock
import java.io.IOException
import java.io.OutputStream
import java.nio.ByteBuffer

/**
 * Tracks the bounded clientless window using a monotonic clock so wall-clock changes cannot
 * prematurely expire or indefinitely extend a capture session.
 */
internal class ReconnectWindow(
  private val clock: () -> Long,
  private val durationMs: Long,
) {
  private var clientlessSinceMs: Long? = null
  private var clientAttached = false

  fun start() {
    clientAttached = false
    clientlessSinceMs = clock()
  }

  fun onClientAttached() {
    clientAttached = true
    clientlessSinceMs = null
  }

  fun onClientDetached() {
    clientAttached = false
    clientlessSinceMs = clock()
  }

  fun isExpired(): Boolean {
    val clientlessSince = clientlessSinceMs ?: return false
    return !clientAttached && clock() - clientlessSince >= durationMs
  }
}

/**
 * Writes encoded video packets to a LocalSocket using the VideoStreamProtocol binary framing. A
 * disconnected client is replaceable: the writer retains codec configuration plus the latest
 * complete keyframe and replays them before live packets to the next client.
 */
class VideoStreamWriter(
  private val socketName: String,
  private val width: Int,
  private val height: Int,
  private val audioEnabled: Boolean = false,
  private val nowMs: () -> Long = { SystemClock.elapsedRealtime() },
) {
  private data class CachedPacket(
    val trackId: Int,
    val ptsAndFlags: Long,
    val data: ByteArray,
  )

  private var serverSocket: LocalServerSocket? = null
  // @Volatile: stop() closes this without the lock to unblock a writer thread wedged in a
  // blocking socket write (the writer holds `lock` for the duration of that write).
  @Volatile private var clientSocket: LocalSocket? = null
  private var outputStream: OutputStream? = null
  private var commandHandler: ((Int) -> Unit)? = null
  private val lock = Any()
  private val packetCache = VideoPacketCache()
  private val reconnectWindow = ReconnectWindow(nowMs, CLIENT_RECONNECT_WINDOW_MS)

  // Decouple encode from transport (#4749): the encode loop offers to a drop-oldest single-slot
  // handoff and returns immediately; this dedicated thread drains it into the socket, so a stalled
  // reader can never back-pressure MediaCodec's Surface input.
  private val handoff = FrameHandoff()
  // @Volatile: assigned on the thread that calls start(), read by stop() on the shutdown hook.
  @Volatile private var writerThread: Thread? = null

  @Volatile private var stopped = false

  companion object {
    /** Keep capture warm long enough for ADB/daemon local-socket recovery. */
    const val CLIENT_RECONNECT_WINDOW_MS = 5_000L

    /** Upper bound on how long [stop] waits for the transport writer thread to unwind. */
    const val WRITER_JOIN_TIMEOUT_MS = 200L

    /** "h264" as big-endian int: 0x68323634 */
    const val CODEC_ID_H264 = VideoStreamProtocol.CODEC_ID_H264
    /** "amux" as big-endian int: 0x616d7578 */
    const val CODEC_ID_AMUX = VideoStreamProtocol.CODEC_ID_AMUX
    /** "s16l" as big-endian int: 0x7331366c */
    const val CODEC_ID_PCM16 = VideoStreamProtocol.CODEC_ID_PCM16
    const val TRACK_ID_VIDEO = VideoStreamProtocol.TRACK_ID_VIDEO
    const val TRACK_ID_AUDIO = VideoStreamProtocol.TRACK_ID_AUDIO

    /** Bit 63: codec configuration data */
    const val PACKET_FLAG_CONFIG = VideoStreamProtocol.PACKET_FLAG_CONFIG

    /** Bit 62: key frame (I-frame) */
    const val PACKET_FLAG_KEY_FRAME = VideoStreamProtocol.PACKET_FLAG_KEY_FRAME

    /** Mask for PTS (bits 0-61) */
    const val PTS_MASK = VideoStreamProtocol.PTS_MASK
  }

  /**
   * Bind the abstract LocalSocket and accept clients in the background.
   *
   * The callback runs after the cached packets are written, so callers can request a current IDR
   * without delaying initial decoder setup.
   */
  fun start(onClientConnected: () -> Unit = {}) {
    serverSocket = LocalServerSocket(socketName)
    synchronized(lock) { reconnectWindow.start() }
    println("Waiting for client connection on localabstract:$socketName")
    writerThread =
      Thread({ drainToTransport() }, "video-transport-writer").apply {
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

  /**
   * The single consumer of [handoff]: blocks for the next encoded packet and writes it to the
   * current client. Isolating the blocking transport write on this thread is what keeps a slow or
   * stalled reader from back-pressuring the encode loop.
   */
  private fun drainToTransport() {
    while (!stopped) {
      val frame = handoff.take() ?: break
      synchronized(lock) { writePacketDataLocked(TRACK_ID_VIDEO, frame.ptsAndFlags, frame.data) }
    }
  }

  /**
   * Registers a callback for every current or future bidirectional client. The reader is
   * deliberately owned by the writer so reconnects do not lose the keyframe-request control
   * channel.
   */
  fun startCommandReader(onCommand: (Int) -> Unit) {
    synchronized(lock) {
      commandHandler = onCommand
    }
  }

  private fun acceptClients(onClientConnected: () -> Unit) {
    while (!stopped) {
      val client =
        try {
          serverSocket?.accept() ?: return
        } catch (e: IOException) {
          if (!stopped) {
            println("Error accepting video client: ${e.message}")
          }
          return
        }

      val attached =
        synchronized(lock) {
          closeClientLocked()
          clientSocket = client
          outputStream = client.outputStream
          try {
            writeStreamHeaderLocked()
            replayCachedVideoLocked()
            reconnectWindow.onClientAttached()
            true
          } catch (e: IOException) {
            println("Error attaching video client: ${e.message}")
            closeClientLocked()
            reconnectWindow.onClientDetached()
            false
          }
        }
      if (!attached) {
        continue
      }

      println("Client connected, writing stream header")
      startCommandReaderFor(client)
      onClientConnected()
    }
  }

  private fun startCommandReaderFor(client: LocalSocket) {
    val input = client.inputStream
    Thread(
        {
          try {
            while (!stopped && isCurrentClient(client)) {
              val command = input.read()
              if (command < 0) break
              commandHandler?.invoke(command)
            }
          } catch (_: IOException) {
            // The write path or a replacement connection owns cleanup.
          } finally {
            synchronized(lock) {
              if (clientSocket === client) {
                closeClientLocked()
                reconnectWindow.onClientDetached()
              }
            }
          }
        },
        "video-command-reader",
      )
      .apply { isDaemon = true }
      .start()
  }

  /**
   * Hand one encoded video packet off to the transport writer. Copies the buffer, caches decoder
   * state, then offers to the drop-oldest [handoff] — all non-blocking, so the caller may release
   * the MediaCodec output buffer immediately without waiting on the socket.
   *
   * Caching happens here on the producer side, before the handoff can drop anything, so a dropped
   * live packet never removes SPS/PPS or the latest IDR from the reconnect replay cache.
   *
   * @return false once the writer has been [stop]ped, signalling the encode loop to exit.
   */
  fun writePacket(buffer: ByteBuffer, bufferInfo: MediaCodec.BufferInfo): Boolean {
    val data = ByteArray(bufferInfo.size)
    buffer.position(bufferInfo.offset)
    buffer.get(data, 0, bufferInfo.size)
    val ptsAndFlags =
      VideoStreamProtocol.ptsAndFlags(
        bufferInfo.presentationTimeUs,
        (bufferInfo.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0,
        (bufferInfo.flags and MediaCodec.BUFFER_FLAG_KEY_FRAME) != 0,
      )
    synchronized(lock) { packetCache.remember(CachedVideoPacket(ptsAndFlags, data)) }
    return handoff.offer(EncodedVideoFrame(ptsAndFlags, data))
  }

  fun writeAudioPacket(data: ByteArray, ptsUs: Long): Boolean =
    synchronized(lock) {
      writePacketDataLocked(TRACK_ID_AUDIO, ptsUs and PTS_MASK, data)
    }

  /** True once the initial or replacement client misses the bounded reconnect window. */
  fun reconnectWindowExpired(): Boolean =
    synchronized(lock) {
      reconnectWindow.isExpired()
    }

  private fun writeStreamHeaderLocked() {
    if (audioEnabled) {
      outputStream!!.write(
        VideoStreamProtocol.muxHeader(
          width,
          height,
          AudioCapture.SAMPLE_RATE_HZ,
          AudioCapture.CHANNELS,
        )
      )
    } else {
      outputStream!!.write(VideoStreamProtocol.legacyHeader(width, height))
    }
    outputStream!!.flush()
  }

  private fun replayCachedVideoLocked() {
    for (packet in packetCache.replay()) {
      writePacketDataLocked(
        TRACK_ID_VIDEO,
        VideoStreamProtocol.replayed(packet.ptsAndFlags),
        packet.data,
      )
    }
  }

  private fun writePacketDataLocked(trackId: Int, ptsAndFlags: Long, data: ByteArray): Boolean {
    if (stopped) return false

    // Keep the encoder alive during local client recovery. Video data is cached;
    // audio resumes live when the replacement mux client attaches.
    val output = outputStream ?: return true
    try {
      // One write per packet: header + payload are framed into a single buffer so each packet
      // costs one syscall instead of two and the header is never split from its payload across
      // TCP segments (issue #4743).
      output.write(VideoStreamProtocol.framedPacket(audioEnabled, trackId, ptsAndFlags, data))
      return true
    } catch (e: IOException) {
      println("Error writing packet: ${e.message}")
      closeClientLocked()
      reconnectWindow.onClientDetached()
      return true
    }
  }

  private fun isCurrentClient(client: LocalSocket): Boolean =
    synchronized(lock) { clientSocket === client }

  private fun closeClientLocked() {
    try {
      outputStream?.close()
    } catch (_: IOException) {}
    try {
      clientSocket?.close()
    } catch (_: IOException) {}
    outputStream = null
    clientSocket = null
  }

  /** Stop the stream writer and close all sockets. */
  fun stop() {
    stopped = true
    handoff.close()
    // Unblock the writer thread if it is wedged in a blocking socket write (it holds `lock` for the
    // duration, so we must NOT take `lock` here). Closing the socket makes that write throw.
    try {
      clientSocket?.close()
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
    synchronized(lock) {
      closeClientLocked()
    }
    try {
      serverSocket?.close()
    } catch (_: IOException) {}
    serverSocket = null
  }
}

/** Cached decoder setup and latest complete keyframe for a replacement client. */
internal data class CachedVideoPacket(val ptsAndFlags: Long, val data: ByteArray) {
  fun copyPacket(): CachedVideoPacket = CachedVideoPacket(ptsAndFlags, data.copyOf())
}

internal class VideoPacketCache {
  private var config: CachedVideoPacket? = null
  private var idr: CachedVideoPacket? = null

  fun remember(packet: CachedVideoPacket) {
    if ((packet.ptsAndFlags and VideoStreamProtocol.PACKET_FLAG_CONFIG) != 0L) {
      config = packet.copyPacket()
    }
    if ((packet.ptsAndFlags and VideoStreamProtocol.PACKET_FLAG_KEY_FRAME) != 0L) {
      idr = packet.copyPacket()
    }
  }

  fun replay(): List<CachedVideoPacket> {
    val cachedConfig = config
    val cachedIdr = idr
    return when {
      cachedConfig == null && cachedIdr == null -> emptyList()
      cachedConfig == null -> listOfNotNull(cachedIdr).map(CachedVideoPacket::copyPacket)
      cachedIdr == null -> listOf(cachedConfig.copyPacket())
      cachedConfig.ptsAndFlags == cachedIdr.ptsAndFlags &&
        cachedConfig.data.contentEquals(cachedIdr.data) -> listOf(cachedConfig.copyPacket())
      else -> listOf(cachedConfig.copyPacket(), cachedIdr.copyPacket())
    }
  }
}
