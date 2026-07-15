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

  /** Bit 63: codec configuration data */
  const val PACKET_FLAG_CONFIG = 1L shl 63

  /** Bit 62: key frame (I-frame) */
  const val PACKET_FLAG_KEY_FRAME = 1L shl 62

  /** Mask for PTS (bits 0-61) */
  const val PTS_MASK = (1L shl 62) - 1

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

  fun packetHeader(audioEnabled: Boolean, trackId: Int, ptsAndFlags: Long, size: Int): ByteArray =
    if (audioEnabled) {
      ByteBuffer.allocate(16).putInt(trackId).putLong(ptsAndFlags).putInt(size).array()
    } else {
      ByteBuffer.allocate(12).putLong(ptsAndFlags).putInt(size).array()
    }
}
