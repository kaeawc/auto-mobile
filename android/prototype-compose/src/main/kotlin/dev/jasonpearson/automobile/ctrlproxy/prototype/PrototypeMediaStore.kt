package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.PrototypeAssetContract
import dev.jasonpearson.automobile.protocol.PrototypeSpecValidator
import java.io.IOException
import java.util.logging.Level
import java.util.logging.Logger
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

@InternalAutoMobilePrototypeApi
enum class PrototypeMediaKind {
  IMAGE,
  VIDEO,
  AUDIO,
}

@InternalAutoMobilePrototypeApi
enum class PrototypeMediaSource {
  CAMERA,
  LIBRARY,
  MICROPHONE,
  INJECTED,
}

@InternalAutoMobilePrototypeApi
data class PrototypeMediaItem(
  val id: String,
  val kind: PrototypeMediaKind,
  val mimeType: String,
  val bytes: Int,
  val source: PrototypeMediaSource,
  val createdAt: String,
  val width: Int? = null,
  val height: Int? = null,
  val durationMs: Long? = null,
  val name: String? = null,
  val thumbnail: String? = null,
) {
  fun toJson(): JsonObject = buildJsonObject {
    put("asset", id)
    put("kind", kind.name.lowercase())
    put("mimeType", mimeType)
    width?.let { put("width", it) }
    height?.let { put("height", it) }
    put("bytes", bytes)
    put("source", source.name.lowercase())
    put("createdAt", createdAt)
    thumbnail?.let { put("thumbnail", it) }
  }
}

@InternalAutoMobilePrototypeApi
enum class PrototypeMediaRejection(val detail: String) {
  MEDIA_LIMIT("media_limit"),
  EMPTY("empty"),
  KIND_MISMATCH("kind_mismatch"),
  UNSUPPORTED_MIME("unsupported_mime"),
  STORAGE_FAILURE("io"),
}

@InternalAutoMobilePrototypeApi
sealed interface PrototypeMediaPutResult {
  data class Stored(val item: PrototypeMediaItem) : PrototypeMediaPutResult

  data class Rejected(val reason: PrototypeMediaRejection, val message: String) :
    PrototypeMediaPutResult
}

@InternalAutoMobilePrototypeApi
data class PrototypeMediaLimits(
  val maxCount: Int = PrototypeSpecValidator.MAX_PROTOTYPE_MEDIA_ITEMS,
  val maxTotalBytes: Long = PrototypeSpecValidator.MAX_PROTOTYPE_MEDIA_TOTAL_BYTES.toLong(),
  val maxImageBytes: Int = PrototypeSpecValidator.MAX_PROTOTYPE_MEDIA_IMAGE_BYTES,
  val maxVideoBytes: Int = PrototypeSpecValidator.MAX_PROTOTYPE_MEDIA_VIDEO_BYTES,
  val maxAudioBytes: Int = PrototypeSpecValidator.MAX_PROTOTYPE_MEDIA_AUDIO_BYTES,
) {
  internal fun maxBytes(kind: PrototypeMediaKind): Int =
    when (kind) {
      PrototypeMediaKind.IMAGE -> maxImageBytes
      PrototypeMediaKind.VIDEO -> maxVideoBytes
      PrototypeMediaKind.AUDIO -> maxAudioBytes
    }
}

@InternalAutoMobilePrototypeApi
interface PrototypeMediaStore {
  @Suppress("LongParameterList") // The optional fields are the item's media metadata.
  fun put(
    kind: PrototypeMediaKind,
    mimeType: String,
    bytes: ByteArray,
    source: PrototypeMediaSource,
    width: Int? = null,
    height: Int? = null,
    durationMs: Long? = null,
    name: String? = null,
    thumbnail: ByteArray? = null,
  ): PrototypeMediaPutResult

  fun list(): List<PrototypeMediaItem>

  fun lookup(id: String): PrototypeMediaItem?

  /** Returns bytes for an item or its thumbnail, or null if the file is unavailable. */
  fun read(id: String): ByteArray?

  /** Removes an item and its thumbnail by the item's id. */
  fun remove(id: String): Boolean

  fun clear()
}

/**
 * Bounded media storage over a dedicated [files] namespace. [newId] supplies a bare UUID and
 * [clock] supplies an ISO timestamp. Mutations serialize against each other so [clear] can delete
 * all files safely. The bookkeeping monitor is released before any file I/O.
 */
