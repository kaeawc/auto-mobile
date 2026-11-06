package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.fail
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.text
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * `permissions` module rules the contract table cannot express (#14297), the twin of TypeScript's
 * `prototypePermissionRequestError`: a literal `permissions.request` list names only permissions
 * declared in `requires.permissions`, since the declaration carries the usage string and the
 * manifest entry. A bound list is checked by the runtime once it resolves.
 */
internal object PrototypePermissionRules {
  fun callError(action: JsonObject, path: String, declared: Set<String>): PrototypeSpecError? {
    if (action.text("call") != "permissions.request") return null
    val names =
      ((action["args"] as? JsonObject)?.get("names") as? JsonObject)?.get("value") as? JsonArray
        ?: return null
    return names.withIndex().firstNotNullOfOrNull { (index, entry) ->
      val name = (entry as? JsonPrimitive)?.takeIf { it.isString }?.content
      if (name != null && name !in declared) {
        fail(
          "$path.args.names.value[$index]",
          "Permission $name is not declared in requires.permissions",
        )
      } else null
    }
  }
}
