package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypeStateChecks.Context
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.keyPath
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.text
import kotlinx.serialization.json.*

/** Contract-only route relationships. No navigation or persisted-path restoration occurs here. */
internal object PrototypeRouteRules {
  private val namePattern = PrototypeSpecContract.pathKeyPattern

  fun fields(text: String): List<String> =
    PrototypeRepeatTemplate.segments(text, "route")
      .filterIsInstance<PrototypeRepeatSegment.Field>()
      .map { it.name }

  fun error(spec: JsonObject, context: Context): PrototypeSpecError? {
    val stacks = context.nodes.filter { it.value.text("type") == "stack" }
    for ((stack, path) in stacks) {
      val screens = stack["screens"] as? JsonObject ?: continue
      for ((name, raw) in (stack["routes"] as? JsonObject).orEmpty().toSortedMap()) {
        val route = raw.jsonObject
        val at = keyPath("$path.routes", name)
        if (name !in screens) return PrototypeSpecError(at, "Unknown route screen")
        for (key in (route["params"] as? JsonObject).orEmpty().keys.sorted()) {
          if (!namePattern.matches(key))
            return PrototypeSpecError(keyPath("$at.params", key), "Invalid route param name")
        }
        for ((index, action) in (route["onBack"] as? JsonArray).orEmpty().withIndex()) {
          val entry = action.jsonObject
          if (
            entry.text("type") == "pop" &&
              entry["stack"] == stack["id"] &&
              entry["force"] != JsonPrimitive(true)
          )
            return PrototypeSpecError(
              "$at.onBack[$index]",
              "Direct onBack pop requires force: true",
            )
        }
      }
    }
    for ((action, path) in context.actions) {
      if (action.text("type") !in listOf("push", "replace", "setStack")) continue
      val stack = stacks.firstOrNull { it.value["id"] == action["stack"] }?.value ?: continue
      val entries =
        if (action.text("type") == "setStack") action["path"]!!.jsonArray else listOf(action)
      for (raw in entries) {
        val entry = raw.jsonObject
        if (entry.text("screen") !in stack["screens"]!!.jsonObject) {
          if (action.text("type") == "setStack")
            return PrototypeSpecError(path, "Unknown stack screen")
          continue
        }
        val declared =
          ((stack["routes"] as? JsonObject)?.get(entry.text("screen")) as? JsonObject)?.get(
            "params",
          ) as? JsonObject
        val params = entry["params"] as? JsonObject
        for ((name, value) in params.orEmpty().toSortedMap()) {
          if (!namePattern.matches(name))
            return PrototypeSpecError(path, "Invalid route param name")
          if (name !in declared.orEmpty())
            return PrototypeSpecError(path, "Undeclared route param ${JsonPrimitive(name)}")
          if (value is JsonPrimitive) {
            val type =
              if (value.isString) "string"
              else if (value.booleanOrNull != null) "boolean" else "number"
            if (type != declared?.text(name))
              return PrototypeSpecError(path, "Wrong type for route param ${JsonPrimitive(name)}")
          }
        }
        for (name in declared.orEmpty().keys.sorted()) if (name !in params.orEmpty())
          return PrototypeSpecError(path, "Missing route param ${JsonPrimitive(name)}")
      }
    }
    for ((node, path) in context.nodes) {
      if ((node["repeat"] as? JsonObject)?.text("as") == "route")
        return PrototypeSpecError("$path.repeat.as", "route is reserved for route params")
      val owners = stacks.flatMap { stack ->
        (stack.value["screens"] as? JsonObject).orEmpty().keys.map { screen ->
          val prefix = "${stack.path}.screens[${JsonPrimitive(screen)}]"
          listOf(prefix, keyPath("${stack.path}.routes", screen)) to
            (((stack.value["routes"] as? JsonObject)?.get(screen) as? JsonObject)?.get("params")
              as? JsonObject)
        }
      }
      val error =
        PrototypeBindableFields.first<PrototypeSpecError>(
          node,
          path,
          includeRoutePointers = true,
        ) { raw, at, kind ->
          val text = (raw as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return@first null
          val owner =
            owners
              .filter { owner -> owner.first.any { at.startsWith("$it.") } }
              .maxByOrNull { it.first.first().length }
          for (name in fields(text)) {
            if (owner == null)
              return@first PrototypeSpecError(at, "Route placeholder outside a screen")
            if (name !in owner.second.orEmpty())
              return@first PrototypeSpecError(at, "Undeclared route param ${JsonPrimitive(name)}")
          }
          if (
            (kind.isDataPath() || kind == PrototypeBindableKind.ROUTE_POINTER) &&
              text.split('/').any { segment ->
                val names = fields(segment)
                names.isNotEmpty() && (names.size != 1 || segment != "{route.${names.first()}}")
              }
          )
            PrototypeSpecError(at, "Route placeholder must occupy a whole data pointer segment")
          else null
        }
      if (error != null) return error
    }
    return null
  }

  fun uses(spec: JsonObject, context: Context): Boolean =
    context.nodes.any { it.value.text("type") == "stack" && "routes" in it.value } ||
      context.actions.any {
        (it.value.text("type") in listOf("push", "replace") && "params" in it.value) ||
          it.value.text("type") == "setStack" ||
          (it.value.text("type") == "pop" && "force" in it.value)
      } ||
      ((spec["storage"] as? JsonObject)?.get("keys") as? JsonArray).orEmpty().any {
        it.jsonPrimitive.content.startsWith("stack:")
      } ||
      context.nodes.any {
        PrototypeBindableFields.first<Boolean>(it.value, it.path, includeRoutePointers = true) {
          raw,
          _,
          _ ->
          (raw as? JsonPrimitive)
            ?.takeIf { it.isString }
            ?.content
            ?.let { text -> true.takeIf { fields(text).isNotEmpty() } }
        } == true
      }
}
