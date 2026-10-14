package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.PrototypeSpecValidation
import dev.jasonpearson.automobile.protocol.PrototypeSpecValidator

/** Consumer fake: snapshots in memory, with explicit results for invalid specs. No file I/O. */
internal class FakeSavedPrototypeStore(private val clock: () -> Long = { 0L }) :
  SavedPrototypeStore {
  val stored = LinkedHashMap<String, SavedPrototypeLoadResult.Loaded>()

  override fun save(request: SavedPrototypeSaveRequest): SavedPrototypeSaveResult {
    val validated = PrototypeSpecValidator.validate(request.specJson)
    if (validated !is PrototypeSpecValidation.Success) {
      return SavedPrototypeSaveResult.Rejected(SavedPrototypeRejection.INVALID_SPEC, "Invalid spec")
    }
    val replaced = request.id in stored
    stored[request.id] =
      SavedPrototypeLoadResult.Loaded(
        request.id,
        request.label,
        stored[request.id]?.slug ?: "fake-${stored.size}",
        clock(),
        validated.spec,
        request.specJson,
        request.assets.associate { it.id to it.bytes.copyOf() },
      )
    return SavedPrototypeSaveResult.Saved(request.id, stored.getValue(request.id).slug, replaced)
  }

  override fun list(): List<SavedPrototypeSummary> =
    stored.values
      .map {
        SavedPrototypeSummary(it.id, it.label, it.slug, it.savedAt)
      }
      .sortedWith(compareByDescending<SavedPrototypeSummary> { it.savedAt }.thenBy { it.id })

  override fun load(id: String): SavedPrototypeLoadResult =
    stored[id] ?: SavedPrototypeLoadResult.NotFound

  override fun delete(id: String): Boolean = stored.remove(id) != null
}
