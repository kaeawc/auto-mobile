package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypeRepeatFields.fail
import dev.jasonpearson.automobile.protocol.PrototypeRepeatFields.text
import dev.jasonpearson.automobile.protocol.PrototypeRepeatTextChecks.RepeatState
import dev.jasonpearson.automobile.protocol.PrototypeRepeatValidator.Scope
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** Per-outer-row scopes shared by template, state-key and expanded-budget validation. */
internal object PrototypeNestedRepeat {
  fun innerScope(node: JsonObject, path: String, outer: Scope, index: Int): Scope {
    val repeat = node.getValue("repeat") as JsonObject
    val field = checkNotNull((repeat.getValue("items") as JsonObject).text("field"))
    val item = outer.items.getOrNull(index)
    val rows =
      (outer.sourceItems.getOrNull(index)?.get(field) as? JsonArray)
        .orEmpty()
        .filterIsInstance<JsonObject>()
    val names = (repeat["derive"] as? JsonObject)?.keys.orEmpty()
    val fields =
      item.orEmpty().mapKeys { (key, _) -> "outer.$key" } + ("\$outerIndex" to JsonPrimitive(index))
    return Scope(
      path,
      checkNotNull(repeat.text("as")),
      rows.map {
        JsonObject(
          PrototypeDataValues.project(it) + names.associateWith { JsonPrimitive("") } + fields,
        )
      },
      true,
      names + outer.derivedNames.map { "outer.$it" },
      "field",
      outer.alias,
      item,
      rows,
    )
  }

  private fun innerSourceError(
    item: JsonObject,
    field: String,
    at: String,
    state: RepeatState,
  ): PrototypeSpecError? {
    if (field !in item) return fail(at, "Unknown repeat field ${JsonPrimitive(field)}")
    val rows =
      item[field] as? JsonArray ?: return fail(at, "Repeat field does not resolve to an array")
    if (rows.size > PrototypeSpecValidator.MAX_PROTOTYPE_INNER_REPEAT_ITEMS)
      return fail(at, "Repeat field resolves to more than 100 items")
    val invalid = rows.indexOfFirst { it !is JsonObject }
    if (invalid >= 0) return fail(at, "Repeat field item $invalid is not an object")
    state.cells += PrototypeRepeatData(JsonObject(mapOf("rows" to rows))).cells("/rows")
    return if (state.cells > PrototypeSpecValidator.MAX_PROTOTYPE_REPEAT_PATH_CELLS)
      fail(at, "Repeat path cell limit exceeded")
    else null
  }

  fun templateErrors(
    node: JsonObject,
    path: String,
    outer: Scope,
    field: String,
    state: RepeatState,
  ): PrototypeSpecError? {
    val count = maxOf(1, outer.items.size)
    for (index in 0 until count) {
      val scope =
        if (outer.items.isEmpty())
          Scope(
            path,
            checkNotNull((node.getValue("repeat") as JsonObject).text("as")),
            emptyList(),
            outerAlias = outer.alias,
          )
        else {
          innerSourceError(outer.sourceItems[index], field, "$path.repeat.items.field", state)
            ?.let {
              return it
            }
          innerScope(node, path, outer, index)
        }
      for (child in PrototypeRepeatTree.childrenOf(node, path)) {
        PrototypeRepeatTree.templateErrors(child.node, child.path, scope, state)?.let {
          return it
        }
      }
      PrototypeRepeatTree.repeatKeyError(node, path, scope)?.let {
        return it
      }
    }
    return null
  }
}
