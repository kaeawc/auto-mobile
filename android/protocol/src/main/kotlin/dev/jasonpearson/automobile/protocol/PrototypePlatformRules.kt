package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypePlatformModules.callDefinition
import dev.jasonpearson.automobile.protocol.PrototypePlatformModules.eventModule
import dev.jasonpearson.automobile.protocol.PrototypePlatformModules.member
import dev.jasonpearson.automobile.protocol.PrototypePlatformModules.module
import dev.jasonpearson.automobile.protocol.PrototypePlatformModules.pointerModule
import dev.jasonpearson.automobile.protocol.PrototypePlatformModules.strings
import dev.jasonpearson.automobile.protocol.PrototypePlatformUses.Use
import dev.jasonpearson.automobile.protocol.PrototypePlatformUses.uses
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
      is Use.Read -> readError(use, declared)
      is Use.Event ->
        if (use.inHandler) null
        else fail(use.path, "{event} is only available inside a platform.on handler")
    }

  private fun readError(use: Use.Read, declared: Declared): PrototypeSpecError? {
    val name = pointerModule(use.pointer)
    return when {
      module(name) == null -> fail(use.path, "Unknown platform module $name")
      name !in declared.modules -> notDeclared(use.path, name)
      module(name)?.member("state")?.let { state ->
        val tokens = PrototypeDataPointer.tokens(use.pointer)
        tokens.size != 2 || tokens[1] !in state
      } == true -> fail(use.path, "Unknown platform state ${use.pointer}")
      else -> comparisonError(use)
    }
  }

  private fun comparisonError(use: Use.Read): PrototypeSpecError? {
    val tokens = PrototypeDataPointer.tokens(use.pointer)
    val entry =
      module(tokens.firstOrNull().orEmpty())?.member("state")?.member(tokens.lastOrNull().orEmpty())
        ?: return null
    val overrides = entry.member("valueByPlatform") ?: return null
    // A portable spec may branch on device.os; validation has no target platform.
    val rule =
      JsonObject(
        mapOf(
          "kind" to JsonPrimitive("choice"),
          "options" to JsonArray(listOf(entry.getValue("value")) + overrides.values),
        ),
      )
    for (op in listOf("equals", "notEquals")) {
      val literal = use.condition?.get(op) ?: continue
      walk(literal, rule, use.path.removeSuffix(".platform") + ".$op", Context(), 0)?.let {
        return it
      }
    }
    return null
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
}
