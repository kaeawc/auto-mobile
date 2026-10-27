package dev.jasonpearson.automobile.video

import dev.jasonpearson.automobile.video.VideoStreamWriter.Companion.CLIENT_RECONNECT_WINDOW_MS
import dev.jasonpearson.automobile.video.VideoStreamWriter.Companion.NO_WRITE_IN_PROGRESS
import dev.jasonpearson.automobile.video.VideoStreamWriter.Companion.TRACK_ID_VIDEO
import java.io.IOException
import java.io.OutputStream

internal data class VideoTransportOptions(
  val width: Int,
  val height: Int,
  val audioEnabled: Boolean,
)

/**
 * Serializes attachment/replay and packet writes; socket close remains lock-free for the watchdog.
 */
internal class VideoClientOutput(
  options: VideoTransportOptions,
  private val nowMs: () -> Long,
) {
  private val width = options.width
  private val height = options.height
  private val audioEnabled = options.audioEnabled
  val lock = Any()
  val packetCache = VideoPacketCache()
  val reconnectWindow = ReconnectWindow(nowMs, CLIENT_RECONNECT_WINDOW_MS)
  @Volatile
  var clientSocket: VideoClientConnection? = null
    private set

  @Volatile
  var writeStartedAtMs: Long = NO_WRITE_IN_PROGRESS
    private set

  @Volatile var stopped = false
  private var outputStream: OutputStream? = null

  fun attach(client: VideoClientConnection): Boolean =
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

  fun writePacket(trackId: Int, ptsAndFlags: Long, data: ByteArray): Boolean =
    synchronized(lock) { writePacketDataLocked(trackId, ptsAndFlags, data) }

  fun detachIfCurrent(client: VideoClientConnection) {
    synchronized(lock) {
      if (clientSocket === client) {
        closeClientLocked()
        reconnectWindow.onClientDetached()
      }
    }
  }

  fun closeClient() {
    synchronized(lock) { closeClientLocked() }
  }

  private fun writeStreamHeaderLocked() {
    val header =
      if (audioEnabled) {
        VideoStreamProtocol.muxHeader(
          width,
          height,
          AudioCapture.SAMPLE_RATE_HZ,
          AudioCapture.CHANNELS,
        )
      } else {
        VideoStreamProtocol.legacyHeader(width, height)
      }
    val output = requireNotNull(outputStream)
    trackingWriteStall {
      output.write(header)
      output.flush()
    }
  }

  private inline fun trackingWriteStall(action: () -> Unit) {
    writeStartedAtMs = nowMs()
    try {
      action()
    } finally {
      writeStartedAtMs = NO_WRITE_IN_PROGRESS
    }
  }

  private fun replayCachedVideoLocked() {
    for (packet in packetCache.replay()) {
      // Replay must propagate I/O failures so attachment rolls back instead of reporting a client.
      writeFramedPacketLocked(
        TRACK_ID_VIDEO,
        VideoStreamProtocol.replayed(packet.ptsAndFlags),
        packet.data,
      )
    }
  }

  private fun writeFramedPacketLocked(trackId: Int, ptsAndFlags: Long, data: ByteArray): Boolean {
    // Replay ignores the result, preserving stopped/clientless no-ops; audio keeps this contract.
    if (stopped) return false

    // Keep the encoder alive during local client recovery. Video data is cached;
    // audio resumes live when the replacement mux client attaches.
    val output = outputStream ?: return true
    // One write per packet: header + payload are framed into a single buffer so each packet
    // costs one syscall instead of two and the header is never split from its payload across
    // TCP segments (issue #4743). Stamped for the write-stall watchdog (#4784) so a wedged
    // half-open transport is force-detached instead of orphaning the server.
    trackingWriteStall {
      output.write(VideoStreamProtocol.framedPacket(audioEnabled, trackId, ptsAndFlags, data))
    }
    return true
  }

  private fun writePacketDataLocked(trackId: Int, ptsAndFlags: Long, data: ByteArray): Boolean {
    try {
      return writeFramedPacketLocked(trackId, ptsAndFlags, data)
    } catch (e: IOException) {
      println("Error writing packet: ${e.message}")
      closeClientLocked()
      reconnectWindow.onClientDetached()
      return true
    }
  }

  fun isCurrentClient(client: VideoClientConnection): Boolean =
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
}
