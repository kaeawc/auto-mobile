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
    val validator = Validator(context)
    return validator.declarationsError()
      ?: validator.actionsError()
      ?: Placeholders(spec, context).error()
  }

  private fun declares(fields: JsonObject): Boolean =
    when (fields.text("type")) {
      "stack" -> "routes" in fields
      "push",
      "replace" -> "params" in fields
      "pop" -> "force" in fields
      "setStack" -> true
      else -> false
    }

  fun nodeUses(fields: JsonObject, routeAlias: Boolean): Boolean =
    declares(fields) ||
      (!routeAlias &&
        PrototypeBindableFields.first<Boolean>(
          fields,
          "",
          includeRoutePointers = true,
        ) { raw, _, _ ->
          (raw as? JsonPrimitive)
            ?.takeIf { it.isString }
            ?.content
            ?.let { text -> true.takeIf { fields(text).isNotEmpty() } }
        } == true)

  fun uses(spec: JsonObject, context: Context): Boolean {
    val aliases =
      context.nodes
        .filter { (it.value["repeat"] as? JsonObject)?.text("as") == "route" }
        .map { "${it.path}.children[" }
    return context.nodes.any { it.value.text("type") == "stack" && "routes" in it.value } ||
      context.actions.any { declares(it.value) } ||
      ((spec["storage"] as? JsonObject)?.get("keys") as? JsonArray).orEmpty().any {
        it.jsonPrimitive.content.startsWith("stack:")
      } ||
      (context.nodes + context.actions.filter { it.path.startsWith("platform.on[") }).any {
        PrototypeBindableFields.routeFirst<Boolean>(it.value, it.path) { raw, at, _ ->
          if (aliases.any { at.startsWith(it) }) return@routeFirst null
          (raw as? JsonPrimitive)
            ?.takeIf { it.isString }
            ?.content
            ?.let { text -> true.takeIf { fields(text).isNotEmpty() } }
        } == true
      }
  }

  private class Validator(val context: Context) {
    val stacks = context.nodes.filter { it.value.text("type") == "stack" }

    fun declarationsError(): PrototypeSpecError? {
      for ((stack, path) in stacks) {
        val screens = stack["screens"] as? JsonObject ?: continue
        for ((name, raw) in (stack["routes"] as? JsonObject).orEmpty().toSortedMap()) {
          routeError(stack, screens, name, raw.jsonObject, keyPath("$path.routes", name))?.let {
            return it
          }
        }
      }
      return null
    }

    private fun routeError(
      stack: JsonObject,
      screens: JsonObject,
      name: String,
      route: JsonObject,
      path: String,
    ): PrototypeSpecError? {
      if (name !in screens) return PrototypeSpecError(path, "Unknown route screen")
      val params = (route["params"] as? JsonObject).orEmpty()
      for (key in params.keys.sorted()) {
        if (!namePattern.matches(key))
          return PrototypeSpecError(keyPath("$path.params", key), "Invalid route param name")
      }
      if (name == stack.text("start") && params.isNotEmpty())
        return PrototypeSpecError("$path.params", "Start screen cannot declare route params")
      return lifecycleError(stack["id"], name, path)
    }

    private fun lifecycleError(
      stackId: JsonElement?,
      screen: String,
      path: String,
    ): PrototypeSpecError? {
      for (action in context.actions) {
        if (action.value["stack"] != stackId) continue
        if (
          action.path.startsWith("$path.onBack[") &&
            action.value.text("type") == "pop" &&
            action.value["force"] != JsonPrimitive(true)
        )
          return PrototypeSpecError(action.path, "Direct onBack pop requires force: true")
        if (
          action.path.startsWith("$path.onEnter[") &&
            action.value.text("type") in listOf("push", "replace") &&
            action.value.text("screen") == screen
        )
          return PrototypeSpecError(action.path, "onEnter cannot navigate to its own screen")
      }
      return null
    }

    fun actionsError(): PrototypeSpecError? {
      for ((action, path) in context.actions) {
        if (action.text("type") !in listOf("push", "replace", "setStack")) continue
        val stack = stacks.firstOrNull { it.value["id"] == action["stack"] }?.value ?: continue
        val entries =
          if (action.text("type") == "setStack") action.getValue("path").jsonArray
          else listOf(action)
        for (raw in entries) {
          entryError(raw.jsonObject, stack, path, action.text("type") == "setStack")?.let {
            return it
          }
        }
      }
      return null
    }

    private fun entryError(
      entry: JsonObject,
      stack: JsonObject,
      path: String,
      setStack: Boolean,
    ): PrototypeSpecError? {
      if (entry.text("screen") !in stack.getValue("screens").jsonObject) {
        return if (setStack) PrototypeSpecError(path, "Unknown stack screen") else null
      }
      val declared =
        ((stack["routes"] as? JsonObject)?.get(entry.text("screen")) as? JsonObject)?.get("params")
          as? JsonObject
      return paramsError((entry["params"] as? JsonObject).orEmpty(), declared.orEmpty(), path)
    }

    private fun paramsError(
      params: Map<String, JsonElement>,
      declared: Map<String, JsonElement>,
      path: String,
    ): PrototypeSpecError? {
      for ((name, value) in params.toSortedMap()) {
        if (!namePattern.matches(name)) return PrototypeSpecError(path, "Invalid route param name")
        if (name !in declared)
          return PrototypeSpecError(path, "Undeclared route param ${JsonPrimitive(name)}")
        if (value is JsonPrimitive) {
          val type =
            if (value.isString) "string"
            else if (value.booleanOrNull != null) "boolean" else "number"
          if (type != (declared[name] as? JsonPrimitive)?.content)
            return PrototypeSpecError(path, "Wrong type for route param ${JsonPrimitive(name)}")
        }
      }
      for (name in declared.keys.sorted()) if (name !in params)
        return PrototypeSpecError(path, "Missing route param ${JsonPrimitive(name)}")
      return null
    }
  }

  private class Placeholders(spec: JsonObject, val context: Context) {
    private val owners =
      context.nodes
        .filter { it.value.text("type") == "stack" }
        .flatMap { stack ->
          (stack.value["screens"] as? JsonObject).orEmpty().keys.flatMap { screen ->
            val params =
              ((stack.value["routes"] as? JsonObject)?.get(screen) as? JsonObject)?.get("params")
                as? JsonObject
            listOf(
                "${stack.path}.screens[${JsonPrimitive(screen)}]",
                keyPath("${stack.path}.routes", screen),
              )
              .map { it to params }
          }
        }
        .toMap()
    private val usesRoutes = uses(spec, context)
    private val aliases =
      context.nodes
        .filter { (it.value["repeat"] as? JsonObject)?.text("as") == "route" }
        .map { "${it.path}.children[" }

    fun error(): PrototypeSpecError? {
      val entries = context.nodes + context.actions.filter { it.path.startsWith("platform.on[") }
      for ((node, path) in entries) {
        if (usesRoutes && (node["repeat"] as? JsonObject)?.text("as") == "route")
          return PrototypeSpecError("$path.repeat.as", "route is reserved for route params")
        PrototypeBindableFields.routeFirst<PrototypeSpecError>(node, path, ::fieldError)?.let {
          return it
        }
      }
      return null
    }

    private fun fieldError(
      raw: JsonElement?,
      path: String,
      kind: PrototypeBindableKind,
    ): PrototypeSpecError? {
      if (!usesRoutes && aliases.any { path.startsWith(it) }) return null
      val text = (raw as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return null
      var parent = path
      while (parent !in owners && '.' in parent) parent = parent.substringBeforeLast('.')
      for (name in fields(text)) {
        if (parent !in owners) return PrototypeSpecError(path, "Route placeholder outside a screen")
        if (name !in owners[parent].orEmpty())
          return PrototypeSpecError(path, "Undeclared route param ${JsonPrimitive(name)}")
      }
      if (kind.isDataPath() || kind == PrototypeBindableKind.ROUTE_POINTER) {
        if (text.split('/').any(::partialPointer))
          return PrototypeSpecError(
            path,
            "Route placeholder must occupy a whole data pointer segment",
          )
      }
      return null
    }

    private fun partialPointer(segment: String): Boolean {
      val names = fields(segment)
      return names.isNotEmpty() && (names.size != 1 || segment != "{route.${names.first()}}")
    }
  }
}
