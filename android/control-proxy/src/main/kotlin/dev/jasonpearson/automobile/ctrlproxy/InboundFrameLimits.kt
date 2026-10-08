package dev.jasonpearson.automobile.ctrlproxy

import android.util.JsonReader
import android.util.JsonToken
import android.util.Log
import dev.jasonpearson.automobile.ctrlproxy.overlay.OverlayAssetLimits
import java.io.ByteArrayInputStream
import java.io.IOException
import java.io.InputStreamReader

/**
 * Per-request-type caps on an inbound frame, checked on the frame's raw bytes before they are
 * decoded into a String or deserialized (#9935). ktor's `maxFrameSize`
 * ([WebSocketServer.MAX_FRAME_SIZE_BYTES]) stays the transport-wide ceiling for every frame; a type
 * listed here is held to a tighter cap derived from its contract. Types without an entry keep only
 * the transport ceiling because no contract bounds their payload (typed text, clipboard text,
 * network mock bodies, CA certificates).
 */
class InboundFrameLimits internal constructor(private val maxBytesByType: Map<String, Long>) {
  /** Frames at or below the smallest cap cannot exceed any cap, so they are never peeked. */
  private val smallestCap: Long = maxBytesByType.values.minOrNull() ?: Long.MAX_VALUE

  /** The rejection for a [frame] above its type's cap, or null when it may be decoded. */
  internal fun check(frame: ByteArray): Rejection? {
    val size = frame.size.toLong()
    if (size <= smallestCap) return null
    val header = InboundFrameHeader.peek(frame)
    val type = header.type ?: return null
    val cap = maxBytesByType[type] ?: return null
    return if (size > cap) Rejection(type, header.requestId, size, cap) else null
  }

  data class Rejection(
    val type: String,
    val requestId: String?,
    val frameBytes: Long,
    val maxBytes: Long,
  ) {
    val message: String
      get() = "Request frame for $type is $frameBytes bytes; the limit is $maxBytes bytes."
  }

  companion object {
    /** Room for the JSON keys, `requestId`, `id` and `mimeType` around an asset's base64 text. */
    internal const val ENVELOPE_ALLOWANCE_BYTES: Long = 64L * 1024

    val DEFAULT: InboundFrameLimits =
      InboundFrameLimits(
        mapOf(
          "put_overlay_asset" to OverlayAssetLimits().maxEncodedLength + ENVELOPE_ALLOWANCE_BYTES,
          "remove_overlay_asset" to ENVELOPE_ALLOWANCE_BYTES,
        )
      )
  }
}

/**
 * The top-level `type` and `requestId` of a raw frame, read by streaming over its bytes. Every
 * other value is skipped without being materialized, wherever it sits in the object, so an
 * oversized payload is never copied into a String. Both fields are null when unreadable.
 */
internal data class InboundFrameHeader(val type: String?, val requestId: String?) {
  companion object {
    private const val TAG = "InboundFrameHeader"

    fun peek(frame: ByteArray): InboundFrameHeader {
      var type: String? = null
      var requestId: String? = null
      try {
        JsonReader(InputStreamReader(ByteArrayInputStream(frame), Charsets.UTF_8)).use { reader ->
          reader.beginObject()
          while (reader.hasNext() && (type == null || requestId == null)) {
            when (reader.nextName()) {
              "type" -> type = reader.nextStringOrSkip()
              "requestId" -> requestId = reader.nextStringOrSkip()
              else -> reader.skipValue()
            }
          }
        }
      } catch (error: IOException) {
        // A malformed frame keeps whatever was read; the full decode reports the syntax error.
        Log.d(TAG, "Frame header unreadable (${frame.size} bytes): ${error.javaClass.simpleName}")
      } catch (error: IllegalStateException) {
        // A non-object frame or an unexpected token: same as malformed, the full decode reports it.
        Log.d(TAG, "Frame header unreadable (${frame.size} bytes): ${error.javaClass.simpleName}")
      }
      return InboundFrameHeader(type, requestId)
    }

    private fun JsonReader.nextStringOrSkip(): String? =
      if (peek() == JsonToken.STRING) nextString()
      else {
        skipValue()
        null
      }
  }
}
