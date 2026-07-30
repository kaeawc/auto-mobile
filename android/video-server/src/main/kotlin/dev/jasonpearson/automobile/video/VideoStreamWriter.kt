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
  private var clientSocket: LocalSocket? = null
  private var outputStream: OutputStream? = null
  private var commandHandler: ((Int) -> Unit)? = null
  private val lock = Any()
  private val packetCache = VideoPacketCache()
  private val reconnectWindow = ReconnectWindow(nowMs, CLIENT_RECONNECT_WINDOW_MS)

  /**
   * Growable scratch buffer reused across inter frames to move the payload out of the codec
   * [ByteBuffer] without a per-frame heap allocation. Only ever touched under [lock] from the
   * single encoder thread. Config/keyframe packets bypass it because they are copied for the cache
   * anyway.
   */
  private var scratch = ByteArray(0)

  @Volatile private var stopped = false

  companion object {
    /** Keep capture warm long enough for ADB/daemon local-socket recovery. */
    const val CLIENT_RECONNECT_WINDOW_MS = 5_000L

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
    Thread(
        { acceptClients(onClientConnected) },
        "video-client-acceptor",
      )
      .apply { isDaemon = true }
      .start()
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
   * Write one encoded video packet directly from the codec [ByteBuffer].
   *
   * Config and keyframe packets are copied into an exact-size [ByteArray] and cached before
   * writing, so a later client can decode immediately even if this client fails mid-write. Inter
   * frames are not cached, so they are moved through a reused growable scratch buffer rather than a
   * fresh per-frame allocation — the payload is fully written before the caller releases the output
   * buffer, so the codec-owned bytes stay valid for the duration of this call.
   */
  fun writePacket(buffer: ByteBuffer, bufferInfo: MediaCodec.BufferInfo): Boolean {
    val size = bufferInfo.size
    val isConfig = (bufferInfo.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0
    val isKeyFrame = (bufferInfo.flags and MediaCodec.BUFFER_FLAG_KEY_FRAME) != 0
    val ptsAndFlags =
      VideoStreamProtocol.ptsAndFlags(bufferInfo.presentationTimeUs, isConfig, isKeyFrame)
    buffer.position(bufferInfo.offset)
    synchronized(lock) {
      if (isConfig || isKeyFrame) {
        val data = ByteArray(size)
        buffer.get(data, 0, size)
        packetCache.remember(CachedVideoPacket(ptsAndFlags, data))
        return writePacketDataLocked(TRACK_ID_VIDEO, ptsAndFlags, data)
      }
      scratch = growScratch(scratch, size)
      buffer.get(scratch, 0, size)
      return writePacketDataLocked(TRACK_ID_VIDEO, ptsAndFlags, scratch, size)
    }
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

  private fun writePacketDataLocked(
    trackId: Int,
    ptsAndFlags: Long,
    data: ByteArray,
    length: Int = data.size,
  ): Boolean {
    if (stopped) return false

    // Keep the encoder alive during local client recovery. Video data is cached;
    // audio resumes live when the replacement mux client attaches.
    val output = outputStream ?: return true
    try {
      output.write(VideoStreamProtocol.packetHeader(audioEnabled, trackId, ptsAndFlags, length))
      output.write(data, 0, length)
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
    synchronized(lock) {
      closeClientLocked()
    }
    try {
      serverSocket?.close()
    } catch (_: IOException) {}
    serverSocket = null
  }
}

/**
 * Returns a [ByteArray] of at least [size] bytes, reusing [scratch] whenever it already fits so
 * inter frames avoid a per-frame allocation. Only the leading [size] bytes are ever written, so a
 * larger reused buffer never leaks stale trailing bytes onto the wire.
 */
internal fun growScratch(scratch: ByteArray, size: Int): ByteArray =
  if (scratch.size < size) ByteArray(size) else scratch

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
