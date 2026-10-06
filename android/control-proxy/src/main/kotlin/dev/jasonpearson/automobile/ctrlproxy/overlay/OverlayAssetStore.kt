package dev.jasonpearson.automobile.ctrlproxy.overlay

import android.util.Log
import dev.jasonpearson.automobile.protocol.OverlayAssetContract
import java.io.IOException
import java.util.concurrent.Executor

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

/**
 * Tells the renderer's decoded-image cache that stored assets changed. [ids] names the assets whose
 * bytes were added, replaced or removed; null means every asset (a clear or a session change).
 * Called after the store monitor and the put lock are released, on the thread that made the change,
 * before that call returns. A listener may therefore call back into the store (`lookup`, `read`)
 * without deadlocking; it must still be quick, since it runs on the caller's thread.
 */
fun interface OverlayAssetChangeListener {
  fun onAssetsChanged(ids: Set<String>?)
}

/** What the renderer needs from the store: metadata, bytes, and a change signal. */
interface OverlayAssetSource {
  fun lookup(id: String): OverlayAssetInfo?

  /** Call off the main thread. Null when unknown, or when the OS evicted the file. */
  fun read(id: String): ByteArray?

  /** Replaces the single registered listener; null unregisters. */
  fun setChangeListener(listener: OverlayAssetChangeListener?)
}

