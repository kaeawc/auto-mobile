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
        if (name == stack.text("start") && (route["params"] as? JsonObject).orEmpty().isNotEmpty())
          return PrototypeSpecError("$at.params", "Start screen cannot declare route params")
        for (action in context.actions) {
          if (
            action.path.startsWith("$at.onBack[") &&
              action.value.text("type") == "pop" &&
              action.value["stack"] == stack["id"] &&
              action.value["force"] != JsonPrimitive(true)
          )
            return PrototypeSpecError(action.path, "Direct onBack pop requires force: true")
          if (
            action.path.startsWith("$at.onEnter[") &&
              action.value.text("type") in listOf("push", "replace") &&
              action.value["stack"] == stack["id"] &&
              action.value.text("screen") == name
          )
            return PrototypeSpecError(action.path, "onEnter cannot navigate to its own screen")
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
    val owners = stacks.flatMap { stack ->
      (stack.value["screens"] as? JsonObject).orEmpty().keys.map { screen ->
        val prefix = "${stack.path}.screens[${JsonPrimitive(screen)}]"
        listOf(prefix, keyPath("${stack.path}.routes", screen)) to
          (((stack.value["routes"] as? JsonObject)?.get(screen) as? JsonObject)?.get("params")
            as? JsonObject)
      }
    }
    val ownerByPath = owners.flatMap { owner -> owner.first.map { it to owner } }.toMap()
    val usesRoutes = uses(spec, context)
    val aliases =
      context.nodes
        .filter { (it.value["repeat"] as? JsonObject)?.text("as") == "route" }
        .map { "${it.path}.children[" }
    val entries = context.nodes + context.actions.filter { it.path.startsWith("platform.on[") }
    for ((node, path) in entries) {
      if (usesRoutes && (node["repeat"] as? JsonObject)?.text("as") == "route")
        return PrototypeSpecError("$path.repeat.as", "route is reserved for route params")
      val error =
        PrototypeBindableFields.routeFirst<PrototypeSpecError>(
          node,
          path,
        ) { raw, at, kind ->
          if (!usesRoutes && aliases.any { at.startsWith(it) }) return@routeFirst null
          val text =
            (raw as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return@routeFirst null
          var parent = at
          var owner: Pair<List<String>, JsonObject?>? = null
          while (owner == null && '.' in parent) {
            parent = parent.substringBeforeLast('.')
            owner = ownerByPath[parent]
          }
          for (name in fields(text)) {
            if (owner == null)
              return@routeFirst PrototypeSpecError(at, "Route placeholder outside a screen")
            if (name !in owner.second.orEmpty())
              return@routeFirst PrototypeSpecError(
                at,
                "Undeclared route param ${JsonPrimitive(name)}",
              )
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

  fun uses(spec: JsonObject, context: Context): Boolean {
    val aliases =
      context.nodes
        .filter { (it.value["repeat"] as? JsonObject)?.text("as") == "route" }
        .map { "${it.path}.children[" }
    return context.nodes.any { it.value.text("type") == "stack" && "routes" in it.value } ||
      context.actions.any {
        (it.value.text("type") in listOf("push", "replace") && "params" in it.value) ||
          it.value.text("type") == "setStack" ||
          (it.value.text("type") == "pop" && "force" in it.value)
      } ||
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
}
