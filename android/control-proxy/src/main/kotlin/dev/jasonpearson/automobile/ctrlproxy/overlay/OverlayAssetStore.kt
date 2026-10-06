package dev.jasonpearson.automobile.ctrlproxy.overlay

import android.util.Log
import dev.jasonpearson.automobile.protocol.OverlayAssetContract
import java.io.IOException

/**
 * Where asset bytes live. The production implementation is a directory under the CtrlProxy cache;
 * tests use an in-memory fake. Names are opaque store-generated tokens, never asset ids, so an id
 * can never reach the file system.
 */
interface OverlayAssetFiles {
  @Throws(IOException::class) fun write(name: String, bytes: ByteArray)

  @Throws(IOException::class) fun read(name: String): ByteArray?

  fun delete(name: String)

  fun deleteAll()
}

/** Caps and allowed types, defaulting to the contract shared with the TypeScript host. */
data class OverlayAssetLimits(
  val maxAssetBytes: Int = OverlayAssetContract.MAX_OVERLAY_ASSET_BYTES,
  val maxCount: Int = OverlayAssetContract.MAX_OVERLAY_ASSET_COUNT,
  val maxTotalBytes: Int = OverlayAssetContract.MAX_OVERLAY_ASSET_TOTAL_BYTES,
  val maxIdLength: Int = OverlayAssetContract.MAX_OVERLAY_ASSET_ID_LENGTH,
  val mimeTypes: Set<String> = OverlayAssetContract.MIME_TYPES,
) {
  /** Longest base64 text that can still decode to [maxAssetBytes]; longer is rejected unread. */
  val maxEncodedLength: Long = (maxAssetBytes.toLong() + 2) / 3 * 4
}

/**
 * Metadata the renderer needs to decide how to decode; the bytes come from
 * [OverlayAssetStore.read].
 */
data class OverlayAssetInfo(val id: String, val mimeType: String, val byteCount: Int)

enum class OverlayAssetRejection {
  INVALID_ID,
  UNSUPPORTED_MIME_TYPE,
  EMPTY,
  TOO_LARGE,
  CONTENT_MISMATCH,
  COUNT_LIMIT,
  TOTAL_LIMIT,
  STORAGE_FAILURE,
}

sealed interface OverlayAssetPutResult {
  data class Stored(val info: OverlayAssetInfo, val replaced: Boolean) : OverlayAssetPutResult

  /** [message] is the caller-facing text; the store is left exactly as it was. */
  data class Rejected(val reason: OverlayAssetRejection, val message: String) :
    OverlayAssetPutResult
}

/**
 * Bounded, replace-by-id asset store. Pure logic over [OverlayAssetFiles]: no image decoding, so it
 * runs in plain JVM tests. When full a put is rejected, never evicting: the agent gets a clear
 * error and chooses what to remove, because silently dropping an asset a live overlay references
 * would turn into a placeholder. A rejected put, including a rejected replacement, leaves every
 * existing asset untouched. Bytes are never logged.
 */
