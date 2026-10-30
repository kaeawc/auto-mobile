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
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/** The platform vocabulary's reserved names (#14294). */
object PrototypePlatform {
  /** The emit-kind event name a finished platform call is reported under. */
  const val CALL_EVENT_NAME = "prototype_platform"

  /** The emit-kind event name a delivered platform event is reported under. */
  const val DELIVERED_EVENT_NAME = "prototype_platform_event"

  /** Authored emit names cannot start with this; the runtime reports its own events under it. */
  const val RESERVED_EMIT_PREFIX = "prototype_"

  /** Authored `testTag`s cannot start with this; host controls own the namespace (#15120). */
  const val RESERVED_TEST_TAG_PREFIX = "automobile-"
}

/**
 * Static checks for the platform vocabulary (#14294) that the contract cannot express, the twin of
 * TypeScript's `prototypePlatformError`: known modules, calls and events from the contract's
 * `platformModules` table, per-call arguments, declared modules, permissions and background names,
 * `{event}` scope, the `into` path and the reserved `prototype_` emit prefix.
 */
internal object PrototypePlatformRules {
  private class Declared(root: JsonObject, nodes: List<PrototypeStateChecks.Located>) {
    private val requires = root.member("requires") ?: JsonObject(emptyMap())
    val modules = requires.strings("platform").toSet()
    val permissions =
      (requires["permissions"] as? JsonArray)
        .orEmpty()
        .mapNotNull { (it as? JsonObject)?.text("name") }
        .toSet()
    val channels = root.member("channels") ?: JsonObject(emptyMap())
    val players = PrototypeMedia.players(root, nodes)
    val notificationChannels = PrototypeNotificationRules.channels(root)
    val background = requires.strings("background").toSet()
    val sensors = root.member("sensors")
  }

  // Root-level blocks, checked in order before any call or event use. The videoPlayer node rules
  // need the node list, so they take it too and run before requires, in the host's order.
  private val rootChecks:
    List<(JsonObject, List<PrototypeStateChecks.Located>) -> PrototypeSpecError?> =
    listOf(
      { root, _ -> PrototypeChannels.error(root) },
      { root, _ -> PrototypeAuthRules.blockError(root) },
      { root, _ -> PrototypeCommerceRules.blockError(root) },
      { root, _ -> PrototypeSecureStorageRules.blockError(root) },
      { root, _ -> PrototypeLocationRules.blockError(root) },
      { root, _ -> PrototypeSensorRules.blockError(root) },
      { root, _ -> PrototypeNotificationRules.blockError(root) },
      { root, _ -> PrototypeMedia.error(root) },
      { root, _ -> PrototypeMediaQueue.error(root) },
      PrototypeMedia::videoPlayerError,
      PrototypeMap::error,
      PrototypeMediaCaptions::error,
      { root, _ -> requiresError(root) },
    )

  // Module rules for a call beyond its arguments, checked in order after the generic call checks.
  private val callChecks: List<(JsonObject, String, JsonObject, Declared) -> PrototypeSpecError?> =
    listOf(
      { action, path, root, _ -> PrototypeChannels.callError(action, path, root) },
      { action, path, root, _ -> PrototypeAuthRules.callError(action, path, root) },
      { action, path, root, _ -> PrototypeCommerceRules.callError(action, path, root) },
      { action, path, root, _ -> PrototypeNotificationRules.callError(action, path, root) },
      { action, path, _, declared -> PrototypeMedia.callError(action, path, declared.players) },
    )

