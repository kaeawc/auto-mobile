package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypeStateChecks.Context
import dev.jasonpearson.automobile.protocol.PrototypeStructuralWalk.walk
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.fail
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.flag
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.keyPath
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.text
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject

/** The platform vocabulary's reserved names (#14294). */
object PrototypePlatform {
  /** The emit-kind event name a finished platform call is reported under. */
  const val CALL_EVENT_NAME = "prototype_platform"

  /** The emit-kind event name a delivered platform event is reported under. */
  const val DELIVERED_EVENT_NAME = "prototype_platform_event"

  /** Authored emit names cannot start with this; the runtime reports its own events under it. */
  const val RESERVED_EMIT_PREFIX = "prototype_"
}

/**
 * Static checks for the platform vocabulary (#14294) that the contract cannot express, the twin of
 * TypeScript's `prototypePlatformError`: known modules, calls and events from the contract's
 * `platformModules` table, per-call arguments, declared modules, permissions and background names,
 * `{event}` scope, the `into` path and the reserved `prototype_` emit prefix.
 */
internal object PrototypePlatformRules {
  private val modules: JsonObject =
    PrototypeSpecContract.contract.getValue("platformModules").jsonObject

  private fun module(name: String): JsonObject? = modules[name] as? JsonObject

  private fun JsonObject.member(key: String): JsonObject? = get(key) as? JsonObject

  private fun JsonObject.strings(key: String): List<String> =
    (get(key) as? JsonArray).orEmpty().mapNotNull {
      (it as? JsonPrimitive)?.takeIf(JsonPrimitive::isString)?.content
    }

  /** `<module>.<member>` split at its first dot, or null when either side is empty. */
  private fun qualified(name: String?): Pair<String, String>? {
    name ?: return null
    val dot = name.indexOf('.')
    return if (dot > 0 && dot < name.length - 1) name.substring(0, dot) to name.substring(dot + 1)
    else null
  }

  private fun callDefinition(call: String?): Pair<String, JsonObject>? {
    val (owner, op) = qualified(call) ?: return null
    val definition = module(owner)?.member("calls")?.member(op) ?: return null
    return owner to definition
  }

  private fun eventModule(event: String): String? {
    val (owner, member) = qualified(event) ?: return null
    return owner.takeIf { module(owner)?.member("events")?.containsKey(member) == true }
  }

  /** The module a `/platform` pointer reads: its first segment. */
  private fun pointerModule(pointer: String): String =
    pointer.substring(1).substringBefore('/').replace("~1", "/").replace("~0", "~")

  private sealed class Use(val path: String) {
    class Handler(path: String, val event: String) : Use(path)

    class Call(path: String, val action: JsonObject) : Use(path)

    class Read(path: String, val pointer: String) : Use(path)

    class Event(path: String, val inHandler: Boolean) : Use(path)
  }

  private class Declared(root: JsonObject) {
    private val requires = root.member("requires") ?: JsonObject(emptyMap())
    val modules = requires.strings("platform").toSet()
    val permissions =
      (requires["permissions"] as? JsonArray)
        .orEmpty()
        .mapNotNull { (it as? JsonObject)?.text("name") }
        .toSet()
    val background = requires.strings("background").toSet()
  }

  fun platformErrors(value: JsonElement, context: Context): PrototypeSpecError? {
    val root = value as? JsonObject ?: return null
    val declared = Declared(root)
    requiresError(root)?.let {
      return it
    }
    for (use in uses(root, context)) {
      useError(use, declared)?.let {
        return it
      }
    }
    for ((action, path) in context.actions) {
      emitNameError(action, path)?.let {
        return it
      }
    }
    return null
  }

  private fun requiresError(root: JsonObject): PrototypeSpecError? {
    val requires = root.member("requires") ?: return null
    (requires["platform"] as? JsonArray).orEmpty().forEachIndexed { index, name ->
      val text = (name as? JsonPrimitive)?.takeIf(JsonPrimitive::isString)?.content
      if (text != null && module(text) == null) {
        return fail("requires.platform[$index]", "Unknown platform module")
      }
    }
    val seen = HashSet<String?>()
    (requires["permissions"] as? JsonArray).orEmpty().forEachIndexed { index, permission ->
      if (!seen.add((permission as? JsonObject)?.text("name"))) {
        return fail("requires.permissions[$index].name", "Duplicate permission")
      }
    }
    return null
  }

  /** Handlers, then the scan of each node root, then text placeholders: TypeScript's order. */
  private fun uses(root: JsonObject, context: Context): List<Use> {
    val found = mutableListOf<Use>()
    val handlers = root.member("platform")?.member("on")
    for (event in handlers?.keys.orEmpty().sorted()) {
      val at = "platform.on[${PrototypeSpecInput.canonicalString(event)}]"
      found.add(Use.Handler(at, event))
      scan(handlers!!.getValue(event), at, true, found)
    }
    root["root"]?.let { scan(it, "root", false, found) }
    for ((node, path) in context.nodes) {
      PrototypeBindableFields.first(node, path) { field, at, kind ->
        if (kind == PrototypeBindableKind.TEXT) {
          val text = (field as? JsonPrimitive)?.takeIf(JsonPrimitive::isString)?.content
          text?.let(::placeholders)?.forEach { found.add(Use.Read(at, it)) }
        }
        null
      }
    }
    return found
  }

  /** Emit payloads and literal repeat items are data; a `{value}` binding's literal is opaque. */
  private val opaqueKeys = setOf("payload", "repeat")

