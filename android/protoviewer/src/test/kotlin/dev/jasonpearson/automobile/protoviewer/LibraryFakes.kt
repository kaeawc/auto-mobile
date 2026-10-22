package dev.jasonpearson.automobile.protoviewer

import dev.jasonpearson.automobile.ctrlproxy.prototype.SavedPrototypeLoadResult
import dev.jasonpearson.automobile.ctrlproxy.prototype.SavedPrototypeSaveRequest
import dev.jasonpearson.automobile.ctrlproxy.prototype.SavedPrototypeSaveResult
import dev.jasonpearson.automobile.ctrlproxy.prototype.SavedPrototypeStore
import dev.jasonpearson.automobile.ctrlproxy.prototype.SavedPrototypeSummary
import dev.jasonpearson.automobile.ctrlproxy.prototype.sha256Hex
import dev.jasonpearson.automobile.protocol.PrototypeSpecValidation
import dev.jasonpearson.automobile.protocol.PrototypeSpecValidator
import dev.jasonpearson.automobile.protocol.PrototypeStoredValues
import dev.jasonpearson.automobile.prototype.PrototypeStorage
import java.io.IOException
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

internal const val FIRST = "00000000-0000-4000-8000-000000000001"
internal const val SECOND = "00000000-0000-4000-8000-000000000002"
internal const val SPEC =
  """{"id":"same-spec-id","window":{"placement":{"type":"fullscreen"}},"root":{"type":"text","id":"fixture","text":"Prototype content"}}"""

internal object Fixtures {
  private val hash = sha256Hex(SPEC.toByteArray())
  val spec = (PrototypeSpecValidator.validate(SPEC) as PrototypeSpecValidation.Success).spec

  fun entry(id: String = FIRST, opened: Long = 0) =
    LibraryEntry(
      id,
      "Example $id",
      10,
      opened,
      LibrarySource.file,
      hash,
      emptyList(),
      false,
    )

  fun loaded(id: String = FIRST) =
    SavedPrototypeLoadResult.Loaded(id, "Example", "slug", 10, spec, SPEC, emptyMap())

  fun prototype(id: String = FIRST) = LibraryPrototype(entry(id), loaded(id))
}

internal class FakeLibraryFiles : LibraryFileOperations {
  val documents = mutableMapOf<String, String>()
  val unreadable = mutableSetOf<String>()
  var fail = false
  var usedBytes = 0L

  override fun sizeBytes(): Long {
    checkStorage()
    return usedBytes
  }

  override fun ids(): List<String> {
    checkStorage()
    return documents.keys.toList()
  }

  override fun read(id: String): String {
    checkStorage()
    if (id in unreadable) throw IOException("Unreadable")
    return documents[id] ?: throw IOException("Missing")
  }

  override fun write(id: String, text: String) {
    checkStorage()
    documents[id] = text
  }

  override fun delete(id: String) {
    checkStorage()
    documents.remove(id)
  }

  fun put(entry: LibraryEntry) {
    documents[entry.libraryId] = Json.encodeToString(entry)
  }

  private fun checkStorage() {
    if (fail) throw IOException("Unavailable")
  }
}

internal class FakePrototypeStorage : PrototypeStorage {
  val values = mutableMapOf<String, PrototypeStoredValues>()

  override fun load(id: String) = values[id]

  override fun save(id: String, values: PrototypeStoredValues) {
    this.values[id] = values
  }

  override fun delete(id: String) {
    values.remove(id)
  }
}

internal class FakeSavedStore : SavedPrototypeStore {
  val results = mutableMapOf<String, SavedPrototypeLoadResult>()

  override fun list() = emptyList<SavedPrototypeSummary>()

  override fun load(id: String) = results[id] ?: SavedPrototypeLoadResult.NotFound

  override fun save(request: SavedPrototypeSaveRequest): SavedPrototypeSaveResult {
    results[request.id] =
      SavedPrototypeLoadResult.Loaded(
        request.id,
        request.label,
        "slug",
        10,
        Fixtures.spec,
        request.specJson,
        emptyMap(),
      )
    return SavedPrototypeSaveResult.Saved(request.id, "slug", false)
  }

  override fun delete(id: String) = results.remove(id) != null
}

/** In-memory repository for activity tests: no real file, database, network or clock. */
internal class FakeLibraryRepository : LibraryRepository {
  val prototypes = mutableMapOf<String, LibraryPrototype>()
  val opened = mutableListOf<String>()
  val resets = mutableListOf<String>()
  var error: LibraryError? = null

  override fun list(): LibraryResult<List<LibraryEntry>> =
    error?.let { LibraryResult.Failure(it) }
      ?: LibraryResult.Success(
        prototypes.values.map { it.entry }.sortedByDescending { it.lastOpenedAt },
      )

  override fun get(libraryId: String): LibraryResult<LibraryPrototype> =
    error?.let { LibraryResult.Failure(it) }
      ?: prototypes[libraryId]?.let { LibraryResult.Success(it) }
      ?: LibraryResult.Failure(LibraryError.NotFound)

  override fun delete(libraryId: String): LibraryResult<Unit> {
    prototypes.remove(libraryId)
    return LibraryResult.Success(Unit)
  }

  override fun markOpened(libraryId: String): LibraryResult<Unit> {
    opened += libraryId
    return LibraryResult.Success(Unit)
  }

  override fun resetStorage(libraryId: String): LibraryResult<Unit> {
    resets += libraryId
    return LibraryResult.Success(Unit)
  }
}
