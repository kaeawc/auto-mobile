package dev.jasonpearson.automobile.desktop.core.video

import java.nio.ByteBuffer
import java.nio.ByteOrder

/** "h264" as a big-endian int, matching the daemon's stream header. */
internal const val CODEC_ID_H264 = 0x68323634

private const val STREAM_HEADER_BYTES = 12
private const val PACKET_HEADER_BYTES = 12
private const val FLAG_CONFIG = 1L shl 63
private const val FLAG_KEY_FRAME = 1L shl 62

// Mirror src/daemon/videoStreamFraming.ts: PACKET_FLAG_SUBSCRIPTION_NOTICE and
// SUBSCRIPTION_NOTICE_CODES. Bit 61 is also ROTATION_PRESENT on CONFIG packets.
private const val FLAG_SUBSCRIPTION_NOTICE = 1L shl 61
private const val NOTICE_DOWNGRADED_TO_VIEWER = 1L
private const val NOTICE_DEVICE_REMOVED = 2L
private const val NOTICE_IDENTITY_QUARANTINED = 3L
private const val NOTICE_DAEMON_SHUTDOWN = 4L
private const val NOTICE_SESSION_ENDED = 5L
private const val NOTICE_DEVICE_RESTORED = 6L

/**
 * Bit 61: ROTATION_PRESENT (issue #4786). Set on a CONFIG packet whose bits 60-59 attest a display
 * rotation (`0..3`). The daemon relay leaves it clear when its source cannot prove rotation
 * (screenrecord/iOS), so an absent bit means "unknown" — distinct from the valid value 0. See
 * `src/daemon/videoStreamFraming.ts` for the encoder.
 */
private const val FLAG_ROTATION_PRESENT = 1L shl 61
/** Bit 59 is CONFIG-only rotation data, so it is free for non-CONFIG dropped-frame telemetry. */
private const val FLAG_DROPPED_FRAMES = 1L shl 59
private const val ROTATION_SHIFT = 59
private const val ROTATION_MASK = 0b11L shl ROTATION_SHIFT

/**
 * Bit 60 on a non-CONFIG, zero-payload packet: a relay-originated heartbeat (issue #7549). Bit 60
 * is otherwise only meaningful on a CONFIG packet (part of the rotation field), so it is free to
 * reuse here as long as CONFIG stays clear. See `src/daemon/videoStreamFraming.ts` for the encoder.
 */
private const val FLAG_HEARTBEAT = 1L shl 60

/**
 * Bits 0-58 carry the presentation timestamp. Narrowed from bits 0-61 for the rotation presence bit
 * and field; backward compatible because a real microsecond PTS never reaches bit 59.
 */
private const val PTS_MASK = (1L shl ROTATION_SHIFT) - 1

enum class VideoStreamEndReason(val wire: String) {
  DeviceRemoved("device_removed"),
  IdentityQuarantined("identity_quarantined"),
  DaemonShutdown("daemon_shutdown"),
  SessionEnded("session_ended"),
  DeviceRestored("device_restored");

  companion object {
    fun fromWire(value: String?): VideoStreamEndReason? = entries.firstOrNull { it.wire == value }
  }
}

sealed interface VideoStreamNotice {
  data object Downgraded : VideoStreamNotice

  data class Ended(val reason: VideoStreamEndReason) : VideoStreamNotice

  data class Unknown(val code: Long) : VideoStreamNotice
}

