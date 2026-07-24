package dev.jasonpearson.automobile.video

import android.media.MediaCodec
import android.net.LocalServerSocket
import android.net.LocalSocket
import android.os.SystemClock
import java.io.IOException
import java.io.OutputStream
import java.nio.ByteBuffer

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
  private val reconnectWindow = ClientReconnectWindow()

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
            reconnectWindow.onClientConnected()
            true
          } catch (e: IOException) {
            println("Error attaching video client: ${e.message}")
            closeClientLocked()
            reconnectWindow.onClientDisconnected(nowMs())
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
                reconnectWindow.onClientDisconnected(nowMs())
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
   * Write one encoded video packet. It is cached before writing, allowing a later client to decode
   * immediately even if this client fails mid-write.
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
    synchronized(lock) {
      packetCache.remember(CachedVideoPacket(ptsAndFlags, data))
      return writePacketDataLocked(TRACK_ID_VIDEO, ptsAndFlags, data)
    }
  }

  fun writeAudioPacket(data: ByteArray, ptsUs: Long): Boolean =
    synchronized(lock) {
      writePacketDataLocked(TRACK_ID_AUDIO, ptsUs and PTS_MASK, data)
    }

  /** True once a prior client has failed to reconnect inside the bounded window. */
  fun reconnectWindowExpired(): Boolean =
    synchronized(lock) {
      reconnectWindow.hasExpired(nowMs())
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
      output.write(VideoStreamProtocol.packetHeader(audioEnabled, trackId, ptsAndFlags, data.size))
      output.write(data)
      return true
    } catch (e: IOException) {
      println("Error writing packet: ${e.message}")
      closeClientLocked()
      reconnectWindow.onClientDisconnected(nowMs())
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

internal class ClientReconnectWindow(
  private val windowMs: Long = VideoStreamWriter.CLIENT_RECONNECT_WINDOW_MS
) {
  private var hasConnected = false
  private var disconnectedAtMs: Long? = null

  fun onClientConnected() {
    hasConnected = true
    disconnectedAtMs = null
  }

  fun onClientDisconnected(nowMs: Long) {
    if (hasConnected && disconnectedAtMs == null) {
      disconnectedAtMs = nowMs
    }
  }

  fun hasExpired(nowMs: Long): Boolean = disconnectedAtMs?.let { nowMs - it >= windowMs } ?: false
}
