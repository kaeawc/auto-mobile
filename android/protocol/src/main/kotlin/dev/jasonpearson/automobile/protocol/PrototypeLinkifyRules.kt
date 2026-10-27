package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypeStateChecks.Context
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.fail
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/**
 * Static `linkify` checks the contract cannot express (#14233), the twin of TypeScript's
 * `prototypeLinkifyError`: linkify needs `text`, and `{match}` appears only inside `linkify.onTap`.
 */
internal object PrototypeLinkifyRules {
  fun linkifyErrors(value: JsonElement, context: Context): PrototypeSpecError? {
    for ((node, path) in context.nodes) {
      if (node["linkify"] !is JsonObject) continue
      if (node.containsKey("spans"))
        return fail("$path.linkify", "linkify applies to text, not spans")
    }
    val root = (value as? JsonObject)?.get("root") ?: return null
    return strayMatch(root, "root")?.let {
      fail(it, "{match} is only available inside linkify.onTap")
    }
  }

  private fun isLiteral(value: JsonObject) = value.size == 1 && value.containsKey("value")

  private fun strayMatch(value: JsonElement, path: String): String? =
    when (value) {
      is JsonArray ->
        value.withIndex().firstNotNullOfOrNull { (index, child) ->
          strayMatch(child, "$path[$index]")
        }
      is JsonObject ->
        when {
          isLiteral(value) -> null
          PrototypeLinkify.isMatchBinding(value) -> "$path.match"
          else ->
            value.keys.sorted().firstNotNullOfOrNull { key ->
              val screens = if (key == "screens") value[key] as? JsonObject else null
              when {
                // Stack screens are named in brackets, as the screen-map walk reports them.
                screens != null ->
                  screens.keys.sorted().firstNotNullOfOrNull { name ->
                    val at = "$path.screens[${PrototypeSpecInput.canonicalString(name)}]"
                    strayMatch(screens.getValue(name), at)
                  }
                key in setOf("linkify", "payload", "repeat") -> null
                else -> strayMatch(value.getValue(key), "$path.$key")
              }
            }
        }
      else -> null
    }
}
