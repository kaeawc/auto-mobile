package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypeRepeatFields.string
import dev.jasonpearson.automobile.protocol.PrototypeRepeatFields.text
import dev.jasonpearson.automobile.protocol.PrototypeRepeatValidator.Scope
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

internal object PrototypeRepeatKeyBindings {
  val checkedKeyFields =
    listOf("key", "stateKey", "statusKey", "activeKey", "hourKey", "minuteKey", "atEndKey")

  /** The state-key values the validator type-checks: node keys and an action's `key`. */
  fun checkedKeys(value: JsonObject): List<String> {
    val keys = mutableListOf<String>()
    PrototypeBindableFields.first<Boolean>(value, "") { field, _, kind ->
      if (kind == PrototypeBindableKind.KEY) field.string()?.let(keys::add)
      null
    }
    keys.addAll((value["requireValid"] as? JsonArray).orEmpty().mapNotNull { it.string() })
    return keys +
      checkedKeyFields.mapNotNull { value.text(it) } +
      listOfNotNull(
        (value["trailing"] as? JsonObject)?.text("stateKey"),
        (value["openWhen"] as? JsonObject)?.text("key"),
        (value["refresh"] as? JsonObject)?.text("stateKey"),
      )
  }

  fun JsonObject.bound(field: String, scope: Scope, item: JsonObject, index: Int): JsonObject {
    val text = text(field) ?: return this
    return JsonObject(
      this + (field to JsonPrimitive(PrototypeRepeatTemplate.bind(text, scope.alias, item, index))),
    )
  }

  fun replace(
    element: JsonElement,
    path: String,
    replacements: Map<String, JsonElement>,
  ): JsonElement =
    replacements[path]
      ?: when (element) {
        is JsonObject ->
          JsonObject(
            element.mapValues { (key, child) ->
              replace(child, PrototypeBindableFields.memberPath(path, key), replacements)
            },
          )
        is JsonArray ->
          JsonArray(element.mapIndexed { i, child -> replace(child, "$path[$i]", replacements) })
        else -> element
      }

  fun bindRequired(value: JsonObject, scope: Scope, item: JsonObject, index: Int): JsonObject {
    var bound = value
    (bound["requireValid"] as? JsonArray)?.let { keys ->
      bound =
        JsonObject(
          bound +
            ("requireValid" to
              JsonArray(
                keys.map { key ->
                  key.string()?.let {
                    JsonPrimitive(PrototypeRepeatTemplate.bind(it, scope.alias, item, index))
                  } ?: key
                },
              )),
        )
    }
    return bound
  }

  fun bindKeys(value: JsonObject, scope: Scope, item: JsonObject, index: Int): JsonObject {
    val replacements = mutableMapOf<String, JsonElement>()
    PrototypeBindableFields.first<Boolean>(value, "") { field, path, kind ->
      if (kind == PrototypeBindableKind.KEY)
        field.string()?.let {
          replacements[path] =
            JsonPrimitive(PrototypeRepeatTemplate.bind(it, scope.alias, item, index))
        }
      null
    }
    var bound = replace(value, "", replacements) as JsonObject
    bound = bindRequired(bound, scope, item, index)
    for (field in checkedKeyFields) bound = bound.bound(field, scope, item, index)
    (bound["trailing"] as? JsonObject)?.let {
      bound = JsonObject(bound + ("trailing" to it.bound("stateKey", scope, item, index)))
    }
    (bound["openWhen"] as? JsonObject)?.let {
      bound = JsonObject(bound + ("openWhen" to it.bound("key", scope, item, index)))
    }
    (bound["refresh"] as? JsonObject)?.let {
      bound = JsonObject(bound + ("refresh" to it.bound("stateKey", scope, item, index)))
    }
    return bound
  }
}
