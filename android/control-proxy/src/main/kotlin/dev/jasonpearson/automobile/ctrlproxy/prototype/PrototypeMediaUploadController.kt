package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.PrototypeMediaResult
import dev.jasonpearson.automobile.protocol.PrototypeMediaUploadReceiver
import kotlin.coroutines.CoroutineContext
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Answers the chunked media upload requests (#14254): `put_prototype_asset_begin`, `_chunk`,
 * `_commit` and `_abort`. Every request gets exactly one `prototype_result` through [sink]; a
 * refusal carries the receiver's rejection code. Chunk bytes and base64 text are never logged.
 *
 * Media belongs to the observer [session] that uploaded it, like the image store: the first request
 * of a later session drops every earlier upload and stored file before it runs. Receiver calls run
 * on [io] because each one writes, renames or deletes a cache file.
 */
class PrototypeMediaUploadController(
  private val receiver: PrototypeMediaUploadReceiver,
  private val sink: PrototypeResultSink,
  private val session: () -> Int = { 0 },
  private val io: CoroutineContext = Dispatchers.IO,
) {
  private var ownerSession = session()

  suspend fun begin(requestId: String?, id: String, mimeType: String, size: Long, sha256: String) =
    reply(requestId) { receiver.begin(id, mimeType, size, sha256) }

  suspend fun chunk(requestId: String?, id: String, offset: Long, dataBase64: String) =
    reply(requestId) { receiver.chunkBase64(id, offset, dataBase64) }

  suspend fun commit(requestId: String?, id: String) = reply(requestId) { receiver.commit(id) }

  suspend fun abort(requestId: String?, id: String) =
    reply(requestId) {
      receiver.abort(id)
      null
    }

  /** Drops every upload and stored media file, as when the prototype session ends. */
  fun clear() = receiver.clear()

  private suspend fun reply(requestId: String?, action: () -> PrototypeMediaResult?) {
    val result =
      withContext(io) {
        dropEarlierSession()
        action()
      }
    if (result is PrototypeMediaResult.Rejected) {
      sink.sendMediaRefusal(requestId, result.reason.code, result.message)
    } else {
      sink.send(requestId, true, null)
    }
  }

  @Synchronized
  private fun dropEarlierSession() {
    val current = session()
    if (current == ownerSession) return
    ownerSession = current
    receiver.clear()
  }
}
