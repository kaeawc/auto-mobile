package dev.jasonpearson.automobile.protoviewer

import dev.jasonpearson.automobile.ctrlproxy.prototype.SavedPrototypeLimits
import dev.jasonpearson.automobile.ctrlproxy.prototype.SavedPrototypeLoadResult
import dev.jasonpearson.automobile.ctrlproxy.prototype.SavedPrototypeSaveRequest
import dev.jasonpearson.automobile.ctrlproxy.prototype.SavedPrototypeSaveResult
import dev.jasonpearson.automobile.ctrlproxy.prototype.SavedPrototypeStore
import dev.jasonpearson.automobile.ctrlproxy.prototype.sha256Hex
import dev.jasonpearson.automobile.protocol.PrototypeSpecValidation
import dev.jasonpearson.automobile.protocol.PrototypeSpecValidator
import dev.jasonpearson.automobile.prototype.AutoMobilePrototype
import java.util.UUID
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

const val MAX_LIBRARY_PROTOTYPES = 200
val libraryLimits = SavedPrototypeLimits(maxSavedPrototypes = MAX_LIBRARY_PROTOTYPES)

fun interface IdGenerator {
  fun newId(): String
}

fun interface LibraryClock {
  fun nowMillis(): Long
}

@Serializable
enum class LibrarySource {
  mcp,
  file,
  share,
  paste,
}

@Serializable
data class LibraryEntry(
  val libraryId: String,
  val label: String,
  val importedAt: Long,
  val lastOpenedAt: Long,
  val source: LibrarySource,
  val specSha256: String,
  val requires: List<String>,
  val pinned: Boolean,
)

enum class LibraryError {
  NotFound,
  Corrupt,
  UnsupportedFormat,
  Storage,
  Limit,
  Invalid,
}

sealed interface LibraryResult<out T> {
  data class Success<T>(val value: T) : LibraryResult<T>

  data class Failure(val error: LibraryError) : LibraryResult<Nothing>
}

data class LibraryPrototype(val entry: LibraryEntry, val saved: SavedPrototypeLoadResult.Loaded)

/**
 * Synchronous storage boundary; callers use their injected I/O dispatcher. No delete in slice 1.
 */
interface LibraryRepository {
  fun list(): LibraryResult<List<LibraryEntry>>

  fun get(libraryId: String): LibraryResult<LibraryPrototype>

  fun markOpened(libraryId: String): LibraryResult<Unit>

  fun resetStorage(libraryId: String): LibraryResult<Unit>
}

