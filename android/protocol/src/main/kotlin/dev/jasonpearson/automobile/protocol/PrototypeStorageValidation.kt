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
    val context = stackContext(spec, keys)
    val pointers = mutableListOf<String>()
    var bytes = 0
    for ((index, raw) in keys.withIndex()) {
      val key = raw.jsonPrimitive.content
      val path = "storage.keys[$index]"
      if (key.startsWith("stack:")) {
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
            if (overlaps(pointers, pointer))
              return PrototypeSpecError(path, "Overlapping storage pointers")
            pointers.add(pointer)
            PrototypeDataPointer.resolve(spec["data"] as? JsonObject, pointer)
          }
        }
      if (value != null) bytes += PrototypeStorageRestorer.entryBytes(key, value)
    }
    return byteLimitError(bytes, enforceBytes)
  }

  fun keyedBindingError(
    spec: JsonObject,
    context: PrototypeStateChecks.Context,
  ): PrototypeSpecError? {
    for ((action, path) in context.actions) {
      val type = (action["type"] as? JsonPrimitive)?.content
      if (type != "request" && type !in PrototypeDataRules.dataActionTypes) continue
      val candidates = buildList {
        (action["where"] as? JsonObject)?.get("equals")?.let { add(it to "$path.where.equals") }
        if (type != "request") {
          action["value"]?.let { add(it to "$path.value") }
          // `{object}` members (#18826) read state, directly or through `{derived}`, like a value.
          val members = (action["value"] as? JsonObject)?.get("object") as? JsonObject
          for ((name, member) in members.orEmpty().toSortedMap()) {
            add(member to PrototypeValidationPaths.keyPath("$path.value.object", name))
          }
        }
      }
      for ((binding, at) in candidates) {
        // Reuse the existing template-aware secure guard, including the request opt-in.
        val probe = buildJsonObject {
          put("type", "request")
          put("body", binding)
          if (type == "request")
            action["allowSecureInRequest"]?.let { put("allowSecureInRequest", it) }
        }
        val error = PrototypeSecureStorageRules.actionError(probe, path, spec) ?: continue
        return error.copy(
          path = at,
          message =
            if (type == "request") error.message
            else error.message.replace("a request without allowSecureInRequest", "data actions"),
        )
      }
    }
    return null
  }

  private fun byteLimitError(bytes: Int, enforceBytes: Boolean): PrototypeSpecError? =
    if (
      enforceBytes &&
        bytes >
          PrototypeSpecContract.limits.getValue("MAX_PROTOTYPE_STORAGE_BYTES").jsonPrimitive.int
    )
      PrototypeSpecError("storage.keys", "Storage byte limit exceeded")
    else null

  private fun overlaps(pointers: List<String>, pointer: String): Boolean = pointers.any {
    it == pointer || it.startsWith("$pointer/") || pointer.startsWith("$it/")
  }

  private fun stackContext(spec: JsonObject, keys: JsonArray): PrototypeStateChecks.Context {
    val context = PrototypeStateChecks.Context()
    if (keys.any { it.jsonPrimitive.content.startsWith("stack:") }) {
      // Reuse the contract visitor to collect declared stack nodes.
      PrototypeStructuralWalk.walk(
        spec,
        PrototypeSpecContract.definitions.getValue("spec").jsonObject,
        "",
        context,
        0,
      )
    }
    return context
  }
}
