package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.json.*

/** Strict cross-references reuse the runtime key grammar, pointer lookup and entry accounting. */
internal object PrototypeStorageValidation {
  /**
   * [enforceBytes] is false for live state writes: the runtime applies an over-limit write on
   * screen and only skips persisting it, so the byte budget is an import-time check.
   */
  fun error(spec: JsonObject, enforceBytes: Boolean = true): PrototypeSpecError? {
    val storage = spec["storage"] as? JsonObject ?: return null
    val keys = storage["keys"] as? JsonArray ?: return null
    val pointers = mutableListOf<String>()
    var bytes = 0
    for ((index, raw) in keys.withIndex()) {
      val key = raw.jsonPrimitive.content
      val path = "storage.keys[$index]"
      if (key.startsWith("stack:")) {
        val context = PrototypeStateChecks.Context()
        // Reuse the contract visitor to collect declared stack nodes.
        PrototypeStructuralWalk.walk(
          spec,
          PrototypeSpecContract.definitions.getValue("spec").jsonObject,
          "",
          context,
          0,
        )
        if (
          context.nodes.none {
            it.value["type"] == JsonPrimitive("stack") &&
              it.value["id"] == JsonPrimitive(key.removePrefix("stack:"))
          }
        )
          return PrototypeSpecError(path, "Unknown storage stack")
        continue
      }
      val value =
        when (val parsed = PrototypeStorageKey.parse(key)) {
          null -> return PrototypeSpecError(path, "Invalid storage key")
          is PrototypeStorageKey.State ->
            (spec["state"] as? JsonObject)?.get(parsed.key)
              ?: return PrototypeSpecError(path, "Undeclared storage state")
          is PrototypeStorageKey.Data -> {
            val pointer = parsed.pointer
            if (
              pointers.any {
                it == pointer || it.startsWith("$pointer/") || pointer.startsWith("$it/")
              }
            )
              return PrototypeSpecError(path, "Overlapping storage pointers")
            pointers.add(pointer)
            PrototypeDataPointer.resolve(spec["data"] as? JsonObject, pointer)
          }
        }
      if (value != null) bytes += PrototypeStorageRestorer.entryBytes(key, value)
    }
    return if (
      enforceBytes &&
        bytes >
          PrototypeSpecContract.limits.getValue("MAX_PROTOTYPE_STORAGE_BYTES").jsonPrimitive.int
    )
      PrototypeSpecError("storage.keys", "Storage byte limit exceeded")
    else null
  }
}
