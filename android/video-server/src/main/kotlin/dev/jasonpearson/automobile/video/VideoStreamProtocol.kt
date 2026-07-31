package dev.jasonpearson.automobile.video

import java.nio.ByteBuffer

object VideoStreamProtocol {
  /** "h264" as big-endian int: 0x68323634 */
  const val CODEC_ID_H264 = 0x68323634
  /** "amux" as big-endian int: 0x616d7578 */
  const val CODEC_ID_AMUX = 0x616d7578
  /** "s16l" as big-endian int: 0x7331366c */
  const val CODEC_ID_PCM16 = 0x7331366c
  const val TRACK_ID_VIDEO = 1
  const val TRACK_ID_AUDIO = 2
  private const val MUX_VERSION = 1

  /**
   * Host→device command byte: request that the encoder emit a sync frame (IDR) as soon as possible.
   * Sent when a downstream WHEP viewer PLI is relayed to the publisher; keep in sync with
   * `VIDEO_SERVER_COMMAND_REQUEST_KEY_FRAME` in
   * `src/features/webrtc/PersistentEncoderH264Source.ts`.
   */
  const val COMMAND_REQUEST_KEY_FRAME = 0x01

  /**
   * The whitelist of host→device command bytes the control channel accepts. Bytes outside this set
   * are unknown control input and must be ignored rather than forwarded to the handler
   * (issue #4732), keeping the control surface minimal and making future command additions safe by
   * construction.
   */
  val KNOWN_COMMANDS = setOf(COMMAND_REQUEST_KEY_FRAME)

  /** True when [command] is a recognized control byte that may reach the command handler. */
  fun isKnownCommand(command: Int): Boolean = command in KNOWN_COMMANDS

  /** Bit 63: codec configuration data */
  const val PACKET_FLAG_CONFIG = 1L shl 63

  /** Bit 62: key frame (I-frame) */
  const val PACKET_FLAG_KEY_FRAME = 1L shl 62

  /** Bit 61: cached packet replayed for a replacement LocalSocket client. */
  const val PACKET_FLAG_REPLAYED = 1L shl 61

  /** Mask for PTS (bits 0-60). */
  const val PTS_MASK = (1L shl 61) - 1

  fun legacyHeader(width: Int, height: Int): ByteArray =
    ByteBuffer.allocate(12).putInt(CODEC_ID_H264).putInt(width).putInt(height).array()

  fun muxHeader(width: Int, height: Int, audioSampleRateHz: Int, audioChannels: Int): ByteArray =
    ByteBuffer.allocate(44)
      .putInt(CODEC_ID_AMUX)
      .putInt(MUX_VERSION)
      .putInt(2)
      .putInt(TRACK_ID_VIDEO)
      .putInt(CODEC_ID_H264)
      .putInt(width)
      .putInt(height)
      .putInt(TRACK_ID_AUDIO)
      .putInt(CODEC_ID_PCM16)
      .putInt(audioSampleRateHz)
      .putInt(audioChannels)
      .array()

  fun ptsAndFlags(presentationTimeUs: Long, isConfig: Boolean, isKeyFrame: Boolean): Long {
    var ptsAndFlags = presentationTimeUs and PTS_MASK
    if (isConfig) {
      ptsAndFlags = ptsAndFlags or PACKET_FLAG_CONFIG
    }
    if (isKeyFrame) {
      ptsAndFlags = ptsAndFlags or PACKET_FLAG_KEY_FRAME
    }
    return ptsAndFlags
  }

  fun replayed(ptsAndFlags: Long): Long = ptsAndFlags or PACKET_FLAG_REPLAYED

  fun packetHeader(audioEnabled: Boolean, trackId: Int, ptsAndFlags: Long, size: Int): ByteArray =
    if (audioEnabled) {
      ByteBuffer.allocate(16).putInt(trackId).putLong(ptsAndFlags).putInt(size).array()
    } else {
      ByteBuffer.allocate(12).putLong(ptsAndFlags).putInt(size).array()
    }

  /**
   * Assemble the packet header and payload into a single contiguous buffer so each packet can be
   * emitted with one `write` syscall and its header is never split from its payload across TCP
   * segments (issue #4743).
   */
  fun framedPacket(
    audioEnabled: Boolean,
    trackId: Int,
    ptsAndFlags: Long,
    data: ByteArray,
  ): ByteArray {
    val header = packetHeader(audioEnabled, trackId, ptsAndFlags, data.size)
    val framed = ByteArray(header.size + data.size)
    System.arraycopy(header, 0, framed, 0, header.size)
    System.arraycopy(data, 0, framed, header.size, data.size)
    return framed
  }
}
