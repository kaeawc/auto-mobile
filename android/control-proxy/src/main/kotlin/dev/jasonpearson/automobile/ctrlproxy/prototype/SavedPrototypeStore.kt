package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.PrototypeSpec
import dev.jasonpearson.automobile.protocol.PrototypeSpecValidator
import java.io.File

const val SAVED_PROTOTYPE_FORMAT_VERSION = 1

data class SavedPrototypeLimits(
  val assets: PrototypeAssetLimits = PrototypeAssetLimits(),
  val maxSavedPrototypes: Int = 50,
  val maxLabelLength: Int = 120,
  val maxSpecBytes: Int = PrototypeSpecValidator.MAX_PROTOTYPE_SPEC_BYTES,
)

data class SavedPrototypeAsset(val id: String, val mediaType: String, val bytes: ByteArray)

data class SavedPrototypeSaveRequest(
  val id: String,
  val label: String,
  val specJson: String,
  val assets: List<SavedPrototypeAsset>,
)

data class SavedPrototypeSummary(
  val id: String,
  val label: String,
  val slug: String,
  val savedAt: Long,
)

enum class SavedPrototypeRejection {
  INVALID_ID,
  INVALID_LABEL,
  SPEC_TOO_LARGE,
  INVALID_SPEC,
  INVALID_ASSET_ID,
  DUPLICATE_ASSET_ID,
  UNSUPPORTED_MIME_TYPE,
  EMPTY_ASSET,
  ASSET_TOO_LARGE,
  COUNT_LIMIT,
  TOTAL_LIMIT,
  MISSING_ASSET,
  SAVED_COUNT_LIMIT,
  STORAGE_FAILURE,
  UNSUPPORTED_EXISTING,
}

sealed interface SavedPrototypeSaveResult {
  data class Saved(val id: String, val slug: String, val replaced: Boolean) :
    SavedPrototypeSaveResult

  data class Rejected(val reason: SavedPrototypeRejection, val message: String) :
    SavedPrototypeSaveResult
}

sealed interface SavedPrototypeLoadResult {
  /** Bytes are a verified snapshot; file paths are valid until this id is replaced or deleted. */
  class Loaded(
    val id: String,
    val label: String,
    val slug: String,
    val savedAt: Long,
    val spec: PrototypeSpec,
    val specJson: String,
    private val bytes: Map<String, ByteArray>,
    private val files: Map<String, File> = emptyMap(),
    private val fonts: Set<String> = emptySet(),
  ) : SavedPrototypeLoadResult {
    fun assetBytes(id: String): ByteArray? = bytes[id]?.copyOf()

    fun assetFile(id: String): File? = files[id]

    fun fontFile(id: String): File? = files[id]?.takeIf { id in fonts }
  }

  data object NotFound : SavedPrototypeLoadResult

  data class UnsupportedFormat(val version: Int) : SavedPrototypeLoadResult {
    val message: String =
      "Unsupported saved prototype format $version; expected $SAVED_PROTOTYPE_FORMAT_VERSION."
  }

  data class Corrupt(val message: String) : SavedPrototypeLoadResult
}

/**
 * Call off the main thread. Credential-encrypted storage may be unavailable before first unlock:
 * save returns STORAGE_FAILURE, load returns Corrupt, delete returns false, and list returns empty.
 * List never throws for storage or corrupt data; unreadable entries are omitted with a log line.
 * The saved-count cap counts only readable current-format manifests, without reading spec/assets.
 * Saving refuses unreadable entries with a parsable manifest. A missing or unparsable manifest may
 * be replaced only at a slug derived from the requested id; other directories are untouched.
 */
interface SavedPrototypeStore {
  fun save(request: SavedPrototypeSaveRequest): SavedPrototypeSaveResult

  fun list(): List<SavedPrototypeSummary>

  fun load(id: String): SavedPrototypeLoadResult

  fun delete(id: String): Boolean
}

/** Injectable disk operations; tests can skip sync and model partial recursive deletion. */
interface SavedPrototypeFileOperations {
  fun sync(file: File)

  fun remove(file: File)

  fun readManifest(file: File): String
}

object SavedPrototypeStores {
  private val stores = mutableMapOf<String, SavedPrototypeStore>()

  @Synchronized
  fun inDirectory(root: File): SavedPrototypeStore {
    val path = root.canonicalPath
    return stores.getOrPut(path) { SavedPrototypeDirectoryStore(File(path)) }
  }
}
