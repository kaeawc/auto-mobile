package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.util.Log
import kotlinx.coroutines.CancellationException

fun interface PrototypeBase64Decoder {
  /** Throws [IllegalArgumentException] for text that is not valid base64. */
  fun decode(encoded: String): ByteArray
}

/**
 * Answers `put_prototype_asset` and `remove_prototype_asset`. Every request gets exactly one
 * `prototype_result` through [sink], on every path: success, a rejected asset, undecodable data, or
 * an unexpected failure. Asset bytes and base64 text are never logged; errors name only the rule
 * broken.
 */
class PrototypeAssetController(
  private val store: PrototypeAssetStore,
  private val sink: PrototypeResultSink,
  private val decoder: PrototypeBase64Decoder,
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
      return "Prototype asset is larger than the ${store.limits.maxAssetBytes} byte limit."
    }
    val bytes =
      try {
        decoder.decode(dataBase64)
      } catch (error: IllegalArgumentException) {
        Log.w(TAG, "Prototype asset data is not valid base64 (${dataBase64.length} chars)")
        return "Prototype asset data is not valid base64."
      }
    return (store.put(id, mimeType, bytes) as? PrototypeAssetPutResult.Rejected)?.message
  }

  private suspend fun reply(requestId: String?, action: () -> String?) {
    val error =
      try {
        action()
      } catch (error: CancellationException) {
        throw error
      } catch (error: Exception) {
        Log.w(TAG, "Prototype asset request failed", error)
        error.message ?: "Prototype asset request failed (${error.javaClass.simpleName})"
      }
    sink.send(requestId, error == null, error)
  }

  private companion object {
    const val TAG = "PrototypeAssetController"
  }
}
