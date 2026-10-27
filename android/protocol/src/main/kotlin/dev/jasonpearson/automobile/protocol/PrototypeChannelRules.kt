package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypePlatformModules.member
import dev.jasonpearson.automobile.protocol.PrototypeStateChecks.Context
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.fail
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.keyPath
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.text
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * Static checks for realtime channels (#14261) that the contract cannot express, the twin of
 * TypeScript's `prototypeChannelsError`: `requires.platform`, the URL scheme per kind, forbidden
 * headers, the `statusKey` type, `when` forms per kind and decode, which actions a route may run,
 * and `realtime.*` calls naming a declared channel.
 */
internal object PrototypeChannelRules {
  const val MODULE = "realtime"

  private val hooks = listOf("onOpen", "onClose", "onError")
  private val pathKey = Regex("^[A-Za-z_][A-Za-z0-9_]*$")
  private val token = Regex("^[!#$%&'*+\\-.^_`|~0-9A-Za-z]+$")
  private val forbiddenHeader = Regex("^(sec-websocket-|last-event-id$)", RegexOption.IGNORE_CASE)
  private val refusedInRoutes =
    mapOf(
      "request" to
        "A request action cannot run from a channel, so a frame cannot trigger traffic loops",
      "push" to "A navigation action cannot run from a channel",
      "pop" to "A navigation action cannot run from a channel",
      "popToRoot" to "A navigation action cannot run from a channel",
      "replace" to "A navigation action cannot run from a channel",
      "setPage" to "A navigation action cannot run from a channel",
    )

  fun channelErrors(root: JsonElement, context: Context): PrototypeSpecError? {
    val spec = root as? JsonObject ?: return null
    val channels = spec.member("channels") ?: JsonObject(emptyMap())
    val ids = channels.keys.sortedWith(compareBy { it })
    val declared = (spec.member("requires")?.get("platform") as? JsonArray).orEmpty()
    if (ids.isNotEmpty() && declared.none { (it as? JsonPrimitive)?.content == MODULE }) {
      return fail("channels", "channels require realtime in requires.platform")
    }
    val state = spec.member("state") ?: JsonObject(emptyMap())
    for (id in ids) {
      channelError(id, channels.member(id) ?: JsonObject(emptyMap()), state)?.let {
        return it
      }
    }
    for ((action, path) in context.actions) {
      callError(action, path, channels)?.let {
        return it
      }
    }
    return null
  }

  /**
   * The state-dependent part of [channelErrors]: each channel's `statusKey` must name a declared
   * string state key. State-write validation re-runs only this, so it stays first among the checks
   * it shares with the full pass.
   */
  fun statusKeyError(spec: JsonObject): PrototypeSpecError? {
    val channels = spec.member("channels") ?: return null
    val state = spec.member("state") ?: JsonObject(emptyMap())
    for (id in channels.keys.sortedWith(compareBy { it })) {
      val channel = channels.member(id) ?: continue
      PrototypeStateBindings.requestStatusKeyError(channel, keyPath("channels", id), state)?.let {
        return it
      }
    }
    return null
  }

  private fun channelError(
    id: String,
    channel: JsonObject,
    state: JsonObject,
  ): PrototypeSpecError? {
    val at = keyPath("channels", id)
    if (!pathKey.matches(id)) return fail(at, "A channel id is letters, digits and underscores")
    channel
      .text("url")
      ?.let { urlError(channel.text("kind"), it) }
      ?.let {
        return fail("$at.url", it)
      }
    if (channel["protocols"] != null && channel.text("kind") != "websocket") {
      return fail("$at.protocols", "protocols apply to websocket channels only")
    }
    (channel["protocols"] as? JsonArray).orEmpty().forEachIndexed { index, protocol ->
      val name = (protocol as? JsonPrimitive)?.takeIf(JsonPrimitive::isString)?.content
      if (name != null && !token.matches(name)) {
        return fail("$at.protocols[$index]", "Invalid websocket subprotocol")
      }
    }
    return headersError(channel, at)
      ?: PrototypeStateBindings.requestStatusKeyError(channel, at, state)
      ?: reconnectError(channel, at)
      ?: routesError(channel, at)
  }

  private fun urlError(kind: String?, url: String): String? {
    val websocket = kind == "websocket"
    val message =
      if (websocket) "A websocket channel url must be an absolute ws or wss URL"
      else "An sse channel url must be an absolute http or https URL"
    val scheme =
      if (websocket) Regex("^wss?://", RegexOption.IGNORE_CASE)
      else Regex("^https?://", RegexOption.IGNORE_CASE)
    if ('{' in url) return if (scheme.containsMatchIn(url)) null else message
    // The WebSocket schemes parse like their HTTP twins, so one absolute-URL parser serves both.
    val parsable =
      if (websocket) url.replaceFirst(Regex("^ws", RegexOption.IGNORE_CASE), "http") else url
    val schemeOk = scheme.containsMatchIn(url)
    return if (schemeOk && PrototypeUrl.parse(parsable) is PrototypeUrl.Result.Absolute) null
    else message
  }

  private fun headersError(channel: JsonObject, at: String): PrototypeSpecError? {
    PrototypeRequestRules.requestEntryError(channel["headers"], at, "headers")?.let {
      return it
    }
    for (name in channel.member("headers")?.keys.orEmpty()) {
      if (forbiddenHeader.containsMatchIn(name)) {
        return fail(keyPath("$at.headers", name), "Forbidden channel header")
      }
    }
    return null
  }

  private fun reconnectError(channel: JsonObject, at: String): PrototypeSpecError? {
    val reconnect = channel.member("reconnect")
    val initial =
      (reconnect?.get("initialDelayMs") as? JsonPrimitive)?.content?.toDoubleOrNull() ?: 500.0
    val max = (reconnect?.get("maxDelayMs") as? JsonPrimitive)?.content?.toDoubleOrNull() ?: 30000.0
    return if (max < initial)
      fail("$at.reconnect.maxDelayMs", "maxDelayMs must be at least initialDelayMs")
    else null
  }

  private fun routesError(channel: JsonObject, at: String): PrototypeSpecError? {
    (channel["routes"] as? JsonArray).orEmpty().forEachIndexed { index, entry ->
      val route = entry as? JsonObject ?: JsonObject(emptyMap())
      val routeAt = "$at.routes[$index]"
      whenError(channel, route, routeAt)?.let {
        return it
      }
      refusedActionError(route["actions"], "$routeAt.actions")?.let {
        return it
      }
    }
    for (hook in hooks) {
      refusedActionError(channel[hook], "$at.$hook")?.let {
        return it
      }
    }
    return null
  }

  private fun whenError(channel: JsonObject, route: JsonObject, at: String): PrototypeSpecError? {
    val condition = route.member("when") ?: return null
    if (condition.containsKey("event") && channel.text("kind") != "sse") {
      return fail("$at.when.event", "when.event applies to sse channels only")
    }
    if (condition.containsKey("pointer") && channel.text("decode") == "text") {
      return fail(
        "$at.when.pointer",
        "A pointer condition needs decode json; a text frame has no members",
      )
    }
    return null
  }

  /** The first refused action in [actions] or the follow-up lists nested in them. */
  private fun refusedActionError(actions: JsonElement?, at: String): PrototypeSpecError? {
    (actions as? JsonArray)?.forEachIndexed { index, entry ->
      val action = entry as? JsonObject
      val here = "$at[$index]"
      val message = action?.text("type")?.let { refusedInRoutes[it] }
      if (message != null) return fail(here, message)
      for (nested in listOf("onSuccess", "onError", "actions")) {
        refusedActionError(action?.get(nested), "$here.$nested")?.let {
          return it
        }
      }
    }
    return null
  }

  private fun callError(
    action: JsonObject,
    path: String,
    channels: JsonObject,
  ): PrototypeSpecError? {
    val call = action.text("call").orEmpty()
    if (action.text("type") != "platform" || !call.startsWith("$MODULE.")) return null
    val literal =
      ((action.member("args")?.get("channel") as? JsonObject)?.get("value") as? JsonPrimitive)
        ?.takeIf(JsonPrimitive::isString)
        ?.content ?: return null
    val channel =
      channels.member(literal)
        ?: return fail("$path.args.channel.value", "Unknown channel $literal")
    return if (call == "realtime.send" && channel.text("kind") != "websocket")
      fail("$path.args.channel.value", "realtime.send needs a websocket channel")
    else null
  }
}
