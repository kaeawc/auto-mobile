package dev.jasonpearson.automobile.video

import android.media.MediaCodec
import android.net.LocalServerSocket
import android.net.LocalSocket
import java.io.IOException
import java.io.OutputStream
import java.nio.ByteBuffer

/**
 * Writes encoded video packets to a LocalSocket using a binary protocol.
 *
 * ## Protocol
 *
 * ### Stream Header (12 bytes)
 *
 * ```
 * ┌─────────────────┬─────────────────┬─────────────────┐
 * │ codec_id (4)    │ width (4)       │ height (4)      │
 * │ big-endian      │ big-endian      │ big-endian      │
 * └─────────────────┴─────────────────┴─────────────────┘
 * ```
 *
 * codec_id values:
 * - 0x68323634 = "h264" (H.264/AVC)
 *
 * ### Packet Header (12 bytes per packet)
 *
 * ```
 * ┌─────────────────────────────────────┬─────────────────┐
 * │ pts_and_flags (8)                   │ size (4)        │
 * │ big-endian                          │ big-endian      │
 * └─────────────────────────────────────┴─────────────────┘
 * ```
 *
 * pts_and_flags bit layout:
 * - bit 63: CONFIG flag (codec config data, not a frame)
 * - bit 62: KEY_FRAME flag (I-frame)
 * - bits 0-61: presentation timestamp in microseconds
 *
 * Followed by `size` bytes of encoded frame data.
 *
 * When audio is enabled, the stream uses a multiplexed header:
 * ```
 * amux header: magic "amux" (4) | version (4) | track_count (4)
 * track:       track_id (4) | codec_id (4) | param1 (4) | param2 (4)
 * packet:      track_id (4) | pts_and_flags (8) | size (4) | payload
 * ```
 */
class VideoStreamWriter(
  private val socketName: String,
  private val width: Int,
  private val height: Int,
  private val audioEnabled: Boolean = false,
) {
  private var serverSocket: LocalServerSocket? = null
  private var clientSocket: LocalSocket? = null
  private var outputStream: OutputStream? = null

  @Volatile private var stopped = false

  companion object {
    /** "h264" as big-endian int: 0x68323634 */
    const val CODEC_ID_H264 = 0x68323634
    /** "amux" as big-endian int: 0x616d7578 */
    const val CODEC_ID_AMUX = 0x616d7578
    /** "s16l" as big-endian int: 0x7331366c */
    const val CODEC_ID_PCM16 = 0x7331366c
    const val TRACK_ID_VIDEO = 1
    const val TRACK_ID_AUDIO = 2
    private const val MUX_VERSION = 1

    /** Bit 63: codec configuration data */
    const val PACKET_FLAG_CONFIG = 1L shl 63

    /** Bit 62: key frame (I-frame) */
    const val PACKET_FLAG_KEY_FRAME = 1L shl 62

    /** Mask for PTS (bits 0-61) */
    const val PTS_MASK = (1L shl 62) - 1
  }

  /**
   * Start the server and wait for a client connection.
   *
   * This method blocks until a client connects.
   *
   * @throws IOException if the socket cannot be created or written to
   */
  fun start() {
    // Create LocalServerSocket in abstract namespace
    serverSocket = LocalServerSocket(socketName)
    println("Waiting for client connection on localabstract:$socketName")

    // Accept a single client connection (blocking)
    val client = serverSocket!!.accept()
    clientSocket = client
    outputStream = client.outputStream

    println("Client connected, writing stream header")

    // Write stream header
    if (audioEnabled) {
      writeMuxHeader()
    } else {
      writeLegacyHeader()
    }
  }

  private fun writeLegacyHeader() {
    val header = ByteBuffer.allocate(12)
    header.putInt(CODEC_ID_H264)
    header.putInt(width)
    header.putInt(height)
    outputStream!!.write(header.array())
    outputStream!!.flush()
  }

  private fun writeMuxHeader() {
    val header = ByteBuffer.allocate(12 + 16 + 16)
    header.putInt(CODEC_ID_AMUX)
    header.putInt(MUX_VERSION)
    header.putInt(2)
    header.putInt(TRACK_ID_VIDEO)
    header.putInt(CODEC_ID_H264)
    header.putInt(width)
    header.putInt(height)
    header.putInt(TRACK_ID_AUDIO)
    header.putInt(CODEC_ID_PCM16)
    header.putInt(AudioCapture.SAMPLE_RATE_HZ)
    header.putInt(AudioCapture.CHANNELS)
    outputStream!!.write(header.array())
    outputStream!!.flush()
  }

  /**
   * Write an encoded packet to the stream.
   *
   * @param buffer The encoded data buffer
   * @param bufferInfo The buffer info from MediaCodec
   * @return true if the packet was written successfully, false if the stream was closed
   */
  fun writePacket(buffer: ByteBuffer, bufferInfo: MediaCodec.BufferInfo): Boolean {
    val data = ByteArray(bufferInfo.size)
    buffer.position(bufferInfo.offset)
    buffer.get(data, 0, bufferInfo.size)
    var ptsAndFlags = bufferInfo.presentationTimeUs and PTS_MASK

    if ((bufferInfo.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0) {
      ptsAndFlags = ptsAndFlags or PACKET_FLAG_CONFIG
    }

    if ((bufferInfo.flags and MediaCodec.BUFFER_FLAG_KEY_FRAME) != 0) {
      ptsAndFlags = ptsAndFlags or PACKET_FLAG_KEY_FRAME
    }

    return writePacketData(TRACK_ID_VIDEO, ptsAndFlags, data)
  }

  fun writeAudioPacket(data: ByteArray, ptsUs: Long): Boolean {
    return writePacketData(TRACK_ID_AUDIO, ptsUs and PTS_MASK, data)
  }

  @Synchronized
  private fun writePacketData(trackId: Int, ptsAndFlags: Long, data: ByteArray): Boolean {
    if (stopped) return false

    val output = outputStream ?: return false

    try {
      val packetHeader =
        if (audioEnabled) {
          ByteBuffer.allocate(16).also {
            it.putInt(trackId)
            it.putLong(ptsAndFlags)
            it.putInt(data.size)
          }
        } else {
          ByteBuffer.allocate(12).also {
            it.putLong(ptsAndFlags)
            it.putInt(data.size)
          }
        }
      output.write(packetHeader.array())
      output.write(data)

      return true
    } catch (e: IOException) {
      println("Error writing packet: ${e.message}")
      return false
    }
  }

  /** Stop the stream writer and close all sockets. */
  fun stop() {
    stopped = true

    try {
      outputStream?.close()
    } catch (_: IOException) {}

    try {
      clientSocket?.close()
    } catch (_: IOException) {}

    try {
      serverSocket?.close()
    } catch (_: IOException) {}

    outputStream = null
    clientSocket = null
    serverSocket = null
  }
}
