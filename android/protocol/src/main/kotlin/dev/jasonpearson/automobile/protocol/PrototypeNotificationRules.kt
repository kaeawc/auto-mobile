package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypePlatformModules.member
import dev.jasonpearson.automobile.protocol.PrototypePlatformModules.strings
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.fail
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.text
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * Notification rules (#14280) the contract cannot express, the twin of TypeScript's
 * `prototypeNotifications.ts`: the root `notifications` block needs `notifications` in
 * `requires.platform` and unique channel ids; a literal `notifications.post` channel names a
 * declared channel and its action ids are unique; `notifications.cancel` names exactly one target;
 * a channel-scoped `/platform` read names a declared channel.
 */
internal object PrototypeNotificationRules {
  private val cancelTargets = listOf("id", "group", "all")

  /** Channel-scoped `/platform` keys, read at `/notifications/channels/<id>/<key>`. */
  private val channelStateKeys = setOf("blocked")

  /** Whether a `/notifications` read names a module key or a declared channel's key. */
  fun validRead(tokens: List<String>, channels: Set<String>, state: JsonObject): Boolean =
    if (tokens.getOrNull(1) == "channels")
      tokens.size == 4 && tokens[2] in channels && tokens[3] in channelStateKeys
    else tokens.size == 2 && tokens[1] in state && tokens[1] !in channelStateKeys

  fun blockError(root: JsonObject): PrototypeSpecError? {
    val block = root.member("notifications") ?: return null
    if ("notifications" !in (root.member("requires")?.strings("platform") ?: emptyList()))
      return fail(
        "notifications",
        "The notifications block requires notifications in requires.platform",
      )
    return duplicateIdIndex(block["channels"])?.let {
      fail("notifications.channels[$it].id", "Duplicate channel id")
    }
  }

  fun callError(action: JsonObject, path: String, root: JsonObject): PrototypeSpecError? {
    val args = action["args"] as? JsonObject ?: JsonObject(emptyMap())
    return when (action.text("call")) {
      "notifications.cancel" ->
        if (cancelTargets.count { it in args } == 1) null
        else fail("$path.args", "notifications.cancel takes exactly one of id, group or all")
      "notifications.post",
      "notifications.schedule" -> postError(args, path, root)
      else -> null
    }
  }

  // A bound channel or action list is checked by the runtime once it resolves.
  private fun postError(args: JsonObject, path: String, root: JsonObject): PrototypeSpecError? {
    val channel = ((args["channel"] as? JsonObject)?.get("value") as? JsonPrimitive)
    if (channel != null && channel.isString && channel.content !in channels(root))
      return fail("$path.args.channel.value", "Undeclared notification channel")
    return duplicateIdIndex((args["actions"] as? JsonObject)?.get("value"))?.let {
      fail("$path.args.actions.value[$it].id", "Duplicate action id")
    }
  }

  /** The declared channel ids of the root `notifications` block. */
  fun channels(root: JsonObject): Set<String> =
    (root.member("notifications")?.get("channels") as? JsonArray)
      .orEmpty()
      .mapNotNull { (it as? JsonObject)?.text("id") }
      .toSet()

  /** The index of the first entry whose `id` repeats an earlier entry's, or null. */
  private fun duplicateIdIndex(list: JsonElement?): Int? {
    val seen = HashSet<JsonElement?>()
    (list as? JsonArray).orEmpty().forEachIndexed { index, entry ->
      if (!seen.add((entry as? JsonObject)?.get("id"))) return index
    }
    return null
  }
}
