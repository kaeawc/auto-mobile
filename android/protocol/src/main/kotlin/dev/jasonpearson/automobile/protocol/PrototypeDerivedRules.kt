package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypeStateChecks.Context
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.fail
import kotlinx.serialization.json.*

/** Semantic checks not expressible in the structural contract. */
internal object PrototypeDerivedRules {
  fun error(spec: JsonElement, context: Context): PrototypeSpecError? {
    val root = spec as? JsonObject ?: return null
    val derived = root["derive"] as? JsonObject ?: JsonObject(emptyMap())
    fractions(derived, "derive")?.let {
      return it
    }
    for ((node, path) in context.nodes) {
      PrototypeBindableFields.first<PrototypeSpecError>(node, path) { value, at, kind ->
          if (kind != PrototypeBindableKind.TEXT && kind != PrototypeBindableKind.REQUEST_TEXT) null
          else
            (value as? JsonPrimitive)
              ?.takeIf { it.isString }
              ?.let { text ->
                PrototypeDerivedText.names(text.content)
                  .firstOrNull { it !in derived }
                  ?.let {
                    fail(at, "Unknown derived value ${JsonPrimitive(it)}")
                  }
              }
        }
        ?.let {
          return it
        }
      repeatError(node, path, root)?.let {
        return it
      }
    }
    return null
  }

  private fun repeatError(node: JsonObject, path: String, root: JsonObject): PrototypeSpecError? {
    val repeat = node["repeat"] as? JsonObject ?: return null
    val entries = repeat["derive"] as? JsonObject ?: JsonObject(emptyMap())
    fractions(entries, "$path.repeat.derive")?.let {
      return it
    }
    val source = repeat["items"]
    val items =
      if (source is JsonObject) {
        val name = source["derived"]?.jsonPrimitive?.content
        if (name != null) {
          val entry =
            (root["derive"] as? JsonObject)?.get(name) as? JsonObject
              ?: return fail(
                "$path.repeat.items.derived",
                "Unknown derived value ${JsonPrimitive(name)}",
              )
          if (entry["collection"] == null || entry["reduce"] != null)
            return fail(
              "$path.repeat.items.derived",
              "Repeat derived items must name a collection without reduce",
            )
          PrototypeDerive.fromSpec(root)[name] as? JsonArray
        } else {
          val pointer = source["path"]?.jsonPrimitive?.content ?: return null
          PrototypeDataPointer.resolve(root["data"], pointer) as? JsonArray
        }
      } else source as? JsonArray
    for (name in entries.keys) {
      if (items.orEmpty().any { (it as? JsonObject)?.containsKey(name) == true })
        return fail("$path.repeat.derive.$name", "Derived name collides with an item field")
    }
    return null
  }

  private fun fractions(entries: JsonObject, path: String): PrototypeSpecError? {
    for ((name, entry) in entries) {
      val format = (entry as? JsonObject)?.get("format") as? JsonObject ?: continue
      for (kind in listOf("number", "percent")) {
        val options = format[kind] as? JsonObject ?: continue
        val min = options["minFraction"]?.jsonPrimitive?.doubleOrNull
        val max = options["maxFraction"]?.jsonPrimitive?.doubleOrNull
        if (min != null && max != null && min > max)
          return fail(
            "$path.$name.format.$kind.minFraction",
            "minFraction cannot exceed maxFraction",
          )
      }
    }
    return null
  }
}

/** Single-pass span grammar shared by validation, localization and runtime interpolation. */
object PrototypeDerivedText {
  /** Resolve only this node's declared text fields; child nodes retain their own mapping scope. */
  fun bindNode(node: PrototypeNode, resolve: (String) -> String): PrototypeNode {
    val json = PrototypeSpecValidator.json
    val encoded = json.encodeToJsonElement(PrototypeNode.serializer(), node).jsonObject
    val replacements = mutableMapOf<String, JsonElement>()
    PrototypeBindableFields.first<Boolean>(encoded, "") { value, path, kind ->
      val text = (value as? JsonPrimitive)?.takeIf { it.isString }?.content
      if (
        kind == PrototypeBindableKind.TEXT && text != null && PrototypeDerivedText.hasBinding(text)
      )
        replacements[path] = JsonPrimitive(resolve(text))
      null
    }
    return if (replacements.isEmpty()) node
    else
      json.decodeFromJsonElement<PrototypeNode>(
        PrototypeRepeatKeyBindings.replace(encoded, "", replacements),
      )
  }

  fun tokenEnd(text: String, start: Int): Int {
    if (!text.startsWith("{derived:", start)) return -1
    val end = text.indexOf('}', start + 9)
    if (end < 0 || !PrototypeSpecContract.stateKeyPattern.matches(text.substring(start + 9, end)))
      return -1
    return end + 1
  }

  fun names(text: String): List<String> = buildList {
    var index = 0
    while (index < text.length) {
      val end = tokenEnd(text, index)
      if (end < 0) index++
      else {
        add(text.substring(index + 9, end - 1))
        index = end
      }
    }
  }

  fun hasBinding(text: String): Boolean = names(text).isNotEmpty()
}

/** Device-local projections must pass the value-dependent checks deferred by host validation. */
object PrototypeDerivedRows {
  fun validate(
    node: PrototypeNode,
    rows: List<Map<String, PrototypeScalar>>,
    sourceItems: List<JsonObject>? = null,
    outerAlias: String? = null,
  ): PrototypeSpecError? {
    val json = PrototypeSpecValidator.json
    val encoded = json.encodeToJsonElement(PrototypeNode.serializer(), node).jsonObject
    val repeat = encoded["repeat"] as? JsonObject ?: return null
    val projected = json.encodeToJsonElement(rows).jsonArray
    val items =
      JsonArray(
        projected.mapIndexed { index, row ->
          JsonObject(sourceItems?.getOrNull(index).orEmpty() + row.jsonObject)
        },
      )
    val materialized =
      JsonObject(
        encoded + ("repeat" to JsonObject((repeat - "derive") + ("items" to items))),
      )
    if (outerAlias == null)
      return PrototypeRepeatValidator.validate(buildJsonObject { put("root", materialized) })
    val data = PrototypeRepeatData(null)
    val scope =
      checkNotNull(PrototypeRepeatTree.scopeOf(materialized, "root", data))
        .copy(
          outerAlias = outerAlias,
          outerItem =
            items.firstOrNull()?.jsonObject?.let { row ->
              JsonObject(
                row
                  .filterKeys { it.startsWith("outer.") }
                  .mapKeys { it.key.removePrefix("outer.") },
              )
            },
        )
    for (child in PrototypeRepeatTree.childrenOf(materialized, "root")) {
      PrototypeRepeatTree.templateErrors(
          child.node,
          child.path,
          scope,
          PrototypeRepeatTextChecks.RepeatState(data),
        )
        ?.let {
          return it
        }
    }
    return PrototypeRepeatTree.repeatKeyError(materialized, "root", scope)
  }
}
