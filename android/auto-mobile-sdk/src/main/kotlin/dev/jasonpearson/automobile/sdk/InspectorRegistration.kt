package dev.jasonpearson.automobile.sdk

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