/** Only app-owned importing code constructs source/metadata; never deserialize it from a bundle. */
class DirectoryLibraryRepository(
  private val store: SavedPrototypeStore,
  private val files: LibraryFileOperations,
  private val storage: LibraryStorage,
  private val ids: IdGenerator = IdGenerator { UUID.randomUUID().toString() },
  private val clock: LibraryClock = LibraryClock(System::currentTimeMillis),
) : LibraryRepository {
  private val json = Json {
    ignoreUnknownKeys = false
    encodeDefaults = true
  }

  @Synchronized
  override fun list(): LibraryResult<List<LibraryEntry>> = storageResult {
    files
      .ids()
      .mapNotNull { id -> readEntry(id) }
      .sortedWith(compareByDescending<LibraryEntry> { it.lastOpenedAt }.thenBy { it.libraryId })
      .take(MAX_LIBRARY_PROTOTYPES)
  }

  @Synchronized
  override fun get(libraryId: String): LibraryResult<LibraryPrototype> {
    val entry = readEntry(libraryId) ?: return LibraryResult.Failure(LibraryError.NotFound)
    return when (val loaded = storageResult { store.load(libraryId) }) {
      is LibraryResult.Failure -> loaded
      is LibraryResult.Success ->
        when (val saved = loaded.value) {
          SavedPrototypeLoadResult.NotFound -> LibraryResult.Failure(LibraryError.NotFound)
          is SavedPrototypeLoadResult.Corrupt -> LibraryResult.Failure(LibraryError.Corrupt)
          is SavedPrototypeLoadResult.UnsupportedFormat ->
            LibraryResult.Failure(LibraryError.UnsupportedFormat)
          is SavedPrototypeLoadResult.Loaded -> validateLoaded(entry, saved)
        }
    }
  }

  private fun validateLoaded(
    entry: LibraryEntry,
    saved: SavedPrototypeLoadResult.Loaded,
  ): LibraryResult<LibraryPrototype> {
    if (!AutoMobilePrototype.capabilities.containsAll(entry.requires))
      return LibraryResult.Failure(LibraryError.UnsupportedFormat)
    if (
      saved.id != entry.libraryId ||
        sha256Hex(saved.specJson.toByteArray()) != entry.specSha256 ||
        !validLibrarySpec(saved.specJson)
    )
      return LibraryResult.Failure(LibraryError.Corrupt)
    return LibraryResult.Success(LibraryPrototype(entry, saved))
  }

  @Synchronized
  override fun markOpened(libraryId: String): LibraryResult<Unit> {
    val entry = readEntry(libraryId) ?: return LibraryResult.Failure(LibraryError.NotFound)
    return storageResult { writeEntry(entry.copy(lastOpenedAt = clock.nowMillis())) }
  }

  @Synchronized
  override fun resetStorage(libraryId: String): LibraryResult<Unit> {
    if (readEntry(libraryId) == null) return LibraryResult.Failure(LibraryError.NotFound)
    return storageResult { storage.reset(libraryId) }
  }

  /** Internal commit seam for the next slice; no import activity or untrusted metadata input. */
  @Synchronized
  fun add(
    request: SavedPrototypeSaveRequest,
    source: LibrarySource,
    requires: List<String> = emptyList(),
  ): LibraryResult<LibraryEntry> {
    if (
      !validLibrarySpec(request.specJson) || !AutoMobilePrototype.capabilities.containsAll(requires)
    )
      return LibraryResult.Failure(LibraryError.Invalid)
    val listed = list()
    if (listed is LibraryResult.Failure) return listed
    if ((listed as LibraryResult.Success).value.size >= MAX_LIBRARY_PROTOTYPES)
      return LibraryResult.Failure(LibraryError.Limit)
    val result = storageResult {
      val id = ids.newId()
      check(validLibraryId(id) && store.load(id) == SavedPrototypeLoadResult.NotFound) {
        "Library id collision"
      }
      when (val saved = store.save(request.copy(id = id))) {
        is SavedPrototypeSaveResult.Rejected ->
          LibraryResult.Failure(
            if (
              saved.reason ==
                dev.jasonpearson.automobile.ctrlproxy.prototype.SavedPrototypeRejection
                  .SAVED_COUNT_LIMIT
            )
              LibraryError.Limit
            else LibraryError.Storage,
          )
        is SavedPrototypeSaveResult.Saved -> {
          val entry =
            LibraryEntry(
              id,
              request.label,
              clock.nowMillis(),
              0,
              source,
              sha256Hex(request.specJson.toByteArray()),
              requires.distinct().sorted(),
              false,
            )
          // Metadata is the library's commit marker. An interrupted commit stays invisible.
          var committed = false
          try {
            writeEntry(entry)
            committed = true
          } finally {
            if (!committed) store.delete(id)
          }
          LibraryResult.Success(entry)
        }
      }
    }
    return when (result) {
      is LibraryResult.Failure -> result
      is LibraryResult.Success -> result.value
    }
  }

  private fun readEntry(id: String): LibraryEntry? =
    if (!validLibraryId(id)) null
    else
      try {
        json.decodeFromString<LibraryEntry>(files.read(id)).takeIf {
          it.libraryId == id &&
            it.label.isNotBlank() &&
            it.label.length <= libraryLimits.maxLabelLength &&
            it.importedAt >= 0 &&
            it.lastOpenedAt >= 0 &&
            Regex("[a-f0-9]{64}").matches(it.specSha256)
        }
      } catch (_: Exception) {
        // A damaged or unreadable entry never prevents the remaining library from opening.
        null
      }

  private fun writeEntry(entry: LibraryEntry) =
    files.write(entry.libraryId, json.encodeToString(entry))
}

internal fun validLibraryId(id: String): Boolean = runCatching {
  UUID.fromString(id).toString() == id
}
  .getOrDefault(false)

internal fun <T> storageResult(block: () -> T): LibraryResult<T> =
  try {
    LibraryResult.Success(block())
  } catch (_: Exception) {
    // File/security/serialization failures are typed; raw exception details never become UI text.
    LibraryResult.Failure(LibraryError.Storage)
  }

private fun validLibrarySpec(spec: String): Boolean =
  PrototypeSpecValidator.validate(spec, AutoMobilePrototype.capabilities, library = true) is
    PrototypeSpecValidation.Success