class OverlayAssetStore(
  private val files: OverlayAssetFiles,
  val limits: OverlayAssetLimits = OverlayAssetLimits(),
) {
  private class Entry(val info: OverlayAssetInfo, val fileName: String)

  private val entries = LinkedHashMap<String, Entry>()
  private var totalBytes = 0L
  private var nextFile = 0L

  val count: Int
    @Synchronized get() = entries.size

  val totalByteCount: Long
    @Synchronized get() = totalBytes

  @Synchronized fun ids(): List<String> = entries.keys.toList()

  @Synchronized
  fun put(id: String, mimeType: String, bytes: ByteArray): OverlayAssetPutResult {
    rejectionFor(id, mimeType, bytes)?.let {
      return it
    }
    val replaced = entries[id]
    val replacedBytes = replaced?.info?.byteCount ?: 0
    if (replaced == null && entries.size >= limits.maxCount) {
      return rejected(
        OverlayAssetRejection.COUNT_LIMIT,
        "Overlay asset limit reached (${limits.maxCount} assets); remove one first.",
      )
    }
    if (totalBytes - replacedBytes + bytes.size > limits.maxTotalBytes) {
      return rejected(
        OverlayAssetRejection.TOTAL_LIMIT,
        "Overlay asset storage full (${limits.maxTotalBytes} bytes in total); remove an asset first.",
      )
    }
    val fileName = "asset-${nextFile++}"
    try {
      files.write(fileName, bytes)
    } catch (error: IOException) {
      Log.w(TAG, "Overlay asset write failed (${bytes.size} bytes)", error)
      files.delete(fileName)
      return rejected(OverlayAssetRejection.STORAGE_FAILURE, "Failed to store overlay asset.")
    }
    val info = OverlayAssetInfo(id, mimeType, bytes.size)
    entries[id] = Entry(info, fileName)
    totalBytes += bytes.size - replacedBytes
    replaced?.let { files.delete(it.fileName) }
    return OverlayAssetPutResult.Stored(info, replaced != null)
  }

  /** Idempotent: returns whether an asset was actually removed. */
  @Synchronized
  fun remove(id: String): Boolean {
    val entry = entries.remove(id) ?: return false
    totalBytes -= entry.info.byteCount
    files.delete(entry.fileName)
    return true
  }

  /** Drops every asset and any orphan file a previous process left behind. */
  @Synchronized
  fun clear() {
    entries.clear()
    totalBytes = 0
    files.deleteAll()
  }

  /** Renderer lookup: null means the id is unknown, which the renderer shows as a placeholder. */
  @Synchronized fun lookup(id: String): OverlayAssetInfo? = entries[id]?.info

  /** Stored bytes for [id], or null when unknown or unreadable. Call off the main thread. */
  fun read(id: String): ByteArray? {
    val fileName = synchronized(this) { entries[id]?.fileName } ?: return null
    return try {
      files.read(fileName)
    } catch (error: IOException) {
      Log.w(TAG, "Overlay asset read failed", error)
      null
    }
  }

  private fun rejectionFor(
    id: String,
    mimeType: String,
    bytes: ByteArray,
  ): OverlayAssetPutResult.Rejected? =
    when {
      id.isEmpty() || id.length > limits.maxIdLength ->
        rejected(
          OverlayAssetRejection.INVALID_ID,
          "Overlay asset id must be 1 to ${limits.maxIdLength} characters.",
        )
      mimeType !in limits.mimeTypes ->
        rejected(
          OverlayAssetRejection.UNSUPPORTED_MIME_TYPE,
          "Unsupported overlay asset MIME type; use one of ${limits.mimeTypes.sorted()}.",
        )
      bytes.isEmpty() -> rejected(OverlayAssetRejection.EMPTY, "Overlay asset has no data.")
      bytes.size > limits.maxAssetBytes ->
        rejected(
          OverlayAssetRejection.TOO_LARGE,
          "Overlay asset is ${bytes.size} bytes; the limit is ${limits.maxAssetBytes}.",
        )
      !matchesSignature(mimeType, bytes) ->
        rejected(
          OverlayAssetRejection.CONTENT_MISMATCH,
          "Overlay asset bytes are not a valid $mimeType image.",
        )
      else -> null
    }

  private fun rejected(reason: OverlayAssetRejection, message: String) =
    OverlayAssetPutResult.Rejected(reason, message)

  private companion object {
    const val TAG = "OverlayAssetStore"
  }
}

/** Cheap magic-number check so a mislabeled payload fails here rather than at decode time. */
internal fun matchesSignature(mimeType: String, bytes: ByteArray): Boolean =
  when (mimeType) {
    "image/png" -> bytes.startsWith(PNG_SIGNATURE)
    "image/jpeg" -> bytes.startsWith(JPEG_SIGNATURE)
    "image/webp" -> bytes.startsWith(RIFF_SIGNATURE) && bytes.matchesAt(8, WEBP_SIGNATURE)
    else -> false
  }

private val PNG_SIGNATURE = intArrayOf(0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A)
private val JPEG_SIGNATURE = intArrayOf(0xFF, 0xD8, 0xFF)
private val RIFF_SIGNATURE = intArrayOf(0x52, 0x49, 0x46, 0x46)
private val WEBP_SIGNATURE = intArrayOf(0x57, 0x45, 0x42, 0x50)

private fun ByteArray.startsWith(signature: IntArray) = matchesAt(0, signature)

private fun ByteArray.matchesAt(offset: Int, signature: IntArray): Boolean =
  size >= offset + signature.size &&
    signature.indices.all { (this[offset + it].toInt() and 0xFF) == signature[it] }
