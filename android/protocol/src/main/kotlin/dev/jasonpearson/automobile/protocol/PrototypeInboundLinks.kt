package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypeStateChecks.Context
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.text
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/** Inbound contract checks only; no runtime navigation or platform service. */
internal object PrototypeInboundLinks {
  private fun bindings(value: JsonElement?): Set<String> = buildSet {
    fun scan(raw: JsonElement?) {
      when (raw) {
        is JsonArray -> raw.forEach(::scan)
        is JsonObject -> {
          if (raw.size == 1 && "value" in raw) return
          if (raw.size == 1) raw.text("link")?.let(::add)
          raw.forEach { (key, child) ->
            if (key in setOf("params", "context", "args", "headers", "query", "form")) {
              (child as? JsonObject)?.values?.forEach(::scan)
              return@forEach
            }
            if (
              key !in setOf("value", "payload") ||
                (key == "value" && (child as? JsonObject)?.get("link") != null)
            )
              scan(child)
          }
        }
        else -> Unit
      }
    }
    scan(value)
  }

  fun error(spec: JsonObject, context: Context): PrototypeSpecError? {
    val entries = (spec["links"] as? JsonArray).orEmpty().map { it.jsonObject }
    val table = entries.mapIndexed { index, entry ->
      val path =
        entry.text("path") ?: return PrototypeSpecError("links[$index]", "Missing link path")
      PrototypeLinkMatcher.Entry(
        path,
        (entry["query"] as? JsonObject).orEmpty().mapValues { (_, value) ->
          (value as? JsonObject)?.text("type") ?: value.jsonPrimitive.content
        },
        bindings(entry["actions"]),
      )
    }
    PrototypeLinkMatcher.validateLinkTable(table).firstOrNull()?.let {
      return PrototypeSpecError("links[${it.index}]", it.message)
    }
    if ("links" in spec && "prototype_links_v1" !in declaredPrototypeCapabilities(spec["requires"]))
      return PrototypeSpecError("requires", "links requires prototype_links_v1")
    for ((action, path) in context.actions) {
      actionError(action, path, table, spec, context)?.let {
        return PrototypeSpecError(path, it)
      }
    }
    return null
  }

  private fun types(entry: PrototypeLinkMatcher.Entry?): Map<String, String> {
    val types = mutableMapOf<String, String>()
    entry
      ?.path
      ?.split('/')
      ?.filter { it.startsWith('{') && it.endsWith('}') }
      ?.forEach {
        types[it.drop(1).dropLast(1)] = "string"
      }
    entry?.query?.forEach { (name, type) ->
      types[name] = type.removeSuffix("?").let { if (it == "int") "number" else it }
    }
    return types
  }

  private fun actionError(
    action: JsonObject,
    path: String,
    table: List<PrototypeLinkMatcher.Entry>,
    spec: JsonObject,
    context: Context,
  ): String? {
    val index = Regex("^links\\[(\\d+)\\]\\.actions\\[").find(path)?.groupValues?.get(1)?.toInt()
    val entry = index?.let { table.getOrNull(it) }
    val types = types(entry)
    if (bindings(action).any { it !in types }) return "Unknown link binding"
    return stateTypeError(action, spec, types) ?: routeError(action, context, types)
  }

  private fun stateTypeError(
    action: JsonObject,
    spec: JsonObject,
    types: Map<String, String>,
  ): String? {
    val written = (action["value"] as? JsonObject)?.text("link")
    if (written == null) return null
    val stateValue = (spec["state"] as? JsonObject)?.get(action.text("key")) as? JsonPrimitive
    val stateType = stateValue?.let {
      if (it.isString) "string" else if (it.booleanOrNull != null) "boolean" else "number"
    }
    val writesLinkToState = action.text("type") == "setState"
    if (writesLinkToState && stateType != null && types[written] != stateType)
      return "Wrong type for link state value"
    return null
  }

  private fun routeError(
    action: JsonObject,
    context: Context,
    types: Map<String, String>,
  ): String? {
    val stack =
      context.nodes
        .firstOrNull {
          it.value.text("type") == "stack" && it.value.text("id") == action.text("stack")
        }
        ?.value
    val targets =
      if (action.text("type") == "setStack") (action["path"] as? JsonArray).orEmpty()
      else listOf(action)
    for (target in targets) {
      val navigation = target.jsonObject
      val declared =
        (((stack?.get("routes") as? JsonObject)?.get(navigation.text("screen")) as? JsonObject)
            ?.get("params") as? JsonObject)
          .orEmpty()
      for ((name, value) in (navigation["params"] as? JsonObject).orEmpty()) {
        val binding = (value as? JsonObject)?.text("link") ?: continue
        if (types[binding] != (declared[name] as? JsonPrimitive)?.content)
          return "Wrong type for route param ${JsonPrimitive(name)}"
      }
    }
    return null
  }
}
