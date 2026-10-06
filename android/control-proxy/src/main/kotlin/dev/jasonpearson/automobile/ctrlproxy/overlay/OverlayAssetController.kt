package dev.jasonpearson.automobile.ctrlproxy.overlay

import android.util.Log
import kotlinx.coroutines.CancellationException

fun interface OverlayBase64Decoder {
  /** Throws [IllegalArgumentException] for text that is not valid base64. */
  fun decode(encoded: String): ByteArray
}

/**
 * Answers `put_overlay_asset` and `remove_overlay_asset`. Every request gets exactly one
 * `overlay_result` through [sink], on every path: success, a rejected asset, undecodable data, or
 * an unexpected failure. Asset bytes and base64 text are never logged; errors name only the rule
 * broken.
 */
class OverlayAssetController(
  private val store: OverlayAssetStore,
  private val sink: OverlayResultSink,
  private val decoder: OverlayBase64Decoder,
) {
  suspend fun put(requestId: String?, id: String, mimeType: String, dataBase64: String) =
    reply(requestId) { putError(id, mimeType, dataBase64) }

  suspend fun remove(requestId: String?, id: String) =
    reply(requestId) {
      store.remove(id)
      null
    }

  private fun putError(id: String, mimeType: String, dataBase64: String): String? {
    // Size is checked on the text first so an oversized payload is never decoded into the heap.
    if (dataBase64.length > store.limits.maxEncodedLength) {
      return "Overlay asset is larger than the ${store.limits.maxAssetBytes} byte limit."
    }
    val bytes =
      try {
        decoder.decode(dataBase64)
      } catch (error: IllegalArgumentException) {
        Log.w(TAG, "Overlay asset data is not valid base64 (${dataBase64.length} chars)")
        return "Overlay asset data is not valid base64."
      }
    return (store.put(id, mimeType, bytes) as? OverlayAssetPutResult.Rejected)?.message
  }

  private suspend fun reply(requestId: String?, action: () -> String?) {
    val error =
      try {
        action()
      } catch (error: CancellationException) {
        throw error
      } catch (error: Exception) {
        Log.w(TAG, "Overlay asset request failed", error)
        error.message ?: "Overlay asset request failed (${error.javaClass.simpleName})"
      }
    sink.send(requestId, error == null, error)
  }

  private companion object {
    const val TAG = "OverlayAssetController"
  }
}