enum class OverlayAssetRejection {
  INVALID_ID,
  UNSUPPORTED_MIME_TYPE,
  EMPTY,
  TOO_LARGE,
  CONTENT_MISMATCH,
  COUNT_LIMIT,
  TOTAL_LIMIT,
  STORAGE_FAILURE,
  SESSION_ENDED,
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
 *
 * The store monitor guards bookkeeping only and is never held across file I/O, so a main-thread
 * [clear] or [lookup] never waits on a multi-megabyte write. A put validates and reserves under the
 * monitor, writes outside it, then commits under it again; puts are serialized against each other
 * so the reservation stays valid. File deletions made by [clear], [remove] and a session change go
 * through [fileWorker], which production points at an IO executor.
 *
 * Assets belong to the observer [session] that uploaded them. Any operation in a later session
 * first drops the earlier session's assets, so a reconnect that outruns the disconnect callback
 * cannot leave leftovers counting against the caps. A put whose write finishes after a [clear] (or
 * such a session change) discards its file and is rejected instead of resurrecting an asset the
 * session no longer owns.
 *
 * Every change (put, remove, [clear], and a session-driven drop) is reported to the change listener
 * after the monitor and put lock are released, so a listener that reads the store cannot deadlock.
 * The lock order is therefore store monitor, never listener; the listener's own locks (the image
 * cache's) are only ever taken with none of the store's locks held.
 */
class OverlayAssetStore(
  private val files: OverlayAssetFiles,
  val limits: OverlayAssetLimits = OverlayAssetLimits(),
  private val session: () -> Int = { 0 },
  private val fileWorker: Executor = Executor { it.run() },
) : OverlayAssetSource {
  private class Entry(val info: OverlayAssetInfo, val fileName: String)

  /** Either a slot to write into or the rejection that explains why there is none. */
  private class Reservation(
    val generation: Long,
    val fileName: String,
    val info: OverlayAssetInfo,
    val rejection: OverlayAssetPutResult.Rejected? = null,
  )

  private val entries = LinkedHashMap<String, Entry>()
  private var totalBytes = 0L
  private var nextFile = 0L

  // Bumped by every clear so an in-flight put can tell its reservation was cancelled.
  private var generation = 0L
  private var ownerSession = session()

  // Serializes puts and the one-time orphan purge; never taken by clear, lookup or read.
  private val putLock = Any()
  private var orphansPurged = false
  @Volatile private var changeListener: OverlayAssetChangeListener? = null

  /**
   * What one call changed, collected under the monitor and delivered by [deliver] once every lock
   * is released. [ids] null means everything.
   */
  private class Changes {
    private var changed = false
    private var everything = false
    private val ids = mutableSetOf<String>()

    fun add(id: String) {
      changed = true
      ids += id
    }

    fun addEverything() {
      changed = true
      everything = true
    }

    fun deliver(listener: OverlayAssetChangeListener?) {
      if (changed) listener?.onAssetsChanged(if (everything) null else ids)
    }
  }

  override fun setChangeListener(listener: OverlayAssetChangeListener?) {
    changeListener = listener
  }

  /** Runs [block] under the monitor, then reports what it changed with the monitor released. */
  private inline fun <T> locked(block: (Changes) -> T): T {
    val changes = Changes()
    try {
      return synchronized(this) { block(changes) }
    } finally {
      changes.deliver(changeListener)
    }
  }

  val count: Int
    get() = locked { changes ->
      dropStaleSessionLocked(changes)
      entries.size
    }

  val totalByteCount: Long
    get() = locked { changes ->
      dropStaleSessionLocked(changes)
      totalBytes
    }

  fun ids(): List<String> = locked { changes ->
    dropStaleSessionLocked(changes)
    entries.keys.toList()
  }

  fun put(id: String, mimeType: String, bytes: ByteArray): OverlayAssetPutResult {
    val changes = Changes()
    try {
      return synchronized(putLock) {
        purgeOrphansLocked()
        val reservation = synchronized(this) { reserve(id, mimeType, bytes, changes) }
        reservation.rejection ?: writeAndCommit(reservation, bytes, changes)
      }
    } finally {
      changes.deliver(changeListener)
    }
  }

  private fun reserve(
    id: String,
    mimeType: String,
    bytes: ByteArray,
    changes: Changes,
  ): Reservation {
    dropStaleSessionLocked(changes)
    val info = OverlayAssetInfo(id, mimeType, bytes.size)
    val rejection = rejectionFor(id, mimeType, bytes) ?: limitRejection(id, bytes.size)
    return Reservation(generation, "asset-${nextFile++}", info, rejection)
  }

  private fun limitRejection(id: String, size: Int): OverlayAssetPutResult.Rejected? {
    val replacedBytes = entries[id]?.info?.byteCount ?: 0
    return when {
      entries[id] == null && entries.size >= limits.maxCount ->
        rejected(
          OverlayAssetRejection.COUNT_LIMIT,
          "Overlay asset limit reached (${limits.maxCount} assets); remove one first.",
        )
      totalBytes - replacedBytes + size > limits.maxTotalBytes ->
        rejected(
          OverlayAssetRejection.TOTAL_LIMIT,
          "Overlay asset storage full (${limits.maxTotalBytes} bytes in total); remove an asset first.",
        )
      else -> null
    }
  }

  private fun writeAndCommit(
    reservation: Reservation,
    bytes: ByteArray,
    changes: Changes,
  ): OverlayAssetPutResult {
    try {
      files.write(reservation.fileName, bytes)
    } catch (error: IOException) {
      Log.w(TAG, "Overlay asset write failed (${bytes.size} bytes)", error)
      discardFile(reservation.fileName)
      return rejected(OverlayAssetRejection.STORAGE_FAILURE, "Failed to store overlay asset.")
    }
    val result = synchronized(this) { commit(reservation, changes) }
    if (result is OverlayAssetPutResult.Rejected) discardFile(reservation.fileName)
    return result
  }

  private fun commit(reservation: Reservation, changes: Changes): OverlayAssetPutResult {
    dropStaleSessionLocked(changes)
    if (reservation.generation != generation) {
      return rejected(
        OverlayAssetRejection.SESSION_ENDED,
        "Overlay asset session ended before the upload finished; upload it again.",
      )
    }
    val info = reservation.info
    // Re-read: a remove during the write only loosens the caps that were checked at reservation.
    val replaced = entries[info.id]
    entries[info.id] = Entry(info, reservation.fileName)
    totalBytes += info.byteCount - (replaced?.info?.byteCount ?: 0)
    replaced?.let { discardFile(it.fileName) }
    // Also for a new id: a placeholder drawn while it was missing must now pick it up.
    changes.add(info.id)
    return OverlayAssetPutResult.Stored(info, replaced != null)
  }

  /** Idempotent: returns whether an asset was actually removed. */
  fun remove(id: String): Boolean = locked { changes ->
    dropStaleSessionLocked(changes)
    val entry = entries.remove(id)
    if (entry != null) {
      totalBytes -= entry.info.byteCount
      discardFile(entry.fileName)
      changes.add(id)
    }
    entry != null
  }

  /**
   * Drops every asset and cancels any put still writing. The in-memory state is reset before this
   * returns, so a following [lookup] is already null; the files go on [fileWorker].
   */
  fun clear() {
    locked { changes ->
      ownerSession = session()
      dropAllLocked(changes)
    }
  }

  /**
   * Service start: schedules removal of files a previous process left behind. It runs before the
   * first put writes anything, so it can only ever see orphans.
   */
  fun purgeLeftovers() {
    fileWorker.execute { synchronized(putLock) { purgeOrphansLocked() } }
  }

  private fun purgeOrphansLocked() {
    if (orphansPurged) return
    orphansPurged = true
    try {
      files.deleteAll()
    } catch (error: RuntimeException) {
      Log.w(TAG, "Overlay asset orphan cleanup failed", error)
    }
  }

  private fun dropAllLocked(changes: Changes) {
    generation++
    val names = entries.values.map { it.fileName }
    entries.clear()
    totalBytes = 0
    names.forEach(::discardFile)
    changes.addEverything()
  }

  /** A new observer session starts with an empty store; the previous session's assets are gone. */
  private fun dropStaleSessionLocked(changes: Changes) {
    val current = session()
    if (current == ownerSession) return
    ownerSession = current
    dropAllLocked(changes)
  }

  private fun discardFile(name: String) {
    fileWorker.execute {
      try {
        files.delete(name)
      } catch (error: RuntimeException) {
        Log.w(TAG, "Overlay asset file cleanup failed", error)
      }
    }
  }

  /** Renderer lookup: null means the id is unknown, which the renderer shows as a placeholder. */
  override fun lookup(id: String): OverlayAssetInfo? = locked { changes ->
    dropStaleSessionLocked(changes)
    entries[id]?.info
  }

  /** Stored bytes for [id], or null when unknown or unreadable. Call off the main thread. */
  override fun read(id: String): ByteArray? {
    val fileName =
      locked { changes ->
        dropStaleSessionLocked(changes)
        entries[id]?.fileName
      } ?: return null
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