  fun platformErrors(value: JsonElement, context: Context): PrototypeSpecError? {
    val root = value as? JsonObject ?: return null
    val declared = Declared(root, context.nodes)
    reservedTestTagError(context)?.let {
      return it
    }
    rootChecks
      .firstNotNullOfOrNull { it(root, context.nodes) }
      ?.let {
        return it
      }
    for (use in uses(root, context)) {
      (useError(use, declared)
          ?: (use as? Use.Call)?.let { call ->
            callChecks.firstNotNullOfOrNull { it(call.action, call.path, root, declared) }
          })
        ?.let {
          return it
        }
    }
    for ((action, path) in context.actions) {
      (emitNameError(action, path) ?: PrototypeSecureStorageRules.emitError(action, path, root))
        ?.let {
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
          else -> PrototypeSensorRules.eventError(use.event, use.path, declared.sensors)
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
        when (name) {
          "realtime" -> !PrototypeChannels.validRead(use.pointer, declared.channels)
          "media" -> !PrototypeMedia.validRead(use.pointer, declared.players)
          "notifications" ->
            !PrototypeNotificationRules.validRead(tokens, declared.notificationChannels, state)
          else -> tokens.size != 2 || tokens[1] !in state
        }
      } == true -> fail(use.path, "Unknown platform state ${use.pointer}")
      else ->
        PrototypeSensorRules.readError(use.pointer, use.path, declared.sensors)
          ?: comparisonError(use)
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
    if (call == "share.open")
      PrototypeShare.argumentsError(action.member("args") ?: JsonObject(emptyMap()), "$path.args")
        ?.let {
          return it
        }
    if (call == "links.open")
      PrototypeLinks.argumentsError(action.member("args") ?: JsonObject(emptyMap()), "$path.args")
        ?.let {
          return it
        }
    return action.text("into")?.let(::intoError)?.let { fail("$path.into", it) }
  }

  internal fun argumentsError(
    action: JsonObject,
    path: String,
    definition: JsonObject,
  ): PrototypeSpecError? {
    val declared = definition.member("args") ?: JsonObject(emptyMap())
    val args = action.member("args") ?: JsonObject(emptyMap())
    for (name in (declared.keys + args.keys).sorted()) {
      val at = keyPath("$path.args", name)
      val argument =
        declared[name] as? JsonObject
          ?: return fail(
            at,
            if (action.text("call") == "share.open" && name == "title")
              "Unknown argument: use subject"
            else "Unknown argument",
          )
      val binding = args[name]
      if (binding == null) {
        if (!argument.flag("optional")) return fail(at, "Required argument")
        continue
      }
      argumentValueError(action, name, binding, argument, at)?.let {
        return it
      }
    }
    return null
  }

  private fun intoError(into: String): String? =
    if (into == "/platform" || into.startsWith("/platform/"))
      "/platform is read-only: write a platform call result into /data"
    else PrototypeRequestRules.requestIntoError(into)?.replaceFirst("request into", "platform into")

  private fun reservedTestTagError(context: Context): PrototypeSpecError? =
    context.nodes
      .firstOrNull {
        it.value.text("testTag")?.startsWith(PrototypePlatform.RESERVED_TEST_TAG_PREFIX) == true
      }
      ?.let {
        fail(
          "${it.path}.testTag",
          "testTag values starting with ${PrototypePlatform.RESERVED_TEST_TAG_PREFIX} are reserved for host controls",
        )
      }

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

/** Checks resolved runtime arguments against the same contract rules as literal arguments. */
object PrototypePlatformCalls {
  val maxInFlight: Int =
    PrototypeSpecContract.limits
      .getValue("MAX_PROTOTYPE_PLATFORM_CALLS_IN_FLIGHT")
      .jsonPrimitive
      .int
  val defaultTimeoutMs: Int =
    PrototypeSpecContract.limits.getValue("DEFAULT_PROTOTYPE_PLATFORM_TIMEOUT_MS").jsonPrimitive.int

  fun eventOwner(name: String): String? = eventModule(name)

  /** The contract's trailing debounce for a module event, or null when it delivers at once. */
  fun eventDebounceMs(name: String): Long? {
    val owner = eventModule(name) ?: return null
    val event = module(owner)?.member("events")?.member(name.substringAfter('.'))
    return (event?.get("debounceMs") as? JsonPrimitive)?.content?.toLongOrNull()
  }

  fun argumentsError(call: String, args: JsonObject): PrototypeSpecError? {
    val definition = callDefinition(call)?.second ?: return fail("call", "Unknown platform call")
    val bound = JsonObject(args.mapValues { JsonObject(mapOf("value" to it.value)) })
    return PrototypePlatformRules.argumentsError(
      JsonObject(mapOf("args" to bound, "call" to JsonPrimitive(call))),
      "platform",
      definition,
    )
      ?: when (call) {
        "share.open" -> PrototypeShare.argumentsError(args, "platform.args", resolved = true)
        "links.open" -> PrototypeLinks.argumentsError(args, "platform.args", resolved = true)
        else -> null
      }
  }
}

private fun argumentValueError(
  action: JsonObject,
  name: String,
  binding: JsonElement,
  argument: JsonObject,
  at: String,
): PrototypeSpecError? {
  if (binding is JsonPrimitive && binding.isString) {
    if (action.text("call")?.startsWith("realtime.") == true && name == "channel") return null
    return fail(at, "Invalid union value")
  }
  val literal = (binding as? JsonObject)?.get("value") ?: return null
  if (action.text("call") == "share.open" && argument.member("value")?.text("kind") == "string")
    return null
  walk(literal, argument.getValue("value").jsonObject, "$at.value", Context(), 0)?.let {
    return it
  }
  return null
}
