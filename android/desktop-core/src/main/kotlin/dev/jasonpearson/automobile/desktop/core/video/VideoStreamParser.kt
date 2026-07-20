package dev.jasonpearson.automobile.desktop.core.video

import java.nio.ByteBuffer
import java.nio.ByteOrder

/** "h264" as a big-endian int, matching the daemon's stream header. */
internal const val CODEC_ID_H264 = 0x68323634

private const val STREAM_HEADER_BYTES = 12
private const val PACKET_HEADER_BYTES = 12
private const val FLAG_CONFIG = 1L shl 63
private const val FLAG_KEY_FRAME = 1L shl 62
private const val PTS_MASK = (1L shl 62) - 1

/** Dimensions advertised by the stream header. Both are zero unless the client sent a size hint. */
data class VideoStreamHeader(val width: Int, val height: Int)

/**
 * One framed access unit.
 *
 * [isConfig] marks parameter sets (SPS/PPS), which the daemon replays to late joiners so they can
 * decode without waiting for the next key frame.
 */
data class VideoPacket(
  val payload: ByteArray,
  val presentationTimeUs: Long,
  val isConfig: Boolean,
  val isKeyFrame: Boolean,
) {
  // Data classes compare arrays by identity, which would make equality useless in tests.
  override fun equals(other: Any?): Boolean =
    other is VideoPacket &&
      payload.contentEquals(other.payload) &&
      presentationTimeUs == other.presentationTimeUs &&
      isConfig == other.isConfig &&
      isKeyFrame == other.isKeyFrame

  override fun hashCode(): Int =
    payload.contentHashCode() * 31 + presentationTimeUs.hashCode() * 31 + isConfig.hashCode()
}

/** Raised when the stream is not the framing this client understands. */
class VideoStreamFormatException(message: String) : Exception(message)

/**
 * Reassembles the daemon's binary video framing from arbitrarily chunked socket reads.
 *
 * The wire format is a 12-byte stream header (codec id, width, height) followed by repeating
 * 12-byte packet headers (`ptsAndFlags` as a big-endian int64, then payload length) each followed
 * by an Annex-B payload. See `src/daemon/videoStreamFraming.ts` for the encoder.
 *
 * Socket reads split anywhere, including mid-header, so bytes are buffered until a complete unit is
 * available. Not thread-safe: feed it from a single reader.
 */
class VideoStreamParser {
  private var buffer = ByteArray(0)
  private var headerSeen = false

  /**
   * Feeds bytes, invoking [onHeader] once for the stream header and [onPacket] for each complete
   * packet. Both may be called zero or many times per chunk.
   */
  fun onBytes(
    chunk: ByteArray,
    onHeader: (VideoStreamHeader) -> Unit,
    onPacket: (VideoPacket) -> Unit,
  ) {
    if (chunk.isEmpty()) return
    buffer = if (buffer.isEmpty()) chunk.copyOf() else buffer + chunk

    var offset = 0

    if (!headerSeen) {
      if (buffer.size - offset < STREAM_HEADER_BYTES) return
      val view = ByteBuffer.wrap(buffer, offset, STREAM_HEADER_BYTES).order(ByteOrder.BIG_ENDIAN)
      val codecId = view.int
      if (codecId != CODEC_ID_H264) {
        throw VideoStreamFormatException(
          "Unexpected codec id 0x${codecId.toUInt().toString(16)}; this client only decodes H.264"
        )
      }
      onHeader(VideoStreamHeader(view.int, view.int))
      headerSeen = true
      offset += STREAM_HEADER_BYTES
    }

    while (buffer.size - offset >= PACKET_HEADER_BYTES) {
      val view = ByteBuffer.wrap(buffer, offset, PACKET_HEADER_BYTES).order(ByteOrder.BIG_ENDIAN)
      val ptsAndFlags = view.long
      val size = view.int
      if (size < 0) {
        throw VideoStreamFormatException("Packet declares a negative length ($size)")
      }
      if (buffer.size - offset - PACKET_HEADER_BYTES < size) {
        // The payload has not fully arrived yet.
        break
      }

      val start = offset + PACKET_HEADER_BYTES
      onPacket(
        VideoPacket(
          payload = buffer.copyOfRange(start, start + size),
          // Bit 63 makes the int64 negative, so mask before reading the timestamp.
          presentationTimeUs = ptsAndFlags and PTS_MASK,
          isConfig = (ptsAndFlags and FLAG_CONFIG) != 0L,
          isKeyFrame = (ptsAndFlags and FLAG_KEY_FRAME) != 0L,
        )
      )
      offset = start + size
    }

    buffer = if (offset == 0) buffer else buffer.copyOfRange(offset, buffer.size)
  }
}