private fun subscriptionNotice(code: Long): VideoStreamNotice =
  when (code) {
    NOTICE_DOWNGRADED_TO_VIEWER -> VideoStreamNotice.Downgraded
    NOTICE_DEVICE_REMOVED -> VideoStreamNotice.Ended(VideoStreamEndReason.DeviceRemoved)
    NOTICE_IDENTITY_QUARANTINED -> VideoStreamNotice.Ended(VideoStreamEndReason.IdentityQuarantined)
    NOTICE_DAEMON_SHUTDOWN -> VideoStreamNotice.Ended(VideoStreamEndReason.DaemonShutdown)
    NOTICE_SESSION_ENDED -> VideoStreamNotice.Ended(VideoStreamEndReason.SessionEnded)
    NOTICE_DEVICE_RESTORED -> VideoStreamNotice.Ended(VideoStreamEndReason.DeviceRestored)
    else -> VideoStreamNotice.Unknown(code)
  }

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
  /**
   * Attested display rotation (`0..3`) from a CONFIG packet, or null when unknown (issue #4786): a
   * non-config packet, or a config packet from a relay whose source could not prove rotation. Null
   * leaves the control gate to fail closed rather than trust an unattested orientation.
   */
  val rotation: Int? = null,
  /** Cumulative source-encoder drops in a zero-payload telemetry packet (#5582). */
  val droppedFrames: Long? = null,
  /**
   * A relay-originated, zero-payload keep-alive (issue #7549), sent while the capture is producing
   * data so a source with no idle output of its own (screenrecord, iOS) still gives the
   * Streaming-stall watchdog something to see progress on.
   */
  val heartbeat: Boolean = false,
) {
  // Data classes compare arrays by identity, which would make equality useless in tests.
  override fun equals(other: Any?): Boolean =
    other is VideoPacket &&
      payload.contentEquals(other.payload) &&
      presentationTimeUs == other.presentationTimeUs &&
      isConfig == other.isConfig &&
      isKeyFrame == other.isKeyFrame &&
      rotation == other.rotation &&
      droppedFrames == other.droppedFrames &&
      heartbeat == other.heartbeat

  override fun hashCode(): Int =
    payload.contentHashCode() * 31 +
      presentationTimeUs.hashCode() * 31 +
      isConfig.hashCode() +
      droppedFrames.hashCode() +
      heartbeat.hashCode()
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
  var hasEnded: Boolean = false
    private set

  /** Raw bytes after the end notice, including a terminal JSON line if the relay sent one. */
  val trailingBytes: ByteArray
    get() = buffer.copyOf()

  /**
   * Feeds the first [length] bytes of [chunk], invoking [onHeader] once for the stream header and
   * [onPacket] for each complete video/telemetry packet and [onNotice] for subscription notices.
   * After an end notice, binary parsing stops and subsequent bytes are retained in [trailingBytes].
   *
   * [length] lets a caller pass a reused read buffer without slicing it first (the reader fills a
   * fixed 64KB buffer and only `read` bytes are valid). When there is no buffered remainder from a
   * previous call — the common case, where a read lands on packet boundaries — this parses straight
   * out of [chunk] and copies nothing but the per-packet payloads and any partial-packet tail. That
   * removes two full-buffer copies per read on the 60fps hot path (the caller's slice and this
   * parser's old `buffer + chunk` accumulation), which was steady heap churn feeding GC.
   */
  fun onBytes(
    chunk: ByteArray,
    onHeader: (VideoStreamHeader) -> Unit,
    onPacket: (VideoPacket) -> Unit,
    onNotice: (VideoStreamNotice) -> Unit = {},
  ) = onBytes(chunk, chunk.size, onHeader, onPacket, onNotice)

  fun onBytes(
    chunk: ByteArray,
    length: Int,
    onHeader: (VideoStreamHeader) -> Unit,
    onPacket: (VideoPacket) -> Unit,
    onNotice: (VideoStreamNotice) -> Unit = {},
  ) {
    if (length <= 0) return

    // Parse source: the incoming bytes directly when nothing is buffered, otherwise the buffered
    // remainder with the new bytes appended. `src` may be the caller's reused buffer, so every
    // bound below is `srcLen` (valid bytes), never `src.size`.
    val src: ByteArray
    val srcLen: Int
    if (buffer.isEmpty()) {
      src = chunk
      srcLen = length
    } else {
      src = ByteArray(buffer.size + length)
      System.arraycopy(buffer, 0, src, 0, buffer.size)
      System.arraycopy(chunk, 0, src, buffer.size, length)
      srcLen = src.size
      buffer = EMPTY
    }

    if (hasEnded) {
      buffer = src.copyOfRange(0, srcLen)
      return
    }

    var offset = 0

    if (!headerSeen) {
      if (srcLen - offset < STREAM_HEADER_BYTES) {
        buffer = src.copyOfRange(offset, srcLen)
        return
      }
      val view = ByteBuffer.wrap(src, offset, STREAM_HEADER_BYTES).order(ByteOrder.BIG_ENDIAN)
      val codecId = view.int
      if (codecId != CODEC_ID_H264) {
        throw VideoStreamFormatException(
          "Unexpected codec id 0x${codecId.toUInt().toString(16)}; this client only decodes H.264",
        )
      }
      onHeader(VideoStreamHeader(view.int, view.int))
      headerSeen = true
      offset += STREAM_HEADER_BYTES
    }

    while (srcLen - offset >= PACKET_HEADER_BYTES) {
      val view = ByteBuffer.wrap(src, offset, PACKET_HEADER_BYTES).order(ByteOrder.BIG_ENDIAN)
      val ptsAndFlags = view.long
      val size = view.int
      if (size < 0) {
        throw VideoStreamFormatException("Packet declares a negative length ($size)")
      }
      if (srcLen - offset - PACKET_HEADER_BYTES < size) {
        // The payload has not fully arrived yet.
        break
      }

      val start = offset + PACKET_HEADER_BYTES
      val isConfig = (ptsAndFlags and FLAG_CONFIG) != 0L
      val isDroppedFrames = !isConfig && size == 0 && (ptsAndFlags and FLAG_DROPPED_FRAMES) != 0L
      val isHeartbeat = !isConfig && size == 0 && (ptsAndFlags and FLAG_HEARTBEAT) != 0L
      val isKeyFrame = (ptsAndFlags and FLAG_KEY_FRAME) != 0L
      if (
        !isConfig &&
          !isKeyFrame &&
          size == 0 &&
          !isHeartbeat &&
          !isDroppedFrames &&
          (ptsAndFlags and FLAG_SUBSCRIPTION_NOTICE) != 0L
      ) {
        val notice = subscriptionNotice(ptsAndFlags and PTS_MASK)
        offset = start
        if (notice is VideoStreamNotice.Ended) hasEnded = true
        onNotice(notice)
        if (hasEnded) break
        continue
      }
      onPacket(
        VideoPacket(
          payload = src.copyOfRange(start, start + size),
          // Bit 63 makes the int64 negative, so mask before reading the timestamp.
          presentationTimeUs = ptsAndFlags and PTS_MASK,
          isConfig = isConfig,
          isKeyFrame = isKeyFrame,
          // Rotation is attested only on a config packet carrying the presence bit (issue #4786).
          rotation =
            if (isConfig && (ptsAndFlags and FLAG_ROTATION_PRESENT) != 0L) {
              ((ptsAndFlags and ROTATION_MASK) shr ROTATION_SHIFT).toInt()
            } else {
              null
            },
          droppedFrames = if (isDroppedFrames) ptsAndFlags and PTS_MASK else null,
          heartbeat = isHeartbeat,
        ),
      )
      offset = start + size
    }

    // Keep only the unconsumed tail. Empty in the common case, so nothing is retained from `src`.
    buffer = if (offset >= srcLen) EMPTY else src.copyOfRange(offset, srcLen)
  }

  private companion object {
    val EMPTY = ByteArray(0)
  }
}
