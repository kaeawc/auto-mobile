package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.json.*

/** Inputs written since the preceding evaluation; pointers invalidate ancestors and descendants. */
data class PrototypeDeriveChanges(
  val dataPointers: Set<String> = emptySet(),
  val stateKeys: Set<String> = emptySet(),
)

fun interface PrototypeDeriveObserver {
  fun recomputed(name: String)
}

/**
 * Pure raw-value evaluation. JSON rows retain their source identity; formatting is a caller seam.
 */
object PrototypeDerive {
  @Suppress("LongParameterList") // Matches the shared incremental evaluator contract.
  fun evaluate(
    derive: Map<String, PrototypeDerivedEntry>?,
    data: JsonElement?,
    state: Map<String, JsonElement>,
    previous: Map<String, JsonElement?>? = null,
    changed: PrototypeDeriveChanges? = null,
    observer: PrototypeDeriveObserver? = null,
  ): Map<String, JsonElement?> =
    derive.orEmpty().mapValues { (name, entry) ->
      if (previous?.containsKey(name) == true && changed != null && !affected(entry, changed))
        previous[name]
      else {
        observer?.recomputed(name)
        value(entry, data, state)
      }
    }

  private class Revision(val spec: JsonObject, val values: Map<String, JsonElement?>)

  @Volatile private var lastRevision: Revision? = null

  /**
   * One evaluation per spec revision: validation reads derived values from many repeat nodes and
   * caches, and parsed JSON is immutable, so the same spec instance reuses the last result.
   */
  internal fun fromSpec(
    spec: JsonObject,
    observer: PrototypeDeriveObserver? = null,
  ): Map<String, JsonElement?> {
    lastRevision
      ?.takeIf { it.spec === spec }
      ?.let {
        return it.values
      }
    return evaluateSpec(spec, observer).also { lastRevision = Revision(spec, it) }
  }

  private fun evaluateSpec(
    spec: JsonObject,
    observer: PrototypeDeriveObserver?,
  ): Map<String, JsonElement?> {
    val entries =
      (spec["derive"] as? JsonObject).orEmpty().mapValues { (_, value) ->
        PrototypeSpecValidator.json.decodeFromJsonElement<PrototypeDerivedEntry>(value)
      }
    return evaluate(
      entries,
      spec["data"],
      (spec["state"] as? JsonObject).orEmpty(),
      observer = observer,
    )
  }

  private fun affected(entry: PrototypeDerivedEntry, changed: PrototypeDeriveChanges): Boolean {
    val source = entry.collection?.get("of")?.jsonObject ?: entry.of
    val pointer = source["data"]?.jsonPrimitive?.content
    val keys =
      if (entry.collection == null) listOfNotNull(source["state"]?.jsonPrimitive?.content)
      else
        PrototypeCollection.clauses(entry.collection).mapNotNull {
          it["value"]?.jsonObject?.get("state")?.jsonPrimitive?.content
        }
    return keys.any { it in changed.stateKeys } ||
      (pointer != null &&
        changed.dataPointers.any {
          PrototypeDataPointer.overlaps(it, pointer)
        })
  }

  private fun value(
    entry: PrototypeDerivedEntry,
    data: JsonElement?,
    state: Map<String, JsonElement>,
  ): JsonElement? =
    entry.collection?.let { PrototypeCollection.collect(it, entry.reduce, data, state) }
      ?: when {
        "data" in entry.of ->
          PrototypeDataPointer.resolve(data, entry.of.getValue("data").jsonPrimitive.content)
        "state" in entry.of -> state[entry.of.getValue("state").jsonPrimitive.content]
        else -> entry.of["value"]
      }
}