  private fun scan(value: JsonElement, path: String, inHandler: Boolean, found: MutableList<Use>) {
    when (value) {
      is JsonArray ->
        value.forEachIndexed { index, child -> scan(child, "$path[$index]", inHandler, found) }
      is JsonObject -> {
        if (value.size == 1 && value.containsKey("value")) return
        val type = value["type"]
        if (value.text("type") == "platform" && value.text("call") != null) {
          found.add(Use.Call(path, value))
        }
        if (type == null) {
          value.text("platform")?.let { found.add(Use.Read("$path.platform", it)) }
          if (value.text("event") != null) found.add(Use.Event("$path.event", inHandler))
        }
        for (key in value.keys.sorted()) {
          val screens = if (key == "screens") value[key] as? JsonObject else null
          if (screens != null) {
            // Stack screens are named in brackets, as the screen-map walk reports them.
            for (name in screens.keys.sorted()) {
              val at = "$path.screens[${PrototypeSpecInput.canonicalString(name)}]"
              scan(screens.getValue(name), at, inHandler, found)
            }
          } else if (key !in opaqueKeys) {
            scan(value.getValue(key), keyPath(path, key), inHandler, found)
          }
        }
      }
      else -> Unit
    }
  }

  private fun notDeclared(path: String, name: String) =
    fail(path, "Platform module $name is not declared in requires.platform")

  private fun useError(use: Use, declared: Declared): PrototypeSpecError? =
    when (use) {
      is Use.Handler -> {
        val owner = eventModule(use.event)
        when {
          owner == null -> fail(use.path, "Unknown platform event")
          owner !in declared.modules -> notDeclared(use.path, owner)
          else -> null
        }
      }
      is Use.Call -> callError(use.action, use.path, declared)
      is Use.Read -> {
        val name = pointerModule(use.pointer)
        when {
          module(name) == null -> fail(use.path, "Unknown platform module $name")
          name !in declared.modules -> notDeclared(use.path, name)
          else -> null
        }
      }
      is Use.Event ->
        if (use.inHandler) null
        else fail(use.path, "{event} is only available inside a platform.on handler")
    }

  private fun callError(action: JsonObject, path: String, declared: Declared): PrototypeSpecError? {
    val call = action.text("call")
    val (owner, definition) =
      callDefinition(call) ?: return fail("$path.call", "Unknown platform call")
    if (owner !in declared.modules) return notDeclared("$path.call", owner)
    definition
      .strings("permissions")
      .firstOrNull { it !in declared.permissions }
      ?.let {
        return fail(
          "$path.call",
          "Platform call $call requires permission $it in requires.permissions",
        )
      }
    definition
      .strings("background")
      .firstOrNull { it !in declared.background }
      ?.let {
        return fail("$path.call", "Platform call $call requires $it in requires.background")
      }
    argumentsError(action, path, definition)?.let {
      return it
    }
    return action.text("into")?.let(::intoError)?.let { fail("$path.into", it) }
  }

  private fun argumentsError(
    action: JsonObject,
    path: String,
    definition: JsonObject,
  ): PrototypeSpecError? {
    val declared = definition.member("args") ?: JsonObject(emptyMap())
    val args = action.member("args") ?: JsonObject(emptyMap())
    for (name in (declared.keys + args.keys).sorted()) {
      val at = keyPath("$path.args", name)
      val argument = declared[name] as? JsonObject ?: return fail(at, "Unknown argument")
      val binding = args[name]
      if (binding == null) {
        if (!argument.flag("optional")) return fail(at, "Required argument")
        continue
      }
      val literal = (binding as? JsonObject)?.get("value") ?: continue
      walk(literal, argument.getValue("value").jsonObject, "$at.value", Context(), 0)?.let {
        return it
      }
    }
    return null
  }

  private fun intoError(into: String): String? =
    if (into == "/platform" || into.startsWith("/platform/"))
      "/platform is read-only: write a platform call result into /data"
    else PrototypeRequestRules.requestIntoError(into)?.replaceFirst("request into", "platform into")

  private fun emitNameError(action: JsonObject, path: String): PrototypeSpecError? {
    val name = action.text("name") ?: return null
    return if (
      action.text("type") == "emit" &&
        name != PrototypeRequests.EVENT_NAME &&
        name.startsWith(PrototypePlatform.RESERVED_EMIT_PREFIX)
    )
      fail(
        "$path.name",
        "Emit names starting with ${PrototypePlatform.RESERVED_EMIT_PREFIX} are reserved for runtime events",
      )
    else null
  }

  /** `{platform:/pointer}` placeholders, scanned exactly as `{data:/pointer}` ones. */
  private fun placeholders(text: String): List<String> {
    val prefix = "platform:"
    val found = mutableListOf<String>()
    var cursor = 0
    while (cursor < text.length) {
      if (text[cursor] != '{' || !text.startsWith(prefix, cursor + 1)) {
        cursor++
        continue
      }
      val end =
        minOf(
          text.length,
          cursor + 2 + prefix.length + PrototypeSpecValidator.MAX_PROTOTYPE_DATA_POINTER_LENGTH,
        )
      val close = (cursor + 1 until end).firstOrNull { text[it] == '}' }
      val pointer = close?.let { text.substring(cursor + 1 + prefix.length, it) }.orEmpty()
      if (close != null && PrototypeDataPointer.isValid(pointer)) {
        found.add(pointer)
        cursor = close + 1
      } else {
        cursor++
      }
    }
    return found
  }
}