@InternalAutoMobilePrototypeApi
class DefaultPrototypeMediaStore(
  private val files: PrototypeAssetFiles,
  private val newId: () -> String,
  private val clock: () -> String,
  private val limits: PrototypeMediaLimits = PrototypeMediaLimits(),
) : PrototypeMediaStore {
  private class Entry(
    val item: PrototypeMediaItem,
    val fileName: String,
    val thumbnailFileName: String?,
    val storedBytes: Long,
  )

  private val mutationLock = Any()
  private val monitor = Any()
  private val entries = linkedMapOf<String, Entry>()
  private var totalBytes = 0L
  private var nextFile = 0L

  @Suppress("LongParameterList") // Mirrors the store interface.
  override fun put(
    kind: PrototypeMediaKind,
    mimeType: String,
    bytes: ByteArray,
    source: PrototypeMediaSource,
    width: Int?,
    height: Int?,
    durationMs: Long?,
    name: String?,
    thumbnail: ByteArray?,
  ): PrototypeMediaPutResult =
    synchronized(mutationLock) {
      val thumbnailSize = thumbnail?.size ?: 0
      val storedBytes = bytes.size.toLong() + thumbnailSize
      rejectionFor(kind, mimeType, bytes.size, thumbnail?.size)?.let {
        return@synchronized it
      }
      limitRejection(storedBytes)?.let {
        return@synchronized it
      }

      val id = PrototypeAssetContract.MEDIA_ID_PREFIX + newId()
      if (lookup(id) != null) {
        return@synchronized PrototypeMediaPutResult.Rejected(
          PrototypeMediaRejection.STORAGE_FAILURE,
          "Could not allocate a unique prototype media id.",
        )
      }
      val item =
        PrototypeMediaItem(
          id = id,
          kind = kind,
          mimeType = mimeType,
          bytes = bytes.size,
          source = source,
          createdAt = clock(),
          width = width,
          height = height,
          durationMs = durationMs,
          name = name,
          thumbnail = thumbnail?.let { id + THUMBNAIL_SUFFIX },
        )
      val entry =
        Entry(item, "asset-${nextFile++}", thumbnail?.let { "asset-${nextFile++}" }, storedBytes)
      write(entry, bytes, thumbnail)
    }

  private fun rejectionFor(
    kind: PrototypeMediaKind,
    mimeType: String,
    size: Int,
    thumbnailSize: Int?,
  ): PrototypeMediaPutResult.Rejected? {
    val mimeKind = mimeType.substringBefore('/').lowercase()
    return when {
      size == 0 || thumbnailSize == 0 ->
        PrototypeMediaPutResult.Rejected(PrototypeMediaRejection.EMPTY, "Media data is empty.")
      !MIME_TYPE.matches(mimeType) ||
        PrototypeMediaKind.entries.none { it.name.lowercase() == mimeKind } ->
        PrototypeMediaPutResult.Rejected(
          PrototypeMediaRejection.UNSUPPORTED_MIME,
          "Unsupported media MIME type.",
        )
      kind.name.lowercase() != mimeKind ->
        PrototypeMediaPutResult.Rejected(
          PrototypeMediaRejection.KIND_MISMATCH,
          "MIME type does not match the media kind.",
        )
      size > limits.maxBytes(kind) || (thumbnailSize ?: 0) > limits.maxImageBytes ->
        mediaLimit("Media data exceeds the per-file byte limit.")
      else -> null
    }
  }

  private fun limitRejection(storedBytes: Long): PrototypeMediaPutResult.Rejected? =
    synchronized(monitor) {
      when {
        entries.size >= limits.maxCount -> mediaLimit("Media store item limit reached.")
        storedBytes > limits.maxTotalBytes - totalBytes ->
          mediaLimit("Media store byte limit reached.")
        else -> null
      }
    }

  private fun mediaLimit(message: String) =
    PrototypeMediaPutResult.Rejected(PrototypeMediaRejection.MEDIA_LIMIT, message)

  private fun write(
    entry: Entry,
    bytes: ByteArray,
    thumbnail: ByteArray?,
  ): PrototypeMediaPutResult {
    try {
      files.write(entry.fileName, bytes)
      if (thumbnail != null && entry.thumbnailFileName != null) {
        files.write(entry.thumbnailFileName, thumbnail)
      }
    } catch (error: IOException) {
      logger.log(Level.WARNING, "Prototype media write failed", error)
      deleteFiles(entry)
      return PrototypeMediaPutResult.Rejected(
        PrototypeMediaRejection.STORAGE_FAILURE,
        "Failed to store prototype media.",
      )
    }
    synchronized(monitor) {
      entries[entry.item.id] = entry
      totalBytes += entry.storedBytes
    }
    return PrototypeMediaPutResult.Stored(entry.item)
  }

  override fun list(): List<PrototypeMediaItem> =
    synchronized(monitor) {
      entries.values.map { it.item }
    }

  override fun lookup(id: String): PrototypeMediaItem? = synchronized(monitor) { entries[id]?.item }

  override fun read(id: String): ByteArray? {
    val fileName =
      synchronized(monitor) {
        if (id.endsWith(THUMBNAIL_SUFFIX)) {
          entries[id.removeSuffix(THUMBNAIL_SUFFIX)]?.thumbnailFileName
        } else {
          entries[id]?.fileName
        }
      } ?: return null
    return try {
      files.read(fileName)
    } catch (error: IOException) {
      logger.log(Level.WARNING, "Prototype media read failed", error)
      null
    }
  }

  override fun remove(id: String): Boolean =
    synchronized(mutationLock) {
      val entry =
        synchronized(monitor) {
          entries.remove(id)?.also { totalBytes -= it.storedBytes }
        } ?: return@synchronized false
      deleteFiles(entry)
      true
    }

  override fun clear() {
    synchronized(mutationLock) {
      synchronized(monitor) {
        entries.clear()
        totalBytes = 0
      }
      files.deleteAll()
    }
  }

  private fun deleteFiles(entry: Entry) {
    files.delete(entry.fileName)
    entry.thumbnailFileName?.let(files::delete)
  }

  private companion object {
    const val THUMBNAIL_SUFFIX = "/thumb"
    val MIME_TYPE = Regex("[A-Za-z]+/[A-Za-z0-9][A-Za-z0-9!#\$&^_.+-]*")
    val logger: Logger = Logger.getLogger(DefaultPrototypeMediaStore::class.java.name)
  }
}
