package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypeStateChecks.Context
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.fail
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * Static `linkify` checks the contract cannot express (#14233), the twin of TypeScript's
 * `prototypeLinkifyError`: linkify needs `text`, its actions take no repeat bindings, and `{match}`
 * appears only inside `linkify.onTap`.
 */
internal object PrototypeLinkifyRules {
  private val repeatPlaceholder =
    Regex("\\{(?:index|[A-Za-z_][A-Za-z0-9_]*\\.[A-Za-z_][A-Za-z0-9_]*)\\}")

  fun linkifyErrors(value: JsonElement, context: Context): PrototypeSpecError? {
    for ((node, path) in context.nodes) {
      val linkify = node["linkify"] as? JsonObject ?: continue
      if (node.containsKey("spans"))
        return fail("$path.linkify", "linkify applies to text, not spans")
      repeatBindingPath(linkify["onTap"], "$path.linkify.onTap")?.let {
        return fail(it, "linkify actions cannot use repeat bindings")
      }
    }
    val root = (value as? JsonObject)?.get("root") ?: return null
    return strayMatch(root, "root")?.let {
      fail(it, "{match} is only available inside linkify.onTap")
    }
  }

  private fun isLiteral(value: JsonObject) = value.size == 1 && value.containsKey("value")

  private fun repeatBindingPath(value: JsonElement?, path: String): String? =
    when (value) {
      is JsonPrimitive ->
        if (value.isString && repeatPlaceholder.containsMatchIn(value.content)) path else null
      is JsonArray ->
        value.withIndex().firstNotNullOfOrNull { (index, child) ->
          repeatBindingPath(child, "$path[$index]")
        }
      is JsonObject ->
        when {
          isLiteral(value) -> null
          value.containsKey("item") || value.containsKey("index") -> path
          else ->
            value.keys.sorted().firstNotNullOfOrNull { key ->
              if (key == "payload") null else repeatBindingPath(value.getValue(key), "$path.$key")
            }
        }
      else -> null
    }

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
