package dev.jasonpearson.automobile.sdk

import java.util.concurrent.ConcurrentHashMap

/**
 * Removes [name] only if it currently maps to the exact [value] instance (reference identity, not
 * [equals]). Returns whether it was removed.
 *
 * `ConcurrentHashMap.remove(key, value)` compares with `equals`, so two distinct drivers that
 * compare equal (or the same instance registered twice) would let a stale handle remove a live
 * replacement (issue #5581). This uses `===` under an atomic `computeIfPresent` instead.
 */
internal fun <V : Any> ConcurrentHashMap<String, V>.removeIfIdentical(
  name: String,
  value: V,
): Boolean {
  var removed = false
  computeIfPresent(name) { _, current ->
    if (current === value) {
      removed = true
      null // returning null removes the mapping
    } else {
      current
    }
  }
  return removed
}

/**
 * Handle returned by an inspector's driver/adapter registration
 * ([dev.jasonpearson.automobile.sdk.storage.SharedPreferencesInspector.registerDriver],
 * [dev.jasonpearson.automobile.sdk.database.DatabaseInspector.registerDriver],
 * [dev.jasonpearson.automobile.sdk.storage.DataStoreInspector.registerAdapter]).
 *
 * Removal via this handle is **identity-conditioned**: it removes the registration only if it is
 * still the current one for its name. When a second lifecycle owner registers under the same stable
 * name, the newer registration replaces the older; a stale owner calling [unregister] on its old
 * handle then no-ops instead of tearing down the replacement (issue #5581). The name-based
 * `unregister*` entry points remain for callers that manage lifetime by name.
 */
class InspectorRegistration internal constructor(private val remove: () -> Boolean) {
  /**
   * Removes this registration if it is still the current one for its name. Returns whether it was
   * removed (false if it had already been replaced or removed).
   */
  fun unregister(): Boolean = remove()
}
